/**
 * Engine-parametrized scenarios for the Git coalescing window (#5530): the
 * consumer leaves a fresh single-file Git effect unclaimed for a bounded
 * window, so a sequential writer's files publish as one batch. PGLite runs
 * them from test/persistence-git-coalescing.test.ts and
 * test/grandfather-git-batching.test.ts; test/e2e/ runs the same bodies on
 * Postgres. Window cases backdate `updated_at` instead of sleeping.
 */
import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { phaseCGrandfather } from '../../src/commands/migrations/v0_13_1.ts';
import { PersistenceConsumer, STOP_PASS_BUDGET_MS } from '../../src/core/persistence/consumer.ts';
import { GIT_BATCH_PATHS } from '../../src/core/persistence/effect-git.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { acquireNativeLock } from '../../src/core/persistence/native-lock.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { commits, gitEffects, harden, pass, pushes, put, remoteFiles, remoteRepo, writeUnpublished, type GitEffect } from './git-batch-scenarios.ts';
import { git } from './git-publication.ts';
import { managedBrain } from './managed-brain.ts';

/** A window no test outlives, so only a backdated `updated_at` ever ages an effect past it. */
const WINDOW_MS = 60_000;
const ids = (effects: GitEffect[]) => effects.map(effect => Number(effect.id));

/**
 * Makes exactly `effects` ready as never-attempted (or `attempts`) rows queued
 * `ageMs` ago, with `data` merged in; every other effect waits an hour.
 */
async function queue(engine: BrainEngine, effects: GitEffect[], opts: { ageMs?: number; attempts?: number; data?: Record<string, unknown> } = {}): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_effects SET state='queued',attempts=$2,execution_token=NULL,claim_expires_at=NULL,error_code=NULL,
      outcome=NULL,data=data||$3::text::jsonb,updated_at=now()-($4::double precision*interval '1 millisecond') WHERE id=ANY($1::bigint[])`,
    [ids(effects), opts.attempts ?? 0, JSON.stringify(opts.data ?? {}), opts.ageMs ?? 0]);
    await tx.executeRaw(`UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=ANY($1::bigint[]) THEN now() ELSE now()+interval '1 hour' END`, [ids(effects)]);
  });
}
async function states(engine: BrainEngine, effects: GitEffect[]): Promise<Array<{ state: string; attempts: number }>> {
  return engine.executeRaw<{ state: string; attempts: number }>('SELECT state,attempts FROM persistence_effects WHERE id=ANY($1::bigint[]) ORDER BY id', [ids(effects)]);
}
const held = (count: number) => Array.from({ length: count }, () => ({ state: 'queued', attempts: 0 }));
/** The consumer's idle probe; `hasWork` is private because only the tick loop calls it. */
function idleProbe(engine: BrainEngine, ctx: OperationContext): () => Promise<boolean> {
  const consumer = new PersistenceConsumer(engine, ctx.config, async () => { throw new Error('the idle probe prepares nothing'); }, { hostId: localHostId() });
  return () => (consumer as unknown as { hasWork(): Promise<boolean> }).hasWork();
}
const slugsOf = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `notes/${prefix}-${String(i).padStart(3, '0')}`);

export async function freshGitEffectWaitsOutTheWindow(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(1, 'single');
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, slugs);
    const probe = idleProbe(engine, ctx);
    const before = commits(root);
    await queue(engine, effects);
    expect(await probe()).toBe(false);
    await pass(engine, ctx, { gitCoalesceMs: WINDOW_MS });
    expect(await states(engine, effects)).toEqual(held(1));
    expect(commits(root)).toBe(before);
    await queue(engine, effects, { ageMs: WINDOW_MS + 1000 });
    expect(await probe()).toBe(true);
    await pass(engine, ctx, { gitCoalesceMs: WINDOW_MS });
    expect(await states(engine, effects)).toEqual([{ state: 'committed', attempts: 1 }]);
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** `consumerHolds`: whether the consumer's idle probe, which always applies the window, still reports no work. */
export interface ClaimedAtOnceCase { name: string; window?: number; attempts?: number; data?: Record<string, unknown>; consumerHolds: boolean }
/** Every case is fresh (queued just now) and one pass claims it; a scan claims one page per pass, so claims are counted by attempts. */
export const claimedAtOnceCases: ClaimedAtOnceCase[] = [
  { name: 'a direct caller without a window claims a fresh Git effect at once', consumerHolds: true },
  { name: 'a retried Git effect keeps only its retry delay under the window', window: WINDOW_MS, attempts: 1, consumerHolds: false },
  { name: 'a source scan Git effect is never held by the window', window: WINDOW_MS, data: { source_scan: true }, consumerHolds: false },
  { name: 'a withdrawal walk Git effect is never held by the window', window: WINDOW_MS, data: { version: 2, targets: [] }, consumerHolds: false },
];
export async function gitEffectClaimedAtOnce(scenario: ClaimedAtOnceCase, databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(1, 'claimed');
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, slugs);
    await queue(engine, effects, { attempts: scenario.attempts, data: scenario.data });
    expect(await idleProbe(engine, ctx)()).toBe(!scenario.consumerHolds);
    await pass(engine, ctx, scenario.window === undefined ? {} : { gitCoalesceMs: scenario.window });
    expect((await states(engine, effects)).map(effect => effect.attempts)).toEqual([(scenario.attempts ?? 0) + 1]);
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** A writer that never pauses keeps adding fresh effects; the oldest still publishes once it ages, with every fresh sibling. */
export async function oldestGitEffectIsNotHeldByLaterWrites(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(5, 'continuous');
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const [oldest, ...later] = await gitEffects(engine, slugs);
    await queue(engine, [oldest, ...later]);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET updated_at=now()-interval '2 minutes' WHERE id=$1", [oldest.id]);
    });
    const before = commits(root);
    await pass(engine, ctx, { gitCoalesceMs: WINDOW_MS });
    expect(await states(engine, [oldest, ...later])).toEqual(slugs.map(() => ({ state: 'committed', attempts: 1 })));
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** A worktree holding a full batch publishes it at once, however fresh; one fewer stays held. */
export async function fullBatchIsNotHeld(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(GIT_BATCH_PATHS, 'batch');
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, slugs);
    const probe = idleProbe(engine, ctx);
    const before = commits(root);
    await queue(engine, effects.slice(0, -1));
    expect(await probe()).toBe(false);
    await pass(engine, ctx, { gitCoalesceMs: WINDOW_MS });
    expect(await states(engine, effects.slice(0, -1))).toEqual(held(GIT_BATCH_PATHS - 1));
    await queue(engine, effects);
    expect(await probe()).toBe(true);
    await pass(engine, ctx, { gitCoalesceMs: WINDOW_MS });
    expect(await states(engine, effects)).toEqual(slugs.map(() => ({ state: 'committed', attempts: 1 })));
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/**
 * A one-shot writer (a CLI put) stops its consumer well inside the window; the
 * stop publishes the held Git effect in one commit and one push instead of
 * leaving it queued for the next consumer.
 */
export async function stoppingConsumerPublishesHeldGitEffects(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(1, 'one-shot');
    const before = commits(root);
    for (const slug of slugs) await put(ctx, slug, `Body of ${slug}.`);
    const effects = await gitEffects(engine, slugs);
    expect(await states(engine, effects)).toEqual(held(1));
    await disposePersistenceConsumer(engine);
    expect(await states(engine, effects)).toEqual([{ state: 'committed', attempts: 1 }]);
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
    const remote = join(dirname(root), 'remote.git');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(remote, 'show', `refs/heads/main:${slugs[0]}.md`)).toContain(`Body of ${slugs[0]}.`);
  }, { databaseUrl, setup: ({ root }) => { remoteRepo(root); harden(root); } });
}

/**
 * A consumer stopped during a batch push leaves those claims running; once no
 * process holds them, they expire here instead of after their lease.
 */
async function expireRunningGitClaims(engine: BrainEngine): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_effects SET claim_expires_at=now()-interval '1 second' WHERE kind='git' AND state='running'");
  });
}

/**
 * The stop pass has its own time budget: while another push holds the push
 * lock, stop returns within the budget instead of waiting out the 5 s
 * push-lock timeout. The effect keeps its claim, as any halted batch does, and
 * publishes once lease recovery claims it again.
 */
export async function stopPassEndsWithinItsBudget(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(1, 'budget');
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    const pushLock = (await acquireNativeLock(`${binding.coordination_path}.push`, { timeoutMs: 0 }))!;
    expect(pushLock).not.toBeNull();
    const before = commits(root);
    let stopMs = Infinity;
    try {
      for (const slug of slugs) await put(ctx, slug, `Body of ${slug}.`);
      expect(await states(engine, await gitEffects(engine, slugs))).toEqual(held(1));
      const started = performance.now();
      await disposePersistenceConsumer(engine);
      stopMs = performance.now() - started;
    } finally { await pushLock.release(); }
    expect(stopMs).toBeLessThan(STOP_PASS_BUDGET_MS + 1500);
    const effects = await gitEffects(engine, slugs);
    expect(await states(engine, effects)).toEqual([{ state: 'running', attempts: 1 }]);
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(0);
    await expireRunningGitClaims(engine);
    await pass(engine, ctx);
    expect(await states(engine, effects)).toEqual([{ state: 'committed', attempts: 2 }]);
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
    const remote = join(dirname(root), 'remote.git');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
  }, { databaseUrl, setup: ({ root }) => { remoteRepo(root); harden(root); } });
}

/**
 * The stop pass publishes single-file Git effects only: an embedding effect and
 * an effect recovery on another worktree of the host, both due beside the
 * fresh Git effect, keep their state and attempts (no provider call or
 * recovery while the process shuts down).
 */
export async function stopPassClaimsOnlySingleFileGitEffects(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const [publishing, embedded, recovering] = ['notes/publishing', 'notes/embedded', 'notes/recovering'];
    await writeUnpublished(engine, ctx, root, [publishing, embedded, recovering].map(slug => [slug, `Body of ${slug}.`]));
    const [gitEffect] = await gitEffects(engine, [publishing]);
    const [recovery] = await gitEffects(engine, [recovering]);
    const [embedding] = await engine.executeRaw<GitEffect>(`SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE e.kind='embedding' AND r.slug=$1`, [embedded]);
    const second = (await getWorktreeBinding(engine, 'second', localHostId()))!;
    await queue(engine, []);
    // One tick while nothing is due starts the consumer's effects worker, so its stop runs the pass.
    const consumer = new PersistenceConsumer(engine, ctx.config, async () => { throw new Error('the stop pass prepares nothing'); }, { hostId: localHostId() });
    await consumer.tick();
    await (consumer as unknown as { effectsWorker?: Promise<void> }).effectsWorker;
    await queue(engine, [gitEffect, embedding, recovery]);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`UPDATE persistence_effects SET source_id=$2,source_incarnation=$3::uuid,worktree_id=$4::uuid,recovery='{}'::jsonb
        WHERE id=$1`, [recovery.id, second.source_id, second.source_incarnation, second.worktree_id]);
    });
    const before = commits(root);
    await consumer.stop();
    expect(await states(engine, [gitEffect])).toEqual([{ state: 'committed', attempts: 1 }]);
    expect(commits(root)).toBe(before + 1);
    expect(pushes(root)).toBe(1);
    expect(await states(engine, [embedding, recovery])).toEqual(held(2));
  }, { databaseUrl, setup: async ({ engine, root }) => {
    remoteRepo(root);
    const second = join(dirname(root), 'second'); mkdirSync(second);
    await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('second','second',$1)", [second]);
    await claimWorktree(engine, 'second', second);
  } });
}

/** Runs direct (unwindowed) passes until no Git effect is pending, waiting out retry delays. */
async function drainGitEffects(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await disposePersistenceConsumer(engine);
  await expireRunningGitClaims(engine);
  const deadline = Date.now() + 30_000;
  for (;;) {
    await pass(engine, ctx, { limit: 20 });
    const [pending] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE kind='git' AND state IN ('queued','running')");
    if (Number(pending.n) === 0) return;
    if (Date.now() > deadline) throw new Error(`${pending.n} Git effects still pending`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const commitPaths = (root: string, sha: string) => git(root, 'show', '--name-only', '--pretty=format:', sha).split('\n').filter(Boolean);

/**
 * #5530 regression: managed grandfathering of pages on a hardened worktree
 * whose remote push takes one second longer. Unfixed, every page waited for
 * the previous page's commit and push; now the step runs at database speed and
 * publishes a few batches.
 */
export async function grandfatherPublishesInBatches(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = slugsOf(8, 'grandfather');
    for (const slug of slugs) await put(ctx, slug, `Body of ${slug}.`);
    await drainGitEffects(engine, ctx);
    const base = git(root, 'rev-parse', 'HEAD').trim();
    const pushesBefore = pushes(root);
    writeFileSync(remoteFiles(root).slow, '');
    const started = performance.now();
    const { detail } = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
    const stepMs = performance.now() - started;
    const commitsDuringStep = commits(root) - Number(git(root, 'rev-list', '--count', base).trim());
    const pushesDuringStep = pushes(root) - pushesBefore;
    expect(detail).toMatchObject({ touched: slugs.length, failed: 0 });
    // Unfixed, the step took about one push delay (1 s) per page.
    expect(stepMs).toBeLessThanOrEqual(slugs.length * 1000 / 2);
    expect(commitsDuringStep).toBeLessThanOrEqual(1);
    expect(pushesDuringStep).toBeLessThanOrEqual(1);
    await drainGitEffects(engine, ctx);
    const made = git(root, 'rev-list', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean);
    expect(made.length).toBeGreaterThanOrEqual(1);
    expect(made.length).toBeLessThanOrEqual(2);
    // The first page's effect waits for its siblings instead of publishing alone.
    expect(commitPaths(root, made[0]).length).toBeGreaterThan(1);
    expect(made.flatMap(sha => commitPaths(root, sha)).sort()).toEqual(slugs.map(slug => `${slug}.md`));
    const remote = join(dirname(root), 'remote.git');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
    for (const slug of slugs) {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('validate: false');
      expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('validate: false');
      expect(git(remote, 'show', `refs/heads/main:${slug}.md`)).toContain('validate: false');
    }
  }, { databaseUrl, setup: ({ root }) => { remoteRepo(root); harden(root); } });
}

/**
 * Engine-parametrized scenarios for batched Git publication (#5530): one
 * worker pass commits every ready single-file Git effect of a worktree
 * together and pushes after releasing the worktree lock. PGLite runs them
 * from test/persistence-git-batch.test.ts; test/e2e/ runs the same bodies on
 * Postgres.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects, type EffectWorkerOptions } from '../../src/core/persistence/effects.ts';
import { publicEffectsForRequest } from '../../src/core/persistence/effect-journal.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { acquireWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { acquireNativeLock } from '../../src/core/persistence/native-lock.ts';
import { managedBrain } from './managed-brain.ts';
import { git } from './git-publication.ts';

type GitEffect = { id: number; request_id: string; slug: string; state: string; error_code: string | null;
  data: Record<string, unknown>; outcome: Record<string, unknown> | null };

/** Remote-side files: a push log with one `start`/`end` pair per receive-pack, a gate that holds pushes, a flag that rejects them. */
interface Remote { log: string; gate: string; reject: string }
const remoteFiles = (root: string): Remote => ({ log: join(dirname(root), 'pushes.log'), gate: join(dirname(root), 'push.gate'), reject: join(dirname(root), 'push.reject') });

/**
 * An unhardened repo with a tracking remote whose receive-pack logs, waits
 * while the gate exists and fails while the reject flag exists. Effects that
 * run before `harden` complete as durability_not_enabled and commit nothing.
 */
function remoteRepo(root: string, files: Record<string, string> = {}): void {
  const remote = join(dirname(root), 'remote.git');
  const { log, gate, reject } = remoteFiles(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const [name, content] of Object.entries({ 'README.md': 'Example brain\n', ...files })) writeFileSync(join(root, name), content);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'Initial');
  git(dirname(root), 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  const wrapper = join(dirname(root), 'receive-pack.sh');
  writeFileSync(wrapper, `#!/bin/sh\necho start >> '${log}'\nwhile [ -e '${gate}' ]; do sleep 0.02; done\n`
    + `if [ -e '${reject}' ]; then echo end >> '${log}'; exit 1; fi\ngit receive-pack "$@"\ncode=$?\necho end >> '${log}'\nexit $code\n`);
  chmodSync(wrapper, 0o755);
  git(root, 'config', 'remote.origin.receivepack', wrapper);
}
function harden(root: string): void {
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 99\n');
  chmodSync(hook, 0o755);
}
const pushLog = (root: string) => existsSync(remoteFiles(root).log) ? readFileSync(remoteFiles(root).log, 'utf8').split('\n').filter(Boolean) : [];
const pushes = (root: string) => pushLog(root).filter(line => line === 'start').length;
const commits = (root: string) => Number(git(root, 'rev-list', '--count', 'HEAD').trim());
const headPaths = (root: string) => git(root, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean).sort();
const remoteHead = (root: string) => git(join(dirname(root), 'remote.git'), 'rev-parse', 'refs/heads/main');
const remotePaths = (root: string) => git(join(dirname(root), 'remote.git'), 'ls-tree', '-r', '--name-only', 'refs/heads/main').split('\n').filter(Boolean);

async function put(ctx: OperationContext, slug: string, body: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`, ...(current ? { expected_revision: current.revision } : {}) } });
}
async function gitEffects(engine: BrainEngine, slugs: string[]): Promise<GitEffect[]> {
  return engine.executeRaw<GitEffect>(`SELECT e.id,e.request_id::text AS request_id,r.slug,e.state,e.error_code,e.data,e.outcome
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.kind='git' AND r.slug=ANY($1::text[]) ORDER BY e.id`, [slugs]);
}
const ids = (effects: GitEffect[]) => effects.map(effect => Number(effect.id));
/** Makes exactly these effects due; `fresh` also forgets their prior attempts and outcomes. */
async function due(engine: BrainEngine, effects: GitEffect[], fresh = false): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    if (fresh) await tx.executeRaw(`UPDATE persistence_effects SET state='queued',attempts=0,execution_token=NULL,claim_expires_at=NULL,
      error_code=NULL,outcome=NULL,data=data-'target_failures'-'failing_target' WHERE id=ANY($1::bigint[])`, [ids(effects)]);
    await tx.executeRaw(`UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=ANY($1::bigint[]) THEN now() ELSE now()+interval '1 hour' END`, [ids(effects)]);
  });
}
/** Writes pages (and any further mutations) while the repo is not hardened, then hardens it: their Git effects committed nothing. */
async function writeUnpublished(engine: BrainEngine, ctx: OperationContext, root: string, pages: Array<[slug: string, body: string]>,
  more?: () => Promise<unknown>): Promise<void> {
  for (const [slug, body] of pages) await put(ctx, slug, body);
  await more?.();
  await disposePersistenceConsumer(engine);
  harden(root);
}
const pass = (engine: BrainEngine, ctx: OperationContext, opts: Partial<EffectWorkerOptions> = {}) =>
  runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1, ...opts });
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const pagePaths = (slugs: string[]) => slugs.map(slug => `${slug}.md`).sort();

export async function oneCommitAndOnePushForReadyEffects(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = Array.from({ length: 4 }, (_, i) => `notes/page-${i}`);
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    writeFileSync(join(root, 'staged.md'), 'Unrelated staged change\n'); git(root, 'add', 'staged.md');
    writeFileSync(join(root, 'README.md'), 'Unrelated worktree change\n');
    const effects = await gitEffects(engine, slugs);
    expect(effects).toHaveLength(slugs.length);
    await due(engine, effects, true);
    const before = commits(root);
    await pass(engine, ctx);
    expect(commits(root)).toBe(before + 1);
    expect(headPaths(root)).toEqual(pagePaths(slugs));
    expect(pushes(root)).toBe(1);
    expect(remoteHead(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('staged.md\n');
    expect(git(root, 'diff', '--name-only')).toBe('README.md\n');
    for (const effect of await gitEffects(engine, slugs)) {
      expect(effect).toMatchObject({ state: 'committed', error_code: null, outcome: { git: 'committed', push: 'committed' } });
      expect(await publicEffectsForRequest(engine, effect.request_id)).toContainEqual({ kind: 'git', state: 'committed', push: 'committed' });
    }
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

export async function pushRunsAfterTheWorktreeLockIsReleased(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = ['notes/first', 'notes/second'];
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, slugs);
    await due(engine, effects, true);
    const { gate } = remoteFiles(root);
    writeFileSync(gate, '');
    const running = pass(engine, ctx);
    try {
      await until(() => pushes(root) === 1, 'the batch push to reach the remote');
      const lock = await acquireWorktree((await getWorktreeBinding(engine, 'default', localHostId()))!, 0, undefined, engine);
      expect(lock).not.toBeNull();
      await lock!.release();
      // A publication on the same worktree commits while the push is still held.
      const receipt = await put(ctx, 'notes/during-push', 'Written while the push is in flight.');
      expect(receipt).toMatchObject({ state: 'committed' });
      expect(pushLog(root)).toEqual(['start']);
    } finally {
      rmSync(gate, { force: true });
      await running;
      await disposePersistenceConsumer(engine);
    }
    for (const effect of await gitEffects(engine, slugs)) {
      expect(effect).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
    }
    expect(remotePaths(root)).toEqual(expect.arrayContaining(pagePaths(slugs)));
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

export async function eachEffectKeepsItsOwnOutcome(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await writeUnpublished(engine, ctx, root, [
      ['notes/twice', 'First version.'], ['notes/twice', 'Second version.'],
      ['conversations/chat', 'Kept in the database only.'],
      ['notes/gone', 'Deleted before publication.'],
      ['aa/unsafe', 'Ignored by Git.'],
      ['notes/good-1', 'Publishes.'], ['notes/good-2', 'Publishes too.'],
    ], async () => {
      const gone = (await engine.readPageSnapshot('notes/gone', { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/gone', request_id: randomUUID(), expected_revision: gone.revision, purge: true } });
    });
    expect(existsSync(join(root, 'notes', 'gone.md'))).toBe(false);
    const slugs = ['notes/twice', 'conversations/chat', 'notes/gone', 'aa/unsafe', 'notes/good-1', 'notes/good-2'];
    const effects = await gitEffects(engine, slugs);
    await due(engine, effects, true);
    const before = commits(root);
    await pass(engine, ctx);
    expect(commits(root)).toBe(before + 1);
    expect(headPaths(root)).toEqual(pagePaths(['notes/good-1', 'notes/good-2', 'notes/twice']));
    const settled = await gitEffects(engine, slugs);
    const outcomes = settled.map(effect => [effect.slug, effect.state, effect.error_code, effect.outcome]);
    expect(outcomes).toEqual([
      ['notes/twice', 'committed', null, { git: 'superseded' }],
      ['notes/twice', 'committed', null, { git: 'committed', push: 'committed' }],
      ['conversations/chat', 'committed', null, { git: 'skipped', reason: 'db_only' }],
      ['notes/gone', 'committed', null, { git: 'superseded' }],
      ['aa/unsafe', 'queued', 'git_target_unsafe', null],
      ['notes/good-1', 'committed', null, { git: 'committed', push: 'committed' }],
      ['notes/good-2', 'committed', null, { git: 'committed', push: 'committed' }],
      ['notes/gone', 'committed', null, { git: 'skipped', reason: 'target_absent', push: 'skipped' }],
    ]);
    const unsafe = settled.filter(effect => effect.slug === 'aa/unsafe');
    expect(unsafe[0].data).toMatchObject({ target_failures: 1, failing_target: 'aa/unsafe' });
    const head = git(root, 'rev-parse', 'HEAD');
    for (let attempt = 2; attempt <= 5; attempt++) { await due(engine, unsafe); await pass(engine, ctx); }
    expect((await gitEffects(engine, ['aa/unsafe']))[0]).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'aa/unsafe', error_code: 'git_target_unsafe' }] } });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect((await gitEffects(engine, slugs)).filter(effect => effect.slug !== 'aa/unsafe').map(effect => effect.state))
      .toEqual(Array(settled.length - 1).fill('committed'));
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root, { '.gitignore': 'aa/\nconversations/\n', 'gbrain.yml': 'storage:\n  db_only:\n    - conversations/\n' }) });
}

export async function pushFailureKeepsTheCommitAndRetriesWithoutAnother(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = ['notes/first', 'notes/second', 'notes/third'];
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, slugs);
    await due(engine, effects, true);
    const { reject } = remoteFiles(root);
    const remoteBefore = remoteHead(root);
    const before = commits(root);
    writeFileSync(reject, '');
    await pass(engine, ctx);
    expect(commits(root)).toBe(before + 1);
    expect(headPaths(root)).toEqual(pagePaths(slugs));
    expect(remoteHead(root)).toBe(remoteBefore);
    for (const effect of await gitEffects(engine, slugs)) {
      expect(effect).toMatchObject({ state: 'queued', error_code: 'git_push_unavailable', outcome: null });
      expect(await publicEffectsForRequest(engine, effect.request_id)).toContainEqual({ kind: 'git', state: 'queued', reason: 'git_push_unavailable' });
    }
    rmSync(reject);
    const head = git(root, 'rev-parse', 'HEAD');
    await due(engine, effects);
    await pass(engine, ctx);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(remoteHead(root)).toBe(head);
    for (const effect of await gitEffects(engine, slugs)) {
      expect(effect).toMatchObject({ state: 'committed', error_code: null, outcome: { git: 'unchanged', push: 'committed' } });
    }
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** Stops a pass at each Git boundary, leaves its claims as a dead process would, and resumes. */
export async function crashAtEveryGitBoundaryResumesWithoutDuplicates(databaseUrl?: string) {
  const boundaries = ['before_git_commit', 'after_git_commit', 'after_git_push'] as const;
  await managedBrain(async ({ engine, ctx, root }) => {
    const groups = boundaries.map(boundary => [0, 1, 2].map(i => `notes/${boundary.replaceAll('_', '-')}-${i}`));
    await writeUnpublished(engine, ctx, root, groups.flat().map(slug => [slug, `Body of ${slug}.`]));
    for (const [index, boundary] of boundaries.entries()) {
      const slugs = groups[index];
      const effects = await gitEffects(engine, slugs);
      await due(engine, effects, true);
      const before = commits(root);
      let stopped = false;
      await pass(engine, ctx, { boundary: async name => { if (name === boundary) { stopped = true; throw new Error('process ended'); } } });
      expect(stopped).toBe(true);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_effects SET state='running',execution_token=gen_random_uuid(),claim_expires_at=now()-interval '1 second',
          error_code=NULL,outcome=NULL,data=data-'target_failures'-'failing_target' WHERE id=ANY($1::bigint[])`, [ids(effects)]);
      });
      await due(engine, effects);
      await pass(engine, ctx);
      expect(commits(root)).toBe(before + 1);
      expect(headPaths(root)).toEqual(pagePaths(slugs));
      expect(remoteHead(root)).toBe(git(root, 'rev-parse', 'HEAD'));
      const replayed = boundary === 'before_git_commit' ? 'committed' : 'unchanged';
      for (const effect of await gitEffects(engine, slugs)) {
        expect([boundary, effect.state, effect.outcome]).toEqual([boundary, 'committed', { git: replayed, push: 'committed' }]);
      }
    }
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** Two passes reach their push together: the second waits for the first instead of racing it on the same ref. */
export async function concurrentPushesOnOneWorktreeNeverOverlap(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const first = ['notes/a-0', 'notes/a-1', 'notes/a-2'];
    const second = ['notes/b-0', 'notes/b-1', 'notes/b-2'];
    await writeUnpublished(engine, ctx, root, [...first, ...second].map(slug => [slug, `Body of ${slug}.`]));
    const effects = await gitEffects(engine, [...first, ...second]);
    await due(engine, effects, true);
    await due(engine, await gitEffects(engine, first));
    const { gate } = remoteFiles(root);
    writeFileSync(gate, '');
    const passes: Promise<void>[] = [];
    try {
      passes.push(pass(engine, ctx));
      await until(() => pushes(root) === 1, 'the first push to reach the remote');
      await due(engine, await gitEffects(engine, second));
      let committed = false;
      passes.push(pass(engine, ctx, { boundary: async name => { if (name === 'after_git_commit') committed = true; } }));
      await until(() => committed, 'the second pass to commit');
      // The second pass is now at its push step; give an unserialized push time to start.
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
      rmSync(gate, { force: true });
      await Promise.all(passes);
    }
    expect(pushLog(root)).toEqual(['start', 'end', 'start', 'end']);
    expect(remoteHead(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(remotePaths(root)).toEqual(expect.arrayContaining(pagePaths([...first, ...second])));
    for (const effect of await gitEffects(engine, [...first, ...second])) {
      expect(effect).toMatchObject({ state: 'committed', error_code: null, outcome: { git: 'committed', push: 'committed' } });
    }
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

/** A walk page pushes under the same push lock as a batch, so it never races a batch push of the same ref. */
export async function walkPushWaitsForThePushLock(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await writeUnpublished(engine, ctx, root, [['notes/scanned', 'Body of the scanned page.']]);
    const [effect] = await gitEffects(engine, ['notes/scanned']);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb WHERE id=$1`, [effect.id]);
    });
    await due(engine, [effect], true);
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    const held = (await acquireNativeLock(`${binding.coordination_path}.push`, { timeoutMs: 0 }))!;
    expect(held).not.toBeNull();
    const before = commits(root);
    // The whole pass runs while another push holds the lock.
    try { await pass(engine, ctx); } finally { await held.release(); }
    expect(commits(root)).toBe(before + 1);
    expect(headPaths(root)).toEqual(['notes/scanned.md']);
    expect(pushes(root)).toBe(0);
    expect((await gitEffects(engine, ['notes/scanned']))[0]).toMatchObject({ state: 'queued', error_code: 'writer_busy' });
    await due(engine, [effect]);
    await pass(engine, ctx);
    expect(commits(root)).toBe(before + 1);
    expect(pushLog(root)).toEqual(['start', 'end']);
    expect(remoteHead(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await gitEffects(engine, ['notes/scanned']))[0]).toMatchObject({ error_code: null, data: { source_scan: true, after_slug: 'notes/scanned' } });
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

export interface SettleFailureCase {
  name: string;
  /** Codes the database refuses the first entries to settle with, one per entry, in settle order. */
  refused: string[];
  /** The worker stops right after the push. */
  abort?: boolean;
  /** Entries whose settle reaches the database. */
  attempts: number;
}
/**
 * Once the batch push is done the database refuses some entries' writes. An
 * entry-specific refusal leaves its siblings settled; a database outage or a
 * stopping worker ends settling at once, and the unsettled entries keep their
 * claims for lease recovery.
 */
export const settleFailureCases: SettleFailureCase[] = [
  { name: 'a refusal of one entry leaves its siblings settled and surfaces the refusal', refused: ['23514'], attempts: 3 },
  { name: 'refusals of two entries surface as one error carrying the first code', refused: ['23514', '23505'], attempts: 3 },
  { name: 'a database outage on one entry stops the remaining settles', refused: ['ECONNREFUSED'], attempts: 1 },
  { name: 'a stopping worker settles nothing after the push', refused: [], abort: true, attempts: 0 },
];
export async function settleFailureInABatch(scenario: SettleFailureCase, databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = ['notes/first', 'notes/second', 'notes/third'];
    await writeUnpublished(engine, ctx, root, slugs.map(slug => [slug, `Body of ${slug}.`]));
    await due(engine, await gitEffects(engine, slugs), true);
    let armed = false;
    // Effect ids in the order their settle first reached the database.
    const attempted: number[] = [];
    const refusals = scenario.refused.map(code => Object.assign(new Error(`database refused (${code})`), { code }));
    const flaky = new Proxy(engine, { get(target, prop) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[], ...rest: unknown[]) => {
        if (armed && /^\s*UPDATE persistence_effects/.test(sql)) {
          const id = Number(params?.[0]);
          if (!attempted.includes(id)) attempted.push(id);
          const refusal = refusals[attempted.indexOf(id)];
          if (refusal) return Promise.reject(refusal);
        }
        return (target.executeRaw as (...args: unknown[]) => Promise<unknown>)(sql, params, ...rest);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine;
    const stop = new AbortController();
    const outcome = await runPersistenceEffects(flaky, ctx.config, { hostId: localHostId(), limit: 1, signal: stop.signal,
      boundary: async name => { if (name === 'after_git_push') { armed = true; if (scenario.abort) stop.abort(); } } }).then(() => undefined, error => error);
    if (refusals.length > 1) {
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(outcome).toMatchObject({ code: refusals[0].code, errors: refusals });
    } else expect(outcome).toBe(refusals[0]);
    expect(pushes(root)).toBe(1);
    expect(attempted).toHaveLength(scenario.attempts);
    const settled = await gitEffects(engine, slugs);
    const committed = (id: number) => attempted.indexOf(id) >= refusals.length;
    expect(settled.filter(effect => committed(Number(effect.id)))).toHaveLength(scenario.attempts - refusals.length);
    expect(settled.map(effect => [effect.state, effect.outcome])).toEqual(settled.map(effect =>
      committed(Number(effect.id)) ? ['committed', { git: 'committed', push: 'committed' }] : ['running', null]));
  }, { databaseUrl, setup: ({ root }) => remoteRepo(root) });
}

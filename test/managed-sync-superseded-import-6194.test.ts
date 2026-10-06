import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import type { SyncOpts, SyncResult } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { finishUnpublishedFailure } from '../src/core/persistence/coordinator.ts';
import { readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { loadSyncFailures, syncFailuresPath } from '../src/core/sync-failure-ledger.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// #6194: a managed sync freezes a page import at revision R. A coordinated page
// write then commits R+1 and publishes its canonical file before that import
// publishes. The import can never match R again, and its refusal used to block
// the cursor on every later run until `--retry-failed`, although the working
// tree already held the newer page.

const home = mkdtempSync(join(tmpdir(), 'gbrain-6194-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string): string => {
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  return git(root, 'rev-parse', 'HEAD');
};
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => {
  for (const engine of engines) { try { await fn(engine); } finally { installFaultHook(undefined); rmSync(syncFailuresPath(), { force: true }); } }
});

const ALICE = 'people/alice-example';
const NEWER = 'The newest observation, committed while the sync held this page.';
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A managed Git source whose pages are imported, with one more commit for the next sync to import. */
async function fixture(engine: BrainEngine, others: string[] = []) {
  const id = `s-${randomUUID().slice(0, 12)}`, root = join(home, id);
  const file = (slug: string) => join(root, `${slug}.md`);
  mkdirSync(root); git(root, 'init', '-q');
  for (const slug of [ALICE, ...others]) { mkdirSync(dirname(file(slug)), { recursive: true }); writeFileSync(file(slug), note(slug, `The first observation of ${slug}.`)); }
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const opts: SyncOpts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] };
  expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
  // The page's own coordinated write reaches Git, so the next sync enumerates a file that already is the page.
  await put(engine, id, 'The second observation, written through the coordinator.');
  for (const slug of others) writeFileSync(file(slug), note(slug, `An edited observation of ${slug}.`));
  return { id, root, opts, path: file(ALICE), target: commit(root) };
}

/** An ordinary coordinated `put_page` of the page: it commits a new revision and publishes the canonical file. */
async function put(engine: BrainEngine, sourceId: string, body: string): Promise<void> {
  const ctx = { engine, sourceId, remote: false as const, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: ALICE, request_id: randomUUID(), content: note(ALICE, body),
    expected_revision: (await engine.readPageSnapshot(ALICE, { sourceId }))!.revision } });
  expect(receipt.write_through).toMatchObject({ written: true });
}

/** Runs `write` once, when the source's cursor first holds the frozen, not yet admitted entry of the page. */
function whenFrozen(engine: BrainEngine, sourceId: string, write: () => Promise<void>): void {
  let ran = false;
  installFaultHook(async (point, detail) => {
    if (ran || point !== 'sync:mid_checkpoint' || detail.sourceId !== sourceId) return;
    const [held] = await engine.executeRaw<{ slug: string | null }>(
      "SELECT completed_keys->0->'pending'->>'slug' AS slug FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
    if (held?.slug !== ALICE) return;
    ran = true;
    await write();
  });
}

/** Resumes a run that only ran out of its wait for the writer. */
async function sync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  let result = await performManagedSync(engine, opts, slice);
  for (let i = 0; i < 10 && result.status === 'partial' && result.reason === 'writer_pending'; i++) result = await performManagedSync(engine, opts, slice);
  return result;
}
const body = async (engine: BrainEngine, id: string) => (await engine.getPage(ALICE, { sourceId: id }))?.compiled_truth;
const lastCommit = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0].last_commit;
const uncommitted = (engine: BrainEngine, id: string) => engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(
  "SELECT slug,state,error_code FROM persistence_requests WHERE source_id=$1 AND state<>'committed' ORDER BY sequence", [id]);

/** The source finished its run at `target`, kept the newer page and its file, and no later sync is blocked. */
async function expectSuperseded(engine: BrainEngine, f: Fixture, result: SyncResult, published: string) {
  expect(result).toMatchObject({ status: 'synced', toCommit: f.target });
  expect(result.managedWrite).toBeUndefined();
  expect(await body(engine, f.id)).toContain(NEWER);
  expect(readFileSync(f.path, 'utf8')).toBe(published);
  expect(await lastCommit(engine, f.id)).toBe(f.target);
  expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
  expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
  expect((await sync(engine, f.opts)).status).toBe('up_to_date');
  // The commit that carries the newer bytes then imports as the no-op it is.
  commit(f.root);
  expect(await sync(engine, f.opts)).toMatchObject({ status: 'synced', added: 0, modified: 0, deleted: 0 });
  expect(await body(engine, f.id)).toContain(NEWER);
}

test('#6194 a coordinated write that publishes a newer revision of a frozen import supersedes it instead of blocking the cursor', () => each(async engine => {
  const f = await fixture(engine);
  let published = '';
  whenFrozen(engine, f.id, async () => { await put(engine, f.id, NEWER); published = readFileSync(f.path, 'utf8'); });
  const result = await sync(engine, f.opts);
  expect(published).toContain(NEWER);
  expect(result).toMatchObject({ status: 'synced', added: 0, modified: 0, deleted: 0 });
  // The refused request keeps its receipt; nothing else of the run failed.
  expect(await uncommitted(engine, f.id)).toEqual([{ slug: ALICE, state: 'conflict', error_code: 'revision_conflict' }]);
  const [refused] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND state='conflict'", [f.id]);
  expect(result.converted_from_failed).toEqual([refused!.request_id]);
  expect((await readGitHoldStatuses(engine, [f.id])).get(f.id)).toMatchObject({
    recent_conversions: [{ request_id: refused!.request_id, path: `${ALICE}.md`, outcome: 'refrozen' }] });
  await expectSuperseded(engine, f, result, published);
}), 180_000);

test('#6194 a cursor an earlier run left blocked completes once the working tree holds the newer page', () => each(async engine => {
  const f = await fixture(engine);
  let published = '';
  whenFrozen(engine, f.id, async () => {
    await put(engine, f.id, NEWER); published = readFileSync(f.path, 'utf8');
    writeFileSync(f.path, note(ALICE, 'A local edit that nothing imported.'));
  });
  expect((await sync(engine, f.opts)).status).toBe('blocked_by_failures');
  expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(1);
  writeFileSync(f.path, published);
  await expectSuperseded(engine, f, await sync(engine, f.opts), published);
}), 180_000);

test('#6194 a coordinated write between enumeration and freeze supersedes the enumerated import', () => each(async engine => {
  const f = await fixture(engine, ['a-first']);
  expect(await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 60_000 })).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 1 });
  await put(engine, f.id, NEWER);
  const published = readFileSync(f.path, 'utf8');
  const result = await sync(engine, f.opts);
  expect(await uncommitted(engine, f.id)).toEqual([]);
  expect(result).toMatchObject({ added: 0, modified: 1, deleted: 0 });
  await expectSuperseded(engine, f, result, published);
}), 180_000);

test('#6194 a bulk group whose head was superseded publishes its other pages', () => each(async engine => {
  const f = await fixture(engine, ['people/bob-example', 'people/carol-example']);
  let published = '';
  whenFrozen(engine, f.id, async () => { await put(engine, f.id, NEWER); published = readFileSync(f.path, 'utf8'); });
  const groups: number[] = [];
  const result = await sync(engine, { ...f.opts, bulk: { enabled: true, reason: null, size: 4, maxTxnMs: 15_000 },
    onProgress: p => { if (p.phase === 'managed_sync.group') groups.push(p.group!); } });
  expect(groups[0]).toBe(3);
  expect(result.converted_from_failed).toHaveLength(1);
  // How the other members of the refused group ended depends on the engine's claim (cancelled, or published one by one); their pages are imported either way.
  for (const slug of ['people/bob-example', 'people/carol-example']) expect((await engine.getPage(slug, { sourceId: f.id }))?.compiled_truth).toContain('An edited observation');
  await expectSuperseded(engine, f, result, published);
}), 180_000);

test.each([
  ['a newer page whose bytes never reached the working tree', async (engine: BrainEngine, f: Fixture) => {
    const page = (await engine.getPage(ALICE, { sourceId: f.id }))!;
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage(ALICE, { type: page.type, title: page.title, compiled_truth: NEWER,
      timeline: '', frontmatter: {}, content_hash: 'newer' }, { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
  }],
  ['a local edit over the newer published file', async (engine: BrainEngine, f: Fixture) => {
    await put(engine, f.id, NEWER);
    writeFileSync(f.path, note(ALICE, 'A local edit that nothing imported.'));
  }],
  // The page was written through the coordinator, but the file holds the older bytes again: importing them would undo the write.
  ['a newer coordinated write whose file was put back to the older bytes', async (engine: BrainEngine, f: Fixture) => {
    const older = readFileSync(f.path);
    await put(engine, f.id, NEWER);
    writeFileSync(f.path, older);
  }],
  // The working tree holds the newer page, but another sync cursor imported it: the enumerated entry keeps its pinned identity (#5522).
  ['a newer page another sync cursor imported from the working tree', async (engine: BrainEngine, f: Fixture) => {
    writeFileSync(f.path, note(ALICE, NEWER));
    expect(await sync(engine, { ...f.opts, workingTree: true }, { maxPages: 1, maxMs: 60_000 })).toMatchObject({ status: 'partial', reason: 'writer_yield' });
  }],
])('#6194 %s still blocks the frozen import', (_name, write) => each(async engine => {
  const f = await fixture(engine);
  const before = await lastCommit(engine, f.id);
  let bytes = '';
  whenFrozen(engine, f.id, async () => { await write(engine, f); bytes = readFileSync(f.path, 'utf8'); });
  const blocked = await sync(engine, f.opts);
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { slug: ALICE, write_error: 'revision_conflict' } });
  const refused = blocked.managedWrite!.write_request.request_id;
  // Neither copy is overwritten, and the same refusal answers the next run.
  expect(await body(engine, f.id)).toContain(NEWER);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(await sync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_request: { request_id: refused } } });
  expect(await uncommitted(engine, f.id)).toEqual([{ slug: ALICE, state: 'conflict', error_code: 'revision_conflict' }]);
  expect(await lastCommit(engine, f.id)).toBe(before);
}), 180_000);


test('#6194 a revision_conflict refusal whose page did not move stays blocked under its request', () => each(async engine => {
  const f = await fixture(engine);
  writeFileSync(f.path, note(ALICE, 'A committed edit that sync has yet to import.')); commit(f.root);
  // The import is admitted while the worktree is held, then refused for a cause other than a newer page.
  await disposePersistenceConsumer(engine);
  const lock = (await acquireWorktree((await getWorktreeBinding(engine, f.id))!))!;
  let refused = '';
  try {
    const pending = await performManagedSync(engine, f.opts);
    expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    refused = pending.managedWrite!.write_request.request_id;
    await disposePersistenceConsumer(engine);
    let claimed = await claimNextWrite(engine, localHostId());
    for (let i = 0; i < 100 && !claimed; i++) { await new Promise(resolve => setTimeout(resolve, 50)); claimed = await claimNextWrite(engine, localHostId()); }
    expect(claimed?.request_id).toBe(refused);
    await finishUnpublishedFailure(engine, claimed!, new OperationError('revision_conflict', 'The accepted sync cursor changed before publication.'));
  } finally { await lock.release(); }
  // A re-freeze would mint a new request on every run; the page did not move, so the same refusal answers each one.
  for (let run = 0; run < 2; run++) {
    expect(await sync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'revision_conflict', write_request: { request_id: refused } } });
  }
  expect(await uncommitted(engine, f.id)).toEqual([{ slug: ALICE, state: 'conflict', error_code: 'revision_conflict' }]);
  expect(await body(engine, f.id)).toContain('The second observation');
}), 180_000);

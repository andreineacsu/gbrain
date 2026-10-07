/**
 * A bulk managed-sync group whose head ends without committing while members
 * after it, or the group admitted ahead of it, commit: the head cancelled
 * while queued (`cancel_write_request`), or settled on its own before its
 * followers published. Every page that committed is counted by the run that
 * wrote it, once, and the cursor passes its entry without freezing it again.
 * Runs on PGLite and, with DATABASE_URL, on Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { prepareManagedSyncMutation } from '../src/core/persistence/sync-prepare.ts';
import { finishUnpublishedFailure, publishMutation } from '../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-group-tail-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const BULK = { enabled: true, reason: null, size: 4, maxTxnMs: 15_000 };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
const note = (title: string, body = 'A synthetic observation.') => `---\ntitle: ${title}\n---\n${body}\n`;
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const take = (n: number, claim = 'Synthetic take') => `| ${n} | ${claim} | take | brain | 0.7 | 2026-01 | chat |`;
const takesPage = (title: string, ...rows: string[]) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${T}\n${TH}\n${rows.join('\n')}\n${TE}\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (run: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => {
  for (const engine of engines) { try { await run(engine); } finally { await disposePersistenceConsumer(engine); } }
});

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `tail-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  return { id, root, write, sync };
}
type Source = Awaited<ReturnType<typeof source>>;

/**
 * Admits the next run's first bulk group (and, with `drain`, the group admitted
 * ahead of it) while the worktree lock keeps the consumer from publishing,
 * stops the consumer, and settles the group's head with `settle` while every
 * member is still queued. A later consumer then publishes the members after the head.
 */
async function stageGroup(engine: BrainEngine, s: Source, settle: (head: WriteRequest) => Promise<void>, drain = false): Promise<WriteRequest[]> {
  const lock = (await acquireWorktree((await getWorktreeBinding(engine, s.id))!))!;
  const stop = new AbortController();
  try {
    expect(await s.sync({ bulk: BULK, ...(drain ? { drainStartedAt: Date.now(), signal: stop.signal,
      onProgress: p => { if (p.phase === 'managed_sync.group_ahead') stop.abort(); } } : {}) })).toMatchObject({ status: 'partial', reason: drain ? 'timeout' : 'writer_pending' });
  } finally { await disposePersistenceConsumer(engine); await lock.release(); }
  const members = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent ? 'group' ORDER BY sequence", [s.id]);
  expect(members.map(member => member.state)).toEqual(Array(drain ? 8 : 4).fill('queued'));
  await settle(members[0]!);
  return members;
}
/** The run's page_committed progress events: what a drain counts as written. */
const written = (events: Array<{ phase: string; waived?: boolean }>) => events.filter(event => event.phase === 'managed_sync.page_committed' && !event.waived).length;
const states = async (engine: BrainEngine, members: WriteRequest[]) => (await engine.executeRaw<{ state: string }>(
  'SELECT state FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [members.map(member => member.id)])).map(row => row.state);

test('a group head cancelled while queued: the run counts the members that published after it, and the retry does not count them again', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'notes/c.md': note('C'), 'notes/d.md': note('D') });
  const members = await stageGroup(engine, s, async head => {
    expect(await cancelWriteRequest(engine, requestPrincipal(head), head.request_id)).toMatchObject({ state: 'cancelled' });
  });
  const events: Array<{ phase: string; waived?: boolean }> = [];
  const blocked = await s.sync({ bulk: BULK, onProgress: event => events.push(event) });
  // The journal: the cancelled head, and three pages this run wrote.
  expect(await states(engine, members)).toEqual(['cancelled', 'committed', 'committed', 'committed']);
  for (const slug of ['notes/b', 'notes/c', 'notes/d']) expect(await engine.getPage(slug, { sourceId: s.id })).not.toBeNull();
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', added: 3, modified: 0, managedWrite: { slug: 'notes/a' } });
  expect(written(events)).toBe(3);
  // The retry discovers again: it imports the cancelled page; the three written pages change nothing.
  expect(await s.sync({ bulk: BULK, retryFailed: true })).toMatchObject({ status: 'first_sync', added: 1, modified: 0 });
  expect(await engine.getPage('notes/a', { sourceId: s.id })).not.toBeNull();
}), 180_000);

const published = (engine: BrainEngine, members: WriteRequest[], count: number) => {
  startPersistenceConsumer(engine, { engine: engine.kind }).wake();
  return waitFor(async () => (await states(engine, members)).filter(state => state === 'committed').length === count, { timeoutMs: 60_000, label: `${count} pages published` });
};

test.each([
  // The followers publish while the run waits on the group, so the group step drops it; the second member never publishes.
  ['during the run', true],
  // An earlier run ended while the group published: the start-of-run conversion finds the failed head with its followers committed.
  ['before the run', false],
] as const)('a group head held after members behind it committed %s: the cursor passes their entries and counts each once', (_when, cancelSecond) => each(async engine => {
  const s = await source(engine, { 'people/probe.md': takesPage('Probe', take(1)), 'zz/z1.md': note('Z1') });
  expect((await s.sync()).status).toBe('first_sync');
  // One group in manifest order: the probe, a new page, an edited page, a new page.
  s.write('people/probe.md', takesPage('Probe', take(1), take(2, 'Incoming take')));
  s.write('zz/z0.md', note('Z0'));
  s.write('zz/z1.md', note('Z1', 'An edited observation.'));
  s.write('zz/z2.md', note('Z2'));
  commit(s.root);
  const members = await stageGroup(engine, s, async head => {
    // A database-only take added after admission makes the probe collide at preparation, a fence refusal the run holds in place (#6188).
    await engine.transaction(tx => withCoordinatedWrite(tx, [s.id], () => tx.executeRaw(
      "INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) SELECT id,2,'Database-only take','take','brain',0.5 FROM pages WHERE source_id=$1 AND slug='people/probe'", [s.id]),
    TEST_WRITE_ATTRIBUTION));
    // The consumer's single path for the head alone: claim, prepare, publish or record the refusal.
    const claimed = (await claimNextWrite(engine, localHostId()))!;
    expect(claimed.id).toBe(head.id);
    const done = await prepareManagedSyncMutation(engine, claimed, { engine: engine.kind })
      .then(prepared => publishMutation(engine, claimed, prepared, localHostId()), error => finishUnpublishedFailure(engine, claimed, error, 'preparation'));
    expect(done).toMatchObject({ state: 'failed', error_code: 'take_row_collision' });
    if (!cancelSecond) return;
    // The second member never publishes, so the cursor freezes it again, right before the edited page this run already wrote.
    const second = (await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='zz/z0.md'", [s.id]))[0]!;
    expect(await cancelWriteRequest(engine, requestPrincipal(second), second.request_id)).toMatchObject({ state: 'cancelled' });
  });
  if (!cancelSecond) await published(engine, members, 3);
  const result = await s.sync({ bulk: BULK });
  expect(await states(engine, members)).toEqual(['failed', cancelSecond ? 'cancelled' : 'committed', 'committed', 'committed']);
  expect(result).toMatchObject({ status: 'synced', added: 2, modified: 1, held_count: 1, waived: { imports: 0, deletes: 0 } });
  expect(result.held![0]).toMatchObject({ path: 'people/probe.md', reason: 'prepare_time' });
  // The pages the group wrote keep the one request that wrote them; a cancelled page committed on a new one.
  const requests = await engine.executeRaw<{ path: string; states: string }>(`SELECT intent->>'path' AS path,string_agg(state,',' ORDER BY sequence) AS states
    FROM persistence_requests WHERE source_id=$1 AND intent->>'runId'=$2 AND intent->>'path' LIKE 'zz/%' GROUP BY 1 ORDER BY 1`, [s.id, result.runId]);
  expect(requests).toEqual([{ path: 'zz/z0.md', states: cancelSecond ? 'cancelled,committed' : 'committed' }, { path: 'zz/z1.md', states: 'committed' }, { path: 'zz/z2.md', states: 'committed' }]);
  expect((await engine.getPage('zz/z1', { sourceId: s.id }))?.compiled_truth).toContain('An edited observation.');
  expect(await engine.getPage('zz/z0', { sourceId: s.id })).not.toBeNull();
  expect(await s.sync({ bulk: BULK })).toMatchObject({ status: 'up_to_date' });
}), 180_000);

test.each([
  ['already published', false],
  // One member of the group admitted ahead is still publishing when the cursor drops it: the count waits for it.
  ['still publishing', true],
] as const)('a draining run counts the group admitted ahead of a dropped group, %s when the group is dropped', (_when, publishing) => each(async engine => {
  const s = await source(engine, Object.fromEntries('abcdefgh'.split('').map(c => [`notes/${c}.md`, note(c.toUpperCase())])));
  const members = await stageGroup(engine, s, async head => {
    expect(await cancelWriteRequest(engine, requestPrincipal(head), head.request_id)).toMatchObject({ state: 'cancelled' });
  }, true);
  // The second group names the first group's last request as its predecessor, which commits, so the consumer publishes it too.
  expect(members.slice(4).every(member => member.intent?.after === members[3]!.request_id)).toBe(true);
  await published(engine, members, 7);
  const original = engine.executeRaw;
  if (publishing) {
    // The last page reads as running at the first read of the dropped members, and as committed from then on.
    const last = members[7]!.id;
    let read = false;
    await engine.executeRaw("UPDATE persistence_requests SET state='running',claim_expires_at=now()+interval '5 minutes' WHERE id=$1::uuid", [last]);
    (engine as { executeRaw: unknown }).executeRaw = async function (this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>) {
      const rows = await original.apply(this, args);
      if (!read && args[0].includes('SELECT request_id,state,outcome FROM persistence_requests')) {
        read = true;
        await original.call(this, "UPDATE persistence_requests SET state='committed' WHERE id=$1::uuid", [last]);
      }
      return rows;
    };
  }
  const events: Array<{ phase: string; waived?: boolean }> = [];
  const blocked = await s.sync({ bulk: BULK, drainStartedAt: Date.now(), onProgress: event => events.push(event) })
    .finally(() => { (engine as { executeRaw: unknown }).executeRaw = original; });
  expect(await states(engine, members)).toEqual(['cancelled', ...Array(7).fill('committed')]);
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', added: 7, managedWrite: { slug: 'notes/a' } });
  expect(written(events)).toBe(7);
  expect(await s.sync({ bulk: BULK, retryFailed: true })).toMatchObject({ status: 'first_sync', added: 1, modified: 0 });
}), 180_000);

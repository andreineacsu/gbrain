/**
 * #6075: a bulk group whose head another pass admitted on the single path.
 *
 * A bulk pass records a group in the cursor and rewrites the head's intent with
 * `group` (and `lane`), keeping its request ID. A pass without bulk that read the
 * cursor before that admits the same request with the older intent. The group's
 * admission then replays the head with a different intent, so before the fix
 * every pass stopped on idempotency_conflict at the same entry. Runs on PGLite
 * and, with DATABASE_URL, on Postgres; bulk is forced on for both.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { awaitWrite, disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { closeLaneRun } from '../src/core/persistence/sync-lanes.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { SyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const bulk = { enabled: true, reason: null, size: 4, maxTxnMs: 15_000 };
const PAGES = 6;
const note = (i: number) => `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`;
interface StoredCursor { index: number; done?: boolean; sourceId: string; incarnation: string; binding: { worktree_id: string; topology_generation: string | number };
  authority: SyncAuthority; pending?: { requestId: string; slug: string; pageId: number | null; intent: Record<string, unknown> }; group?: Array<{ requestId: string }> }

const cases = [
  { name: 'admitted while the group pass runs: the same pass takes the head on the single path and completes', interrupted: false, conflicting: false, lanes: false },
  { name: 'under lanes, where the head also carries `lane`: the same pass takes the head on the single path and completes', interrupted: false, conflicting: false, lanes: true },
  { name: 'a cursor already wedged on the committed head completes on the next pass, without --retry-failed', interrupted: true, conflicting: false, lanes: false },
  { name: 'a head admitted with a genuinely different intent is still refused', interrupted: true, conflicting: true, lanes: false },
];

for (const kind of testBackends()) {
  describe(`#6075 bulk group head admitted on the single path (${kind})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-group-head-'));
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    }, 120_000);
    afterAll(async () => {
      installFaultHook(undefined);
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      if (close) await close(); else await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
    });

    async function fixture(): Promise<string> {
      const sourceId = `ghead-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const root = join(home, sourceId);
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q');
      for (let i = 0; i < PAGES; i++) writeFileSync(join(root, 'notes', `n${i}.md`), note(i));
      git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      return sourceId;
    }
    async function storedCursor(sourceId: string): Promise<StoredCursor | null> {
      const [row] = await engine.executeRaw<{ cursor: StoredCursor | string }>(
        "SELECT completed_keys->0 AS cursor FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
      return !row ? null : typeof row.cursor === 'string' ? JSON.parse(row.cursor) : row.cursor;
    }
    const requests = (sourceId: string) => engine.executeRaw<{ request_id: string; slug: string; state: string; grp: string | null }>(
      "SELECT request_id,slug,state,intent->>'group' AS grp FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [sourceId]);

    for (const c of cases) {
      test(c.name, async () => withEnv({ GBRAIN_HOME: home }, async () => {
        const sourceId = await fixture();
        const laneRun = c.lanes ? randomUUID() : undefined;
        const opts = { sourceId, noPull: true, noEmbed: true, noExtract: true, bulk: laneRun ? { ...bulk, lanes: 2, laneRun } : bulk };
        let head: WriteRequest | null = null;
        let lane: unknown;
        let frozen: StoredCursor['pending'];
        // The pass without bulk: it read the head as frozen, before the group formed, and admits that copy once the group is recorded.
        installFaultHook(async (point, detail) => {
          if (head || point !== 'sync:mid_checkpoint' || detail.sourceId !== sourceId) return;
          const cursor = await storedCursor(sourceId);
          if (!cursor?.pending) return;
          if (!cursor.group) { frozen = cursor.pending; return; }
          if (frozen?.requestId !== cursor.pending.requestId) return;
          lane = cursor.pending.intent.lane;
          const single = frozen.intent;
          const intent = c.conflicting ? { ...single, content: `${String(single.content)}A different edit.\n` } : single;
          head = await admitWrite(engine, { requestId: cursor.pending.requestId, operation: 'submit_job', sourceId: cursor.sourceId,
            sourceIncarnation: cursor.incarnation, slug: cursor.pending.slug, pageId: cursor.pending.pageId, worktreeId: cursor.binding.worktree_id,
            topologyGeneration: cursor.binding.topology_generation, principal: cursor.authority.writer.principal, authority: cursor.authority.writer,
            callerIntent: intent, intent });
          if (c.interrupted) throw new Error('pass stopped after the group was recorded');
        });
        let first: unknown;
        try { first = await performManagedSync(engine, opts); } catch (error) { first = error; } finally {
          installFaultHook(undefined);
          if (laneRun) await closeLaneRun(laneRun);
        }
        expect(head).not.toBeNull();
        expect(lane).toBe(laneRun);
        const headId = head!.request_id;

        if (c.interrupted) {
          expect(first).toBeInstanceOf(Error);
          // The reported state: the cursor holds the group, its head committed without `group`, the followers were never admitted.
          await awaitWrite(engine, head!, { engine: engine.kind }, { waitMs: 15_000 });
          const wedged = await storedCursor(sourceId);
          expect(wedged).toMatchObject({ index: 0, pending: { requestId: headId, intent: { group: headId } } });
          expect(wedged!.group).toHaveLength(4);
          expect(await requests(sourceId)).toEqual([{ request_id: headId, slug: 'notes/n0', state: 'committed', grp: null }]);
        }

        if (c.conflicting) {
          for (let pass = 0; pass < 2; pass++) await expect(performManagedSync(engine, opts)).rejects.toMatchObject({ code: 'idempotency_conflict' });
          expect((await storedCursor(sourceId))!.group).toHaveLength(4);
          expect((await requests(sourceId)).map(row => row.request_id)).toEqual([headId]);
          return;
        }

        const done = c.interrupted ? await performManagedSync(engine, opts) : first;
        expect(done).toMatchObject({ status: 'first_sync', added: PAGES });
        const rows = await requests(sourceId);
        expect(rows).toHaveLength(PAGES);
        expect(rows.every(row => row.state === 'committed')).toBe(true);
        // The head keeps the one request it was admitted with on the single path; no page is published twice.
        expect(rows.filter(row => row.request_id === headId)).toEqual([{ request_id: headId, slug: 'notes/n0', state: 'committed', grp: null }]);
        expect(new Set(rows.map(row => row.slug)).size).toBe(PAGES);
        for (let i = 0; i < PAGES; i++) expect((await engine.getPage(`notes/n${i}`, { sourceId }))?.title).toBe(`Note ${i}`);
        expect(await storedCursor(sourceId)).toMatchObject({ done: true });
      }), 120_000);
    }
  });
}

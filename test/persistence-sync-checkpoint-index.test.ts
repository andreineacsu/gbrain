import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MANAGED_SYNC_INCOMPLETE_RECEIPT_SQL } from '../src/core/persistence/sync-prepare.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

// #5762: the checkpoint gate runs under the coordinator's 5 s statement_timeout.
// A table scan grows with every retained receipt and eventually never commits.
test('the sync checkpoint gate reads the run and its receipts through an index', async () => {
  for (const engine of engines) {
    const plan = await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL enable_seqscan = off');
      return tx.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${MANAGED_SYNC_INCOMPLETE_RECEIPT_SQL}`, [randomUUID(), randomUUID()]);
    });
    const text = plan.map(row => row['QUERY PLAN']).join('\n');
    expect(text).not.toContain('Seq Scan');
    // Once for the run's receipts, once for the committed-sibling probe.
    expect(text.match(/persistence_requests_sync_run/g)).toHaveLength(2);
  }
});

interface Receipt { run: 'this' | 'other'; kind?: string; index?: number; state: string; recovery?: boolean }
const GATE_CASES: { name: string; receipts: Receipt[]; blocks: boolean }[] = [
  { name: 'only the running checkpoint carries the run id', receipts: [{ run: 'this', kind: 'managed_sync_checkpoint', index: 3, state: 'running' }], blocks: false },
  { name: 'every page receipt of the run committed', receipts: [{ run: 'this', index: 0, state: 'committed' }, { run: 'this', kind: 'managed_sync_delete', index: 1, state: 'committed' }], blocks: false },
  { name: 'a page receipt of the run is still queued', receipts: [{ run: 'this', index: 0, state: 'queued' }], blocks: true },
  { name: 'a failed page receipt whose index later committed', receipts: [{ run: 'this', index: 1, state: 'failed' }, { run: 'this', index: 1, state: 'committed' }], blocks: false },
  { name: 'a failed page receipt with no committed retry', receipts: [{ run: 'this', index: 2, state: 'failed' }], blocks: true },
  { name: 'an unfinished receipt of another run', receipts: [{ run: 'other', index: 0, state: 'queued' }], blocks: false },
  { name: 'retained recovery on any request of the worktree', receipts: [{ run: 'other', index: 0, state: 'committed', recovery: true }], blocks: true },
];

test.each(GATE_CASES)('the sync checkpoint gate: $name', async ({ receipts, blocks }) => {
  for (const engine of engines) {
    const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
    const runs = { this: randomUUID(), other: randomUUID() };
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      for (const receipt of receipts) {
        const intent = { kind: receipt.kind ?? 'managed_sync_import', runId: runs[receipt.run], index: receipt.index, total: 3 };
        await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,
          worktree_id,digest,intent,authority,state,recovery,intent_bytes,terminal_reservation)
          VALUES('local_cli','checkpoint-gate',$1::uuid,'submit_job','default',$2::uuid,'__managed_sync_checkpoint__',$3::uuid,'digest',
          $4::text::jsonb,'{}'::jsonb,$5,$6::text::jsonb,0,0)`,
        [randomUUID(), randomUUID(), worktree.id, JSON.stringify(intent), receipt.state, receipt.recovery ? JSON.stringify({ version: 1 }) : null]);
      }
    });
    const incomplete = await engine.executeRaw(MANAGED_SYNC_INCOMPLETE_RECEIPT_SQL, [worktree.id, runs.this]);
    expect(incomplete.length > 0).toBe(blocks);
  }
});

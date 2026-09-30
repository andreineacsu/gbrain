import type { Migration } from './types.ts';
import { PERSISTENCE_SYNC_RUN_INDEX_SQL } from '../persistence/schema.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v179: Migration = {
  // #5762: the managed sync checkpoint gate finds its run's receipts by
  // intent runId under the 5 s publication statement timeout. Unindexed, it
  // scanned every retained receipt and timed out on every retry once the
  // journal grew. The build reads every retained intent, so Postgres builds
  // it CONCURRENTLY. Not in src/schema.sql: SCHEMA_SQL replays before
  // migrations on every connect and would build it without CONCURRENTLY.
  version: 179, name: 'index_managed_sync_run_receipts', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 179, 'persistence_requests_sync_run');
    await engine.runMigration(179, engine.kind === 'postgres'
      ? PERSISTENCE_SYNC_RUN_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')
      : PERSISTENCE_SYNC_RUN_INDEX_SQL);
  },
};

/**
 * #6089 on Postgres: `apply-migrations` must not exit 0 while it leaves the
 * schema behind, whatever else the run did. An applied reconcile-only
 * migration (0.53.0 in the real registry) re-runs on every run; it is not
 * pending work, so with nothing else to run a schema still behind fails the
 * run before that re-check. When pending orchestrators ran, the verdict reads
 * the schema version again, since an orchestrator may migrate it itself.
 *
 * The runner is the real apply-migrations in a child process against its own
 * throwaway database. The registry is synthetic: an applied reconcile
 * migration and, per case, one pending migration; each logs when it runs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { collect, spawnDriver } from '../helpers/apply-migrations-lock-driver.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const REPO = resolve(import.meta.dir, '..', '..');
/** Product modules the child driver loads or replaces. */
const MODULES = {
  migrate: join(REPO, 'src/core/migrate.ts'),
  registry: join(REPO, 'src/commands/migrations/index.ts'),
  engineFactory: join(REPO, 'src/core/engine-factory.ts'),
  applyMigrations: join(REPO, 'src/commands/apply-migrations.ts'),
};
const RECONCILE = '0.53.0';
const PENDING = '0.60.0';

/** `failing`: the schema migration throws, as a broken DDL replay would. */
type Schema = 'current' | 'behind' | 'failing';
/**
 * `migrates-schema`: the pending orchestrator brings the schema to head itself.
 * `hides-config`: it renames the config table, so the schema version cannot be read again.
 * `fails`: it reports status failed.
 */
type Pending = 'none' | 'leaves-schema' | 'migrates-schema' | 'hides-config' | 'fails';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function withEngine<T>(url: string, fn: (engine: PostgresEngine) => Promise<T>): Promise<T> {
  const engine = new PostgresEngine();
  try {
    await engine.connect({ database_url: url, poolSize: 1 });
    return await fn(engine);
  } finally { await engine.disconnect(); }
}

/** A throwaway database at schema head, set back one version unless `current`. */
async function brainDatabase(schema: Schema): Promise<string> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_schema_behind_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  cleanups.push(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });
  const url = new URL(DATABASE_URL!); url.pathname = `/${name}`;
  await withEngine(url.toString(), async engine => {
    await engine.initSchema();
    if (schema !== 'current') await engine.setConfig('version', String(LATEST_VERSION - 1));
  });
  return url.toString();
}

async function runApply(databaseUrl: string, schema: Schema, pending: Pending, args: string[]) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-schema-behind-')));
  cleanups.push(async () => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.gbrain', 'migrations'), { recursive: true });
  const configPath = join(home, '.gbrain', 'config.json');
  writeFileSync(configPath, JSON.stringify({ engine: 'postgres', database_url: databaseUrl }));
  writeFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), JSON.stringify({ version: RECONCILE, status: 'complete' }) + '\n');
  const log = join(home, 'orchestrators.log');
  const registry = [{ version: RECONCILE, reconcile: true, effect: 'none' },
    ...(pending === 'none' ? [] : [{ version: PENDING, reconcile: false, effect: pending }])];
  const driver = join(home, 'driver.ts');
  writeFileSync(driver, `import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
if (${schema === 'failing'}) {
  const real = await import(${JSON.stringify(MODULES.migrate)});
  mock.module(${JSON.stringify(MODULES.migrate)}, () => ({ ...real, runMigrations: async () => { throw new Error('fixture schema migration failure'); } }));
}
mock.module(${JSON.stringify(MODULES.registry)}, () => ({
  compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  migrations: ${JSON.stringify(registry)}.map(spec => ({
    version: spec.version,
    featurePitch: { headline: 'fixture ' + spec.version },
    reconcile: spec.reconcile,
    orchestrator: async () => {
      appendFileSync(${JSON.stringify(log)}, spec.version + '\\n');
      const cfg = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'));
      if (spec.effect === 'migrates-schema' || spec.effect === 'hides-config') {
        const { createEngine } = await import(${JSON.stringify(MODULES.engineFactory)});
        const engine = await createEngine(cfg);
        await engine.connect(cfg);
        if (spec.effect === 'migrates-schema') await engine.initSchema();
        else await engine.executeRaw('ALTER TABLE config RENAME TO config_hidden');
        await engine.disconnect();
      }
      return { version: spec.version, status: spec.effect === 'fails' ? 'failed' : 'complete', phases: [] };
    },
  })),
}));
const { runApplyMigrations } = await import(${JSON.stringify(MODULES.applyMigrations)});
await runApplyMigrations(${JSON.stringify(args)});
process.exit(0);
`);
  const { stdout, stderr, code } = await collect(spawnDriver(home, driver));
  const ran = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const last = stdout.trim().split('\n').at(-1) ?? '';
  return { code, output: stderr + stdout, document: last.startsWith('{') ? JSON.parse(last) : null, ran };
}

const CASES: Array<{
  name: string; schema: Schema; pending: Pending; args: string[];
  code: number; error?: string; ran: string[]; version?: number; message?: string;
}> = [
  { name: 'only the reconcile re-check left, no --yes: fails before the re-check',
    schema: 'behind', pending: 'none', args: ['--json'], code: 1, error: 'migrations_pending', ran: [], version: LATEST_VERSION - 1 },
  { name: 'only the reconcile re-check left, --yes, schema migration fails: fails before the re-check',
    schema: 'failing', pending: 'none', args: ['--yes', '--json'], code: 1, error: 'migrations_pending', ran: [], version: LATEST_VERSION - 1 },
  { name: 'only the reconcile re-check left, --yes: migrates the schema, then re-checks',
    schema: 'behind', pending: 'none', args: ['--yes', '--json'], code: 0, ran: [RECONCILE], version: LATEST_VERSION },
  { name: 'schema current, no --yes: re-checks and exits 0',
    schema: 'current', pending: 'none', args: ['--json'], code: 0, ran: [RECONCILE], version: LATEST_VERSION },
  { name: 'a pending migration that leaves the schema alone, no --yes: runs, then fails',
    schema: 'behind', pending: 'leaves-schema', args: ['--json'], code: 1, error: 'migrations_pending', ran: [RECONCILE, PENDING], version: LATEST_VERSION - 1 },
  { name: 'a pending migration that migrates the schema, no --yes: exits 0',
    schema: 'behind', pending: 'migrates-schema', args: ['--json'], code: 0, ran: [RECONCILE, PENDING], version: LATEST_VERSION },
  { name: 'a pending migration after which the schema version cannot be read: fails closed',
    schema: 'behind', pending: 'hides-config', args: ['--json'], code: 1, error: 'migrations_pending', ran: [RECONCILE, PENDING],
    message: 'Could not confirm the schema version after the migrations ran' },
  { name: 'a pending migration that fails: reports the orchestrator failure, not the schema',
    schema: 'behind', pending: 'fails', args: ['--json'], code: 1, error: 'migration_failed', ran: [RECONCILE, PENDING], version: LATEST_VERSION - 1 },
];

describe.skipIf(!DATABASE_URL)('apply-migrations never exits 0 with the schema left behind (#6089, Postgres)', () => {
  test.each(CASES)('$name', async ({ schema, pending, args, code, error, ran, version, message }) => {
    const databaseUrl = await brainDatabase(schema);
    const run = await runApply(databaseUrl, schema, pending, args);
    expect(run.code, run.output).toBe(code);
    if (error) expect(run.document).toMatchObject({ error });
    else expect(run.document?.error).toBeUndefined();
    if (message) expect(run.document?.message).toContain(message);
    expect(run.ran).toEqual(ran);
    if (version !== undefined) {
      expect(await withEngine(databaseUrl, async engine => parseInt((await engine.getConfig('version')) ?? '0', 10))).toBe(version);
    }
  }, 120_000);
});

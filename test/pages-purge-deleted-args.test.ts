/**
 * #6114: `gbrain pages purge-deleted` argument handling.
 *
 * The purge is a hard delete with no undo, so every argument the handler does
 * not act on must stop it before the engine is touched: `--help`/`-h` print the
 * subcommand usage, and anything else unrecognized (a positional, a missing
 * `--older-than` value, a flag the CLI registry accepts but this subcommand
 * ignores) exits 2. An ignored argument used to fall through to the real purge.
 *
 * The CLI answers `--help` for `pages` through its engine-free route, which
 * hands the handler a null engine (src/cli.ts SELF_HELP_WITHOUT_ENGINE), so the
 * help cases also run with `null`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPages } from '../src/commands/pages.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const slug of ['notes/expired-example', 'notes/recent-example', 'notes/live-example']) {
    await engine.putPage(slug, { type: 'note' as any, title: slug, compiled_truth: `Content of ${slug}`, timeline: '', frontmatter: {} });
  }
  // expired: past the default 72h window; recent: inside it, but an hour back so
  // `--older-than 0` (a strict `deleted_at < now()`) always covers it; live: never deleted.
  await engine.softDeletePage('notes/expired-example');
  await engine.softDeletePage('notes/recent-example');
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug = $1`, ['notes/expired-example']);
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() - INTERVAL '1 hour' WHERE slug = $1`, ['notes/recent-example']);
});

async function pageRows(): Promise<Array<{ slug: string; deleted_at: string | null }>> {
  return engine.executeRaw(`SELECT slug, deleted_at::text AS deleted_at FROM pages ORDER BY slug`);
}

/** Runs `gbrain pages purge-deleted <argv>` in-process; a process.exit surfaces as `exit`. */
async function purgeDeleted(argv: string[], target: PGLiteEngine | null = engine) {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`EXIT:${code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await runPages(target as never, ['purge-deleted', ...argv]);
  } catch (e) {
    const match = /^EXIT:(\d+)$/.exec(e instanceof Error ? e.message : '');
    if (!match) throw e;
    exitCode = Number(match[1]);
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

describe('pages purge-deleted --help / -h (#6114)', () => {
  const HELP_ARGVS = [['--help'], ['-h'], ['--older-than', '0', '--help'], ['--json', '-h']];

  for (const argv of HELP_ARGVS) {
    test(`${argv.join(' ')} prints usage and purges nothing`, async () => {
      const before = await pageRows();
      const result = await purgeDeleted(argv);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toContain('Usage: gbrain pages purge-deleted');
      expect(await pageRows()).toEqual(before);
    });

    test(`${argv.join(' ')} answers without an engine (the CLI's engine-free help route)`, async () => {
      const result = await purgeDeleted(argv, null);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toContain('Usage: gbrain pages purge-deleted');
    });
  }
});

describe('pages purge-deleted refuses arguments it would ignore (#6114)', () => {
  const REFUSALS: Array<{ argv: string[]; names: string }> = [
    { argv: ['help'], names: '"help"' },
    { argv: ['notes/expired-example'], names: '"notes/expired-example"' },
    { argv: ['--older-than'], names: '--older-than' },
    { argv: ['--older-than', 'soon'], names: '"soon"' },
    { argv: ['--older-than=0'], names: '"--older-than 0"' },
    { argv: ['--older-than', '720', '--older-than', '0'], names: 'more than once' },
    { argv: ['--source', 'default'], names: '"--source"' },
    { argv: ['--dry-run', '--yes'], names: '"--yes"' },
  ];

  for (const { argv, names } of REFUSALS) {
    test(`${argv.join(' ')} exits 2 before the engine and purges nothing`, async () => {
      const before = await pageRows();
      const result = await purgeDeleted(argv);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(names);
      expect(result.stderr).toContain('Nothing was purged.');
      expect(result.stdout).toBe('');
      expect(await pageRows()).toEqual(before);
      // A null engine would throw on first use, so exit 2 here proves the refusal precedes it.
      expect((await purgeDeleted(argv, null)).exitCode).toBe(2);
    });
  }
});

describe('pages purge-deleted still previews and purges', () => {
  test('--dry-run lists the expired page and deletes nothing', async () => {
    const before = await pageRows();
    const result = await purgeDeleted(['--dry-run']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('Would purge 1 page(s)');
    expect(result.stdout).toContain('notes/expired-example');
    expect(await pageRows()).toEqual(before);
  });

  test('no arguments purges past the default 72h window only', async () => {
    const result = await purgeDeleted([]);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('Purged 1 page(s) (older than 72h)');
    expect((await pageRows()).map(r => r.slug)).toEqual(['notes/live-example', 'notes/recent-example']);
  });

  // The documented Nd / Nh spellings resolve to hours; 3d keeps the recent page, 0h takes it.
  for (const { value, hours, count } of [{ value: '3d', hours: 72, count: 1 }, { value: '0h', hours: 0, count: 2 }]) {
    test(`--older-than ${value} --dry-run --json previews a ${hours}h cutoff`, async () => {
      const before = await pageRows();
      const result = await purgeDeleted(['--older-than', value, '--dry-run', '--json']);
      expect(result.exitCode).toBeNull();
      const report = JSON.parse(result.stdout);
      expect(report.older_than_hours).toBe(hours);
      expect(report.count).toBe(count);
      expect(await pageRows()).toEqual(before);
    });
  }

  test('--older-than 0 --json purges every soft-deleted page and reports JSON', async () => {
    const result = await purgeDeleted(['--older-than', '0', '--json']);
    expect(result.exitCode).toBeNull();
    const report = JSON.parse(result.stdout);
    expect(report.older_than_hours).toBe(0);
    expect(report.count).toBe(2);
    expect((await pageRows()).map(r => r.slug)).toEqual(['notes/live-example']);
  });
});

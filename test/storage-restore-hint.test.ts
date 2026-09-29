/**
 * #5532: the restore command `gbrain storage status` prints must restore the
 * files it lists as missing. Status counted the source that owns the repo
 * path (dotfile, then longest registered prefix, else every source) while
 * `gbrain export --restore-only` picks its source by another rule, so on a
 * multi-source brain the printed command restored another source's pages or
 * refused. Each row runs `storage status`, follows its `Use:` line (with an
 * output dir appended), and compares the restored files with the list.
 *
 * In-memory PGLite; the export destination is a physical path because export
 * publication refuses symlinked ancestors (macOS /var).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runStorage, __resetPGLiteWarn } from '../src/commands/storage.ts';
import { runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dir: string;
let repo: string;
let out: string;
let logged: string[];
const original = { log: console.log, error: console.error, warn: console.warn, exit: process.exit };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'storage-restore-hint-')));
  repo = join(dir, 'repo');
  out = join(dir, 'out');
  mkdirSync(repo);
  writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n');
  __resetMissingStorageWarning();
  __resetPGLiteWarn();
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
  await engine.executeRaw(
    "INSERT INTO sources (id, name, local_path) VALUES ('connector-a', 'Connector A', NULL)",
  );
  logged = [];
  console.log = console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.warn = () => {};
  process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as never;
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  process.exit = original.exit;
  rmSync(dir, { recursive: true, force: true });
});

async function dbOnlyPage(slug: string, sourceId: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body-${sourceId}`, timeline: '' }, { sourceId });
}

/** `storage status` output: the listed missing slugs and the printed hint. */
async function storageStatus(args: string[]): Promise<{ missing: string[]; hint: string }> {
  logged = [];
  await runStorage(engine, ['status', ...args, '--json']);
  const missing = (JSON.parse(logged.join('\n')) as { missingFiles: Array<{ slug: string }> })
    .missingFiles.map((m) => m.slug).sort();
  logged = [];
  await runStorage(engine, ['status', ...args]);
  const hint = logged.join('\n').split('\n')
    .find((line) => line.startsWith('Use: ') || line.startsWith('Cannot suggest')) ?? '';
  return { missing, hint };
}

/** Run the hint's command into `out`; the page slugs it restored. */
async function followHint(hint: string): Promise<string[]> {
  const argv = hint.replace(/^Use: gbrain export /, '').match(/"[^"]*"|\S+/g)!
    .map((token) => token.replace(/^"|"$/g, ''));
  logged = [];
  await runExport(engine, [...argv, '--dir', out]);
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name));
      else if (entry.name.endsWith('.md')) files.push(relative(out, join(at, entry.name)).replace(/\.md$/, ''));
    }
  };
  walk(out);
  return files.sort();
}

describe('storage status names a restore command that restores its list (#5532)', () => {
  test.each([
    {
      name: 'legacy sync.repo_path brain with a second source, no --repo',
      args: () => [],
      seed: async () => {
        await engine.setConfig('sync.repo_path', repo);
      },
    },
    {
      name: 'a .gbrain-source in the repo naming another source',
      args: () => ['--repo', repo],
      seed: async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
        writeFileSync(join(repo, '.gbrain-source'), 'connector-a\n');
      },
    },
    {
      // Control row: master already restores the listed file here; it differs
      // only in the hint text (no --source). It pins that the single-owner
      // case keeps working.
      name: 'control: the repo registered to the default source',
      args: () => ['--repo', repo],
      seed: async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
      },
    },
  ])('$name', async ({ args, seed }) => {
    await seed();
    await dbOnlyPage('media/x/default-clip', 'default');
    await dbOnlyPage('media/x/connector-clip', 'connector-a');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(args());
      // Only the default source's page: connector-a's never lived in this repo.
      expect(status.missing).toEqual(['media/x/default-clip']);
      expect(status.hint).toStartWith('Use: gbrain export --restore-only --source default ');
      expect(await followHint(status.hint)).toEqual(['media/x/default-clip']);
    });
  });

  test('a repo that identifies no single source prints the refusal, not a failing command', async () => {
    await engine.setConfig('sync.repo_path', repo);
    await dbOnlyPage('media/x/default-clip', 'default');
    await dbOnlyPage('media/x/connector-clip', 'connector-a');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.hint).toBe(
        'Cannot suggest a restore command: The restore repo does not identify exactly one source. '
        + 'Pass --source <id> and --repo <path> for that source.',
      );
    });
  });
});

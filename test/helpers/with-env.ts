import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run a callback with `process.env` mutations applied, then restore the prior
 * values via try/finally. The canonical pattern for env-touching tests in this
 * repo.
 *
 * Why this exists: `process.env` is process-global. Tests that mutate it
 * leak state across files in the same bun test process (the parallel runner
 * loads multiple files into one process per shard). `withEnv` saves the
 * prior value of every key it touches, runs the callback, and restores via
 * try/finally — including when the callback throws.
 *
 * Important caveat: `withEnv` is cross-test-safe but NOT intra-file
 * concurrent-safe. Two `test.concurrent()` calls in the same file both
 * calling withEnv on the same key will race — the global is only one
 * variable. Files that mutate env stay outside the `test.concurrent()`
 * codemod's eligibility filter (the `*.serial.test.ts` quarantine + the
 * codemod's `grep -L "process\.env\."` exclusion handle this).
 *
 * Use:
 *   import { withEnv } from './helpers/with-env.ts';
 *
 *   test('reads OPENAI_API_KEY', async () => {
 *     await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
 *       expect(loadConfig().openai_key).toBe('sk-test');
 *     });
 *   });
 *
 *   // Delete a var (override is undefined):
 *   await withEnv({ GBRAIN_HOME: undefined }, async () => {
 *     expect(process.env.GBRAIN_HOME).toBeUndefined();
 *   });
 *
 *   // Multiple keys:
 *   await withEnv({ A: '1', B: '2', C: undefined }, fn);
 *
 *   // Nested compose: inner restores to outer's value, not original.
 *   await withEnv({ K: 'outer' }, async () => {
 *     await withEnv({ K: 'inner' }, async () => {
 *       expect(process.env.K).toBe('inner');
 *     });
 *     expect(process.env.K).toBe('outer');
 *   });
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const keys = Object.keys(overrides);
  const prior: Record<string, string | undefined> = {};
  for (const key of keys) {
    prior[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * A fresh empty temp dir for `GBRAIN_HOME`, so `loadConfig()` / `configDir()`
 * resolve to a directory with no config.json. Pair with a `withEnv` override
 * (`GBRAIN_HOME: emptyHome()`) on any "no key" assertion: `hasAnthropicKey()`
 * and the Voyage/embedding key probes read BOTH the env var AND the gbrain config
 * file, so clearing only the env var is NOT hermetic on a dev machine whose
 * real `~/.gbrain/config.json` holds a key — the assertion flips and the test
 * fails locally while passing in key-less CI. The dir is tiny and intentionally
 * leaked (test process is short-lived); the OS reaps tmp.
 */
export function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-nokey-home-'));
}

/**
 * Run a callback with HOME and GBRAIN_HOME pointed at two distinct fresh temp
 * dirs (plus any `extraEnv` overrides), then remove both dirs via try/finally.
 * Use it for "this path follows GBRAIN_HOME, not HOME" assertions.
 *
 * Why two distinct dirs: Bun fixes `os.homedir()` at process start, so HOME
 * alone does not redirect gbrain state, and GBRAIN_HOME is a PARENT dir with
 * `.gbrain` appended. A path still derived from HOME lands in `home`, one from
 * `gbrainPath()` lands in `gbrainHome`, and the test can tell them apart. Run
 * any post-call filesystem assertions inside `fn`: both dirs are removed
 * before `withSplitHomes` resolves.
 *
 * Use:
 *   await withSplitHomes(({ home, gbrainHome }) => {
 *     expect(upgradeStatePath()).toBe(join(gbrainHome, '.gbrain', 'upgrade-state.json'));
 *   }, { GBRAIN_AUDIT_DIR: undefined });
 */
export async function withSplitHomes<T>(
  fn: (dirs: { home: string; gbrainHome: string }) => T | Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-split-home-'));
  const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-split-gbhome-'));
  try {
    return await withEnv({ ...extraEnv, HOME: home, GBRAIN_HOME: gbrainHome }, () => fn({ home, gbrainHome }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(gbrainHome, { recursive: true, force: true });
  }
}

/**
 * #6303: `gbrain doctor --only <check>` (every check's default fix.verify)
 * decided whether to open the engine from the check's registry position, so a
 * check emitted before the DB-checks stop that reads the engine
 * (dream_paid_loop, connectors, sync_failures, ...) ran engine-free and came
 * back as a database connection failure plus "Not run".
 *
 * Each entry before the stop declares the checks whose result depends on an
 * engine in `engineChecks`. The guard runs every such entry with no engine and
 * again with a real PGLite engine and with a probe engine whose every read
 * rejects: a check whose result changes reads the engine and must be declared.
 * A check that swallows the probe's error still differs on the real engine.
 * The journey runs the reported command against a CLI-created brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { dbChecksGateEntry, offlineConnectionEntry } from '../src/commands/doctor/checks/db-connection.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { parseFlags, resolveSkillsDir } from '../src/commands/check-resolvable.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createProgress } from '../src/core/progress.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const gate = DOCTOR_CHECK_REGISTRY.indexOf(dbChecksGateEntry);
// The offline connection entry reports the missing engine itself; --only always runs it.
const preGateEntries = DOCTOR_CHECK_REGISTRY.slice(0, gate).filter(e => e !== offlineConnectionEntry);
// The repository's own skills, so the skill checks that read the engine (skill_preconditions) run.
const skillsDirResolution = resolveSkillsDir(parseFlags(['--skills-dir', join(import.meta.dir, '..', 'skills')]));

let pglite: PGLiteEngine;
beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
}, 60_000);
afterAll(async () => { await pglite.disconnect(); });

/** An engine whose every method rejects; `kind` reads as postgres so kind-gated paths run too. */
function probeEngine(): DoctorContext['engine'] {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'kind') return 'postgres';
      return () => Promise.reject(new Error('probe: engine read'));
    },
  }) as DoctorContext['engine'];
}

function ctxFor(engine: DoctorContext['engine']): DoctorContext {
  return {
    engine, args: ['--json'], dbSource: 'config-file', jsonOutput: true, fastMode: false, doFix: false, dryRun: false,
    scope: 'all', orphanRatioSourceId: undefined, progress: createProgress({ mode: 'quiet' }),
    skillsDirResolution, skillsDir: skillsDirResolution.dir, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only: null,
  };
}

/** Status plus message with digits masked, so counts and clock readings do not read as engine dependence. */
function fingerprint(checks: Check[] | symbol): Map<string, string> {
  if (!Array.isArray(checks)) return new Map();
  return new Map(checks.map(c => [c.name, `${c.status} ${String(c.message).replace(/\d+/g, '#')}`]));
}

/** HOME, GBRAIN_HOME and every harness config dir inside one scratch home. */
function scratchEnv(home: string): Record<string, string | undefined> {
  return { GBRAIN_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined,
    CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
}

describe('doctor --only: entries before the DB-checks stop declare the checks that read the engine (#6303)', () => {
  test('a check whose result changes when an engine is present is listed in its entry\'s engineChecks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-only-engine-'));
    try {
      await withEnv(scratchEnv(home), async () => {
        const undeclared = new Set<string>();
        for (const entry of preGateEntries) {
          const without = fingerprint(await entry.run(ctxFor(null)));
          for (const engine of [probeEngine(), pglite]) {
            const withEngine = fingerprint(await entry.run(ctxFor(engine)));
            for (const name of entry.emits) {
              if (without.get(name) !== withEngine.get(name) && !entry.engineChecks?.includes(name)) undeclared.add(`${entry.name}: ${name}`);
            }
          }
        }
        expect([...undeclared]).toEqual([]);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('engineChecks names are emitted by their entry, and only entries before the stop declare them', () => {
    for (const [i, entry] of DOCTOR_CHECK_REGISTRY.entries()) {
      if (!entry.engineChecks) continue;
      expect({ entry: entry.name, beforeStop: i < gate }).toEqual({ entry: entry.name, beforeStop: true });
      for (const name of entry.engineChecks) expect(entry.emits).toContain(name);
    }
    expect(DOCTOR_CHECK_REGISTRY.find(e => e.emits.includes('dream_paid_loop'))?.engineChecks).toContain('dream_paid_loop');
  });

  // The reported command and the pglite-repair verify, on a CLI-created brain: each reports its own check,
  // not a connection failure, "Not run", or a "PGLite failed to open" on a healthy store.
  test('journey: --only dream_paid_loop and --only pglite_data_dir report the check on a configured brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-only-engine-journey-'));
    const env = { CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config') };
    try {
      const init = await runCli(['init', '--pglite', '--no-embedding'], { home, env, timeoutMs: 120_000 });
      expect(init.exitCode).toBe(0);
      for (const name of ['dream_paid_loop', 'pglite_data_dir']) {
        const out = await runCli(['doctor', '--only', name, '--json'], { home, env, timeoutMs: 120_000 });
        const report = JSON.parse(out.stdout) as { checks: Check[] };
        expect({ name, checks: report.checks.map(c => [c.name, c.status]), exitCode: out.exitCode })
          .toEqual({ name, checks: [[name, 'ok']], exitCode: 0 });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});

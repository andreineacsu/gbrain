/**
 * An automatic remediation run never submits a manual-only step.
 *
 * A manual-only step (the `unify-types` pack upgrade, the
 * `extract-takes-from-pages` takes bootstrap) is a decision the user takes by
 * running its job themselves. `gbrain onboard --auto` and MCP `run_onboard`
 * hand every onboard-check step to runRemediation, which submitted all of
 * them, so an auto run on an unmanaged brain with a successor pack applied the
 * pack upgrade and retyped the brain.
 *
 * Protects: no manual-only step reaches the queue from runRemediation (first
 * plan, mid-run recheck, unreachable-target free steps, dry run); each one is
 * reported in `manual_only_skipped` with a command only the user runs, and its
 * cost stays out of the budget check; the other steps still run; and
 * `onboard --auto` prints that command, on the unreachable-target exit too.
 * Seams: a spy on MinionQueue.prototype.add that refuses manual-only jobs
 * (so a regression fails on the assertion instead of retyping the fixture)
 * and calls through for every other job; real PGLite and inline jobs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { registerWorker } from '../src/core/minions/worker-registry.ts';
import { runRemediation } from '../src/core/remediation/index.ts';
import type { RemediationOpts, RemediationResult } from '../src/core/remediation/types.ts';
import { makeRemediationStep, type RemediationStep } from '../src/core/remediation-step.ts';
import { checkPackUpgradeAvailable } from '../src/core/onboard/checks.ts';
import { toOnboardRecommendation } from '../src/core/onboard/render.ts';
import { runOnboard } from '../src/commands/onboard.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
});

const MANUAL_JOBS = new Set(['unify-types', 'extract-takes-from-pages']);
const TAKES_BOOTSTRAP = makeRemediationStep({
  id: 'onboard.takes_bootstrap', job: 'extract-takes-from-pages', protected: true, params: {},
  severity: 'medium', est_seconds: 1800, est_usd_cost: 5, rationale: 'synthetic takes bootstrap',
});

function autoStep(id: string): RemediationStep {
  return makeRemediationStep({
    id, job: 'orphans', params: { probe: id }, severity: 'low', est_seconds: 5, est_usd_cost: 0, rationale: 'synthetic read-only step',
  });
}

/** Runs fn on a fresh home with the bundled packs, recording every job name handed to the queue. */
async function withQueueSpy<T>(fn: (queued: string[]) => Promise<T>): Promise<{ result: T; queued: string[] }> {
  const queued: string[] = [];
  const realAdd = MinionQueue.prototype.add;
  const add = spyOn(MinionQueue.prototype, 'add').mockImplementation(function (this: MinionQueue, ...args: Parameters<MinionQueue['add']>) {
    queued.push(args[0]);
    if (MANUAL_JOBS.has(args[0])) throw new Error(`test: manual-only job ${args[0]} reached the queue`);
    return realAdd.apply(this, args);
  });
  try {
    const result = await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, () => fn(queued));
    return { result, queued };
  } finally {
    add.mockRestore();
  }
}

/** The step the pack_upgrade_available check offers on a brain still on gbrain-base. */
async function packUpgradeStep(): Promise<RemediationStep> {
  const { remediations } = await checkPackUpgradeAvailable(engine);
  expect(remediations.map((r) => [r.job, r.params])).toEqual([['unify-types', { target_pack: 'gbrain-base-v2', apply: true }]]);
  return remediations[0]!;
}

const PACK_ARGV = ['gbrain', 'jobs', 'submit', 'unify-types', '--params', '{"target_pack":"gbrain-base-v2","apply":true}', '--follow'];
const TAKES_ARGV = ['gbrain', 'jobs', 'submit', 'extract-takes-from-pages', '--follow'];

/** What a run reports for the pack upgrade and the takes bootstrap: the step and a command only the user runs. */
function reported(pack: RemediationStep) {
  return [
    { id: pack.id, job: 'unify-types', params: pack.params, fix: expect.objectContaining({ actor: 'user', consent: [], argv: PACK_ARGV }) },
    {
      id: 'onboard.takes_bootstrap', job: 'extract-takes-from-pages', params: {}, est_usd_cost: 5,
      fix: expect.objectContaining({ actor: 'user', consent: ['paid'], argv: TAKES_ARGV }),
    },
  ];
}

describe('runRemediation leaves manual-only steps to the user', () => {
  const cases: Array<{ name: string; opts: (pack: RemediationStep) => RemediationOpts; queued: string[]; ran: string[]; withWorker?: boolean;
    check?: (result: RemediationResult) => void }> = [
    {
      // Two auto steps, so the mid-run recheck rebuilds the plan from the extras once.
      name: 'a run with auto steps runs them, across the mid-run recheck, and submits no manual-only step',
      opts: (pack) => ({ targetScore: 0, inlineJobs: true, extraRemediations: [pack, TAKES_BOOTSTRAP, autoStep('onboard.auto_a'), autoStep('onboard.auto_b')] }),
      queued: ['orphans', 'orphans'], ran: ['onboard.auto_a', 'onboard.auto_b'],
    },
    {
      name: 'a run with only manual-only steps submits nothing',
      opts: (pack) => ({ targetScore: 0, inlineJobs: true, extraRemediations: [pack, TAKES_BOOTSTRAP] }),
      queued: [], ran: [],
    },
    {
      // The pack upgrade costs nothing, so it would be one of the free steps an unreachable target still runs.
      name: 'an unreachable target with a worker serving the queue does not run the free manual-only step',
      opts: (pack) => ({ targetScore: 101, inlineJobs: true, extraRemediations: [pack, TAKES_BOOTSTRAP] }),
      queued: [], ran: [], withWorker: true,
      check: (result) => expect(result.target_unreachable).toMatchObject({ target: 101 }),
    },
    {
      // The $5 takes bootstrap is not part of the estimate the cap is checked against.
      name: "a cap below a manual-only step's cost still runs the free auto step",
      opts: (pack) => ({ targetScore: 0, inlineJobs: true, maxUsd: 1, extraRemediations: [pack, TAKES_BOOTSTRAP, autoStep('onboard.auto_a')] }),
      queued: ['orphans'], ran: ['onboard.auto_a'],
      check: (result) => expect(result.budget_exhausted).toBeUndefined(),
    },
    {
      name: 'a dry run lists the auto steps only',
      opts: (pack) => ({ targetScore: 0, dryRun: true, extraRemediations: [pack, TAKES_BOOTSTRAP, autoStep('onboard.auto_a')] }),
      queued: [], ran: [],
      check: (result) => expect(result.submitted.map((s) => [s.id, s.status])).toEqual([['onboard.auto_a', 'dry_run']]),
    },
  ];

  test.each(cases)('$name', async ({ opts, queued: expectedQueued, ran, withWorker, check }) => {
    let pack: RemediationStep | undefined;
    const { result, queued } = await withQueueSpy(async () => {
      // Registered inside the run's home: the worker registry lives under GBRAIN_HOME.
      const unregister = withWorker
        ? registerWorker({ pid: process.pid, queue: 'default', nice_requested: null, nice_effective: null, started_at: Date.now() })
        : () => {};
      try {
        pack = await packUpgradeStep();
        return await runRemediation(engine, opts(pack));
      } finally {
        unregister();
      }
    });
    expect(queued).toEqual(expectedQueued);
    expect(result.submitted.filter((s) => s.status !== 'dry_run').map((s) => [s.id, s.status])).toEqual(ran.map((id) => [id, 'completed']));
    expect(result.manual_only_skipped).toEqual(reported(pack!));
    check?.(result);
    expect(await engine.getConfig('schema_pack')).toBeNull();
  });

  test('a run with no manual-only step reports none', async () => {
    const { result, queued } = await withQueueSpy(() =>
      runRemediation(engine, { targetScore: 0, inlineJobs: true, extraRemediations: [autoStep('onboard.auto_a')] }));
    expect(queued).toEqual(['orphans']);
    expect(result.manual_only_skipped).toBeUndefined();
  });
});

describe('the other surfaces that read the manual-only rule', () => {
  test('--check labels a manual-only job by its name, with or without the protected flag', () => {
    for (const isProtected of [true, false]) {
      const step = makeRemediationStep({
        id: 'onboard.pack_upgrade_example', job: 'unify-types', protected: isProtected, params: { target_pack: 'gbrain-base-v2', apply: true },
        severity: 'medium', est_seconds: 600, rationale: 'synthetic pack upgrade',
      });
      expect(toOnboardRecommendation(step).apply_policy).toBe('manual_only');
    }
  });
});

describe('onboard --auto reports the manual-only steps it did not run', () => {
  const origExit = process.exit;
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

  async function onboardAuto(args: string[]): Promise<{ stdout: string; exit: number | null; queued: string[] }> {
    let stdout = '';
    const out = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as never);
    const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit;
    let exit: number | null = null;
    try {
      const { queued } = await withQueueSpy(async () => {
        try { await runOnboard(engine, args); } catch (e) { if (!(e instanceof Exit)) throw e; exit = e.code; }
      });
      return { stdout, exit, queued };
    } finally {
      process.exit = origExit;
      out.mockRestore();
      err.mockRestore();
    }
  }

  // An empty brain on gbrain-base: the pack upgrade is the only onboard remediation.
  const command = `gbrain jobs submit unify-types --params '{"target_pack":"gbrain-base-v2","apply":true}' --follow`;
  const notRun = `Not run: unify-types (onboard.pack_upgrade_gbrain-base-v2) is manual-only; onboard --auto never runs it. To run it yourself: ${command}\n`;
  // With no worker, a target above the ceiling runs nothing and exits 2; the report still reaches the caller.
  const targets = [
    { name: 'a reachable target (exit 0)', target: '0', exit: null, before: 'Brain at score 100/100, target 0/100. Nothing to do.\n' },
    { name: 'an unreachable target (exit 2)', target: '101', exit: 2, before: '' },
  ];

  test.each(targets)('human output names the step and the command that runs it: $name', async ({ target, exit: expectedExit, before }) => {
    const { stdout, exit, queued } = await onboardAuto(['--auto', '--max-usd', '1', '--target-score', target]);
    expect(queued).toEqual([]);
    expect(exit).toBe(expectedExit);
    expect(stdout).toBe(before + notRun);
  });

  // stdout is one JSON document: the nothing-to-do line goes to stderr under --json.
  test.each(targets)('JSON output is one document whose step tells an agent to relay the command: $name', async ({ target, exit: expectedExit }) => {
    const { stdout, exit, queued } = await onboardAuto(['--auto', '--max-usd', '1', '--target-score', target, '--json']);
    expect(queued).toEqual([]);
    expect(exit).toBe(expectedExit);
    const json = JSON.parse(stdout) as RemediationResult;
    expect(json.submitted).toEqual([]);
    expect(json.manual_only_skipped).toEqual([{
      id: 'onboard.pack_upgrade_gbrain-base-v2', job: 'unify-types', params: { target_pack: 'gbrain-base-v2', apply: true },
      fix: expect.objectContaining({ argv: PACK_ARGV, command, consent: [], actor: 'user', next: 'tell_user_to_run', requires_exclusive: false }),
    }]);
    if (expectedExit === 2) expect(json.target_unreachable).toMatchObject({ target: 101 });
  });

  test('a paid manual-only step is listed with its estimated cost', async () => {
    // The takes bootstrap step exists only once the user enabled the bootstrap.
    await engine.setConfig('takes.bootstrap_enabled', 'true');
    const { stdout, exit, queued } = await onboardAuto(['--auto', '--max-usd', '1', '--target-score', '0']);
    expect(queued).toEqual([]);
    expect(exit).toBeNull();
    expect(stdout).toContain(notRun);
    expect(stdout).toContain('Not run: extract-takes-from-pages (onboard.takes_bootstrap) is manual-only; onboard --auto never runs it. '
      + 'It is paid (estimated $5.00). To run it yourself: gbrain jobs submit extract-takes-from-pages --follow\n');
  });
});

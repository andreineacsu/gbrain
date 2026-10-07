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
 * cost stays out of the budget check; the other steps still run.
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

/**
 * #6177 — in-cycle dream patterns runs are sized to the cycle budget from the
 * recorded cost of recent runs (`dream.patterns.last_run`), so a run that
 * cannot finish is shrunk or skipped before any spend.
 *
 * Protects: a first run with no history submits a conservative batch;
 * consecutive timed-out cycles shrink the submission each time and stop
 * before spending once below min_evidence; three budget skips or a stale
 * record decay to a min_evidence-sized probe; a successful run after
 * shrinking restores the estimate; direct runs keep their full size; every
 * child (failed ones included) records last_run; a child the queue killed at
 * its own timeout_ms is recorded as a timeout, so the next in-cycle run is
 * halved instead of resubmitting the same batch (#6296).
 * Fails when: the planner ignores history, never decays, a skip spends, or
 * the record reads a timeout kill as a failed child.
 * Seams: planPatternsRun is pure; the phase cases stop before the model call
 * (budget skip), use a fake key whose child dies immediately, or (#6296) a
 * chat transport stub that answers only when the job's timeout aborts it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { PATTERNS_LAST_RUN_KEY, planPatternsRun, readPatternsLastRun, recordPatternsLastRun, type PatternsLastRun } from '../src/core/cycle/patterns-plan.ts';
import { withEnv } from './helpers/with-env.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const run = (over: Partial<PatternsLastRun>): PatternsLastRun =>
  ({ duration_ms: 30 * MIN, reflections: 100, at: new Date(NOW - 3_600_000).toISOString(), outcome: 'completed', budget_skips: 0, ...over });

describe('planPatternsRun', () => {
  test('a first run with no history submits a conservative batch', () => {
    expect(planPatternsRun({ budgetMs: 28 * MIN, lastRun: null, reflections: 100, minEvidence: 3, nowMs: NOW })).toMatchObject({ kind: 'submit', n: 25, basis: 'first_batch' });
    expect(planPatternsRun({ budgetMs: 28 * MIN, lastRun: null, reflections: 100, minEvidence: 40, nowMs: NOW })).toMatchObject({ n: 40 });
    expect(planPatternsRun({ budgetMs: 28 * MIN, lastRun: null, reflections: 10, minEvidence: 3, nowMs: NOW })).toMatchObject({ n: 10 });
  });

  test('history sizes the run with a 1.25x margin', () => {
    expect(planPatternsRun({ budgetMs: 28 * MIN, lastRun: run({}), reflections: 100, minEvidence: 3, nowMs: NOW }))
      .toEqual({ kind: 'submit', n: 74, basis: 'history' });
  });

  test('consecutive timeouts shrink each submission, then skip before spending below min_evidence', () => {
    const sizes: number[] = [];
    let last = run({ outcome: 'timeout', reflections: 100, duration_ms: 28 * MIN });
    for (let i = 0; i < 6; i++) {
      const plan = planPatternsRun({ budgetMs: 28 * MIN, lastRun: last, reflections: 100, minEvidence: 8, nowMs: NOW });
      if (plan.kind === 'skip') { expect(plan.reason).toBe('budget_below_recent_runtime'); break; }
      sizes.push(plan.n);
      last = run({ outcome: 'timeout', reflections: plan.n, duration_ms: 28 * MIN });
    }
    expect(sizes).toEqual([50, 25, 12]);
  });

  test('three budget skips, or a record older than 7 days, decay to a min_evidence probe', () => {
    const tooSlow = run({ duration_ms: 60 * MIN, reflections: 10 });
    expect(planPatternsRun({ budgetMs: 10 * MIN, lastRun: tooSlow, reflections: 100, minEvidence: 3, nowMs: NOW }).kind).toBe('skip');
    expect(planPatternsRun({ budgetMs: 10 * MIN, lastRun: { ...tooSlow, budget_skips: 3 }, reflections: 100, minEvidence: 3, nowMs: NOW }))
      .toEqual({ kind: 'submit', n: 3, basis: 'probe' });
    expect(planPatternsRun({ budgetMs: 10 * MIN, lastRun: { ...tooSlow, at: new Date(NOW - 8 * 86_400_000).toISOString() }, reflections: 100, minEvidence: 3, nowMs: NOW }))
      .toEqual({ kind: 'submit', n: 3, basis: 'probe' });
  });

  test('a successful run after shrinking restores the estimate', () => {
    expect(planPatternsRun({ budgetMs: 28 * MIN, lastRun: run({ reflections: 12, duration_ms: 3 * MIN }), reflections: 100, minEvidence: 8, nowMs: NOW }))
      .toEqual({ kind: 'submit', n: 89, basis: 'history' });
  });

  test('a direct run (no cycle budget) keeps its full size', () => {
    expect(planPatternsRun({ budgetMs: null, lastRun: run({ outcome: 'timeout' }), reflections: 100, minEvidence: 3, nowMs: NOW }))
      .toEqual({ kind: 'submit', n: 100, basis: 'full' });
  });
});

describe('runPhasePatterns budget sizing (#6177)', () => {
  let engine: PGLiteEngine;
  let schemaVersion: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    schemaVersion = (await engine.getConfig('version')) ?? '7';
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); resetGateway(); });
  afterEach(() => { resetGateway(); });
  beforeEach(async () => {
    resetGateway();
    __setChatTransportForTests(null);
    await resetPgliteState(engine);
    await engine.setConfig('version', schemaVersion);
    for (let i = 0; i < 5; i++) {
      await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ($1, 'note', $2, $3)`,
        [`wiki/personal/reflections/2026-10-0${i + 1}-reflection`, `Reflection ${i + 1}`, `Recurring theme fixture ${i + 1}.`]);
    }
  });
  const jobs = async () => (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'subagent'`))[0].n;

  test('a budget below the recent runtime skips before any submit and counts the skip', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-plan-'));
    try {
      await engine.setConfig(PATTERNS_LAST_RUN_KEY, JSON.stringify(run({ duration_ms: 60 * MIN, reflections: 5, at: new Date().toISOString() })));
      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false, deadlineAtMs: Date.now() + 15 * MIN }));
      expect(result.status).toBe('skipped');
      expect(result.details).toMatchObject({ reason: 'insufficient_cycle_budget', cause: 'budget_below_recent_runtime',
        reflections_selected: 5, reflections_submitted: 0 });
      expect((result.details.fix as { argv: string[] }).argv).toEqual(['gbrain', 'dream', '--phase', 'patterns']);
      expect(await jobs()).toBe(0);
      expect(JSON.parse((await engine.getConfig(PATTERNS_LAST_RUN_KEY))!).budget_skips).toBe(1);
    } finally { rmSync(brainDir, { recursive: true, force: true }); }
  });

  test('a child that ends without completing still records last_run', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-plan-'));
    try {
      await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => runPhasePatterns(engine, { brainDir, dryRun: false }));
      const last = JSON.parse((await engine.getConfig(PATTERNS_LAST_RUN_KEY)) ?? 'null') as PatternsLastRun;
      expect(last).toMatchObject({ reflections: 5, outcome: 'failed', budget_skips: 0 });
      expect(last.duration_ms).toBeGreaterThanOrEqual(0);
    } finally { rmSync(brainDir, { recursive: true, force: true }); }
  }, 60_000);

  // #6296: how a child's end (job status, error text) is recorded for the planner.
  const ends: Array<[status: string, errorText: string | null | undefined, recorded: PatternsLastRun['outcome']]> = [
    ['completed', null, 'completed'],
    ['timeout', null, 'timeout'], // the phase's own wait expired
    ['dead', 'timeout exceeded', 'timeout'], // killed at its own timeout_ms
    ['dead', 'wall-clock timeout exceeded', 'timeout'],
    ['dead', 'provider error: 401 invalid x-api-key', 'failed'],
    ['dead', 'request timeout exceeded', 'failed'], // a handler error that ends with the kill text
    ['dead', 'timeout exceeded after 3 retries', 'failed'], // or starts with it
    ['dead', null, 'failed'],
    ['dead', undefined, 'failed'],
    ['failed', 'timeout exceeded', 'failed'],
    ['cancelled', null, 'failed'],
  ];
  test.each(ends)('a child that ended %j with error %j is recorded as %j', async (status, errorText, recorded) => {
    await recordPatternsLastRun(engine, { duration_ms: 20 * MIN, reflections: 25, outcome: status, error_text: errorText });
    expect(await readPatternsLastRun(engine)).toMatchObject({ duration_ms: 20 * MIN, reflections: 25, outcome: recorded, budget_skips: 0 });
  });

  test('a child killed at its own timeout_ms records a timeout, so the next in-cycle run is halved (#6296)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-plan-'));
    try {
      for (let i = 5; i < 8; i++) {
        await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ($1, 'note', $2, $3)`,
          [`wiki/personal/reflections/2026-10-0${i + 1}-reflection`, `Reflection ${i + 1}`, `Recurring theme fixture ${i + 1}.`]);
      }
      await engine.setConfig('agent.use_gateway_loop', 'true');
      await engine.setConfig('dream.patterns.subagent_timeout_ms', '400');
      // The model call never answers: it ends only when the job's own timeout aborts it.
      let modelCalls = 0;
      __setChatTransportForTests(opts => new Promise((_, reject) => {
        modelCalls++;
        const stop = () => reject(new Error('aborted'));
        if (opts.abortSignal?.aborted) stop(); else opts.abortSignal?.addEventListener('abort', stop, { once: true });
      }));

      const first = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => runPhasePatterns(engine, { brainDir, dryRun: false }));
      expect(modelCalls).toBe(1);
      expect(await engine.executeRaw(`SELECT status, error_text FROM minion_jobs WHERE name = 'subagent'`))
        .toEqual([{ status: 'dead', error_text: 'timeout exceeded' }]);
      // The phase still reports the child's own status; only the planner's record reads it as a timeout.
      expect(first.details).toMatchObject({ child_outcome: 'dead', reflections_considered: 8 });
      const recorded = JSON.parse((await engine.getConfig(PATTERNS_LAST_RUN_KEY))!) as PatternsLastRun;
      expect(recorded).toMatchObject({ reflections: 8, outcome: 'timeout', budget_skips: 0 });

      // The next run's budget is the same 400 ms timeout. Pin the recorded duration so what fits (6) does not
      // depend on how long this machine took: the 4 below then comes from the halving alone.
      await engine.setConfig(PATTERNS_LAST_RUN_KEY, JSON.stringify({ ...recorded, duration_ms: 400 }));
      const next = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false, deadlineAtMs: Date.now() + 15 * MIN }));
      expect(next.details).toMatchObject({ plan_basis: 'history', reflections_selected: 8, reflections_considered: 4 });
    } finally { rmSync(brainDir, { recursive: true, force: true }); }
  }, 60_000);
});

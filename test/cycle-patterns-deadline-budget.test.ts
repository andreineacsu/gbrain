/**
 * #2781 — patterns phase budgets its subagent from the REMAINING parent-job
 * time instead of a fixed 30/35-min default that can exceed any
 * interval-derived cycle budget and dead-letter the whole cycle mid-phase.
 *
 * Layers:
 *   1. Unit tests on the exported pure `clampSubagentBudgets`.
 *   2. A real-queue check that `claim` stamps `timeout_at` (the DB ground
 *      truth `deadlineAtMs` derives from) and leaves it null when the job
 *      has no per-job timeout.
 *   3. Structural assertions pinning the wiring: worker → context →
 *      handler → runCycle → patterns (matches the house style of
 *      test/cycle-patterns.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  clampSubagentBudgets,
  CYCLE_DEADLINE_RESERVE_MS,
  MIN_PATTERNS_SUBAGENT_BUDGET_MS,
} from '../src/core/cycle/patterns.ts';
import {
  budgetCoversLastRun,
  LAST_RUN_RECHECK_MS,
  newReflectionCap,
  parseLastRun,
  selectReflectionBatch,
} from '../src/core/cycle/patterns-run-budget.ts';
import { surfaceSource } from './helpers/source-surface.ts';

const CONFIG = {
  subagentTimeoutMs: 30 * 60 * 1000,
  subagentWaitTimeoutMs: 35 * 60 * 1000,
};

describe('clampSubagentBudgets', () => {
  const now = 1_000_000_000_000; // fixed epoch ms; the function takes nowMs explicitly

  test('null deadline → config passthrough (direct `gbrain dream` back-compat)', () => {
    expect(clampSubagentBudgets(CONFIG, null, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
    expect(clampSubagentBudgets(CONFIG, undefined, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
  });

  test('deadline far away → config values win (no clamping)', () => {
    const deadline = now + 2 * 60 * 60 * 1000; // 2h out
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toEqual({
      timeoutMs: CONFIG.subagentTimeoutMs,
      waitTimeoutMs: CONFIG.subagentWaitTimeoutMs,
    });
  });

  test('deadline inside config window → BOTH timeouts clamp to the same child budget', () => {
    const deadline = now + 10 * 60 * 1000; // 10 min out
    const childBudget = deadline - CYCLE_DEADLINE_RESERVE_MS - now; // 9 min
    const budgets = clampSubagentBudgets(CONFIG, deadline, now);
    expect(budgets).toEqual({ timeoutMs: childBudget, waitTimeoutMs: childBudget });
    // The child's own kill switch never outlives the parent budget.
    expect(budgets!.timeoutMs).toBeLessThanOrEqual(deadline - now);
  });

  test('remaining budget below minimum → null (caller skips, no submit)', () => {
    const deadline = now + CYCLE_DEADLINE_RESERVE_MS + MIN_PATTERNS_SUBAGENT_BUDGET_MS - 1;
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toBeNull();
  });

  test('boundary: exactly the minimum budget → submit allowed', () => {
    const deadline = now + CYCLE_DEADLINE_RESERVE_MS + MIN_PATTERNS_SUBAGENT_BUDGET_MS;
    expect(clampSubagentBudgets(CONFIG, deadline, now)).toEqual({
      timeoutMs: MIN_PATTERNS_SUBAGENT_BUDGET_MS,
      waitTimeoutMs: MIN_PATTERNS_SUBAGENT_BUDGET_MS,
    });
  });

  test('deadline already past → null, never a negative timeout', () => {
    expect(clampSubagentBudgets(CONFIG, now - 1000, now)).toBeNull();
  });
});

describe('budgetCoversLastRun (#6177)', () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 6, 18);
  const run = (ms: number, timed_out: boolean, new_reflections = 25, ageMs = MIN) =>
    ({ ms, timed_out, new_reflections, at: new Date(now - ageMs).toISOString() });
  test.each([
    ['no recorded run', 2 * MIN, null, true],
    ['a budget above a completed run', 29 * MIN, run(20 * MIN, false), true],
    ['a budget equal to a completed run', 20 * MIN, run(20 * MIN, false), true],
    ['a budget below a completed run', 19 * MIN, run(20 * MIN, false), false],
    ['after a timeout, the whole budget the cut-off run had (its batch is halved)', 29 * MIN - 500, run(29 * MIN, true), true],
    ['after a timeout, part of that budget (a job that ran other phases first)', 10 * MIN, run(29 * MIN, true), false],
    ['after a timeout on one new reflection, the same budget', 29 * MIN, run(29 * MIN, true, 1), false],
    ['after a timeout on one new reflection, a quarter more', 37 * MIN, run(29 * MIN, true, 1), true],
    ['a record past the recheck age', 2 * MIN, run(60 * MIN, false, 25, LAST_RUN_RECHECK_MS), true],
  ] as const)('%s', (_label, budgetMs, lastRun, covers) => {
    expect(budgetCoversLastRun(budgetMs, lastRun, now)).toBe(covers);
  });
});

describe('newReflectionCap (#6177)', () => {
  const at = '2026-10-06T18:00:00.000Z';
  test.each([
    ['no recorded run', 25, null, 25],
    ['after a completed run', 25, { ms: 1, timed_out: false, new_reflections: 25, at }, 25],
    ['after a timed-out run: half its new reflections', 25, { ms: 1, timed_out: true, new_reflections: 25, at }, 12],
    ['after a timed-out run: never above the configured cap', 5, { ms: 1, timed_out: true, new_reflections: 25, at }, 5],
    ['after a timed-out run on one new reflection: one', 25, { ms: 1, timed_out: true, new_reflections: 1, at }, 1],
  ] as const)('%s', (_label, configured, lastRun, cap) => {
    expect(newReflectionCap(configured, lastRun)).toBe(cap);
  });
});

describe('parseLastRun (#6177)', () => {
  const at = '2026-10-06T14:48:00.000Z';
  test.each([
    [`{"ms":1801000,"timed_out":false,"new_reflections":25,"at":"${at}"}`, { ms: 1_801_000, timed_out: false, new_reflections: 25, at }],
    [`{"ms":1739684,"timed_out":true,"new_reflections":3,"at":"${at}"}`, { ms: 1_739_684, timed_out: true, new_reflections: 3, at }],
    [null, null],
    ['', null],
    ['not json', null],
    [`{"ms":"soon","timed_out":false,"new_reflections":1,"at":"${at}"}`, null],
    [`{"ms":-5,"timed_out":false,"new_reflections":1,"at":"${at}"}`, null],
    [`{"ms":1000,"timed_out":false,"new_reflections":0,"at":"${at}"}`, null],
    ['{"ms":1000,"timed_out":false,"new_reflections":1,"at":"yesterday"}', null],
    ['{"ms":1000,"timed_out":false}', null],
    ['[1000,true]', null],
  ] as const)('%p', (raw, parsed) => {
    expect(parseLastRun(raw)).toEqual(parsed);
  });
});

describe('selectReflectionBatch (#6177)', () => {
  // Newest first, as gatherReflections returns both lists.
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute));
  const ref = (minute: number) => ({ slug: `r-${minute}`, title: `R ${minute}`, excerpt: `x ${minute}`, updatedAt: at(minute), seat: null });
  const window = [50, 40, 30, 20, 10].map(ref);
  const slugs = (refs: Array<{ slug: string }>) => refs.map(r => r.slug);

  test.each([
    ['no watermark: the whole window is new', NaN, [50, 40, 30, 20, 10], 25, ['r-50', 'r-40', 'r-30', 'r-20', 'r-10'], [], 50],
    ['only reflections newer than the watermark are new', at(30).getTime(), [50, 40], 25, ['r-50', 'r-40'], ['r-30', 'r-20', 'r-10'], 50],
    ['a backlog over the cap takes its oldest first', NaN, [40, 30, 20, 10], 2, ['r-20', 'r-10'], [], 20],
    ['the cap applies to new reflections only', at(20).getTime(), [50, 40, 30], 2, ['r-40', 'r-30'], ['r-20', 'r-10'], 40],
    ['a backlog older than the window still drains', at(5).getTime(), [10, 9, 8, 7], 2, ['r-8', 'r-7'], [], 8],
    ['nothing new (a forced run): the newest window reflections up to the cap', at(50).getTime(), [], 2, ['r-50', 'r-40'], ['r-30', 'r-20', 'r-10'], 50],
  ] as const)('%s', (_label, stampMs, unweighedMinutes, cap, fresh, earlier, newestMinute) => {
    const batch = selectReflectionBatch(window, unweighedMinutes.map(ref), stampMs, cap);
    expect(slugs(batch.fresh)).toEqual([...fresh]);
    expect(slugs(batch.earlier)).toEqual([...earlier]);
    expect(batch.newestMs).toBe(at(newestMinute).getTime());
  });

  test('reflections sharing the boundary timestamp stay in one batch', () => {
    const tied = [
      { ...ref(20), slug: 'tie-b' },
      { ...ref(20), slug: 'tie-a' },
      ref(10),
    ];
    const batch = selectReflectionBatch(window, tied, NaN, 2);
    expect(slugs(batch.fresh)).toEqual(['tie-b', 'tie-a', 'r-10']);
    expect(batch.newestMs).toBe(at(20).getTime());
  });

  test('the evidence a run may cite covers the window and a batch read past it', () => {
    const batch = selectReflectionBatch(window, [9, 8].map(ref), at(5).getTime(), 2);
    expect(slugs(batch.evidence)).toEqual(['r-50', 'r-40', 'r-30', 'r-20', 'r-10', 'r-9', 'r-8']);
  });
});

describe('claim stamps timeout_at (deadlineAtMs ground truth)', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' }); // in-memory
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('job with timeout_ms → claim sets timeout_at ≈ now + timeout_ms', async () => {
    const before = Date.now();
    await queue.add('sync', {}, { timeout_ms: 600_000 });
    const claimed = await queue.claim('tok-dl-1', 30000, 'default', ['sync']);
    const after = Date.now();
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_at).not.toBeNull();
    const at = claimed!.timeout_at!.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 600_000 - 5_000);
    expect(at).toBeLessThanOrEqual(after + 600_000 + 5_000);
  });

  test('job without timeout_ms and no handler default → timeout_at stays null', async () => {
    // 'sync' is not in the long-handler default set, so no stamp either way.
    await queue.add('sync', { which: 'no-timeout' });
    // Drain the possibly-remaining job from the prior test first.
    let claimed = await queue.claim('tok-dl-2', 30000, 'default', ['sync']);
    while (claimed && claimed.timeout_ms != null) {
      claimed = await queue.claim('tok-dl-2', 30000, 'default', ['sync']);
    }
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_ms).toBeNull();
    expect(claimed!.timeout_at).toBeNull();
  });
});

describe('deadline plumbing wiring (structural)', () => {
  const workerSrc = readFileSync(new URL('../src/core/minions/worker.ts', import.meta.url), 'utf-8');
  // The context builder was extracted from executeJob into job-context.ts
  // (shared with `jobs run-child` for process isolation) — the deadlineAtMs
  // derivation lives there now; worker.ts calls buildJobContext.
  const jobContextSrc = readFileSync(new URL('../src/core/minions/job-context.ts', import.meta.url), 'utf-8');
  const jobsSrc = surfaceSource('jobs');
  const cycleSrc = readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf-8');
  const patternsSrc = readFileSync(new URL('../src/core/cycle/patterns.ts', import.meta.url), 'utf-8');

  test('job context exposes deadlineAtMs from the claim-time timeout_at stamp', () => {
    expect(jobContextSrc).toContain('deadlineAtMs: job.timeout_at != null ? job.timeout_at.getTime() : null');
    expect(workerSrc).toContain('buildJobContext(');
  });

  test('worker arms its abort timer from timeout_at when present (one absolute deadline)', () => {
    expect(workerSrc).toContain('job.timeout_at.getTime() - Date.now()');
  });

  test('autopilot-cycle, global-maintenance AND phase-wrapper handlers thread deadlineAtMs into runCycle', () => {
    const matches = jobsSrc.match(/deadlineAtMs: job\.deadlineAtMs/g) ?? [];
    expect(matches.length).toBe(3);
  });

  test('runCycle forwards deadlineAtMs to the patterns phase', () => {
    expect(cycleSrc).toContain('deadlineAtMs: opts.deadlineAtMs ?? null');
  });

  test('patterns submits + waits with the CLAMPED budgets, not raw config', () => {
    expect(patternsSrc).toContain('timeout_ms: budgets.timeoutMs');
    expect(patternsSrc).toContain('timeoutMs: budgets.waitTimeoutMs');
    expect(patternsSrc).not.toContain('timeout_ms: config.subagentTimeoutMs');
    expect(patternsSrc).not.toContain('timeoutMs: config.subagentWaitTimeoutMs');
  });

  test('patterns cancels the child on wait timeout (child clock starts at ITS claim)', () => {
    // A child that sat queued can outlive the parent deadline the wait was
    // clamped to; the timeout path must strip it so it can't keep spending.
    expect(patternsSrc).toContain('queue.cancelJob(job.id)');
  });

  test('patterns skips honestly when the remaining budget is too small', () => {
    expect(patternsSrc).toContain('insufficient_cycle_budget');
    // Budget gate sits AFTER the provider probe so a no-provider brain
    // still reports no_provider (cheaper, more actionable reason).
    const probeIdx = patternsSrc.indexOf("skipped('no_provider'");
    // The budget gate's call site inside runPhasePatterns.
    const budgetIdx = patternsSrc.indexOf('admitChildBudgets(config');
    expect(probeIdx).toBeGreaterThan(0);
    expect(budgetIdx).toBeGreaterThan(probeIdx);
  });
});

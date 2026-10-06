// #6177: the patterns subagent's run time grew toward its 30-minute timeout,
// and inside a maintenance job a run that the remaining budget could not
// cover was still submitted, spent its tokens and died before it wrote
// anything (the child writes its pattern pages in its final turns). The phase
// now records how long its last run needed, skips a cycle submission the
// remaining budget cannot cover, and hands the child only the reflections no
// completed run has weighed yet, oldest first and capped per run.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const LAST_RUN_KEY = 'dream.patterns.last_run';
const STAMP_KEY = 'dream.patterns.last_evidence_ts';
const MIN = 60_000;

// The child row the mocked wait hands back; each test sets the outcome it drives.
let child: { status: string; error_text: string | null; runMs: number } = { status: 'completed', error_text: null, runMs: 0 };
// When set, the phase's own wait runs out instead (the child may never have started).
let waitRunsOut = false;
class TimeoutError extends Error {}

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
}));

const childRow = (jobId: number) => {
  const finished = new Date();
  return {
    id: jobId, status: child.status, error_text: child.error_text,
    started_at: new Date(finished.getTime() - child.runMs), finished_at: finished,
  };
};

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError,
  waitForCompletion: async (_queue: unknown, jobId: number) => childRow(jobId),
  waitForCompletionRenewing: async (_queue: unknown, jobId: number, opts?: { renew?: () => Promise<void> }) => {
    if (opts?.renew) await opts.renew();
    if (waitRunsOut) throw new TimeoutError('wait ran out');
    return childRow(jobId);
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-run-budget-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  child = { status: 'completed', error_text: null, runMs: 12 * MIN };
  waitRunsOut = false;
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
});

// Inside the default 30-day lookback whenever the suite runs.
const BASE_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 24 * 3_600_000;
const reflectionAt = (i: number) => new Date(BASE_MS + i * MIN).toISOString();

/** Reflections 0..count-1, reflection i updated i minutes after BASE_MS. */
async function seedReflections(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, updated_at)
       VALUES ($1, 'note', $2, $3, $4::timestamptz)`,
      [`wiki/personal/reflections/2026-10-06-r${i}`, `Reflection ${i}`, `Excerpt body of reflection ${i}.`, reflectionAt(i)],
    );
  }
}

const lastRun = (ms: number, timed_out: boolean, new_reflections: number, ageMs = MIN) =>
  JSON.stringify({ ms, timed_out, new_reflections, at: new Date(Date.now() - ageMs).toISOString() });
const recorded = async () => JSON.parse((await engine.getConfig(LAST_RUN_KEY))!);

async function submittedPrompts(): Promise<string[]> {
  const rows = await engine.executeRaw<{ prompt: string }>(
    `SELECT data->>'prompt' AS prompt FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
  );
  return rows.map(r => r.prompt);
}

const inCycle = (remainingMs: number) => ({ brainDir, dryRun: false, deadlineAtMs: Date.now() + remainingMs });

describe('patterns cycle budget covers the last run (#6177)', () => {
  test('a cycle whose remaining budget is below the last run skips without submitting a child', async () => {
    await seedReflections(3);
    await engine.setConfig(LAST_RUN_KEY, lastRun(20 * MIN, false, 3));

    const result = await runPhasePatterns(engine, inCycle(10 * MIN));

    expect(result.status).toBe('skipped');
    expect(result.details).toMatchObject({ reason: 'insufficient_cycle_budget', last_run_ms: 20 * MIN, last_run_timed_out: false });
    expect(result.summary).toContain('limited by the time left in this job');
    expect(result.summary).toContain('docs/guides/troubleshooting.md#dream-patterns-runs-outgrow-the-cycle-budget');
    expect(await submittedPrompts()).toHaveLength(0);
  });

  test('after a child its timeout stopped, a job with the same budget runs half the new reflections; a job with less waits', async () => {
    await seedReflections(3);
    child = { status: 'dead', error_text: 'timeout exceeded', runMs: 29 * MIN };

    const first = await runPhasePatterns(engine, inCycle(30 * MIN));
    expect(first.status).toBe('fail');
    expect(await recorded()).toMatchObject({ ms: 29 * MIN, timed_out: true, new_reflections: 3 });

    const midJob = await runPhasePatterns(engine, inCycle(10 * MIN));
    expect(midJob.details).toMatchObject({ reason: 'insufficient_cycle_budget', last_run_timed_out: true });

    child = { status: 'completed', error_text: null, runMs: 12 * MIN };
    const second = await runPhasePatterns(engine, inCycle(30 * MIN));
    expect(second.status).toBe('ok');
    expect(second.details).toMatchObject({ new_reflections: 1 });
    const prompts = await submittedPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Excerpt body of reflection 0.');
    expect(prompts[1]).not.toContain('Excerpt body of reflection 1.');
    expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(0));
  });

  test.each([
    ['a timeout on a single new reflection holds back a job with the same budget', lastRun(29 * MIN, true, 1), 'skipped'],
    ['a record past its 24h recheck age holds nothing back', lastRun(60 * MIN, false, 3, 25 * 3_600_000), 'ok'],
  ] as const)('%s', async (_label, record, status) => {
    await seedReflections(3);
    await engine.setConfig(LAST_RUN_KEY, record);

    const result = await runPhasePatterns(engine, inCycle(30 * MIN));

    expect(result.status).toBe(status);
    expect(await submittedPrompts()).toHaveLength(status === 'ok' ? 1 : 0);
  });

  test('a direct run is never gated and records the run time it measured', async () => {
    await seedReflections(3);
    await engine.setConfig(LAST_RUN_KEY, lastRun(60 * MIN, false, 3));

    const result = await runPhasePatterns(engine, { brainDir, dryRun: false });

    expect(result.status).toBe('ok');
    expect(await submittedPrompts()).toHaveLength(1);
    expect(await recorded()).toMatchObject({ ms: 12 * MIN, timed_out: false, new_reflections: 3 });
  });

  test.each([
    ['a child that died for another reason', () => { child = { status: 'dead', error_text: 'provider refused the request', runMs: MIN }; }],
    ['the phase wait running out, the child perhaps never started', () => { waitRunsOut = true; }],
  ])('%s leaves the recorded run untouched', async (_label, drive) => {
    await seedReflections(3);
    const before = lastRun(9 * MIN, false, 3);
    await engine.setConfig(LAST_RUN_KEY, before);
    drive();

    const result = await runPhasePatterns(engine, inCycle(30 * MIN));

    expect(result.status).toBe('fail');
    expect(await engine.getConfig(LAST_RUN_KEY)).toBe(before);
  });

  test('a failed write of the run record leaves a completed run ok and stamped', async () => {
    await seedReflections(3);
    const setConfig = engine.setConfig.bind(engine);
    const spy = spyOn(engine, 'setConfig').mockImplementation(async (key: string, value: string) => {
      if (key === LAST_RUN_KEY) throw new Error('config write refused');
      return setConfig(key, value);
    });
    try {
      const result = await runPhasePatterns(engine, { brainDir, dryRun: false });
      expect(result.status).toBe('ok');
      expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(2));
      expect(await engine.getConfig(LAST_RUN_KEY)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('patterns hands the child only reflections no completed run has weighed (#6177)', () => {
  test('earlier reflections appear as titles only; the new ones carry their excerpts', async () => {
    await seedReflections(5);
    await engine.setConfig(STAMP_KEY, reflectionAt(2));

    const result = await runPhasePatterns(engine, { brainDir, dryRun: false });

    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ reflections_considered: 5, new_reflections: 2 });
    const [prompt] = await submittedPrompts();
    expect(prompt).toContain('Excerpt body of reflection 4.');
    expect(prompt).toContain('Excerpt body of reflection 3.');
    expect(prompt).toContain('[[wiki/personal/reflections/2026-10-06-r2]]');
    expect(prompt).not.toContain('Excerpt body of reflection 2.');
    expect(prompt).not.toContain('Excerpt body of reflection 0.');
    expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(4));
  });

  test('a backlog over dream.patterns.max_new_reflections drains oldest first, one capped run at a time', async () => {
    await seedReflections(4);
    await engine.setConfig(STAMP_KEY, reflectionAt(0));
    await engine.setConfig('dream.patterns.max_new_reflections', '2');

    const first = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(first.details).toMatchObject({ new_reflections: 2 });
    expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(2));

    const second = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(second.details).toMatchObject({ new_reflections: 1 });
    expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(3));

    const [firstPrompt, secondPrompt] = await submittedPrompts();
    expect(firstPrompt).toContain('Excerpt body of reflection 1.');
    expect(firstPrompt).toContain('Excerpt body of reflection 2.');
    expect(firstPrompt).not.toContain('reflections/2026-10-06-r3');
    expect(secondPrompt).toContain('Excerpt body of reflection 3.');
    expect(secondPrompt).not.toContain('Excerpt body of reflection 2.');
  });

  test('a backlog larger than the 100-reflection window starts at its oldest reflection', async () => {
    await seedReflections(105);
    await engine.setConfig(STAMP_KEY, reflectionAt(0));

    const result = await runPhasePatterns(engine, { brainDir, dryRun: false });

    expect(result.details).toMatchObject({ reflections_considered: 100, new_reflections: 25 });
    const [prompt] = await submittedPrompts();
    expect(prompt).toContain('Excerpt body of reflection 1.');
    expect(prompt).toContain('Excerpt body of reflection 25.');
    expect(prompt).not.toContain('Excerpt body of reflection 26.');
    expect(await engine.getConfig(STAMP_KEY)).toBe(reflectionAt(25));
  });
});

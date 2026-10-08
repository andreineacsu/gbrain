/**
 * #4578: brain-wide maintenance on a large brain died at its fixed 30-minute
 * deadline and restarted every phase on each run, so late phases never ran.
 * The handler now stops starting phases the deadline would cut off, resumes
 * at the next phase on the following run, skips a phase that killed an
 * earlier job, and the deadline is configurable. Doctor names the phase and
 * the command that runs it without the job deadline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LAST_GLOBAL_AT_KEY } from '../src/core/cycle.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  GLOBAL_MAINTENANCE_PROGRESS_KEY,
  makeAutopilotGlobalMaintenanceHandler,
  readGlobalMaintenanceProgress,
} from '../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { dispatchGlobalMaintenance, resolveGlobalMaintenanceTimeoutMs } from '../src/commands/autopilot-fanout.ts';
import { globalMaintenanceTimeoutsCheck } from '../src/commands/doctor/checks/global-maintenance-timeouts.ts';

let engine: PGLiteEngine;
let repoPath: string;
let schemaVersion: string;
const phases = ['orphans', 'purge'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-global-resume-'));
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const run = (job: Record<string, unknown>) => makeAutopilotGlobalMaintenanceHandler(engine)(
  { id: 7001, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases, repoPath }, ...job } as never) as Promise<any>;

describe('autopilot-global-maintenance resumes across jobs (#4578)', () => {
  test('a phase the deadline would cut off is deferred to the next job, which resumes there and completes the pass', async () => {
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ durations: { purge: 20 * 60_000 } }));
    const first = await run({ deadlineAtMs: Date.now() + 5 * 60_000 });
    expect(first.report.phases.map((p: { phase: string }) => p.phase)).toEqual(['orphans']);
    expect(first.report.deferred_phases).toEqual(['purge']);
    expect(first.report.status).toBe('partial');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    expect((await readGlobalMaintenanceProgress(engine)).next_phase).toBe('purge');

    const second = await run({ id: 7002 });
    expect(second.report.phases.map((p: { phase: string }) => p.phase)).toEqual(['purge']);
    expect(second.report.deferred_phases).toBeUndefined();
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
    expect((await readGlobalMaintenanceProgress(engine)).next_phase).toBeUndefined();
  }, 60_000);

  test('a phase that was running when an earlier job died is skipped for the pass; later phases still run', async () => {
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ running_phase: 'orphans', running_job: '6999:0', next_phase: 'orphans' }));
    const result = await run({});
    expect(result.report.phases.find((p: { phase: string }) => p.phase === 'orphans'))
      .toMatchObject({ status: 'skipped', details: { reason: 'timed_out_previous_job', recovery: 'gbrain dream --phase orphans' } });
    expect(result.report.phases.find((p: { phase: string }) => p.phase === 'purge')?.status).not.toBe('skipped');
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const progress = await readGlobalMaintenanceProgress(engine);
    expect(progress.timeouts?.orphans?.count).toBe(1);
    expect(progress.running_phase).toBeUndefined();
  }, 60_000);

  test('the job deadline follows env > config > the autopilot default', async () => {
    expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(1_800_000);
    await engine.setConfig('autopilot.global_maintenance_timeout_ms', '7200000');
    expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(7_200_000);
    await withEnv({ GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS: '5400000' }, async () => {
      expect(await resolveGlobalMaintenanceTimeoutMs(engine, 1_800_000)).toBe(5_400_000);
    });
    const added: Array<{ opts: { timeout_ms: number } }> = [];
    const queue = { add: async (_n: string, _d: unknown, opts: { timeout_ms: number }) => { added.push({ opts }); return { id: 1 }; } } as never;
    await dispatchGlobalMaintenance(engine, queue, { repoPath, slot: 's', timeoutMs: 1_800_000, jsonMode: true, emit: () => {} });
    expect(added[0]!.opts.timeout_ms).toBe(7_200_000);
  });
});

describe('global_maintenance_timeouts doctor check (#4578)', () => {
  async function deadJobs(n: number, error = 'timeout exceeded') {
    const queue = new MinionQueue(engine);
    for (let i = 0; i < n; i++) {
      const job = await queue.add('autopilot-global-maintenance', {}, { idempotency_key: `dead-${error}-${i}` });
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'dead', error_text = $2, finished_at = now() + ($1 || ' seconds')::interval WHERE id = $3`,
        [String(i), error, job.id]);
    }
  }

  test('ok with no deaths; warns after three consecutive timeout deaths and names the phase and its command', async () => {
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
    await deadJobs(2);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
    await deadJobs(1, 'timeout exceeded');
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ timeouts: { embed: { count: 3, last_at: '2026-10-01T00:00:00Z' } } }));
    const check = await globalMaintenanceTimeoutsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({
      code: 'global_maintenance_timeouts',
      fix: { kind: 'run_command', argv: ['gbrain', 'dream', '--phase', 'embed'] },
      docs: 'docs/guides/troubleshooting.md#global-maintenance-timeouts',
      phases: [{ phase: 'embed', consecutive_deaths: 3 }],
    });
    expect(check.message).toContain('gbrain dream --phase embed');
    expect(check.message).toContain('autopilot.global_maintenance_timeout_ms');
  });

  test('a completed job after timeout deaths clears the warning', async () => {
    await deadJobs(3);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('warn');
    const job = await new MinionQueue(engine).add('autopilot-global-maintenance', {}, { idempotency_key: 'completed-after' });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now() + interval '1 hour' WHERE id = $1`, [job.id]);
    expect((await globalMaintenanceTimeoutsCheck(engine)).status).toBe('ok');
  });

  // #6303: the job outlives its patterns child. The child dies at the budget
  // the job gave it, the phase fails with PATTERNS_CHILD_DEAD, and the job
  // still completes, so neither job deaths nor the handler's timeouts see it.
  // A run either ran a child (`outcome` + the child row's end) or skipped the phase for `skipped`.
  type ChildRun =
    | { outcome: string; child: 'timeout exceeded' | 'prompt_too_long: too long' | 'cancelled' | 'completed' }
    | { skipped: string };
  async function maintenanceJobWithPatternsChild(i: number, run: ChildRun) {
    let patterns: Record<string, unknown>;
    let child: number | null = null;
    if ('skipped' in run) {
      patterns = { phase: 'patterns', status: 'skipped', duration_ms: 0, summary: 'skipped', details: { reason: run.skipped } };
    } else {
      const [kid] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_jobs (submission_authority, name, queue, status, error_text, finished_at)
         VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-test', $1, $2, now())
         RETURNING id`,
        [run.child === 'completed' || run.child === 'cancelled' ? run.child : 'dead', run.child === 'completed' ? null : run.child]);
      child = kid!.id;
      patterns = { phase: 'patterns', status: run.outcome === 'completed' ? 'ok' : 'fail', duration_ms: 0, summary: 'child ended',
        details: { child_outcome: run.outcome, job_id: child },
        ...(run.outcome === 'completed' ? {} : { error: { code: `PATTERNS_CHILD_${run.outcome.toUpperCase()}` } }) };
    }
    const owner = await new MinionQueue(engine).add('autopilot-global-maintenance', {}, { idempotency_key: `owner-${i}` });
    const result = { partial: true, status: 'partial', report: { status: 'partial', reason: 'deadline', phases: [
      { phase: 'orphans', status: 'ok', duration_ms: 1, summary: 'ok', details: {} },
      patterns,
    ] } };
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', result = $2::text::jsonb, finished_at = now() + ($1 || ' seconds')::interval WHERE id = $3`,
      [String(i), JSON.stringify(result), owner.id]);
    return { owner: owner.id, child };
  }

  const timedOut: ChildRun = { outcome: 'dead', child: 'timeout exceeded' };
  test.each([
    { label: 'three consecutive child timeouts warn', runs: [timedOut, timedOut, timedOut], status: 'warn' },
    { label: 'a parent wait timeout (child cancelled) counts as a child timeout', runs: [timedOut, timedOut, { outcome: 'timeout', child: 'cancelled' }], status: 'warn' },
    { label: 'a later paid-loop breaker skip keeps the warning', runs: [timedOut, timedOut, timedOut, { skipped: 'dream_breaker_tripped' }], status: 'warn' },
    { label: 'two child timeouts stay ok', runs: [timedOut, timedOut], status: 'ok' },
    { label: 'a completed child after timeouts clears it', runs: [timedOut, timedOut, timedOut, { outcome: 'completed', child: 'completed' }], status: 'ok' },
    { label: 'a later idle skip (evidence a completed run consumed) clears it', runs: [timedOut, timedOut, timedOut, { skipped: 'no_new_evidence' }], status: 'ok' },
    { label: 'deaths that are not timeouts are left to queue_health and dream_paid_loop', runs: [1, 2, 3].map(() => ({ outcome: 'dead', child: 'prompt_too_long: too long' }) as ChildRun), status: 'ok' },
  ])('$label', async ({ runs, status }) => {
    const ids = [];
    for (const [i, run] of runs.entries()) ids.push(await maintenanceJobWithPatternsChild(i, run));
    const check = await globalMaintenanceTimeoutsCheck(engine);
    expect(check.status).toBe(status);
    if (status === 'ok') return;
    const newestFirst = ids.filter(r => r.child !== null).slice(-3).reverse();
    expect(check.details).toMatchObject({
      fix: { kind: 'run_command', argv: ['gbrain', 'dream', '--phase', 'patterns'] },
      child_timeouts: [{ phase: 'patterns', job_ids: newestFirst.map(r => r.owner), child_job_ids: newestFirst.map(r => r.child) }],
    });
    for (const text of ['while the jobs completed', 'gbrain dream --phase patterns (a paid model run: ask the user first)',
      'gbrain config set dream.patterns.subagent_timeout_ms <ms>', 'gbrain doctor --only dream_paid_loop --json']) {
      expect(check.message).toContain(text);
    }
  });

  test('jobs dying at the deadline name their phase; a child timeout in another phase is reported beside them', async () => {
    // The completed jobs finish 10 s before the three deaths, so the deaths are the last three finished jobs.
    for (const i of [-10, -9, -8]) await maintenanceJobWithPatternsChild(i, timedOut);
    await deadJobs(3);
    await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify({ running_phase: 'embed' }));
    const check = await globalMaintenanceTimeoutsCheck(engine);
    expect(check.status).toBe('warn');
    expect((check.details as { fix: unknown }).fix).toEqual({ kind: 'run_command', argv: ['gbrain', 'dream', '--phase', 'embed'] });
    expect(check.message).toContain('jobs (#');
    expect(check.message).toContain(') died at their deadline; the patterns phase\'s subagent child was cut off at its timeout');
    expect(check.message).not.toContain('(a paid model run');
  });
});

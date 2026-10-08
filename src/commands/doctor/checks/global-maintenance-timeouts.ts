/**
 * global_maintenance_timeouts doctor check (#4578): the brain-wide maintenance
 * job (`autopilot-global-maintenance`) keeps dying at its deadline. Warns when
 * its last three finished jobs were all timeout deaths, when one phase was
 * running in three consecutive job deaths (the handler then skips it each
 * pass), or when a phase's subagent child was cut off at its timeout in the
 * last three completed jobs that ran it (#6303: the job outlives its child, so
 * neither job deaths nor the handler's progress record it). The fix runs the
 * phase alone, without the job deadline, and the deadline itself is
 * configurable.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readGlobalMaintenanceProgress } from '../../../core/minions/handlers/autopilot-global-maintenance.ts';

const DOCS = 'docs/guides/troubleshooting.md#global-maintenance-timeouts';
const DEATHS = 3;
/** Completed maintenance jobs whose phase results are read for child timeouts. */
const RECENT_COMPLETED_JOBS = 50;
/**
 * Skip reasons of a phase that had nothing to run (no new evidence after a
 * completed run, too little evidence, turned off, no model). Such a result
 * ends an older child-timeout streak; any other skip (the paid-loop breaker,
 * the cycle budget, admission) keeps it.
 */
const IDLE_SKIP_REASONS = ['disabled', 'insufficient_evidence', 'no_new_evidence', 'no_provider'];

interface ChildTimeouts { phase: string; job_ids: number[]; child_job_ids: number[] }

/** A job the queue dead-lettered at its timeout ('timeout exceeded' or 'wall-clock timeout exceeded'). */
function diedAtTimeout(status: string | null, errorText: string | null): boolean {
  return status === 'dead' && /timeout exceeded/.test(errorText ?? '');
}

/**
 * Phases whose child, in each of the last DEATHS completed maintenance jobs
 * that ran one, was cut off at its timeout: dead at its own timeout, or
 * cancelled when the phase stopped waiting (`child_outcome: 'timeout'`). Read
 * from the phase results the job recorded (`details.child_outcome`,
 * `details.job_id`) and the child's own row. An idle skip ends the streak.
 */
async function readChildTimeouts(engine: BrainEngine): Promise<ChildTimeouts[]> {
  const rows = await engine.executeRaw<{ job_id: number; phase: string; child_outcome: string | null; child_job_id: number | null; child_status: string | null; child_error: string | null }>(
    `SELECT j.id AS job_id, p->>'phase' AS phase, p->'details'->>'child_outcome' AS child_outcome,
            c.id AS child_job_id, c.status AS child_status, c.error_text AS child_error
       FROM (SELECT id, result, finished_at FROM minion_jobs
              WHERE name = 'autopilot-global-maintenance' AND status = 'completed'
              ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT ${RECENT_COMPLETED_JOBS}) j
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.result->'report'->'phases') = 'array'
                                                   THEN j.result->'report'->'phases' ELSE '[]'::jsonb END) p
       LEFT JOIN minion_jobs c ON c.id = CASE WHEN p->'details'->>'job_id' ~ '^[0-9]{1,18}$'
                                              THEN (p->'details'->>'job_id')::bigint END
      WHERE p->'details'->>'child_outcome' IS NOT NULL OR p->'details'->>'reason' = ANY($1::text[])
      ORDER BY j.finished_at DESC NULLS LAST, j.id DESC`, [IDLE_SKIP_REASONS]);
  const byPhase = new Map<string, typeof rows>();
  for (const row of rows) byPhase.set(row.phase, [...byPhase.get(row.phase) ?? [], row]);
  const result: ChildTimeouts[] = [];
  for (const [phase, runs] of byPhase) {
    const last: typeof rows = [];
    for (const run of runs) {
      if (run.child_outcome === null || last.length === DEATHS) break;
      last.push(run);
    }
    const timedOut = (r: (typeof rows)[number]) => r.child_outcome === 'timeout' || diedAtTimeout(r.child_status, r.child_error);
    if (last.length === DEATHS && last.every(timedOut)) {
      result.push({ phase, job_ids: last.map(r => Number(r.job_id)), child_job_ids: last.flatMap(r => r.child_job_id == null ? [] : [Number(r.child_job_id)]) });
    }
  }
  return result;
}

export async function globalMaintenanceTimeoutsCheck(engine: BrainEngine): Promise<Check> {
  try {
    const recent = await engine.executeRaw<{ id: number; status: string; error_text: string | null }>(
      `SELECT id, status, error_text FROM minion_jobs
        WHERE name = 'autopilot-global-maintenance' AND status IN ('completed', 'failed', 'dead', 'cancelled')
        ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT ${DEATHS}`);
    const timeoutDeaths = recent.length === DEATHS && recent.every(job => diedAtTimeout(job.status, job.error_text));
    const progress = await readGlobalMaintenanceProgress(engine);
    const phases = Object.entries(progress.timeouts ?? {})
      .filter(([, t]) => t.count >= DEATHS)
      .map(([phase, t]) => ({ phase, consecutive_deaths: t.count, last_at: t.last_at }));
    const childTimeouts = await readChildTimeouts(engine);
    // Jobs dying at the deadline outrank a child timeout: name the phase they died in.
    const phase = phases[0]?.phase ?? (timeoutDeaths ? progress.running_phase : undefined) ?? childTimeouts[0]?.phase
      ?? progress.running_phase ?? progress.next_phase;
    const childPhase = childTimeouts.find(c => c.phase === phase);
    if (!timeoutDeaths && phases.length === 0 && childTimeouts.length === 0) {
      return { name: 'global_maintenance_timeouts', status: 'ok', message: 'Brain-wide maintenance jobs are finishing within their deadline.' };
    }
    const fix = phase
      ? { kind: 'run_command', argv: ['gbrain', 'dream', '--phase', phase] }
      : { kind: 'run_command', argv: ['gbrain', 'config', 'set', 'autopilot.global_maintenance_timeout_ms', '3600000'] };
    const causes = [
      ...(phases.length > 0
        ? [`phase ${phases.map(p => p.phase).join(', ')} was running in ${DEATHS}+ consecutive autopilot-global-maintenance job deaths and is skipped each pass`]
        : timeoutDeaths ? [`the last ${DEATHS} autopilot-global-maintenance jobs (${recent.map(j => `#${j.id}`).join(', ')}) died at their deadline`] : []),
      ...childTimeouts.map(c => `the ${c.phase} phase's subagent child was cut off at its timeout in each of the last ${DEATHS} autopilot-global-maintenance jobs `
        + `that ran it (${c.job_ids.map(id => `#${id}`).join(', ')}) while the jobs completed; a child gets the smaller of the time left in its job `
        + `and dream.${c.phase}.subagent_timeout_ms`),
    ];
    const cause = causes.join('; ');
    return {
      name: 'global_maintenance_timeouts',
      status: 'warn',
      message: `Brain-wide maintenance is not finishing: ${cause}. `
        + (phase ? `Run the phase without the job deadline: gbrain dream --phase ${phase}${childPhase ? ' (a paid model run: ask the user first)' : ''}. ` : '')
        + `Raise the job deadline with: gbrain config set autopilot.global_maintenance_timeout_ms <ms> (or GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS)`
        + childTimeouts.map(c => `, or the child's own limit with: gbrain config set dream.${c.phase}.subagent_timeout_ms <ms>`).join('')
        + '. '
        + (childTimeouts.length > 0
          ? 'These child deaths also count toward the dream paid-loop breaker, which may now refuse the phase: `gbrain doctor --only dream_paid_loop --json` shows it and names the reset. '
          : '')
        + `See ${DOCS}.`,
      details: { code: 'global_maintenance_timeouts', cause, fix, docs: DOCS, recent_job_ids: recent.map(j => j.id), phases,
        ...(childTimeouts.length > 0 ? { child_timeouts: childTimeouts } : {}), resume_phase: progress.next_phase ?? null },
    };
  } catch (error) {
    return { name: 'global_maintenance_timeouts', status: 'warn', message: `Global maintenance history could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' } };
  }
}

async function runGlobalMaintenanceTimeouts(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { status, message, details } = await globalMaintenanceTimeoutsCheck(connectedEngine(ctx));
  checks.push({ name: 'global_maintenance_timeouts', status, message, details });
  return checks;
}

export const globalMaintenanceTimeoutsEntry: DoctorEntry = {
  name: 'global_maintenance_timeouts',
  emits: ['global_maintenance_timeouts'],
  run: runGlobalMaintenanceTimeouts,
};

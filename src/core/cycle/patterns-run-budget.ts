/**
 * How much one patterns run takes on, and whether a cycle can afford it.
 *
 * The patterns child writes its pattern pages in its final turns, so a run its
 * deadline cuts off has usually written nothing and its tokens are lost. Two
 * state rows steer the phase:
 *   - the evidence watermark (`dream.patterns.last_evidence_ts`): reflections
 *     at or before it were weighed by a completed run, so a run gets in full
 *     only the newer ones, oldest first and capped (`selectReflectionBatch`);
 *   - the last run (`dream.patterns.last_run`, `PatternsLastRun`): how long the
 *     child ran and over how many new reflections, which sets the next run's
 *     cap (`newReflectionCap`) and whether a cycle's budget covers it
 *     (`budgetCoversLastRun`).
 */
import type { BrainEngine } from '../engine.ts';
import type { MinionJob } from '../minions/types.ts';
import type { ReflectionRef } from './patterns.ts';

/**
 * The last patterns child that measured a run time: it completed, or its
 * timeout stopped it (it then needed more than `ms`). `at` is when it was
 * recorded. Scoped like the evidence watermark: per source and incarnation on
 * a managed brain, one row otherwise.
 */
export interface PatternsLastRun { ms: number; timed_out: boolean; new_reflections: number; at: string }

/** A record this old no longer holds a cycle back, so a skipped phase retries without an operator. */
export const LAST_RUN_RECHECK_MS = 24 * 60 * 60 * 1000;
/**
 * A timed-out child's recorded run time exceeds the budget it had by its kill
 * latency, and the next job's budget differs by start-up jitter: a budget
 * within this much of the recorded time counts as the same budget.
 */
const TIMED_OUT_RUN_SLACK_MS = 60 * 1000;
/** The same work after a timeout needs more time than it had, by an unknown amount; ask for a quarter more. */
const TIMED_OUT_RUN_HEADROOM = 1.25;

/** Parse the last-run state row. A malformed row reads as no record, so the budget check fails open. */
export function parseLastRun(raw: string | null | undefined): PatternsLastRun | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; /* malformed row: fail open */ }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { ms, timed_out, new_reflections, at } = value as Record<string, unknown>;
  const valid = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && typeof timed_out === 'boolean'
    && Number.isSafeInteger(new_reflections) && (new_reflections as number) >= 1
    && typeof at === 'string' && Number.isFinite(Date.parse(at));
  return valid ? { ms: ms as number, timed_out, new_reflections: new_reflections as number, at } : null;
}

/**
 * New reflections the next run weighs in full: the configured cap, or after a
 * timed-out run half of what that run had, so the phase does less instead of
 * repeating work that did not fit.
 */
export function newReflectionCap(configured: number, lastRun: PatternsLastRun | null): number {
  if (!lastRun?.timed_out) return configured;
  return Math.max(1, Math.min(configured, Math.floor(lastRun.new_reflections / 2)));
}

/**
 * Whether a cycle's child budget covers the next run, judged by the last one.
 * A completed run needs its run time again. After a timeout the next run has
 * half the new reflections (`newReflectionCap`), so it needs about the budget
 * the cut-off run had; a single new reflection cannot shrink, so it needs more
 * time than the run that timed out. A record older than `LAST_RUN_RECHECK_MS`
 * no longer holds a cycle back.
 */
export function budgetCoversLastRun(budgetMs: number, lastRun: PatternsLastRun | null, nowMs: number): boolean {
  if (!lastRun || nowMs - Date.parse(lastRun.at) >= LAST_RUN_RECHECK_MS) return true;
  if (!lastRun.timed_out) return budgetMs >= lastRun.ms;
  return lastRun.new_reflections > 1
    ? budgetMs >= lastRun.ms - TIMED_OUT_RUN_SLACK_MS
    : budgetMs >= lastRun.ms * TIMED_OUT_RUN_HEADROOM;
}

/** Why `budgetCoversLastRun` refused, for the skip summary. */
export function lastRunNeed(lastRun: PatternsLastRun): string {
  const secs = `${Math.round(lastRun.ms / 1000)}s`;
  if (!lastRun.timed_out) return `the last patterns run, which took ${secs}`;
  return lastRun.new_reflections > 1
    ? `the ${secs} the last patterns run had before its timeout stopped it`
    : `more than the ${secs} after which its timeout stopped the last patterns run on a single new reflection`;
}

/**
 * Record how long this run's child ran, for the next run's cap and budget
 * check. Only a completed child, or one its timeout stopped, measures that;
 * any other ending (including the phase's own wait running out, when the child
 * may never have started) keeps the previous record. A failed write is logged
 * and the phase result stands, since the record only steers later runs.
 */
export async function recordLastRun(engine: BrainEngine, lastRunKey: string, child: MinionJob | null,
  newReflections: number, nowMs = Date.now()): Promise<void> {
  const ranMs = child?.started_at && child.finished_at
    ? new Date(child.finished_at).getTime() - new Date(child.started_at).getTime() : NaN;
  const timedOut = child?.status === 'dead' && /timeout exceeded$/.test(child.error_text ?? '');
  if (!(ranMs >= 0) || (child?.status !== 'completed' && !timedOut)) return;
  const lastRun: PatternsLastRun = { ms: ranMs, timed_out: timedOut, new_reflections: newReflections, at: new Date(nowMs).toISOString() };
  try {
    await engine.setConfig(lastRunKey, JSON.stringify(lastRun));
  } catch (e) {
    process.stderr.write(`[dream] patterns: recording the last run time failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export interface ReflectionBatch {
  /** Reflections this run weighs in full, newest first. */
  fresh: ReflectionRef[];
  /** Window reflections at or before the evidence watermark: earlier runs weighed them. */
  earlier: ReflectionRef[];
  /** Every reflection the run may cite (the window plus the batch), for quote grounding and seat credit. */
  evidence: ReflectionRef[];
  /** Newest `updated_at` in `fresh`, the watermark a completed run stamps. */
  newestMs: number;
}

/**
 * Pick the reflections a run weighs in full. `unweighed` holds the oldest
 * reflections newer than the watermark (newest first), read past the window
 * so a backlog larger than the window still drains; the batch is the oldest
 * `cap` of them, and the rest stays newer than the stamp this run leaves.
 * Reflections sharing the boundary timestamp stay in one batch, because the
 * stamp would otherwise mark the one left out as weighed. With nothing new (a
 * forced `--once` run) the newest window reflections up to `cap` form the batch.
 */
export function selectReflectionBatch(window: ReflectionRef[], unweighed: ReflectionRef[], stampMs: number, cap: number): ReflectionBatch {
  if (unweighed.length === 0) {
    const fresh = window.slice(0, cap);
    return { fresh, earlier: window.slice(cap), evidence: window, newestMs: fresh[0]!.updatedAt.getTime() };
  }
  const limitMs = unweighed[Math.max(0, unweighed.length - cap)]!.updatedAt.getTime();
  const fresh = unweighed.filter(r => r.updatedAt.getTime() <= limitMs);
  const inWindow = new Set(window.map(r => r.slug));
  return {
    fresh,
    earlier: window.filter(r => r.updatedAt.getTime() <= stampMs),
    evidence: [...window, ...fresh.filter(r => !inWindow.has(r.slug))],
    newestMs: fresh[0]!.updatedAt.getTime(),
  };
}

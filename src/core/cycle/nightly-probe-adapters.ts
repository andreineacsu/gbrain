/**
 * Bridge between `NightlyProbeDeps` (object-shape) and the existing CLI
 * functions (argv-shape) for `runEvalLongMemEval` + `runEvalCrossModal`.
 *
 * Per eng-D2: the existing CLI functions take argv arrays, not the object
 * shape the nightly-probe phase expects. The adapter converts; the CLI
 * functions stay unchanged.
 *
 * Per codex round-2 #1: `runEvalCrossModal --batch` only writes the summary
 * to `--output` (or its own default path). The adapter MUST pass
 * `--output summaryPath` so the file lands where the caller expects.
 *
 * Per codex round-2 #12: in-process invocation avoids the gbrain-version-
 * drift bug class. The adapter calls the CLI functions directly (not via
 * subprocess), so the workspace gbrain runs — not whatever's installed.
 */

import { readFileSync, existsSync } from 'node:fs';

import type { RunOpts } from '../../commands/eval-longmemeval.ts';
import type { RunCrossModalOpts } from '../../commands/eval-cross-modal.ts';
import type { NightlyProbeModelRoutes, NightlyProbeSlotId } from './nightly-probe-routes.ts';

/** Arguments accepted by the longmemeval adapter. */
export interface LongMemEvalProbeArgs {
  fixturePath: string;
  outputPath: string;
  searchConfigSnapshot?: Record<string, string>;
  /** Brain-resolved routes (#5872); absent leaves the command's own defaults. */
  modelRoutes?: NightlyProbeModelRoutes;
}

/** Arguments accepted by the cross-modal adapter. */
export interface CrossModalProbeArgs {
  batchPath: string;
  summaryPath: string;
  maxUsd: number;
  /** Brain-resolved routes (#5872); absent leaves the command's own defaults. */
  modelRoutes?: NightlyProbeModelRoutes;
}

/** Cross-modal batch summary shape (matches `runEvalCrossModal --batch --json`'s envelope). */
export interface CrossModalBatchSummary {
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
  est_cost_usd: number;
  verdict: string;
}

/**
 * Adapter for `runEvalLongMemEval`. Builds the argv shape the CLI expects
 * and calls it in-process.
 *
 * The CLI's first positional arg is `<dataset.jsonl>` (fixturePath).
 * `--output PATH` writes per-question rows.
 *
 * Embedded failures throw so the nightly phase can audit the failure
 * without terminating autopilot. Standalone CLI invocations still exit.
 */
export async function runLongMemEvalForProbe(args: LongMemEvalProbeArgs): Promise<void> {
  const { runEvalLongMemEval } = await import('../../commands/eval-longmemeval.ts');
  const { argv, runOpts } = buildLongMemEvalProbeCall(args);
  await runEvalLongMemEval(argv, runOpts);
}

/**
 * argv + RunOpts for the LongMemEval call. The brain-resolved reader rides
 * `--model` and the extractor `RunOpts.extractorModel`; with no routes the
 * call is the pre-#5872 one.
 */
export function buildLongMemEvalProbeCall(args: LongMemEvalProbeArgs): { argv: string[]; runOpts: RunOpts } {
  const argv = [args.fixturePath, '--output', args.outputPath];
  const runOpts: RunOpts = { searchConfigSnapshot: args.searchConfigSnapshot, exitOnError: false };
  if (args.modelRoutes) {
    argv.push('--model', args.modelRoutes.reader.model);
    runOpts.extractorModel = args.modelRoutes.extractor.model;
  }
  return { argv, runOpts };
}

/**
 * QA-shaped judge dimensions for the nightly probe. The batch judge's
 * DEFAULT_DIMENSIONS rubric (DEPTH / SOURCING / SPECIFICITY / …) is built
 * for rich agent responses; LongMemEval hypotheses are deliberately terse
 * factual answers ("in widget-co") that can never score ≥7 on DEPTH or
 * SOURCING — so with the default rubric the probe FAILs every night even
 * when retrieval + answering are perfectly healthy. The probe owns its
 * invocation of the eval tool and passes dimensions matching the
 * fixture's QA shape instead.
 *
 * NOTE: the `--dimensions` CLI flag splits on commas, so these dimension
 * descriptions must stay comma-free.
 */
export const PROBE_QA_DIMENSIONS: string[] = [
  // No faithfulness/grounding dimension on purpose: the judge never sees
  // the haystack, so any accurate detail beyond the terse gold label reads
  // as "invented" and correct answers fail (verified empirically — a
  // correct "before + dates" answer scored 4/10 on such a dimension).
  'CORRECTNESS — Does the hypothesis state the same fact as the expected answer? A terse direct answer is ideal.',
  'DIRECTNESS — Does it answer THIS question without hedging or padding or answering something else?',
];

const SLOT_FLAGS: ReadonlyArray<readonly [NightlyProbeSlotId, string]> = [
  ['A', '--slot-a-model'],
  ['B', '--slot-b-model'],
  ['C', '--slot-c-model'],
];

/**
 * argv + options for the cross-modal batch. Each slot route rides its
 * `--slot-<x>-model` flag, which wins over the #4636 substitution, and with
 * routes the batch keeps the gateway the caller refreshed from the brain
 * (`useConfiguredGateway`) instead of rebuilding it from the file plane.
 * With no routes the call is the pre-#5872 one.
 */
export function buildCrossModalProbeCall(args: CrossModalProbeArgs): { argv: string[]; opts: RunCrossModalOpts } {
  const argv = [
    '--batch',
    args.batchPath,
    '--output',
    args.summaryPath,
    '--max-usd',
    String(args.maxUsd),
    '--dimensions',
    PROBE_QA_DIMENSIONS.join(','),
    '--yes',
    '--json',
  ];
  if (!args.modelRoutes) return { argv, opts: {} };
  for (const [id, flag] of SLOT_FLAGS) {
    const model = args.modelRoutes.slots[id];
    if (model) argv.push(flag, model);
  }
  return { argv, opts: { useConfiguredGateway: true } };
}

/**
 * Adapter for `runEvalCrossModal --batch`. Threads `--output` so the
 * summary lands at the caller-controlled path (codex round-2 #1 fix),
 * then reads + parses the summary from that path.
 *
 * Returns `{ exitCode, summary }` shape so the caller can both surface the
 * verdict and decide what to do with non-zero exit codes (cost overrun,
 * gate failure, etc).
 *
 * Throws if `summaryPath` is missing after the run (caller misconfigured
 * the batch input) or unparseable (cross-modal wrote garbage). Both
 * cases are paste-ready in the error message.
 */
export async function runCrossModalBatchForProbe(
  args: CrossModalProbeArgs,
): Promise<{ exitCode: number; summary: CrossModalBatchSummary }> {
  const { runEvalCrossModal } = await import('../../commands/eval-cross-modal.ts');
  const { argv, opts } = buildCrossModalProbeCall(args);
  const exitCode = await runEvalCrossModal(argv, opts);

  if (!existsSync(args.summaryPath)) {
    throw new Error(
      `nightly-probe-adapter: cross-modal --batch finished (exit ${exitCode}) but ` +
      `summary file is missing at ${args.summaryPath}. ` +
      `Hint: confirm the batch input JSONL is valid and writable.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(args.summaryPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: could not read cross-modal summary at ${args.summaryPath}: ` +
      `${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${args.summaryPath} is malformed JSON: ` +
      `${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${args.summaryPath} is not a JSON object`,
    );
  }

  // Cross-modal --batch --json wraps the summary as a top-level object;
  // pick the fields we care about and pass through. Tolerate the shape
  // being slightly larger (e.g. per-question receipts inline).
  const obj = parsed as Record<string, unknown>;
  const summary: CrossModalBatchSummary = {
    pass_count: Number(obj.pass_count ?? 0),
    fail_count: Number(obj.fail_count ?? 0),
    inconclusive_count: Number(obj.inconclusive_count ?? 0),
    error_count: Number(obj.error_count ?? 0),
    est_cost_usd: Number(obj.est_cost_usd ?? 0),
    verdict: typeof obj.verdict === 'string' ? obj.verdict : 'unknown',
  };

  return { exitCode, summary };
}

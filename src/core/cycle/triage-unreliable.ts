/**
 * What happens to a significance-judge response that yields no usable verdict
 * (truncated, refused, unparseable), #6069.
 *
 * The call is paid either way. Before, the response was dropped without a
 * trace and the transcript was re-judged at full price on every run. Now:
 *
 *   - `describeJudgeResponse` turns the response into one bounded diagnostic
 *     line (size, stop reasons, output tokens, the JSON error and about 120
 *     characters around it, secrets redacted and PII scrubbed). The raw
 *     response is kept nowhere.
 *   - `runTriagePass` stores a backoff marker in the transcript's
 *     dream_verdicts slot and skips the transcript until the backoff ends.
 *     When at least half of the pass's judge calls failed (a provider
 *     problem, not the pages) the marker holds only OUTAGE_BACKOFF_MS and
 *     its attempt count does not grow, once: a page that fails again in the
 *     next outage-looking pass takes the normal backoff, so a judge that is
 *     broken for good stops being paid every run (`flushUnreliableMarkers`).
 *     A marker never replaces a scored verdict.
 *
 * A marker is a row with a NULL score. Every verdict reader already treats a
 * NULL score as a cache miss (it predates triage-v1 as the boolean-era shape),
 * so a marker can never act as a rejection: it only postpones the next paid
 * attempt. It carries the cache tuple (model, triage_version) and its attempt
 * count in `reasons[0]` (`judge-unreliable:<attempt>:<kind>[:outage]`).
 * Changed content (a new hash), another model, a newer TRIAGE_VERSION,
 * retriage `--since` or `--force`, or an explicit synthesize target
 * (`--input`, `--date`, `--from`/`--to`) judges the transcript again at once.
 * A reliable verdict overwrites the marker.
 */
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../engine.ts';
import { explainLlmJsonFailure, stripReasoningBlocks } from '../llm-json.ts';
import { scrubPii } from '../eval-capture-scrub.ts';
import { redactFindings } from '../secret-scan.ts';

export const UNRELIABLE_KINDS = ['truncated', 'refusal', 'unparseable'] as const;
export type UnreliableKind = (typeof UNRELIABLE_KINDS)[number];

/**
 * Days to wait before the next judge attempt after the Nth consecutive
 * unreliable verdict; the last step repeats. Every step stays below the
 * 30-day row TTL so the marker, and with it the attempt count, is still
 * readable when its backoff ends.
 */
export const UNRELIABLE_BACKOFF_DAYS: readonly number[] = [3, 6, 12, 24];

const DAY_MS = 86_400_000;
const MARKER_RE = new RegExp(`^judge-unreliable:(\\d{1,4}):(${UNRELIABLE_KINDS.join('|')})(:outage)?$`);

/** Characters of the response shown around a JSON error. */
const DIAGNOSTIC_WINDOW = 120;

/**
 * A pass whose LLM judge calls came back unreliable half the time or more
 * looks like a provider problem (empty responses, an outage), not a set of
 * pages that cannot be judged: a days-long backoff would delay every page for
 * a failure that may clear within the hour, while no marker at all would
 * re-pay every run. From this many judge calls, with at least half
 * unreliable, the markers hold OUTAGE_BACKOFF_MS only. A single failing call
 * is no evidence of an outage and takes the normal backoff.
 */
export const OUTAGE_MIN_JUDGED = 2;
export const OUTAGE_BACKOFF_MS = 6 * 3_600_000;

export interface UnreliableMarker {
  attempt: number;
  kind: UnreliableKind;
  /** Written by a pass that looked like a provider outage (short hold). */
  outage: boolean;
  /** Epoch ms when the backoff ends and the transcript may be judged again. */
  retryAt: number;
}

export function unreliableBackoffMs(attempt: number): number {
  const step = Math.min(Math.max(1, Math.floor(attempt)), UNRELIABLE_BACKOFF_DAYS.length) - 1;
  return UNRELIABLE_BACKOFF_DAYS[step] * DAY_MS;
}

/**
 * The backoff marker held in a dream_verdicts row, or null when the row is a
 * verdict, a boolean-era row, or a marker outside the current cache tuple
 * (another model or TRIAGE_VERSION, or judged before `staleBefore`).
 */
export function readUnreliableMarker(
  row: Pick<DreamVerdict, 'score' | 'reasons' | 'model' | 'triage_version' | 'judged_at'>,
  model: string,
  triageVersion: number,
  staleBefore?: Date,
): UnreliableMarker | null {
  if (row.score !== null || row.model !== model || row.triage_version !== triageVersion) return null;
  const m = MARKER_RE.exec(row.reasons[0] ?? '');
  if (!m) return null;
  const judgedAt = Date.parse(row.judged_at);
  if (!Number.isFinite(judgedAt)) return null;
  if (staleBefore && judgedAt < staleBefore.getTime()) return null;
  const attempt = Number(m[1]);
  const outage = m[3] !== undefined;
  return { attempt, kind: m[2] as UnreliableKind, outage, retryAt: judgedAt + (outage ? OUTAGE_BACKOFF_MS : unreliableBackoffMs(attempt)) };
}

/** The marker in `row` when its backoff is still running at `now`, else null. */
export function heldBackMarker(
  row: Pick<DreamVerdict, 'score' | 'reasons' | 'model' | 'triage_version' | 'judged_at'> | null,
  model: string,
  triageVersion: number,
  staleBefore?: Date,
  now = Date.now(),
): UnreliableMarker | null {
  const marker = row ? readUnreliableMarker(row, model, triageVersion, staleBefore) : null;
  return marker && now < marker.retryAt ? marker : null;
}

/**
 * The marker row for the next unreliable verdict after `prev` (null = first).
 * An outage marker keeps the attempt count (it records no failure of the
 * page), but only once in a row: after an outage marker the page escalates.
 */
export function unreliableMarkerInput(
  prev: UnreliableMarker | null,
  kind: UnreliableKind,
  reasons: string[],
  model: string,
  triageVersion: number,
  opts: { outage?: boolean; now?: number } = {},
): { input: DreamVerdictInput; attempt: number; retryAt: number } {
  const outage = opts.outage === true && prev?.outage !== true;
  const attempt = outage ? (prev?.attempt ?? 0) : Math.min((prev?.attempt ?? 0) + 1, 9999);
  return {
    input: {
      worth_processing: false,
      reasons: [`judge-unreliable:${attempt}:${kind}${outage ? ':outage' : ''}`, ...reasons],
      score: null,
      content_type: null,
      segments: [],
      entities: [],
      model,
      triage_version: triageVersion,
    },
    attempt,
    retryAt: (opts.now ?? Date.now()) + (outage ? OUTAGE_BACKOFF_MS : unreliableBackoffMs(attempt)),
  };
}

const JUDGE_SOONER = 'changed content or an explicit `gbrain dream --phase synthesize --input <file>` / `--date <day>` run judges';

/** An unreliable verdict waiting for the end of the pass to learn whether it gets a marker. */
export interface PendingUnreliableMarker {
  filePath: string;
  contentHash: string;
  kind: UnreliableKind;
  reasons: string[];
}

/**
 * End of a triage pass: write its backoff markers (short ones when the pass
 * looks like a provider outage, OUTAGE_MIN_JUDGED), none when it was
 * cancelled (#4077: bank nothing new), and log one summary line for markers
 * written and transcripts held back by a running marker (`heldBack`).
 * `judged` counts LLM judge calls only. Each slot is re-read right before its
 * write: a scored verdict there (kept under `--force`, or written by a
 * concurrent run) is never replaced, and an earlier marker carries its
 * attempt count forward. The markers are an optimization, so a failed write
 * is logged and the phase goes on (the next run re-judges those transcripts).
 */
export async function flushUnreliableMarkers(
  engine: Pick<BrainEngine, 'getDreamVerdict' | 'putDreamVerdict'>,
  pending: PendingUnreliableMarker[],
  pass: { judged: number; unreliable: number; heldBack: number; aborted: boolean },
  model: string,
  triageVersion: number,
): Promise<void> {
  if (pass.heldBack > 0) {
    process.stderr.write(
      `[dream] triage: ${pass.heldBack} transcript(s) skipped while an unreliable-judge backoff runs; ${JUDGE_SOONER} them now\n`,
    );
  }
  if (pending.length === 0) return;
  if (pass.aborted) {
    process.stderr.write(`[dream] triage: cycle cancelled; no backoff markers written for ${pending.length} unreliable judge response(s)\n`);
    return;
  }
  const outage = pass.judged >= OUTAGE_MIN_JUDGED && pass.unreliable * 2 >= pass.judged;
  let earliest = Infinity;
  let written = 0;
  let short = 0;
  try {
    for (const p of pending) {
      const current = await engine.getDreamVerdict(p.filePath, p.contentHash);
      if (current && current.score !== null) continue;
      const prev = current ? readUnreliableMarker(current, model, triageVersion) : null;
      const next = unreliableMarkerInput(prev, p.kind, p.reasons, model, triageVersion, { outage });
      await engine.putDreamVerdict(p.filePath, p.contentHash, next.input);
      earliest = Math.min(earliest, next.retryAt);
      written++;
      if (next.input.reasons[0].endsWith(':outage')) short++;
    }
  } catch (err) {
    process.stderr.write(`[dream] triage: could not write backoff markers (${err instanceof Error ? err.message : String(err)}); ${pending.length - written} transcript(s) are re-judged next run\n`);
  }
  if (written === 0) return;
  const escalated = written - short;
  const why = outage
    ? `${pass.unreliable} of ${pass.judged} judge responses this run were unreliable, which looks like a provider problem: holding ${short} transcript(s) ${OUTAGE_BACKOFF_MS / 3_600_000}h only` +
      (escalated > 0 ? `, backing off ${escalated} that failed in the previous outage-looking run too` : '')
    : `backing off ${written} transcript(s) after unreliable judge responses`;
  process.stderr.write(`[dream] triage: ${why}; next judge attempt from ${new Date(earliest).toISOString()} (${JUDGE_SOONER} sooner)\n`);
}

/**
 * One bounded line describing a judge response that yielded no usable
 * verdict. `parse` says how far parsing got: 'failed' adds the JSON error and
 * the redacted window around it, 'no-score' notes an object without a finite
 * numeric score, 'ok' adds nothing (the verdict parsed; its stop was abnormal).
 */
export function describeJudgeResponse(
  text: string,
  meta: { stopReason?: string | null; gatewayStopReason?: string; outputTokens?: number },
  parse: 'failed' | 'no-score' | 'ok',
): string {
  const parts = [`response ${text.length} chars`, `stop_reason=${meta.stopReason ?? 'none'}`];
  // The gateway adapter maps an unknown finish reason to end_turn; keep the
  // original unless it is the clean stop ('end').
  if (meta.gatewayStopReason && meta.gatewayStopReason !== 'end') parts.push(`gateway finish=${meta.gatewayStopReason}`);
  if (meta.outputTokens !== undefined) parts.push(`${meta.outputTokens} output tokens`);
  if (parse === 'no-score') parts.push('JSON object without a finite numeric score');
  if (parse !== 'failed') return parts.join(', ');
  // Explain the text parseLlmJson tried last: without the reasoning block when
  // it had one. Secrets and PII are redacted over that whole text before the
  // window is cut (a value split by the window edge would no longer match its
  // pattern), so the offset is into the redacted text.
  const answer = stripReasoningBlocks(text);
  const stripped = answer !== '' && answer !== text.trim();
  const redacted = scrubPii(redactFindings(stripped ? answer : text).text);
  const failure = explainLlmJsonFailure(redacted);
  if (stripped) parts.push('reasoning block stripped');
  if (failure.fenced) parts.push('fenced');
  let error = `JSON error ${JSON.stringify(failure.error)}`;
  if (failure.offset !== null) {
    const from = Math.max(0, failure.offset - DIAGNOSTIC_WINDOW / 2);
    error += ` at char ${failure.offset} near ${JSON.stringify(redacted.slice(from, from + DIAGNOSTIC_WINDOW))}`;
  }
  return [...parts, error].join(', ');
}

/**
 * Per-run transcript budget for a subagent job (#6236).
 *
 * Every turn re-sends the whole transcript (claude-cli renders it into one
 * prompt), so tool results accumulate until the request no longer fits the
 * model's window and the run dies after it has paid for every turn. With
 * `max_transcript_chars` set, the prompt and the tool results stay under it:
 * a read-only tool's result that would cross it is replaced by a notice
 * (`{ result_withheld: <text> }`, JSON so every persistence path stores it)
 * telling the model to finish with what it has read. Any other tool's result
 * always passes, because the model must see a write's receipt, and still
 * counts. The notice is the persisted output, so a replay shows the model
 * what it saw, and a resumed job counts the results it already holds.
 */
import type { BrainEngine } from '../engine.ts';
import type { SubagentHandlerData, ToolDef } from './types.ts';

/** Key of the notice object that replaces a withheld result. */
export const WITHHELD_RESULT_KEY = 'result_withheld';

export interface TranscriptBudget {
  readonly maxChars: number;
  /** Characters of prompt and tool results already in the transcript. */
  usedChars: number;
}

/** Characters a tool result adds to the transcript, measured as the providers serialize it. */
export function toolResultChars(output: unknown): number {
  if (typeof output === 'string') return output.length;
  return JSON.stringify(output ?? null)?.length ?? 0;
}

/** The job's budget, or null when unset. Anything but a non-negative integer refuses the job. */
export function parseTranscriptBudget(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`subagent max_transcript_chars must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * A budget seeded with the prompt and the results a resumed job already
 * holds, measured like live results: a stored string by its own length,
 * anything else by its JSON text. Withheld notices count, as the model saw them.
 */
export async function loadTranscriptBudget(engine: BrainEngine, jobId: number, maxChars: number, promptChars: number): Promise<TranscriptBudget> {
  const [row] = await engine.executeRaw<{ chars: number | string | null }>(
    `SELECT COALESCE(SUM(length(output #>> '{}')), 0) AS chars
       FROM subagent_tool_executions WHERE job_id = $1 AND status = 'complete'`, [jobId]);
  return { maxChars, usedChars: promptChars + Number(row?.chars ?? 0) };
}

/** Results a job's budget withheld, from its persisted notices. */
export async function countWithheldResults(engine: BrainEngine, jobId: number): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM subagent_tool_executions
      WHERE job_id = $1 AND status = 'complete' AND output->>$2::text IS NOT NULL`, [jobId, WITHHELD_RESULT_KEY]);
  return Number(row?.n ?? 0);
}

function withheldNotice(toolName: string, chars: number, budget: TranscriptBudget): { [WITHHELD_RESULT_KEY]: string } {
  return { [WITHHELD_RESULT_KEY]: `this ${toolName} result is ${chars} characters, more than the ${Math.max(0, budget.maxChars - budget.usedChars)} `
    + `left of this run's ${budget.maxChars}-character transcript budget. Every turn re-sends the whole conversation, so adding it `
    + 'could overflow the model\'s context window. Do not retry it, and do not replace a page you could not read; '
    + 'finish the task with what you have already read.' };
}

export function withTranscriptBudget(tools: ToolDef[], budget: TranscriptBudget): ToolDef[] {
  return tools.map(tool => ({ ...tool, async execute(input, ctx) {
    const output = await tool.execute(input, ctx);
    const chars = toolResultChars(output);
    if (tool.read_only === true && budget.usedChars + chars > budget.maxChars) {
      const notice = withheldNotice(tool.name, chars, budget);
      process.stderr.write(`[subagent:${ctx.jobId}] withheld a ${chars}-character ${tool.name} result `
        + `(transcript ${budget.usedChars} of ${budget.maxChars} characters)\n`);
      budget.usedChars += toolResultChars(notice);
      return notice;
    }
    budget.usedChars += chars;
    return output;
  } }));
}

/** The job's tools under its `max_transcript_chars` budget, or unchanged when it sets none. */
export async function applyTranscriptBudget(engine: BrainEngine, jobId: number,
  data: Pick<SubagentHandlerData, 'prompt' | 'max_transcript_chars'>, tools: ToolDef[]): Promise<ToolDef[]> {
  const maxChars = parseTranscriptBudget(data.max_transcript_chars);
  if (maxChars === null) return tools;
  const promptChars = typeof data.prompt === 'string' ? data.prompt.length : 0;
  return withTranscriptBudget(tools, await loadTranscriptBudget(engine, jobId, maxChars, promptChars));
}

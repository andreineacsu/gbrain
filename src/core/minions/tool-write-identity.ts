import { createHash } from 'node:crypto';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { isWriteReceipt } from '../persistence/types.ts';
import { isPersistenceIpcMutation } from '../persistence/ipc.ts';
import { WRITE_ADMISSION_HEADROOM_MS, replayWhilePending } from '../persistence/write-wait.ts';
import { WIRE_WRITE_WAIT_MAX_MS } from '../persistence/params.ts';
import { maintenanceWriteWaitMs } from '../persistence/maintenance-wait.ts';

/** Bind a durable write to its persisted tool execution, including crash replay. */
export function retainToolWriteRequestId(input: unknown, jobId: number, messageIdx: number, ordinal: number, toolUseId: string, toolName: string): void {
  if (!isPersistenceIpcMutation(toolName.replace(/^brain_/, '')) || !input || typeof input !== 'object' || Array.isArray(input)) return;
  const params = input as Record<string, unknown>;
  if (params.request_id !== undefined || params.dry_run === true) return;
  const hex = createHash('sha256').update(JSON.stringify(['gbrain-tool-write-v1', jobId, messageIdx, ordinal, toolUseId])).digest('hex');
  // UUIDv8 uses the persisted execution coordinates as the application identity.
  params.request_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A queued mutation is durable work, never a completed tool-side write. */
export function assertToolWriteCommitted(output: unknown, toolName: string): void {
  if (!isPersistenceIpcMutation(toolName.replace(/^brain_/, '')) || !isWriteReceipt(output) || output.state === 'committed') return;
  const pending = ['queued', 'running', 'recovering'].includes(output.state);
  const code = pending ? 'write_pending' : 'storage_error';
  const error = opError(code, `Tool write ${output.request_id} is ${output.state}; inspect its durable receipt before retrying.`,
    pending ? `The tool write is accepted and still ${output.state}; read its receipt until it is terminal. Do not repeat the tool call: the same request id replays it.`
      : `The tool write ended ${output.state}; its receipt holds the recorded error. Read it before deciding whether a new write (with a new request id) is needed.`,
    { fix: readFix(`Reads tool write ${output.request_id}'s durable receipt, read-only.`, { argv: ['gbrain', 'write-request', '--', output.request_id] }) });
  error.writeRequest = output; error.writeError = code; throw error;
}

/**
 * A pending tool write stops waiting this long before the job deadline: one
 * more tool wait at its longest (each replay resends the model's `wait_ms`)
 * plus admission headroom, so the handler returns `write_pending` (a retry
 * under a fresh deadline) before the runner's timeout marks the job dead.
 */
const TOOL_WRITE_DEADLINE_RESERVE_MS = WIRE_WRITE_WAIT_MAX_MS + WRITE_ADMISSION_HEADROOM_MS;

/**
 * #5474: run a tool and wait for its accepted write. The tool's own bounded
 * wait can end while the write is still queued; replaying the same request_id
 * admits nothing new and calls no model, so the job replays until the write
 * is terminal, the job is cancelled, or the job deadline less the reserve
 * arrives (a job without a deadline waits the #5854 maintenance wait). The
 * job cannot take its next turn without the result. Only then does the write
 * leave the handler as `write_pending`, its tool row still pending for the
 * retry: runners count that as a failed attempt, and the dream inline drain
 * retries at once. Tradeoff: a write that never commits holds the job, and a
 * serial dream drain behind it, until that deadline. The receipt's
 * `inspect_owner` advice is no exit signal: it also marks writer-pool
 * contention and any write older than 2 min, the slow commits this wait is for.
 */
export async function runToolWrite(run: () => Promise<unknown>, toolName: string,
  job: { deadlineAtMs: number | null; signal?: AbortSignal }): Promise<unknown> {
  const waitMs = job.deadlineAtMs == null ? maintenanceWriteWaitMs()
    : Math.max(0, job.deadlineAtMs - Date.now() - TOOL_WRITE_DEADLINE_RESERVE_MS);
  return replayWhilePending(async () => {
    const output = await run();
    assertToolWriteCommitted(output, toolName);
    return output;
  }, waitMs, { signal: job.signal });
}
export function isPendingToolWrite(error: unknown): error is OperationError {
  return error instanceof OperationError && error.code === 'write_pending' && error.writeRequest !== undefined;
}

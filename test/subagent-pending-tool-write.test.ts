/**
 * #5474: a subagent child whose accepted brain write is still committing when
 * the tool's own bounded wait ends replays the same request id until the write
 * is terminal, up to the job deadline, instead of leaving the handler as a
 * failed attempt. Before the fix every runner counted `write_pending` as an
 * ordinary failure: the dream inline drain retried at once, the worker after
 * 1 s and 2 s, so a write committing after its third 5 s wait killed the child
 * although the page committed, and the next cycle paid to synthesize it again.
 * Existing tests pin the handler's rejection after one wait and the resumed
 * replay, not the child's outcome under a runner. Uses the existing gateway
 * chat-transport and maintenance-wait test seams.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import type { MinionJobContext, ToolDef } from '../src/core/minions/types.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let modelTurns = 0;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  await engine.setConfig('agent.use_gateway_loop', 'true');
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5', env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' } } as never);
  modelTurns = 0;
  __setChatTransportForTests(async () => {
    modelTurns++;
    return { text: modelTurns === 1 ? '' : 'done', blocks: modelTurns === 1
      ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'brain_put_page', input: { slug: 'notes/pending-example', content: 'fixture' } }]
      : [{ type: 'text', text: 'done' }], stopReason: modelTurns === 1 ? 'tool_calls' : 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
  });
});

type Shape = 'returned receipt' | 'thrown write_pending';
/** A put_page whose write commits on dispatch `commitsOn`; earlier dispatches report it queued, as the real tool does after its 5 s wait. */
function putPage(shape: Shape, commitsOn: number, retryAfterMs: (dispatch: number) => number = () => 20) {
  const ids: unknown[] = [];
  const tool: ToolDef = { name: 'brain_put_page', description: 'p', input_schema: { type: 'object' }, idempotent: true,
    execute: async input => {
      const request_id = (input as Record<string, unknown>).request_id; ids.push(request_id);
      if (ids.length >= commitsOn) return { request_id, state: 'committed', retry_after_ms: null };
      const receipt = { request_id, state: 'queued', retry_after_ms: retryAfterMs(ids.length) };
      if (shape === 'returned receipt') return receipt;
      const error = new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt until it is terminal.');
      error.writeRequest = receipt as never; error.writeError = 'write_pending';
      throw error;
    } };
  return { tool, ids };
}
const handlerFor = (tool: ToolDef) => makeSubagentHandler({ engine, config: {} as never, toolRegistry: [tool],
  makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path unused'); } } }) as never });
const toolRows = (jobId: number) => engine.executeRaw<{ status: string }>('SELECT status FROM subagent_tool_executions WHERE job_id=$1', [jobId]);

async function runOnWorker(handler: ReturnType<typeof handlerFor>): Promise<number> {
  const queue = new MinionQueue(engine);
  const job = await queue.add('subagent', { prompt: 'persist the fixture', model: 'openai:gpt-4o' }, {}, { allowProtectedSubmit: true });
  const worker = new MinionWorker(engine, { pollInterval: 25 });
  worker.register('subagent', handler);
  const running = worker.start();
  for (let i = 0; i < 400 && !['completed', 'dead', 'failed'].includes((await queue.getJob(job.id))!.status); i++) await new Promise(r => setTimeout(r, 25));
  worker.stop(); await running;
  return job.id;
}
async function runInline(handler: ReturnType<typeof handlerFor>): Promise<number> {
  const queue = new MinionQueue(engine);
  const queueName = `dream-inline-${Date.now()}-5474abcd`;
  const job = await queue.add('subagent', { prompt: 'persist the fixture', model: 'openai:gpt-4o' }, { queue: queueName }, { allowProtectedSubmit: true });
  await runSubagentsInline(engine, queue, queueName, undefined, handler);
  return job.id;
}

describe('a child waits for its accepted tool write instead of dying (#5474)', () => {
  // A child with a deadline waits up to it: the maintenance wait (here 50 ms)
  // bounds only a job without one.
  let restoreWait: () => void = () => {};
  beforeEach(() => { restoreWait = __setMaintenanceWriteWaitForTests(50); });
  afterEach(() => restoreWait());

  const cases = (['dream inline drain', 'worker'] as const).flatMap(runner =>
    (['returned receipt', 'thrown write_pending'] as const).map(shape => [runner, shape] as const));
  test.each(cases)('%s, %s: the write commits after several bounded waits and the child completes', async (runner, shape) => {
    const { tool, ids } = putPage(shape, 8);
    const jobId = await (runner === 'worker' ? runOnWorker : runInline)(handlerFor(tool));
    const job = (await new MinionQueue(engine).getJob(jobId))!;
    expect({ status: job.status, error: job.error_text }).toEqual({ status: 'completed', error: null });
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(1);
    expect(modelTurns).toBe(2);
    expect((await toolRows(jobId)).map(row => row.status)).toEqual(['complete']);
  }, 20_000);

  test.each([
    // Inside the reserve (the longest model wait_ms plus admission headroom) the wait ends at once,
    // so the retry starts before the runner's timeout marks the job dead.
    ['the job deadline is inside its reserve', { deadlineInMs: 30_000, abortInMs: null, replays: false }],
    // The fourth receipt asks for a 10 s pause; the cancellation must end it.
    ['the job is cancelled', { deadlineInMs: 120_000, abortInMs: 300, replays: true }],
  ] as const)('a write still pending when %s leaves the handler pending before the deadline', async (_when, { deadlineInMs, abortInMs, replays }) => {
    const { tool, ids } = putPage('thrown write_pending', Number.POSITIVE_INFINITY, dispatch => dispatch < 4 ? 20 : 10_000);
    const queue = new MinionQueue(engine);
    const job = await queue.add('subagent', { prompt: 'persist the fixture', model: 'openai:gpt-4o' }, {}, { allowProtectedSubmit: true });
    const abort = new AbortController();
    if (abortInMs !== null) setTimeout(() => abort.abort(new Error('cancelled')), abortInMs);
    const deadlineAtMs = Date.now() + deadlineInMs;
    const ctx = { id: job.id, name: 'subagent', data: job.data, attempts_made: 0, signal: abort.signal, deadlineAtMs, shutdownSignal: new AbortController().signal,
      updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as MinionJobContext;
    const started = Date.now();
    await expect(handlerFor(tool)(ctx)).rejects.toMatchObject({ code: 'write_pending', writeRequest: { state: 'queued' } });
    expect(Date.now()).toBeLessThan(deadlineAtMs);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ids.length > 1).toBe(replays);
    expect(new Set(ids).size).toBe(1);
    expect(modelTurns).toBe(1);
    expect((await toolRows(job.id)).map(row => row.status)).toEqual(['pending']);
  }, 20_000);
});

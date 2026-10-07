/**
 * #6236: `max_transcript_chars` bounds the prompt plus the tool results a
 * subagent's transcript carries. The transcript is re-sent whole on every
 * turn, so without a bound a child that keeps reading grows its request past
 * the model's window and dies mid-run. A read result that would cross the
 * budget is replaced by a notice; a write's receipt always reaches the model;
 * a resumed run counts the results it already holds. Gateway path (the
 * claude-cli path), PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef } from '../src/core/minions/types.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatBlock, type ChatMessage } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('agent.use_gateway_loop', 'true');
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'stub' } });
});

const PAGE = 'x'.repeat(3_000);
const RECEIPT = `saved ${'y'.repeat(2_000)}`;

function tools(): ToolDef[] {
  return [
    { name: 'brain_get_page', description: 'read', input_schema: { type: 'object' }, idempotent: true, read_only: true,
      async execute() { return PAGE; } },
    { name: 'brain_put_page', description: 'write', input_schema: { type: 'object' }, idempotent: true,
      async execute() { return RECEIPT; } },
  ];
}

function handler() {
  return makeSubagentHandler({ engine, config: {} as never, toolRegistry: tools(),
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path not expected'); } } }) as never });
}

async function job(data: Record<string, unknown>): Promise<MinionJobContext> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, status, data, queue, priority, created_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'active', $1::text::jsonb, 'default', 0, now()) RETURNING id`,
    [JSON.stringify(data)]);
  return { id: row!.id, name: 'subagent', data, attempts_made: 0, signal: new AbortController().signal, deadlineAtMs: null,
    shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
    isActive: async () => true, readInbox: async () => [] };
}

function call(id: string, toolName: string): ChatBlock {
  return { type: 'tool-call', toolCallId: id, toolName, input: {} } as ChatBlock;
}

/** Scripted child: three reads, then a write and a read, then a final answer. Returns the tool results it was shown. */
async function runChild(data: Record<string, unknown>): Promise<string[]> {
  const turns: ChatBlock[][] = [
    [call('r1', 'brain_get_page'), call('r2', 'brain_get_page'), call('r3', 'brain_get_page')],
    [call('w1', 'brain_put_page'), call('r4', 'brain_get_page')],
  ];
  let seen: ChatMessage[] = [];
  __setChatTransportForTests(async opts => {
    seen = opts.messages;
    const blocks = turns.shift() ?? [{ type: 'text', text: 'Done.' } as ChatBlock];
    return { text: blocks[0]!.type === 'text' ? 'Done.' : '', blocks, stopReason: blocks[0]!.type === 'text' ? 'end' : 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  const result = await handler()(await job({ prompt: 'find patterns', model: 'anthropic:claude-sonnet-4-6', ...data }));
  expect(result.stop_reason).toBe('end_turn');
  return seen.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter((block): block is Extract<ChatBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    .map(block => typeof block.output === 'string' ? block.output : JSON.stringify(block.output));
}

describe('subagent transcript budget', () => {
  test('a read that would cross the budget is withheld with a notice; a write receipt always passes', async () => {
    const shown = await runChild({ max_transcript_chars: 7_000 });
    expect(shown.map(out => out === PAGE ? 'page' : out === RECEIPT ? 'receipt' : out.startsWith('Result withheld') ? 'withheld' : out))
      .toEqual(['page', 'page', 'withheld', 'receipt', 'withheld']);
    expect(shown[2]).toContain('finish the task with what you have already read');
  });

  test('without a budget every result reaches the model', async () => {
    expect(await runChild({})).toEqual([PAGE, PAGE, PAGE, RECEIPT, PAGE]);
  });

  test('a resumed run counts the results it already holds', async () => {
    const { applyTranscriptBudget } = await import('../src/core/minions/transcript-budget.ts');
    const data = { prompt: 'resume', max_transcript_chars: 4_000 };
    const fresh = await job(data);
    const [freshRead] = await applyTranscriptBudget(engine, fresh.id, data, tools());
    expect(await freshRead!.execute({}, { engine, jobId: fresh.id, remote: true })).toBe(PAGE);
    const resumed = await job(data);
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 1, 'earlier', 'brain_get_page', '{}'::jsonb, 'complete', $2::text::jsonb)`, [resumed.id, JSON.stringify(PAGE)]);
    const [resumedRead] = await applyTranscriptBudget(engine, resumed.id, data, tools());
    expect(String(await resumedRead!.execute({}, { engine, jobId: resumed.id, remote: true }))).toStartWith('Result withheld');
  });

  test('an invalid budget refuses the job before any model call', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; throw new Error('unexpected model call'); });
    for (const bad of [-1, 1.5, '9000']) {
      await expect(handler()(await job({ prompt: 'x', model: 'anthropic:claude-sonnet-4-6', max_transcript_chars: bad })))
        .rejects.toThrow('max_transcript_chars must be a non-negative integer');
    }
    expect(calls).toBe(0);
  });
});

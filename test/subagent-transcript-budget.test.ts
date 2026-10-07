/**
 * #6236: `max_transcript_chars` bounds the prompt plus the tool results a
 * subagent's transcript carries. The transcript is re-sent whole on every
 * turn, so without a bound a child that keeps reading grows its request past
 * the model's window and dies mid-run. A read result that would cross the
 * budget is replaced by a JSON notice; a write's receipt always reaches the
 * model and counts; a resumed run counts the results it already holds.
 * Gateway path (the claude-cli path) and the legacy Anthropic loop, PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef } from '../src/core/minions/types.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatBlock, type ChatMessage } from '../src/core/ai/gateway.ts';
import { patternsTranscriptBudgetChars } from '../src/core/cycle/patterns.ts';

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

// Objects, as brain tools return: the legacy loop stores a plain string result as JSON text and fails on one that is not.
const PAGE = { content: 'x'.repeat(3_000) };
const RECEIPT = { saved: 'y'.repeat(2_000) };

function tools(): ToolDef[] {
  return [
    { name: 'brain_get_page', description: 'read', input_schema: { type: 'object' }, idempotent: true, read_only: true,
      async execute() { return PAGE; } },
    { name: 'brain_put_page', description: 'write', input_schema: { type: 'object' }, idempotent: true,
      async execute() { return RECEIPT; } },
  ];
}

function handler(client?: unknown) {
  return makeSubagentHandler({ engine, config: {} as never, toolRegistry: tools(), ...(client ? { client: client as never } : {}),
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

const read = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'brain_get_page', input: {} }) as ChatBlock;
const write = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'brain_put_page', input: {} }) as ChatBlock;
const label = (out: string) => out === JSON.stringify(PAGE) ? 'page' : out === JSON.stringify(RECEIPT) ? 'receipt'
  : out.startsWith('{"result_withheld"') ? 'withheld' : out;

/** Scripted gateway child: one turn per entry, then a final answer. Returns the tool results it was shown, as labels. */
async function runChild(turns: ChatBlock[][], data: Record<string, unknown>): Promise<{ shown: string[]; jobId: number }> {
  const script = [...turns];
  let seen: ChatMessage[] = [];
  __setChatTransportForTests(async opts => {
    seen = opts.messages;
    const blocks = script.shift() ?? [{ type: 'text', text: 'Done.' } as ChatBlock];
    return { text: blocks[0]!.type === 'text' ? 'Done.' : '', blocks, stopReason: blocks[0]!.type === 'text' ? 'end' : 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  const ctx = await job({ prompt: 'find patterns', model: 'anthropic:claude-sonnet-4-6', ...data });
  expect((await handler()(ctx)).stop_reason).toBe('end_turn');
  const shown = seen.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter((block): block is Extract<ChatBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    .map(block => label(typeof block.output === 'string' ? block.output : JSON.stringify(block.output)));
  return { shown, jobId: ctx.id };
}

describe('subagent transcript budget', () => {
  test.each([
    ['reads that cross the budget are withheld; a receipt still passes', [[read('r1'), read('r2'), read('r3')], [write('w1'), read('r4')]],
      { max_transcript_chars: 7_000 }, ['page', 'page', 'withheld', 'receipt', 'withheld']],
    ['a receipt counts toward the budget', [[write('w1')], [read('r1')]], { max_transcript_chars: 4_000 }, ['receipt', 'withheld']],
    ['without a budget every result reaches the model', [[read('r1'), read('r2'), read('r3')], [write('w1'), read('r4')]],
      {}, ['page', 'page', 'page', 'receipt', 'page']],
  ])('%s', async (_case, turns, data, expected) => {
    const { shown, jobId } = await runChild(turns, data);
    expect(shown).toEqual(expected);
    const { countWithheldResults } = await import('../src/core/minions/transcript-budget.ts');
    expect(await countWithheldResults(engine, jobId)).toBe(expected.filter(entry => entry === 'withheld').length);
  });

  test('the notice tells the model to finish with what it has read', async () => {
    const { shown } = await runChild([[read('r1'), read('r2')]], { max_transcript_chars: 4_000 });
    expect(shown).toEqual(['page', 'withheld']);
    const [row] = await engine.executeRaw<{ notice: string }>(
      `SELECT output->>'result_withheld' AS notice FROM subagent_tool_executions WHERE output->>'result_withheld' IS NOT NULL`);
    expect(row!.notice).toContain('finish the task with what you have already read');
  });

  test('the legacy Anthropic loop stores the notice as a completed result', async () => {
    await engine.unsetConfig('agent.use_gateway_loop');
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const responses = [
      { content: ['r1', 'r2', 'r3'].map(id => ({ type: 'tool_use', id, name: 'brain_get_page', input: {} })), stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
    ];
    const client = { async create(params: Anthropic.MessageCreateParamsNonStreaming) {
      calls.push(params);
      return { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...responses.shift()! };
    } };
    const ctx = await job({ prompt: 'find patterns', model: 'anthropic:claude-sonnet-4-6', max_transcript_chars: 7_000 });
    expect((await handler(client)(ctx)).stop_reason).toBe('end_turn');
    const rows = await engine.executeRaw<{ status: string; withheld: boolean }>(
      `SELECT status, output->>'result_withheld' IS NOT NULL AS withheld FROM subagent_tool_executions WHERE job_id = $1 ORDER BY id`, [ctx.id]);
    expect(rows).toEqual([{ status: 'complete', withheld: false }, { status: 'complete', withheld: false }, { status: 'complete', withheld: true }]);
    expect(JSON.stringify(calls[1]!.messages)).toContain('result_withheld');
  });

  test('a resumed run counts the results it already holds', async () => {
    const { applyTranscriptBudget } = await import('../src/core/minions/transcript-budget.ts');
    const data = { prompt: 'resume', max_transcript_chars: 4_000 };
    const fresh = await job(data);
    const [freshRead] = await applyTranscriptBudget(engine, fresh.id, data, tools());
    expect(await freshRead!.execute({}, { engine, jobId: fresh.id, remote: true })).toEqual(PAGE);
    const resumed = await job(data);
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 1, 'earlier', 'brain_get_page', '{}'::jsonb, 'complete', $2::text::jsonb)`, [resumed.id, JSON.stringify(PAGE)]);
    const [resumedRead] = await applyTranscriptBudget(engine, resumed.id, data, tools());
    expect(await resumedRead!.execute({}, { engine, jobId: resumed.id, remote: true })).toHaveProperty('result_withheld');
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

describe('patterns transcript budget', () => {
  test.each([
    [['claude-cli:claude-opus-5-5'], 280_000],
    [['anthropic:claude-opus-5-5'], 1_400_000],
    [['anthropic:claude-opus-5-5', 'claude-cli:claude-opus-5-5'], 280_000],
    [['no-such-provider:model'], 280_000],
  ])('%p: %i characters of prompt and tool results', (models, chars) => {
    expect(patternsTranscriptBudgetChars(models)).toBe(chars);
  });
});

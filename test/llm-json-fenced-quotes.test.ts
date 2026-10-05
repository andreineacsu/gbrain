/**
 * #6069: a ``` inside a JSON string value (a verbatim quote of a code block,
 * common in conversation transcripts) must not cut the payload short.
 *
 * 1. Protects: parseLlmJson returns the model's object or array when a string
 *    value holds ``` (a pair or a single one), fenced or not, for the object
 *    shape (significance judge, gateway expansion, subagent oneshot) and the
 *    array shape (conversation-parser LLM fallback).
 * 2. Fails when: the fenced extract is again the only candidate, so the
 *    non-greedy fence regex ends the payload at the first inner ```.
 * 3. Not covered before: the reasoning-ladder tests never put ``` inside a
 *    string value.
 * 4. No new seam: every assertion goes through the public entry points that
 *    exist before the fix (importing a new helper here would turn a
 *    reverted-source run into a module-load failure).
 */
import { describe, expect, test } from 'bun:test';
import { parseLlmJson } from '../src/core/llm-json.ts';
import { judgeSignificance, type JudgeClient } from '../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const F = '```';
const verdict = (quote: string) => ({
  score: 0.8, content_type: 'technical', segments: [{ quote, note: 'why' }], entities: [], reasons: ['a', 'b'],
});
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const pair = `run ${F}bash gbrain doctor${F} first`;
const single = `the fix starts with ${F}ts`;

describe('parseLlmJson: ``` inside a JSON string value (#6069)', () => {
  test.each([
    ['fenced object, quote holds a ``` pair', `${F}json\n${pretty(verdict(pair))}\n${F}`, verdict(pair)],
    ['fenced object, quote holds one ``` (a clipped code block)', `${F}json\n${pretty(verdict(single))}\n${F}`, verdict(single)],
    ['unfenced object, quote holds a ``` pair', pretty(verdict(pair)), verdict(pair)],
    ['fenced object with prose around it', `Here is the verdict:\n${F}json\n${pretty(verdict(pair))}\n${F}\nDone.`, verdict(pair)],
    ['reasoning block before a fenced object with a ``` pair', `<think>draft {"score": 0.1}</think>\n${F}json\n${pretty(verdict(pair))}\n${F}`, verdict(pair)],
    ['a brace in prose before a fenced object with a ``` pair', `Note {see below}:\n${F}json\n${pretty(verdict(pair))}\n${F}`, verdict(pair)],
  ])('%s', (_name, raw, expected) => {
    expect(parseLlmJson<unknown>(raw)).toEqual(expected);
  });

  test('array shape (conversation-parser fallback): fenced array whose strings hold ```', () => {
    const turns = [{ role: 'user', text: `try ${F}ls -la${F}` }, { role: 'assistant', text: `${F}py` }];
    expect(parseLlmJson<unknown>(`${F}json\n${pretty(turns)}\n${F}`, { array: true })).toEqual(turns);
  });

  test.each([
    // Both pass before and after the fix: the retry runs only after the fenced extract failed.
    ['a plain fenced object', `${F}json\n{"score": 0.5}\n${F}`, { score: 0.5 }],
    ['a fenced object followed by prose holding another object', `${F}json\n{"score": 0.5}\n${F}\nSee {"note": 1}.`, { score: 0.5 }],
  ])('unchanged success path: %s', (_name, raw, expected) => {
    expect(parseLlmJson<unknown>(raw)).toEqual(expected);
  });

  test.each([
    ['a fenced object truncated inside a quote', `${F}json\n{"score": 0.8, "segments": [{"quote": "run ${F}bash`],
    // The retry starts at the fence, so a draft in the reasoning block cannot stand in for the cut answer.
    ['a reasoning draft before a truncated fenced answer', `<think>draft {"score": 0.1}</think>\n${F}json\n{"score": 0.8, "segments": [{"quote": "run ${F}bash`],
  ])('still null: %s', (_name, raw) => {
    expect(parseLlmJson(raw)).toBeNull();
  });
});

describe('judgeSignificance: a quoted code block no longer makes the verdict unparseable (#6069)', () => {
  test('a fenced verdict whose quote holds a ``` pair is a scored, reliable verdict', async () => {
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: `${F}json\n${pretty(verdict(pair))}\n${F}` }],
        stop_reason: 'end_turn',
      } as never),
    };
    const t: DiscoveredTranscript = {
      filePath: '/corpus/fenced.txt', contentHash: 'hash-fenced'.padEnd(20, '0'),
      content: `user: ${pair}\n`.repeat(20), basename: 'fenced', inferredDate: null,
    };
    const r = await judgeSignificance(judge, t, 'anthropic:claude-haiku-4-5-20251001');
    expect(r.unreliable).toBeUndefined();
    expect(r.score).toBe(0.8);
    expect(r.segments).toEqual([{ quote: pair, note: 'why' }]);
  });
});

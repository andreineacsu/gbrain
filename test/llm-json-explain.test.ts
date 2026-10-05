/**
 * #6069 diagnostic: where an LLM response stops being valid JSON. Bun's
 * JSON.parse messages carry no position, so jsonErrorOffset scans for it and
 * the unreliable-verdict log line centers its scrubbed window on that offset.
 *
 * 1. Protects: the offset and candidate the diagnostic window shows.
 * 2. Fails when: the scanner misplaces the error (the window shows unrelated
 *    text), calls valid JSON invalid, or throws on hostile nesting.
 * 3. New code with no other owner.
 * 4. No seam.
 */
import { describe, expect, test } from 'bun:test';
import { explainLlmJsonFailure, jsonErrorOffset } from '../src/core/llm-json.ts';

describe('jsonErrorOffset', () => {
  test.each([
    ['valid nested JSON', '{"a":[1,2,{"b":null}],"c":-1.5e3,"d":"\\u00e9\\n"}', -1],
    ['a literal newline inside a string', '{"a":"x\ny"}', 7],
    ['an invalid escape', '{"a":"\\d"}', 6],
    ['a bad \\u escape', '{"a":"\\u12G4"}', 6],
    ['truncated inside a string', '{"a":"x', 7],
    ['a truncated array', '[1,2', 4],
    ['a trailing comma', '{"a":1,}', 7],
    ['a missing comma', '{"a":"x" "b":1}', 9],
    ['text after a complete value', '{"a":1} x', 8],
    ['a bare word', 'tru', 0],
    ['empty text', '', 0],
  ])('%s', (_name, s, at) => {
    expect(jsonErrorOffset(s)).toBe(at);
  });

  test('runaway nesting reports no offset instead of throwing', () => {
    expect(jsonErrorOffset('['.repeat(1_000_000))).toBeNull();
  });
});

describe('explainLlmJsonFailure', () => {
  test.each([
    ['a fenced object with a literal newline in a quote', '```json\n{"score":0.8,"q":"one\ntwo"}\n```', {}, { fenced: true, offset: 29 }],
    ['prose with no JSON', 'Sure! Here it is.', {}, { fenced: false, offset: 0 }],
    ['a truncated array', 'rows: [1,2', { array: true }, { fenced: false, offset: 10 }],
    ['valid JSON of the wrong shape', '[1]', {}, { fenced: false, offset: null, error: 'valid JSON of the wrong shape' }],
    ['blank text', '   ', {}, { fenced: false, offset: null, error: 'empty response' }],
  ])('%s', (_name, raw, opts, expected) => {
    expect(explainLlmJsonFailure(raw, opts)).toMatchObject(expected);
  });
});

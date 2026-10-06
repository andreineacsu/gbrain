/**
 * `gbrain edge-proposals` output for the row shape the Postgres driver returns.
 *
 * `link_edge_proposals.id` is BIGSERIAL: postgres.js hands int8 back as a JS
 * bigint, PGLite as a number. The JSON view printed those rows as they came,
 * so `list --json` and `show <id> --json` threw "JSON.stringify cannot
 * serialize BigInt" on Postgres only. These cases feed the command the bigint
 * row and assert one JSON document carrying the numeric id that PGLite and
 * the accept/reject/undo documents already carry. (#6193)
 *
 * The Postgres arm (real driver, real CLI) is in
 * test/e2e/cli-json-commands-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';
import { DREAM_TIMELINE_SOURCE } from '../src/core/cycle/edge-contradictions.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const PROPOSAL = {
  status: 'proposed', link_type: 'works_at', subject: 'people/alice-example',
  a_target: 'companies/acme-example', b_target: 'companies/widget-co', ending: 'companies/acme-example',
  close_date: '2024-05-01', born_closed: false, model: 'test-model', confidence: 0.9,
  generated_line: 'Left Acme Example.',
};
const CREATED_AT = '2026-01-02T03:04:05.000Z';
const JSON_ROW = { id: 12, ...PROPOSAL, created_at: CREATED_AT };
const TEXT_HEAD = '#12 [proposed] people/alice-example: works_at companies/acme-example vs companies/widget-co → companies/acme-example ended 2024-05-01';

/** An engine whose proposal rows carry the id the way postgres.js returns int8. */
function postgresShapedEngine(extra: Record<string, unknown>): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async () => [{ id: 12n, ...PROPOSAL, created_at: new Date(CREATED_AT), ...extra }],
  } as unknown as BrainEngine;
}

const realLog = console.log;
afterEach(() => { console.log = realLog; });

async function run(args: readonly string[], extra: Record<string, unknown> = {}): Promise<string> {
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try {
    await runEdgeProposals(postgresShapedEngine(extra), [...args]);
  } finally {
    console.log = realLog;
  }
  return lines.join('\n');
}

describe('edge-proposals with bigint proposal ids (#6193)', () => {
  test.each([
    { name: 'list', args: ['list', '--json'], expected: [JSON_ROW] },
    { name: 'list of every status', args: ['list', '--status', 'all', '--json'], expected: [JSON_ROW] },
    { name: 'show', args: ['show', '12', '--json'], expected: JSON_ROW },
  ])('$name prints one JSON document with a numeric id', async ({ args, expected }) => {
    expect(JSON.parse(await run(args))).toEqual(expected);
  });

  test('an int8 the row mapping does not cover prints as a decimal string instead of throwing', async () => {
    const printed = JSON.parse(await run(['show', '12', '--json'], { later_column: 9007199254740993n }));
    expect(printed).toEqual({ ...JSON_ROW, later_column: '9007199254740993' });
  });

  test.each([
    { name: 'list', args: ['list'], expected: `${TEXT_HEAD}\n\nNext: gbrain edge-proposals accept <id> | reject <id>` },
    {
      name: 'show', args: ['show', '12'],
      expected: `${TEXT_HEAD}\nmodel: test-model  confidence: 0.9\nline: - **2024-05-01** | ${DREAM_TIMELINE_SOURCE} — Left Acme Example.`,
    },
  ])('$name text output is the same for a bigint id', async ({ args, expected }) => {
    expect(await run(args)).toBe(expected);
  });
});

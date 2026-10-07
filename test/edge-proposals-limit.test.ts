/**
 * `gbrain edge-proposals list --limit` takes a positive integer.
 *
 * The value went through Number() and a 1..1000 clamp straight into the SQL
 * text, so a non-number reached the database as `LIMIT NaN` and the command
 * failed with a raw SQL error, while `--limit=N` was ignored. A bad value in
 * either spelling is now a usage error (`invalid_params`, exit 2 through
 * renderCliError) before any query, and a valid one keeps the clamp.
 */
import { describe, expect, test } from 'bun:test';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function recordingEngine(): { engine: BrainEngine; sql: string[] } {
  const sql: string[] = [];
  const engine = { kind: 'pglite', executeRaw: async (text: string) => { sql.push(text); return []; } } as unknown as BrainEngine;
  return { engine, sql };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

describe('edge-proposals list --limit', () => {
  test.each([
    { name: 'abc', value: 'abc' }, { name: '12abc', value: '12abc' }, { name: '1.5', value: '1.5' }, { name: '0', value: '0' },
    { name: '-2', value: '-2' }, { name: 'an unsafe integer', value: '9007199254740992' }, { name: 'a missing value', value: undefined },
  ])('refuses $name before any query', async ({ value }) => {
    // Both spellings (`--limit N`, `--limit=N`) on both query branches.
    const spellings = [['--limit', ...(value === undefined ? [] : [value])], [`--limit=${value ?? ''}`]];
    for (const status of [[], ['--status', 'all']]) {
      for (const limit of spellings) {
        const { engine, sql } = recordingEngine();
        await expect(runEdgeProposals(engine, ['list', ...status, ...limit])).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--limit') });
        expect(sql).toEqual([]);
      }
    }
  });

  test.each([
    { args: [], limit: 50 },
    { args: ['--limit', '5'], limit: 5 },
    { args: ['--limit', '1000'], limit: 1000 },
    { args: ['--limit', '5000'], limit: 1000 },
    { args: ['--status', 'all', '--limit', '7'], limit: 7 },
    { args: ['--limit=7'], limit: 7 },
  ])('$args queries with LIMIT $limit', async ({ args, limit }) => {
    const { engine, sql } = recordingEngine();
    await quietly(() => runEdgeProposals(engine, ['list', ...args]));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toEndWith(`LIMIT ${limit}`);
  });
});

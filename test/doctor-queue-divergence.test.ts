/**
 * Five-issue fix wave — doctor's NEW queue_health surfaces (queue-type
 * divergence + waiting-TTL cancellation visibility) and the
 * malformed_path_pages discovery check.
 *
 * computeQueueHealthCheck is Postgres-only (short-circuits to ok on PGLite),
 * so its grouped SQL runs on a real PGLite engine behind a `kind: 'postgres'`
 * stub — the same harness as test/doctor-wedged-queue.test.ts.
 * malformed_path_pages has no exported compute function; it is driven through
 * buildChecks on the real PGLite engine (the seam
 * test/doctor-graph-coverage-soft-deleted.test.ts already uses).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { computeQueueHealthCheck, buildChecks } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let base: PGLiteEngine;
let pgLike: BrainEngine;

beforeAll(async () => {
  base = new PGLiteEngine();
  await base.connect({});
  await base.initSchema();
  // computeQueueHealthCheck only reads .kind + .executeRaw.
  pgLike = {
    kind: 'postgres',
    executeRaw: base.executeRaw.bind(base),
  } as unknown as BrainEngine;
});

afterAll(async () => {
  await base.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(base);
});

async function seed(
  queue: string,
  name: string,
  status: string,
  extra: { createdAtSql?: string; finishedAtSql?: string; errorText?: string } = {},
): Promise<void> {
  await base.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, error_text, created_at, updated_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, $1, $2, $3, $4, ${extra.createdAtSql ?? 'now()'}, now(), ${extra.finishedAtSql ?? 'NULL'})`,
    [name, queue, status, extra.errorText ?? null],
  );
}

describe('queue_health — DIVERGENT queue type detection', () => {
  it('flags a type whose intake structurally exceeds drain while a real backlog waits', async () => {
    // Lower the min-waiting knob (default 50) so a small seed triggers.
    await withEnv({ GBRAIN_QUEUE_DIVERGENCE_MIN_WAITING: '5' }, async () => {
      // 6 waiting rows created within 24h: intake=6, completed=0, waiting=6.
      // waiting 6 > minWaiting 5 AND intake 6 > ratio 2 × max(0, 1) → DIVERGENT.
      // Stays under GBRAIN_QUEUE_WAITING_THRESHOLD (10) so the depth problem
      // can't fire and mask which surface produced the warn.
      for (let i = 0; i < 6; i++) {
        await seed('default', 'ingest-batch', 'waiting', {
          createdAtSql: "now() - interval '1 hour'",
        });
      }
      const check = await computeQueueHealthCheck(pgLike, {
        readWorkers: () => [{ queue: 'default' }],
      });
      expect(check.status).toBe('warn');
      expect(check.message).toContain("DIVERGENT queue type 'ingest-batch'");
      expect(check.message).toContain('intake 6/24h vs 0 completed/24h');
      // The quota-config admission hint must be paste-ready.
      expect(check.message).toContain('minions.quota_max_waiting.ingest-batch');
    });
  });
});

describe('queue_health — waiting-TTL cancellation visibility', () => {
  it('surfaces waiting_ttl_expired cancellations from the last 24h with the TTL tuning hint', async () => {
    for (const finishedAtSql of ["now() - interval '1 hour'", "now() - interval '2 hours'"]) {
      await seed('default', 'ingest-batch', 'cancelled', {
        errorText: 'waiting_ttl_expired: test',
        finishedAtSql,
      });
    }
    const check = await computeQueueHealthCheck(pgLike, { readWorkers: () => [] });
    expect(check.status).toBe('warn');
    expect(check.message).toContain("waiting-TTL cancelled 2 'ingest-batch' job(s)");
    expect(check.message).toContain('minions.ttl_waiting_hours.ingest-batch');
  });

  it('ignores TTL cancellations older than the 24h window', async () => {
    await seed('default', 'ingest-batch', 'cancelled', {
      errorText: 'waiting_ttl_expired: test',
      finishedAtSql: "now() - interval '48 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, { readWorkers: () => [] });
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('waiting-TTL cancelled');
  });
});

describe('queue_health — healthy queue stays quiet', () => {
  it('neither the DIVERGENT nor the waiting-TTL string appears on a healthy seed', async () => {
    await seed('default', 'ingest-batch', 'waiting');
    await seed('default', 'ingest-batch', 'completed', { finishedAtSql: 'now()' });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }],
    });
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('DIVERGENT');
    expect(check.message).not.toContain('waiting-TTL cancelled');
  });
});

describe('queue_health: prompt_too_long deaths name their dream phase (#6303)', () => {
  // The submission key (live, or released into data on death) says which dream
  // phase submitted the child, the same rule the paid-loop breaker counts by;
  // an unkeyed child in a private dream-inline queue is a patterns child.
  type Seed = { live?: string; released?: string; queue?: string };
  async function deadSubagent(error: string, seed: Seed = {}): Promise<number> {
    const [row] = await base.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, error_text, idempotency_key, data, created_at, updated_at, finished_at)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $4, 'dead', $1, $2, $3::text::jsonb, now(), now(), now())
       RETURNING id`,
      [error, seed.live ?? null, JSON.stringify(seed.released ? { __released_idempotency_key: seed.released } : {}), seed.queue ?? 'dream-inline-test'],
    );
    return Number(row!.id);
  }

  const synthKey = 'dream:synth-v2:default:filename:a.txt:0123456789abcdef:c1of2';
  it.each([
    {
      label: 'patterns deaths (live key, released key, unkeyed in a dream-inline queue) get the patterns advice, not the synthesize one',
      seed: [{ live: 'dream:patterns:aaa' }, { released: 'dream:patterns:bbb' }, {}] as Seed[],
      contains: ['3 dream patterns subagent job(s) dead-lettered with prompt_too_long', 'dream.patterns.lookback_days', 'models.dream.patterns'],
      excludes: ['gbrain dream --phase synthesize', 'synthesize subagent'],
      byPhase: { patterns: 3 },
    },
    {
      label: 'synthesize deaths keep the synthesize advice',
      seed: [{ live: synthKey }] as Seed[],
      contains: ['1 dream synthesize subagent job(s) dead-lettered with prompt_too_long', 'dream.synthesize.max_prompt_tokens'],
      excludes: ['dream patterns subagent', 'dream.patterns.lookback_days'],
      byPhase: { synthesize: 1 },
    },
    {
      label: 'a death outside dream is not blamed on a dream phase and names the newest job',
      seed: [{ queue: 'default' }, { queue: 'default' }] as Seed[],
      contains: ['2 other subagent job(s) (not submitted by dream synthesize or patterns) dead-lettered with prompt_too_long'],
      excludes: ['dream.synthesize.max_prompt_tokens', 'dream.patterns.lookback_days'],
      byPhase: { other: 2 },
      namesNewestJob: true,
    },
    {
      label: 'deaths of both phases in one window get one line each',
      seed: [{ live: 'dream:patterns:ddd' }, { live: synthKey }] as Seed[],
      contains: ['1 dream synthesize subagent job(s)', '1 dream patterns subagent job(s)'],
      excludes: ['other subagent job(s)'],
      byPhase: { synthesize: 1, patterns: 1 },
    },
  ])('$label', async ({ seed, contains, excludes, byPhase, namesNewestJob }) => {
    const ids: number[] = [];
    for (const s of seed) ids.push(await deadSubagent('prompt_too_long: prompt is too long: 250000 tokens > 200000 maximum', s));
    // A patterns child that died at its timeout is not a prompt_too_long death.
    await deadSubagent('timeout exceeded', { live: 'dream:patterns:ccc' });
    const check = await computeQueueHealthCheck(pgLike, { readWorkers: () => [{ queue: 'default' }] });
    expect(check.status).toBe('warn');
    for (const text of contains) expect(check.message).toContain(text);
    for (const text of excludes) expect(check.message).not.toContain(text);
    if (namesNewestJob) expect(check.message).toContain(`gbrain jobs get ${Math.max(...ids)}`);
    expect(check.details?.prompt_too_long_by_phase).toEqual(byPhase);
  });
});

describe('malformed_path_pages discovery check (buildChecks seam)', () => {
  it('warns naming the count + slug when a page is backed by a bracketed filename', async () => {
    await base.executeRaw(
      `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter, content_hash)
       VALUES ('default', 'junk-1', '[foo.md](https-x).md', 'note', 'Junk', 'b', '', '{}'::jsonb, 'mp1')`,
    );
    const checks = await buildChecks(base, [], null);
    const check = checks.find((c) => c.name === 'malformed_path_pages');
    expect(check, 'malformed_path_pages check must be present').toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('1 page(s) backed by malformed filenames');
    expect(check!.message).toContain('junk-1');
  });

  it('clean DB → the check does not fire (absence is the ok state)', async () => {
    await base.executeRaw(
      `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter, content_hash)
       VALUES ('default', 'clean-1', 'notes/clean-1.md', 'note', 'Clean', 'b', '', '{}'::jsonb, 'cl1')`,
    );
    const checks = await buildChecks(base, [], null);
    expect(checks.find((c) => c.name === 'malformed_path_pages')).toBeUndefined();
  });
});

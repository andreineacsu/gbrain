/**
 * #4152 two-stage cascade — runTriagePass + buildTriageMapBlock +
 * parseSynthV2Key unit tests.
 *
 * runTriagePass touches the engine only through get/putDreamVerdict, so a
 * Map-backed fake engine keeps these tests fast and deterministic (no PGLite
 * startup). The judge is injected via cfg.judge; the clock via cfg.now — no
 * real sleeps anywhere.
 *
 * Run: bun test test/cycle-synthesize-triage.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  runTriagePass,
  judgeSignificance,
  buildTriageMapBlock,
  parseSynthV2Key,
  dreamInlineQueueAgeMs,
  DREAM_INLINE_LIVE_GRACE_MS,
  TRIAGE_VERSION,
  type JudgeClient,
  type TriagePassCfg,
} from '../src/core/cycle/synthesize.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../src/core/engine.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';

function makeTranscript(name: string, content = `content of ${name} `.repeat(50)): DiscoveredTranscript {
  return {
    filePath: `/corpus/${name}.txt`,
    contentHash: `hash-${name}`.padEnd(20, '0'),
    content,
    basename: name,
    inferredDate: null,
  };
}

/** Map-backed fake engine exposing only the two verdict methods runTriagePass uses. */
function makeFakeEngine(): { engine: BrainEngine; rows: Map<string, DreamVerdict>; putCalls: number } {
  const rows = new Map<string, DreamVerdict>();
  const state = { putCalls: 0 };
  const engine = {
    async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
      return rows.get(`${filePath}|${contentHash}`) ?? null;
    },
    async putDreamVerdict(filePath: string, contentHash: string, v: DreamVerdictInput): Promise<void> {
      state.putCalls++;
      rows.set(`${filePath}|${contentHash}`, { ...v, judged_at: new Date().toISOString() });
    },
  } as unknown as BrainEngine;
  return {
    engine,
    rows,
    get putCalls() { return state.putCalls; },
  };
}

function scoredJudge(score: number, extra: Record<string, unknown> = {}): JudgeClient {
  return {
    create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ score, reasons: ['mock'], ...extra }) }],
      stop_reason: 'end_turn',
    } as never),
  };
}

function baseCfg(judge: JudgeClient | null, over: Partial<TriagePassCfg> = {}): TriagePassCfg {
  return {
    model: MODEL,
    maxChars: 24_000,
    maxTokens: 2048,
    threshold: 0.5,
    concurrency: 4,
    maxMs: 0,
    judge,
    ...over,
  };
}

function seedVerdict(rows: Map<string, DreamVerdict>, t: DiscoveredTranscript, v: Partial<DreamVerdict>): void {
  rows.set(`${t.filePath}|${t.contentHash}`, {
    worth_processing: true,
    reasons: ['seed'],
    judged_at: new Date().toISOString(),
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: MODEL,
    triage_version: TRIAGE_VERSION,
    ...v,
  });
}

describe('runTriagePass — cache validity (C8)', () => {
  test('valid cached row is a HIT: no judge call, no cache write, report cached=true, byPath populated', async () => {
    const fake = makeFakeEngine();
    const t = makeTranscript('cached');
    seedVerdict(fake.rows, t, { score: 0.8 });
    let judgeCalls = 0;
    const judge: JudgeClient = { create: async () => { judgeCalls++; throw new Error('should not be called'); } };
    const r = await runTriagePass(fake.engine, [t], baseCfg(judge));
    expect(judgeCalls).toBe(0);
    expect(fake.putCalls).toBe(0); // hit path never re-writes the row
    expect(r.cacheHits).toBe(1);
    expect(r.reports[0].cached).toBe(true);
    expect(r.reports[0].worth).toBe(true);
    expect(r.byPath.get(t.filePath)?.score).toBe(0.8);
  });

  test('legacy boolean-era row (score null) is a MISS — re-judged and overwritten', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('legacy');
    seedVerdict(rows, t, { score: null, triage_version: null, model: null });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.7)));
    expect(r.judged).toBe(1);
    expect(r.cacheHits).toBe(0);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.7);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.triage_version).toBe(TRIAGE_VERSION);
  });

  test('a verdict a chat_fallback_chain model gave decides this run but is never cached', async () => {
    const fake = makeFakeEngine();
    const t = makeTranscript('fallback');
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ score: 0.7, reasons: ['mock'] }) }],
        stop_reason: 'end_turn',
        answered_by: 'openai:gpt-example',
      } as never),
    };
    const r = await runTriagePass(fake.engine, [t], baseCfg(judge));
    expect(r.judged).toBe(1);
    expect(fake.putCalls).toBe(0);
    expect(r.reports[0]?.score).toBe(0.7);
    expect(r.reports[0]?.worth).toBe(true);
  });

  test('model mismatch is a MISS — switching models re-judges (C8)', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('model-switch');
    seedVerdict(rows, t, { score: 0.9, model: 'anthropic:some-other-model' });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.3)));
    expect(r.judged).toBe(1);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.model).toBe(MODEL);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.3);
  });

  test('triage_version mismatch is a MISS', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('version-bump');
    seedVerdict(rows, t, { score: 0.9, triage_version: TRIAGE_VERSION + 1 });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.6)));
    expect(r.judged).toBe(1);
  });

  test('staleBefore treats older rows as misses; force ignores the cache entirely', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('stale');
    seedVerdict(rows, t, { score: 0.9, judged_at: '2020-01-01T00:00:00.000Z' });
    const stale = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.6), { staleBefore: new Date('2025-01-01') }));
    expect(stale.judged).toBe(1);
    // Fresh again now; force still re-judges.
    const forced = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.2), { force: true }));
    expect(forced.judged).toBe(1);
    expect(rows.get(`${t.filePath}|${t.contentHash}`)?.score).toBe(0.2);
  });
});

describe('runTriagePass — gate + threshold', () => {
  test('>= threshold boundary: exactly-at passes, just-below does not', async () => {
    const { engine, rows } = makeFakeEngine();
    const at = makeTranscript('at');
    const below = makeTranscript('below');
    seedVerdict(rows, at, { score: 0.5 });
    seedVerdict(rows, below, { score: 0.4999 });
    const r = await runTriagePass(engine, [at, below], baseCfg(null, { threshold: 0.5 }));
    expect(r.reports.find(x => x.filePath === at.filePath)?.worth).toBe(true);
    expect(r.reports.find(x => x.filePath === below.filePath)?.worth).toBe(false);
  });

  test('threshold 0 gates everything judged in (a low score still passes)', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('zero');
    seedVerdict(rows, t, { score: 0 });
    const r = await runTriagePass(engine, [t], baseCfg(null, { threshold: 0 }));
    expect(r.reports[0].worth).toBe(true);
  });
});

describe('runTriagePass — F2 verified-segment rescue at report construction', () => {
  // A transcript whose content contains two substantive passages the judge
  // can quote verbatim — the buried-signal shape.
  const BURIED = makeTranscript('buried', [
    'routine chatter about scheduling and lunch orders. ',
    'I keep thinking our retention problem is actually an onboarding problem in disguise. ',
    'more routine chatter. ',
    'Decision: we kill the referral program next quarter because it cannibalizes organic signups. ',
  ].join(''));
  const SEGMENTS = [
    { quote: 'our retention problem is actually an onboarding problem in disguise' },
    { quote: 'we kill the referral program next quarter because it cannibalizes organic signups' },
  ];

  test('cached band verdict with verified segments → worth=true, rescued flagged (works on CACHED rows — no re-judge)', async () => {
    const fake = makeFakeEngine();
    seedVerdict(fake.rows, BURIED, { score: 0.35, content_type: 'mixed', segments: SEGMENTS });
    const r = await runTriagePass(fake.engine, [BURIED], baseCfg(null));
    expect(fake.putCalls).toBe(0); // rescue is gate-time: cached verdict, zero LLM
    expect(r.reports[0].worth).toBe(true);
    expect(r.reports[0].rescued).toBe(true);
    expect(r.reports[0].verified_segments).toBe(2);
  });

  test('fresh band verdict rescues the same way (judge returns segments)', async () => {
    const { engine } = makeFakeEngine();
    const judge = scoredJudge(0.4, { content_type: 'mixed', segments: SEGMENTS });
    const r = await runTriagePass(engine, [BURIED], baseCfg(judge));
    expect(r.reports[0].worth).toBe(true);
    expect(r.reports[0].rescued).toBe(true);
  });

  test('fabricated segments never rescue; routine content_type never rescues', async () => {
    const fake = makeFakeEngine();
    seedVerdict(fake.rows, BURIED, {
      score: 0.35, content_type: 'mixed',
      segments: [{ quote: 'a passage that appears nowhere in this transcript at all, invented' }],
    });
    const r1 = await runTriagePass(fake.engine, [BURIED], baseCfg(null));
    expect(r1.reports[0].worth).toBe(false);
    expect(r1.reports[0].rescued).toBeUndefined();

    seedVerdict(fake.rows, BURIED, { score: 0.35, content_type: 'routine', segments: SEGMENTS });
    const r2 = await runTriagePass(fake.engine, [BURIED], baseCfg(null));
    expect(r2.reports[0].worth).toBe(false);
  });

  test('kill switch (rescue.minSegments=0) restores the plain threshold gate', async () => {
    const fake = makeFakeEngine();
    seedVerdict(fake.rows, BURIED, { score: 0.35, content_type: 'mixed', segments: SEGMENTS });
    const r = await runTriagePass(fake.engine, [BURIED], baseCfg(null, {
      rescue: { floor: 0.30, minSegments: 0, contentTypes: ['mixed'] },
    }));
    expect(r.reports[0].worth).toBe(false);
  });

  test('F6 regression: a degenerate (unparseable) judge response still contributes tokens — the call was paid', async () => {
    const { engine } = makeFakeEngine();
    const t = makeTranscript('degenerate-paid');
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: 'not json at all' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1234, output_tokens: 56 },
      } as never),
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge));
    expect(r.unreliable).toBe(1);
    expect(r.tokens).toEqual({ in: 1234, out: 56 });
  });

  test('F6 regression: priceChatUsd is null for unpriced models, non-null rounded for priced (never a fake 0)', async () => {
    const { __testing } = await import('../src/core/cycle/synthesize.ts');
    expect(__testing.priceChatUsd('totally-unknown:model-x', { in: 1000, out: 1000 })).toBeNull();
    const priced = __testing.priceChatUsd('anthropic:claude-haiku-4-5-20251001', { in: 1_000_000, out: 0 });
    expect(priced).not.toBeNull();
    expect(priced!).toBeGreaterThan(0);
  });

  test('buildTriageMapBlock: case/curly-punctuation drift in a judge quote still verifies (shared normalizer)', () => {
    const chunk = 'The user said “We charge for durability, not storage” and moved on.';
    const block = buildTriageMapBlock({
      score: 0.8,
      content_type: 'idea',
      segments: [{ quote: 'we charge for durability, not storage' }],
      entities: [],
    } as never, chunk, 1);
    expect(block).toContain('we charge for durability, not storage');
  });

  test('a rescued report is NOT below_threshold (the one-gate consistency the retriage sweep reads)', async () => {
    const fake = makeFakeEngine();
    seedVerdict(fake.rows, BURIED, { score: 0.35, content_type: 'mixed', segments: SEGMENTS });
    const rejected = makeTranscript('rejected');
    seedVerdict(fake.rows, rejected, { score: 0.35, content_type: 'mixed', segments: [] });
    const r = await runTriagePass(fake.engine, [BURIED, rejected], baseCfg(null));
    const belowThreshold = r.reports.filter(x => x.score !== null && !x.worth);
    expect(belowThreshold.map(x => x.filePath)).toEqual([rejected.filePath]);
  });
});

describe('runTriagePass — time budget (1C) + shouldStop', () => {
  test('maxMs expiry defers remaining MISSES (uncached) while cache hits stay free', async () => {
    const { engine, rows } = makeFakeEngine();
    const miss1 = makeTranscript('m1');
    const miss2 = makeTranscript('m2');
    const miss3 = makeTranscript('m3');
    const hit = makeTranscript('hit');
    seedVerdict(rows, hit, { score: 0.9 });
    // Fake clock: each now() call advances 40ms; budget 100ms → the first
    // miss judges, later misses defer. concurrency 1 for determinism.
    let clock = 0;
    const now = (): number => { clock += 40; return clock; };
    const r = await runTriagePass(engine, [miss1, miss2, miss3, hit], baseCfg(scoredJudge(0.8), {
      concurrency: 1,
      maxMs: 100,
      now,
    }));
    expect(r.judged).toBeGreaterThanOrEqual(1);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect(r.cacheHits).toBe(1); // the hit is NEVER deferred
    const deferredReports = r.reports.filter(x => x.deferred);
    expect(deferredReports.length).toBe(r.deferred);
    for (const d of deferredReports) {
      expect(d.worth).toBe(false);
      expect(d.score).toBeNull();
      // Deferred files are NOT cached — next pass continues.
      expect([...rows.keys()].some(k => k.startsWith(d.filePath))).toBe(false);
    }
  });

  test('in-flight semantics: a judge call started inside the budget completes and IS cached', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('inflight');
    // Clock: 0 at start; stays 0 until the judge call BEGINS, then jumps past
    // the budget while the call is in flight. The pull happened inside the
    // budget, so the verdict must complete and be cached (no torn judgments).
    let clock = 0;
    const now = (): number => clock;
    const judge: JudgeClient = {
      create: async (p) => {
        clock = 10_000; // budget (500ms) expires mid-call
        return scoredJudge(0.7).create(p);
      },
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge, { maxMs: 500, now }));
    expect(r.judged).toBe(1);
    expect(r.deferred).toBe(0);
    expect(rows.size).toBe(1); // cached despite expiry mid-flight
  });

  test('CX3: shouldStop is ticked on UNRELIABLE judge attempts too (paid calls count)', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('u1'), makeTranscript('u2'), makeTranscript('u3')];
    let ticks = 0;
    // Judge always truncates — every attempt is unreliable but still paid.
    const judge: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text: '{"scor' }], stop_reason: 'max_tokens' } as never),
    };
    const r = await runTriagePass(engine, ts, baseCfg(judge, {
      concurrency: 1,
      shouldStop: () => { ticks++; return ticks >= 2; },
    }));
    expect(ticks).toBe(2);       // budget consumed by unreliable attempts
    expect(r.unreliable).toBe(2);
    expect(r.deferred).toBe(1);  // third file never pulled
  });

  test('shouldStop stops pulling new misses (retriage --max-usd seam)', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('s1'), makeTranscript('s2'), makeTranscript('s3'), makeTranscript('s4')];
    let judged = 0;
    const judge = scoredJudge(0.6);
    const counting: JudgeClient = { create: async (p) => { judged++; return judge.create(p); } };
    const r = await runTriagePass(engine, ts, baseCfg(counting, {
      concurrency: 1,
      shouldStop: () => judged >= 2,
    }));
    expect(r.judged).toBe(2);
    expect(r.deferred).toBe(2);
  });
});

describe('runTriagePass — degrade + failure contracts', () => {
  test('null judge (no provider) degrades per transcript; nothing cached; cache hits still served', async () => {
    const { engine, rows } = makeFakeEngine();
    const hit = makeTranscript('hit');
    const miss = makeTranscript('miss');
    seedVerdict(rows, hit, { score: 0.9 });
    const r = await runTriagePass(engine, [hit, miss], baseCfg(null));
    expect(r.cacheHits).toBe(1);
    const missReport = r.reports.find(x => x.filePath === miss.filePath)!;
    expect(missReport.worth).toBe(false);
    expect(missReport.reasons[0]).toContain('no configured provider');
    expect(rows.size).toBe(1); // only the seed
  });

  test('AIConfigError degrades per transcript (gateway error reason), pass continues', async () => {
    const { engine } = makeFakeEngine();
    const bad = makeTranscript('bad');
    const good = makeTranscript('good');
    let call = 0;
    const judge: JudgeClient = {
      create: async (p) => {
        call++;
        if (call === 1) throw new AIConfigError('simulated revoked key');
        return scoredJudge(0.8).create(p);
      },
    };
    const r = await runTriagePass(engine, [bad, good], baseCfg(judge, { concurrency: 1 }));
    expect(r.reports[0].reasons[0]).toContain('gateway error');
    expect(r.reports[1].score).toBe(0.8);
  });

  test('hard (non-AIConfig) error aborts new pulls and rethrows — phase fails', async () => {
    const { engine } = makeFakeEngine();
    const ts = [makeTranscript('h1'), makeTranscript('h2'), makeTranscript('h3')];
    const judge: JudgeClient = { create: async () => { throw new Error('database on fire'); } };
    await expect(runTriagePass(engine, ts, baseCfg(judge, { concurrency: 1 }))).rejects.toThrow('database on fire');
  });

});

/**
 * #6069: an unreliable judgment (truncated / refusal / unparseable) is paid
 * for and thrown away. It must never become a verdict (a cached rejection is
 * permanent for the content hash), but re-judging it at full price on every
 * run is unbounded spend. The pass stores a NULL-score backoff marker in the
 * verdict slot and skips the transcript until the backoff ends. Pre-fix the
 * slot stayed empty and every run paid again.
 */
describe('runTriagePass: unreliable-judge backoff (#6069)', () => {
  const key = (t: DiscoveredTranscript) => `${t.filePath}|${t.contentHash}`;
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const countingJudge = (calls: { n: number }, text: string, extra: Record<string, unknown> = {}): JudgeClient => ({
    create: async () => {
      calls.n++;
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra } as never;
    },
  });
  const seedMarker = (rows: Map<string, DreamVerdict>, t: DiscoveredTranscript, v: Partial<DreamVerdict> = {}) =>
    seedVerdict(rows, t, { score: null, worth_processing: false, reasons: ['judge-unreliable:1:unparseable'], judged_at: daysAgo(1), ...v });

  test('an unreliable judgment is never a verdict: it stores a NULL-score backoff marker', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('trunc');
    const judge: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text: '{"scor' }], stop_reason: 'max_tokens' } as never),
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge));
    expect(r.unreliable).toBe(1);
    expect(r.reports[0].unreliable).toBe('truncated');
    expect(r.byPath.has(t.filePath)).toBe(false);
    expect(rows.get(key(t))).toMatchObject({
      score: null, worth_processing: false, model: MODEL, triage_version: TRIAGE_VERSION,
      reasons: ['judge-unreliable:1:truncated', 'judge response truncated (stop_reason=max_tokens)'],
    });
  });

  test('no judge call while the backoff runs; a failure after it ends doubles the next wait', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('flaky');
    const calls = { n: 0 };
    const judge = countingJudge(calls, 'not json at all');
    await runTriagePass(engine, [t], baseCfg(judge));
    const held = await runTriagePass(engine, [t], baseCfg(judge));
    expect(calls.n).toBe(1);
    expect(held.judged).toBe(0);
    expect(held.backoff).toBe(1);
    expect(held.reports[0]).toMatchObject({ backoff: true, cached: true, worth: false, score: null, unreliable: 'unparseable' });

    rows.get(key(t))!.judged_at = daysAgo(3.1); // first step: 3 days
    const retried = await runTriagePass(engine, [t], baseCfg(judge));
    expect(calls.n).toBe(2);
    expect(retried.unreliable).toBe(1);
    expect(rows.get(key(t))!.reasons[0]).toBe('judge-unreliable:2:unparseable');

    rows.get(key(t))!.judged_at = daysAgo(5); // second step: 6 days
    const heldAgain = await runTriagePass(engine, [t], baseCfg(judge));
    expect(calls.n).toBe(2);
    expect(heldAgain.backoff).toBe(1);
  });

  test('a reliable verdict once the backoff ends replaces the marker', async () => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('recovered');
    seedMarker(rows, t, { judged_at: daysAgo(4) });
    const r = await runTriagePass(engine, [t], baseCfg(scoredJudge(0.8)));
    expect(r.judged).toBe(1);
    expect(r.backoff).toBe(0);
    expect(rows.get(key(t))).toMatchObject({ score: 0.8, reasons: ['mock'] });
    expect(r.byPath.get(t.filePath)?.score).toBe(0.8);
  });

  test.each([
    ['--force', {}, { force: true }],
    ['another verdict model', { model: 'openai:gpt-example' }, {}],
    ['an older TRIAGE_VERSION', { triage_version: TRIAGE_VERSION - 1 }, {}],
    ['retriage --since after the marker', {}, { staleBefore: new Date(Date.now() - 3_600_000) }],
    ['an explicit --input/--date synthesize target', {}, { ignoreBackoff: true }],
  ] as const)('a running marker does not hold back a judge call under %s', async (_name, marker, cfg) => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('tuple');
    seedMarker(rows, t, marker as Partial<DreamVerdict>);
    const calls = { n: 0 };
    const r = await runTriagePass(engine, [t], baseCfg(countingJudge(calls, JSON.stringify({ score: 0.6, reasons: ['mock'] })), cfg as Partial<TriagePassCfg>));
    expect(calls.n).toBe(1);
    expect(r.backoff).toBe(0);
    expect(rows.get(key(t))?.score).toBe(0.6);
  });

  // A pass whose judge calls failed half the time or more looks like a
  // provider problem, not the pages (the #6069 report: 20 of 21 failed, then
  // judged cleanly shortly after). Its markers hold 6 hours without counting
  // an attempt; a lone failure, or a minority, takes the normal backoff.
  const badOrGoodJudge: JudgeClient = {
    create: async (params) => {
      const prompt = String((params as { messages: Array<{ content: unknown }> }).messages[0].content);
      const text = prompt.startsWith('Transcript bad') ? 'not json' : JSON.stringify({ score: 0.6, reasons: ['mock'] });
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn' } as never;
    },
  };
  const mixedRun = (bad: number, good: number) => [
    ...Array.from({ length: bad }, (_, i) => makeTranscript(`bad${i}`)),
    ...Array.from({ length: good }, (_, i) => makeTranscript(`good${i}`)),
  ];
  test.each([
    ['three of six unreliable looks like an outage: short holds', 3, 3, 'judge-unreliable:0:unparseable:outage'],
    ['one of two is the smallest outage (the boundary)', 1, 1, 'judge-unreliable:0:unparseable:outage'],
    ['two of six unreliable: those two back off normally', 2, 4, 'judge-unreliable:1:unparseable'],
    ['one call that fails is no evidence of an outage', 1, 0, 'judge-unreliable:1:unparseable'],
  ])('%s', async (_name, bad, good, marker) => {
    const { engine, rows } = makeFakeEngine();
    const r = await runTriagePass(engine, mixedRun(bad, good), baseCfg(badOrGoodJudge));
    expect(r.unreliable).toBe(bad);
    const markers = [...rows.values()].filter(v => v.score === null);
    expect(markers.map(v => v.reasons[0])).toEqual(Array(bad).fill(marker));
    expect([...rows.values()].filter(v => v.score !== null)).toHaveLength(good);
  });

  test('an outage hold ends after 6 hours; failing in the next outage-looking run escalates to the normal backoff', async () => {
    const { engine, rows } = makeFakeEngine();
    const calls = { n: 0 };
    const judge = countingJudge(calls, 'not json');
    const ts = mixedRun(2, 0);
    await runTriagePass(engine, ts, baseCfg(judge));
    expect((await runTriagePass(engine, ts, baseCfg(judge))).backoff).toBe(2); // held within the 6 hours
    for (const t of ts) rows.get(key(t))!.judged_at = new Date(Date.now() - 7 * 3_600_000).toISOString();
    await runTriagePass(engine, ts, baseCfg(judge));
    expect(calls.n).toBe(4);
    expect(ts.map(t => rows.get(key(t))!.reasons[0])).toEqual(Array(2).fill('judge-unreliable:1:unparseable'));
  });

  test('a failed marker write is logged and the pass still returns its reports', async () => {
    const { engine } = makeFakeEngine();
    (engine as { putDreamVerdict: unknown }).putDreamVerdict = async () => { throw new Error('connection reset'); };
    const r = await runTriagePass(engine, [makeTranscript('w')], baseCfg(countingJudge({ n: 0 }, 'not json')));
    expect(r.unreliable).toBe(1);
    expect(r.reports[0].unreliable).toBe('unparseable');
  });

  test('no marker when a fallback model answered or the cycle was cancelled during the call', async () => {
    const fallback = makeFakeEngine();
    await runTriagePass(fallback.engine, [makeTranscript('fb')], baseCfg(countingJudge({ n: 0 }, 'not json', { answered_by: 'openai:gpt-example' })));
    expect(fallback.rows.size).toBe(0);

    const cancelled = makeFakeEngine();
    const controller = new AbortController();
    const judge: JudgeClient = {
      create: async () => {
        controller.abort();
        return { content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' } as never;
      },
    };
    await runTriagePass(cancelled.engine, [makeTranscript('cx')], baseCfg(judge, { signal: controller.signal }));
    expect(cancelled.rows.size).toBe(0);
  });

  // A marker is for content without a verdict. Under --force the pass never
  // read the slot, and a concurrent run can write a verdict while this call is
  // in flight; either way the scored row must survive the failed re-judge.
  test.each([
    ['--force re-judges a scored verdict and the call fails', true, false],
    ['a concurrent run writes a verdict while the call is in flight', false, true],
  ])('no marker over a scored verdict: %s', async (_name, force, concurrent) => {
    const { engine, rows } = makeFakeEngine();
    const t = makeTranscript('kept');
    if (!concurrent) seedVerdict(rows, t, { score: 0.9, reasons: ['scored'] });
    const judge: JudgeClient = {
      create: async () => {
        if (concurrent) seedVerdict(rows, t, { score: 0.9, reasons: ['scored'] });
        return { content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' } as never;
      },
    };
    const r = await runTriagePass(engine, [t], baseCfg(judge, { force }));
    expect(r.unreliable).toBe(1);
    expect(rows.get(key(t))).toMatchObject({ score: 0.9, reasons: ['scored'] });
  });

  test('the diagnostic names the JSON error and shows a redacted window around it', async () => {
    // A literal newline inside a quote is invalid JSON; the window must point at it.
    // The synthetic token is assembled at runtime so secret scanners never see it in source.
    const token = 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5';
    const text = `\`\`\`json\n{"score": 0.8, "segments": [{"quote": "mail alice@example.com\nkey ${token}"}]}\n\`\`\``;
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text }], stop_reason: 'end_turn', gateway_stop_reason: 'other', usage: { input_tokens: 900, output_tokens: 42 },
      } as never),
    };
    const r = await judgeSignificance(judge, makeTranscript('diag'), MODEL);
    expect(r.unreliable).toBe('unparseable');
    expect(r.diagnostic).toContain(`response ${text.length} chars`);
    expect(r.diagnostic).toContain('stop_reason=end_turn, gateway finish=other, 42 output tokens, fenced');
    // The window is centered on the error (the literal newline), after redaction.
    expect(r.diagnostic).toMatch(/JSON error ".+" at char \d+ near ".*\[REDACTED\]\\nkey <REDACTED:github_token>/);
    expect(r.diagnostic).toContain('[REDACTED]');
    expect(r.diagnostic).not.toContain('alice@example.com');
    expect(r.diagnostic).toContain('<REDACTED:github_token>');
    expect(r.diagnostic).not.toContain(token);
  });

  // A value cut by the window's end no longer matches its pattern, which is
  // why redaction runs over the whole response before the window is cut.
  test.each([
    ['a token', 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5', 'ghp_'],
    ['an email address', 'alice.private@example.com', 'alice.private'],
  ])('redaction covers %s crossing the window end', async (_name, value, fragment) => {
    const text = `{"score": 0.8, "q": "x\n${'y'.repeat(80)} ${value} tail"}`;
    const judge: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' } as never),
    };
    const r = await judgeSignificance(judge, makeTranscript('edge'), MODEL);
    expect(r.diagnostic).toContain('near "');
    expect(r.diagnostic).not.toContain(fragment);
  });

  test.each([
    // A clean gateway stop is 'end' (ChatResult.stopReason); only an unusual one is worth a clause.
    ['a clean gateway stop adds no finish clause', 'not json', 'end', ['response 8 chars, stop_reason=end_turn, JSON error'], ['gateway finish', 'reasoning block']],
    // parseLlmJson last tried the text without the reasoning block, so the error must point into the answer.
    ['the error is located in the answer, not in the reasoning block', '<think>draft {"score": 0.1}</think>{"score": 0.8, "note": "bad\nline"}', 'end',
      ['reasoning block stripped', 'at char 27 near'], ['draft']],
  ])('diagnostic: %s', async (_name, text, gatewayStop, present, absent) => {
    const judge: JudgeClient = {
      create: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', gateway_stop_reason: gatewayStop } as never),
    };
    const r = await judgeSignificance(judge, makeTranscript('diag2'), MODEL);
    expect(r.unreliable).toBe('unparseable');
    for (const p of present) expect(r.diagnostic).toContain(p);
    for (const a of absent) expect(r.diagnostic).not.toContain(a);
  });
});

describe('runTriagePass — pool + reports + lock tick', () => {
  test('reports are index-stable in discovery order regardless of concurrency', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 9 }, (_, i) => makeTranscript(`ord${i}`));
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 4 }));
    expect(r.reports.map(x => x.filePath)).toEqual(ts.map(t => t.filePath));
  });

  test('yieldDuringPhase ticks are coarse: at most one per 30s window (C11)', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 6 }, (_, i) => makeTranscript(`tick${i}`));
    let ticks = 0;
    // Fake clock advances 10s per now() call — several items settle inside
    // each 30s window, so ticks must be well below the item count.
    let clock = 0;
    const now = (): number => { clock += 10_000; return clock; };
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 1, now }), async () => { ticks++; });
    expect(r.judged).toBe(6);
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(6);
  });

  test('yieldDuringPhase throwing is swallowed (best-effort)', async () => {
    const { engine } = makeFakeEngine();
    const ts = Array.from({ length: 3 }, (_, i) => makeTranscript(`yt${i}`));
    let clock = 0;
    const now = (): number => { clock += 40_000; return clock; };
    const r = await runTriagePass(engine, ts, baseCfg(scoredJudge(0.6), { concurrency: 1, now }),
      async () => { throw new Error('tick boom'); });
    expect(r.judged).toBe(3);
  });
});

describe('buildTriageMapBlock', () => {
  const verdict = {
    score: 0.82,
    content_type: 'reflection',
    segments: [
      { quote: 'the future of memory is a database that dreams', note: 'thesis' },
      { quote: 'we should charge for durability not storage', note: 'pricing frame' },
    ],
    entities: ['acme-example', 'fund-a'],
  };

  test('empty for undefined verdict and for legacy (score null) — prompt stays byte-identical', () => {
    expect(buildTriageMapBlock(undefined, 'text', 1)).toBe('');
    expect(buildTriageMapBlock({ score: null, content_type: null, segments: [], entities: [] }, 'text', 1)).toBe('');
  });

  test('single-chunk block carries score, type, entities, and verbatim-verified segments', () => {
    // The presence filter applies to EVERY chunk count (fabricated quotes are
    // dropped), so the chunk text must actually contain the quotes.
    const fullText = 'intro… the future of memory is a database that dreams. later: '
      + 'we should charge for durability not storage. outro.';
    const block = buildTriageMapBlock(verdict, fullText, 1);
    expect(block).toContain('TRIAGE MAP');
    expect(block).toContain('signal score: 0.82');
    expect(block).toContain('content type: reflection');
    expect(block).toContain('acme-example, fund-a');
    expect(block).toContain('database that dreams');
    expect(block).toContain('charge for durability');
    expect(block).not.toContain('bounded sample');
    expect(block).toContain('Work from the candidate segments first');
  });

  test('fabricated quotes are dropped even for single-chunk transcripts (security)', () => {
    const block = buildTriageMapBlock(verdict, 'text that contains neither quote', 1);
    expect(block).not.toContain('database that dreams');
    expect(block).not.toContain('charge for durability');
    // Score/type/entities still ride (they are advisory labels, not quotes).
    expect(block).toContain('signal score: 0.82');
  });

  test('chunked: segments filter to those whose quote prefix appears in THIS chunk + caveat line', () => {
    const chunkWithFirst = 'blah blah the future of memory is a database that dreams blah';
    const block = buildTriageMapBlock(verdict, chunkWithFirst, 3);
    expect(block).toContain('database that dreams');
    expect(block).not.toContain('charge for durability');
    expect(block).toContain('bounded sample of the full transcript');
  });

  test('whitespace-normalized matching: quote with collapsed spacing still matches', () => {
    const chunk = 'x  the   future\nof memory   is a database    that dreams y';
    const block = buildTriageMapBlock(verdict, chunk, 2);
    expect(block).toContain('database that dreams');
  });

  test('size bound: worst-case block stays bounded', () => {
    const segments = Array.from({ length: 8 }, (_, i) => ({ quote: `q${i} ` + 'x'.repeat(300), note: 'n'.repeat(200) }));
    const fat = {
      score: 0.99,
      content_type: 'mixed',
      segments,
      entities: Array.from({ length: 12 }, (_, i) => `entity-${i}-` + 'e'.repeat(70)),
    };
    // Chunk text contains every quote so the presence filter keeps all 8.
    const chunkText = segments.map(s => s.quote).join(' ');
    const block = buildTriageMapBlock(fat, chunkText, 1);
    expect(block).toContain('q7 ');
    expect(block.length).toBeLessThan(6000); // clipped upstream at judge-parse time; this is the structural bound
  });
});

describe('dreamInlineQueueAgeMs (CX1 liveness)', () => {
  test('parses the embedded timestamp; null outside the grammar', () => {
    expect(dreamInlineQueueAgeMs('dream-inline-1700000000000-deadbeef', 1700000001000)).toBe(1000);
    expect(dreamInlineQueueAgeMs('dream-inline-not-a-ts-deadbeef', 1)).toBeNull();
    expect(dreamInlineQueueAgeMs('default', 1)).toBeNull();
    expect(dreamInlineQueueAgeMs('dream-inline-1700000000000-NOTHEX!', 1)).toBeNull();
  });

  test('grace boundary: a fresh queue is within the liveness grace; an old one is past it', () => {
    const nowMs = 1_800_000_000_000;
    const young = `dream-inline-${nowMs - 60_000}-abcd1234`;
    const old = `dream-inline-${nowMs - DREAM_INLINE_LIVE_GRACE_MS - 60_000}-abcd1234`;
    expect(dreamInlineQueueAgeMs(young, nowMs)! <= DREAM_INLINE_LIVE_GRACE_MS).toBe(true);
    expect(dreamInlineQueueAgeMs(old, nowMs)! > DREAM_INLINE_LIVE_GRACE_MS).toBe(true);
  });
});

describe('parseSynthV2Key', () => {
  test('single-chunk key round-trips source + basename + hash16', () => {
    const k = parseSynthV2Key('dream:synth-v2:my-source:filename:2026-05-01-session.txt:0123456789abcdef');
    expect(k).toEqual({ source: 'my-source', basename: '2026-05-01-session.txt', hash16: '0123456789abcdef' });
  });

  test('chunked key carries chunk index + total', () => {
    const k = parseSynthV2Key('dream:synth-v2:default:filename:fat.txt:0123456789abcdef:c2of5');
    expect(k?.chunk).toEqual({ i: 2, n: 5 });
  });

  test('percent-encoded basename decodes (spaces, unicode)', () => {
    const enc = encodeURIComponent('весёлый файл (1).txt');
    const k = parseSynthV2Key(`dream:synth-v2:default:filename:${enc}:0123456789abcdef`);
    expect(k?.basename).toBe('весёлый файл (1).txt');
  });

  test('null on: legacy v1 keys, malformed hash, malformed encoding, foreign keys', () => {
    expect(parseSynthV2Key('dream:synth:/abs/path.txt:0123456789abcdef')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:x.txt:SHORT')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:%E0%A4%A:0123456789abcdef')).toBeNull();
    expect(parseSynthV2Key('embed-backfill:source:x')).toBeNull();
    expect(parseSynthV2Key('dream:synth-v2:default:filename:x.txt:0123456789abcdef:c1of')).toBeNull();
  });
});

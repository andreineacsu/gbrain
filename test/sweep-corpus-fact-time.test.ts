/**
 * #6159: facts the sweep extracts from a session-corpus file are dated with
 * the file's own time, not the moment the sweep ran.
 *
 * 1. Protects: a corpus file written days ago and swept today yields facts
 *    whose valid_from is the file's write time, for a session-end transcript
 *    and for a writeback turn file, on the database-only writer, on the
 *    unmanaged fence writer and through the managed coordinator (row and
 *    fence cell), and the extractor is told that day as its observation date;
 *    created_at stays the sweep's clock; a write time in the future or at the
 *    epoch dates the facts at extraction, leaves the observation date unknown
 *    and the sweep logs why; a caller's validFrom still wins over the turn
 *    time; a managed window retried after its file time moved replays its
 *    batch (no model call, first date kept), because the turn time stays out
 *    of the batch's input digest.
 * 2. Fails when: the corpus pass leaves the event time unset, so the facts
 *    pipeline falls back to its own clock and a late sweep enters old
 *    sessions as today's facts, with their relative dates unresolved.
 * 3. Existing coverage: capture-dedup.test.ts pins the same file time as the
 *    dedup anchor (#5888) only; no test read valid_from after a sweep.
 * 4. Seams: chat + embedding transports only. Synthetic names only. The stub
 *    extractor states no event date, so "the extractor's date wins" is left
 *    to the date-grounding tests.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { bankWritebackTurn } from '../src/core/context/corpus-segments.ts';
import { gateWritebackTurn } from '../src/core/facts/writeback-gate.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const DAY = 24 * 60 * 60 * 1000;
const CLAIM = 'Alice Example approved the Acme Example pilot budget';
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
/** Whole seconds, as file times and fence cells keep them. */
const daysAgo = (n: number): Date => new Date(Math.floor((Date.now() - n * DAY) / 1000) * 1000);

type Form = 'session-end transcript' | 'writeback turn';
const SWEEP_CASES: Array<{ name: string; form: Form; writtenAt: () => Date; datedBy: 'file' | 'sweep'; log?: RegExp }> = [
  { name: 'a session-end transcript written 8 days ago is dated 8 days ago', form: 'session-end transcript', writtenAt: () => daysAgo(8), datedBy: 'file' },
  { name: 'a writeback turn written 8 days ago is dated 8 days ago', form: 'writeback turn', writtenAt: () => daysAgo(8), datedBy: 'file' },
  { name: 'a write time a day in the future is dated at extraction, with the reason logged', form: 'session-end transcript',
    writtenAt: () => daysAgo(-1), datedBy: 'sweep', log: /old-session\.txt: write time \S+ is in the future; its facts are dated when extracted/ },
  { name: 'a write time at the epoch is dated at extraction, with the reason logged', form: 'session-end transcript',
    writtenAt: () => new Date(0), datedBy: 'sweep', log: /old-session\.txt: write time 1970-01-01T00:00:00\.000Z is before 2000; its facts are dated when extracted/ },
];

let engine: BrainEngine;
let dir: string;
let corpusDir: string;
let root: string;
let sourceId: string;
/** The user message of every extractor call this test made. */
let prompts: string[] = [];

async function settled(): Promise<void> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 10))) {
    const s = persistenceConsumerStatus(engine);
    if (s.active_preparations === 0 && s.active_worktrees === 0) return;
  }
  throw new Error('persistence consumer did not settle');
}

type Mode = 'database-only' | 'unmanaged fence' | 'managed';

/**
 * A fresh source holding one synthetic person page. `unmanaged fence` gives it a checkout, so facts are fenced
 * without the coordinator; `managed` also claims a worktree so facts go through the coordinator.
 */
async function freshSource(mode: Mode): Promise<void> {
  sourceId = `fact-time-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, mode === 'database-only' ? null : root]);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('memory.auto_writeback', 'salient');
  await engine.setConfig('sync.write_through', 'true');
  if (mode !== 'managed') {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a synthetic person.' }, { sourceId });
    return;
  }
  await claimWorktree(engine, sourceId, root);
  await submitPageMutation({ engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } }, { operation: 'put_page', params: { slug: 'people/alice-example',
    content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n', request_id: randomUUID() } });
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

/** Writes one corpus file of the given form and sets its write time, as a session captured then would have it. */
async function corpusFile(form: Form, writtenAt: Date): Promise<void> {
  let name = 'old-session.txt';
  if (form === 'writeback turn') {
    const gated = gateWritebackTurn('I approved the Acme Example pilot budget for Alice Example this morning.');
    if (!gated.ok) throw new Error(`fixture turn gated: ${gated.reason}`);
    const banked = await bankWritebackTurn(corpusDir, 'old-session', gated.normalized, gated.hash24, sourceId);
    if (!banked.flushCorpusFile) throw new Error(`bank failed: ${banked.status}`);
    name = banked.flushCorpusFile;
  } else {
    writeFileSync(join(corpusDir, name), toCorpusText([
      { role: 'user', text: 'Alice Example approved the Acme Example pilot budget this morning.' },
      { role: 'assistant', text: 'Noted.' },
    ]));
  }
  utimesSync(join(corpusDir, name), writtenAt, writtenAt);
}

async function activeFacts() {
  await settled();
  return engine.executeRaw<{ fact: string; source: string; valid_from: Date; created_at: Date }>(
    `SELECT fact, source, valid_from, created_at FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id`, [sourceId]);
}

const fenceRow = (): string | undefined =>
  readFileSync(join(root, 'people/alice-example.md'), 'utf8').split('\n').find(line => line.includes(CLAIM));

for (const backend of testBackends()) describe(`sweep corpus fact time on ${backend} (#6159)`, () => {
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-fact-time-'));
    root = join(dir, 'brain'); mkdirSync(root);
    corpusDir = join(dir, 'corpus'); mkdirSync(corpusDir);
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
    prompts = [];
    __setChatTransportForTests(async (request): Promise<ChatResult> => (prompts.push(String(request.messages[0].content)), {
      text: JSON.stringify({ facts: [{ fact: CLAIM, kind: 'fact', entity: 'people/alice-example', confidence: 0.9, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => {
      const vec = Array(1536).fill(0); vec[0] = 1; return vec;
    }) })) as never);
  });
  afterEach(async () => {
    __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.unsetConfig('memory.auto_writeback');
    rmSync(dir, { recursive: true, force: true });
  });
  const inHome = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, fn);

  for (const mode of ['database-only', 'unmanaged fence', 'managed'] as const) {
    for (const c of SWEEP_CASES) {
      test(`${mode}: ${c.name}`, inHome(async () => {
        await freshSource(mode);
        const writtenAt = c.writtenAt();
        await corpusFile(c.form, writtenAt);
        const logs: string[] = [];
        const sweptAt = Date.now();

        const report = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000, log: msg => logs.push(msg) });
        expect(report.corpusIngested).toBe(1);

        const facts = await activeFacts();
        expect(facts.map(f => [f.fact, f.source])).toEqual([[CLAIM, c.form === 'writeback turn' ? 'hook:writeback' : 'sweep:corpus']]);
        const validFrom = new Date(facts[0].valid_from).getTime();
        // The row's own creation time is the sweep's clock either way.
        expect(new Date(facts[0].created_at).getTime()).toBeGreaterThanOrEqual(sweptAt - 5_000);
        const timeLogs = logs.filter(l => l.includes('write time'));
        // The extractor resolves relative dates ("yesterday") against the same time the facts are dated by.
        const observed = c.datedBy === 'file' ? `Observation date: ${writtenAt.toISOString().slice(0, 10)} (` : 'Observation date: unknown';
        expect(prompts.length).toBeGreaterThan(0);
        for (const p of prompts) expect(p.startsWith(observed)).toBe(true);
        if (c.datedBy === 'file') {
          expect(new Date(validFrom).toISOString()).toBe(writtenAt.toISOString());
          expect(timeLogs).toEqual([]);
          if (mode !== 'database-only') expect(fenceRow()).toContain(`| ${writtenAt.toISOString().replace('.000Z', 'Z')} |`);
        } else {
          expect(validFrom).toBeGreaterThanOrEqual(sweptAt - 5_000);
          expect(validFrom).toBeLessThanOrEqual(Date.now() + 5_000);
          expect(timeLogs).toHaveLength(1);
          expect(timeLogs[0]).toMatch(c.log!);
        }
      }), 120_000);
    }

    test(`${mode}: a caller's validFrom wins over the turn time`, inHome(async () => {
      await freshSource(mode);
      const validFrom = daysAgo(3);
      await runFactsPipeline('[user]\nAlice Example approved the Acme Example pilot budget.\n', {
        engine, sourceId, sessionId: 'sess-precedence', source: 'sweep:corpus', mode: 'inline', remote: false,
        validFrom, turnAt: daysAgo(8),
      });
      const facts = await activeFacts();
      expect(facts.map(f => new Date(f.valid_from).toISOString())).toEqual([validFrom.toISOString()]);
    }), 120_000);
  }

  // The turn time stays out of the managed batch identity, so a window retried after its file moved (#6048's
  // backlog) replays its admitted batch instead of paying for a second extraction under a new date.
  test('managed: a window retried with a moved file time replays its batch, with no model call and the first date', inHome(async () => {
    await freshSource('managed');
    const window = { engine, sourceId, sessionId: 'sweep:corpus:old-session.txt', source: 'sweep:corpus' as const, mode: 'inline' as const, remote: false };
    const text = '[user]\nAlice Example approved the Acme Example pilot budget this morning.\n';
    const first = daysAgo(8);
    await runFactsPipeline(text, { ...window, turnAt: first });
    await settled();
    expect(prompts).toHaveLength(1);

    await runFactsPipeline(text, { ...window, turnAt: daysAgo(1) });
    expect(prompts).toHaveLength(1);
    expect((await activeFacts()).map(f => new Date(f.valid_from).toISOString())).toEqual([first.toISOString()]);
  }), 120_000);
});

/**
 * #6048 on a managed brain: a corpus window whose facts batch the canonical file
 * check refused is extracted again once that page's file passes the check.
 *
 * 1. Protects: the sweep cannot give a refused window a new request id, so when
 *    every uncommitted entity request of the stored batch was refused
 *    `source_changed` and each such page's file now passes the check, the
 *    retained facts of those requests are admitted as the batch's next attempt
 *    (no new LLM call) at the page's current revision, never wider than the
 *    current default visibility; committed siblings are kept, and the file
 *    finishes. A page that still fails the check, or a batch with another
 *    refusal, admits nothing, and new attempts stop at 3.
 * 2. Fails when: the sweep replays the stored terminal conflict forever (the
 *    window and every later window of the file never ingest), re-extracts or
 *    re-admits committed siblings, pins the refused revision, widens a fact's
 *    visibility, mints a new batch while the page still drifts or beside
 *    another refusal, or keeps retrying a page whose publication keeps refusing.
 * 3. managed-sweep-corpus-windows.test.ts covers windows that commit; no test
 *    resumes a terminal facts batch.
 * 4. No new seam: gateway test transports, and the persistence fault hook the
 *    crash robot installs, to edit the file after an attempt is prepared.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-file-refusal-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let inputs: string[] = [];
/** Entities every extracted window names, one fact per entity and workstream tag. */
let entities: Array<{ slug: string; name: string }> = [];

const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    const text = content.slice(content.indexOf('<turn>\n') + '<turn>\n'.length, content.lastIndexOf('\n</turn>'));
    inputs.push(text);
    const facts = [...new Set(text.match(/\bT\d\d\b/g) ?? [])].flatMap((m) => entities.map((e) => ({
      fact: `${e.name} works on workstream ${m}`, kind: 'fact', entity: e.slug, confidence: 0.9, notability: 'high',
    })));
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  // Orthogonal vectors per distinct text, so cosine dedup never merges different facts.
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map((v) => {
    const vec = Array(1536).fill(0);
    vec[[...v].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1536, 7)] = 1;
    return vec;
  }) })) as never);
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  __setChatTransportForTests(null); __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const body = (tag: string): string => {
  let s = `${tag} `;
  while (s.length < 5000) s += `${tag.toLowerCase()} detail words\n`;
  return s.slice(0, 5000);
};
const corpus = (count: number): string =>
  toCorpusText(Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: body(`T${String(i).padStart(2, '0')}`) })));

const ACME = { slug: 'companies/acme-example', name: 'Acme Example' };
const ALICE = { slug: 'people/alice-example', name: 'Alice Example' };
const FACTS_COMPLETE = '__managed_facts_complete__';

/** A managed source with committed entity pages, its corpus dir and sweep helpers. */
async function managedSource(engine: BrainEngine, dir: string, pages: Array<{ slug: string; name: string; type: string; body?: string }>) {
  const root = join(dir, 'brain'); mkdirSync(root);
  const corpusDir = join(dir, 'corpus'); mkdirSync(corpusDir);
  const sourceId = `refusal-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await engine.setConfig('sync.write_through', 'true');
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await claimWorktree(engine, sourceId, root);
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  for (const page of pages) {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug,
      content: `---\ntitle: ${page.name}\ntype: ${page.type}\n---\n${page.body ?? `# ${page.name}\n`}`, request_id: randomUUID() } });
  }
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const logs: string[] = [];
  // The sweep returns at the first refused request; its siblings keep publishing in this process.
  const settled = () => waitFor(async () => Number((await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM persistence_requests WHERE source_id=$1
      AND state IN ('queued','running','recovering')`, [sourceId]))[0].n) === 0, { timeoutMs: 30_000, label: 'requests settled' });
  return {
    sourceId, root, corpusDir, logs, ctx: ctx as unknown as OperationContext, settled,
    sweep: async () => {
      const report = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000, log: (m) => logs.push(m) });
      await settled();
      return report;
    },
    requests: () => engine.executeRaw<{ slug: string; state: string; error_code: string | null; updated_at: string }>(
      `SELECT slug,state,error_code,updated_at::text AS updated_at FROM persistence_requests
        WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId]),
    facts: () => engine.executeRaw<{ fact: string; visibility: string }>(
      `SELECT fact,visibility FROM facts WHERE source_id=$1 AND source='sweep:corpus' AND expired_at IS NULL ORDER BY fact`, [sourceId])
      .then((rows) => rows.map((r) => `${r.fact} (${r.visibility})`)),
    revision: (slug: string) => engine.executeRaw<{ revision: string }>(
      'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]).then((rows) => rows[0].revision),
  };
}

test('managed: a refused window is extracted again once its page passes the file check, never while it drifts', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-file-refusal-'));
    inputs = [];
    entities = [ACME, ALICE];
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        const s = await managedSource(engine, dir, [{ ...ACME, type: 'company' }, { ...ALICE, type: 'person' }]);
        await engine.setConfig('facts.default_visibility', 'world');
        const acmeFile = join(s.root, 'companies', 'acme-example.md');
        const good = readFileSync(acmeFile);
        appendFileSync(acmeFile, '\nAn uncoordinated local edit.\n');
        const file = join(s.corpusDir, 'refused-session.txt');
        writeFileSync(file, corpus(2));

        // Window 1: the Acme request is refused, the Alice request commits, the file stops there.
        const r1 = await s.sweep();
        expect(r1.corpusIngested).toBe(0);
        expect(inputs.length).toBe(1);
        expect(s.logs.at(-1)).toContain('The canonical file contains an uncoordinated local edit.');
        const refused = await s.requests();
        expect(refused.map((r) => [r.slug, r.state, r.error_code])).toEqual([
          [ACME.slug, 'conflict', 'source_changed'],
          [ALICE.slug, 'committed', null],
          [FACTS_COMPLETE, 'conflict', 'revision_conflict'],
        ]);

        // Still drifting: the stored outcome stands and nothing new is admitted.
        const r2 = await s.sweep();
        expect(r2.corpusIngested).toBe(0);
        expect(inputs.length).toBe(1);
        expect(await s.requests()).toEqual(refused);

        // The file passes the check again, then another writer moves the page's revision and the
        // default visibility is narrowed. The retained Acme facts are admitted once more at the
        // current revision, never wider than private, without a new extraction; window 2 follows.
        writeFileSync(acmeFile, good);
        const refusedRevision = await s.revision(ACME.slug);
        await submitRememberMutation(s.ctx, { fact: 'Acme Example opened an office', entity: ACME.slug, provenance: 'test', visibility: 'private' }, 10_000);
        await s.settled();
        expect(await s.revision(ACME.slug)).not.toBe(refusedRevision);
        await engine.setConfig('facts.default_visibility', 'private');
        const r3 = await s.sweep();
        expect(r3.corpusIngested).toBe(1);
        expect(JSON.parse(readFileSync(file + CORPUS_INGESTED_SUFFIX, 'utf8')).facts_inserted).toBe(4);
        expect(inputs.length).toBe(2);
        expect(await s.facts()).toEqual([
          'Acme Example works on workstream T00 (private)', 'Acme Example works on workstream T01 (private)',
          'Alice Example works on workstream T00 (world)', 'Alice Example works on workstream T01 (private)',
        ]);
        const after = await s.requests();
        expect(after.slice(0, refused.length)).toEqual(refused);
        // The retry batch carries only the Acme request; window 2 is a batch of its own.
        expect(after.slice(refused.length).map((r) => [r.slug, r.state])).toEqual([
          [ACME.slug, 'committed'], [FACTS_COMPLETE, 'committed'],
          [ACME.slug, 'committed'], [ALICE.slug, 'committed'], [FACTS_COMPLETE, 'committed'],
        ]);
        // The committed Alice request of window 1 was kept, not admitted again.
        expect(after.filter((r) => r.slug === ALICE.slug).length).toBe(2);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

test('managed: a page whose publication keeps refusing gets at most three new attempts', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-file-refusal-cap-'));
    inputs = [];
    entities = [ACME];
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        const s = await managedSource(engine, dir, [{ ...ACME, type: 'company' }]);
        const acmeFile = join(s.root, 'companies', 'acme-example.md');
        const good = readFileSync(acmeFile);
        appendFileSync(acmeFile, '\nAn uncoordinated local edit.\n');
        writeFileSync(join(s.corpusDir, 'flapping-session.txt'), corpus(1));
        expect((await s.sweep()).corpusIngested).toBe(0);
        expect((await s.requests()).length).toBe(2);

        // The file passes the check, then is edited again after each attempt is prepared, before it publishes.
        installFaultHook((point, detail) => {
          if (point === 'consumer:prepared' && detail.operation === 'extract_facts' && detail.sourceId === s.sourceId) {
            appendFileSync(acmeFile, '\nEdited before publication.\n');
          }
        });
        for (let attempt = 1; attempt <= 3; attempt++) {
          writeFileSync(acmeFile, good);
          expect((await s.sweep()).corpusIngested).toBe(0);
          const rows = await s.requests();
          expect(rows.length).toBe(2 + attempt * 2);
          expect(rows.slice(-2).map((r) => [r.slug, r.state, r.error_code])).toEqual([
            [ACME.slug, 'conflict', 'source_changed'], [FACTS_COMPLETE, 'conflict', 'revision_conflict']]);
        }
        installFaultHook(undefined);

        // Past the cap the stored outcome stands, even though the file passes the check now.
        writeFileSync(acmeFile, good);
        const capped = await s.requests();
        expect((await s.sweep()).corpusIngested).toBe(0);
        expect(await s.requests()).toEqual(capped);
        expect(inputs.length).toBe(1);
      });
    } finally {
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

test('managed: a batch with any refusal other than the file check is not retried', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-file-refusal-mixed-'));
    inputs = [];
    entities = [ACME, ALICE];
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        const s = await managedSource(engine, dir, [{ ...ACME, type: 'company' }, { ...ALICE, type: 'person' }]);
        const files = [join(s.root, 'companies', 'acme-example.md'), join(s.root, 'people', 'alice-example.md')];
        const good = files.map((f) => readFileSync(f));
        for (const f of files) appendFileSync(f, '\nAn uncoordinated local edit.\n');
        writeFileSync(join(s.corpusDir, 'mixed-session.txt'), corpus(1));
        expect((await s.sweep()).corpusIngested).toBe(0);
        // The stored batch as a mixed one: the Alice request ended with another refusal
        // (the shape a page written between admission and publication leaves).
        await engine.executeRaw(`UPDATE persistence_requests SET error_code='revision_conflict',
          error_message='The fact entity changed after extraction admission.'
          WHERE source_id=$1 AND operation='extract_facts' AND slug=$2`, [s.sourceId, ALICE.slug]);
        const refused = await s.requests();
        expect(refused.map((r) => [r.slug, r.state, r.error_code])).toEqual([
          [ACME.slug, 'conflict', 'source_changed'],
          [ALICE.slug, 'conflict', 'revision_conflict'],
          [FACTS_COMPLETE, 'conflict', 'revision_conflict'],
        ]);

        // Both files pass the check again, but the other refusal keeps the stored outcome.
        files.forEach((f, i) => writeFileSync(f, good[i]));
        expect((await s.sweep()).corpusIngested).toBe(0);
        expect(await s.requests()).toEqual(refused);
        expect(inputs.length).toBe(1);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

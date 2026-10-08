/**
 * #5211: extract_atoms marks the atoms it writes as dream output.
 *
 * The phase read `dream_generated` to keep dream output out of its own input,
 * but never wrote the marker on its atoms, so an extractor that relies on the
 * marker (propose_takes, #5212) read every atom back as source material.
 *
 * Pins: an atom from a page and an atom from a transcript both carry
 * `dream_generated: true` plus the raw trace doctor's raw_provenance check
 * asks of a dream-generated page, and a propose_takes run after an
 * extract_atoms run scans the source page only.
 *
 * PGLite round-trip with a stubbed chat gateway and a stubbed take extractor
 * (no model calls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { rawProvenanceCheck } from '../src/commands/doctor.ts';
import { isFactsBackstopEligible } from '../src/core/facts/eligibility.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });

const SOURCE_SLUG = 'writings/2026-09-18-pricing-essay';
const SOURCE_BODY = 'Enterprise buyers decide on a working prototype, not on a rendering of one.';
const TRANSCRIPT_PATH = '/fake/corpus/2026-09-18-pricing-call.txt';

const stubChat = async (_opts: ChatOpts): Promise<ChatResult> => ({
  text: JSON.stringify({ atoms: [{ title: 'Prototypes beat renders', atom_type: 'insight',
    body: 'A buyer commits after touching a working prototype; a rendering does not move the decision.' }] }),
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5',
  providerId: 'anthropic',
});

async function storedAtoms(): Promise<Array<{ slug: string; type: string; compiled_truth: string; frontmatter: Record<string, unknown> }>> {
  const rows = await engine.executeRaw<{ slug: string; type: string; compiled_truth: string; frontmatter: unknown }>(
    `SELECT slug, type, compiled_truth, frontmatter FROM pages WHERE type = 'atom' AND deleted_at IS NULL ORDER BY slug`,
  );
  return rows.map(row => ({ ...row,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown> }));
}

const ORIGINS = [
  {
    name: 'a page',
    input: { _transcripts: [], _pages: [{ slug: SOURCE_SLUG, content: SOURCE_BODY, contentHash: 'a1b2c3d4e5f60718' }] },
    rawSource: SOURCE_SLUG,
  },
  {
    name: 'a transcript',
    input: { _transcripts: [{ filePath: TRANSCRIPT_PATH, content: SOURCE_BODY, contentHash: 'b2c3d4e5f6071829' }], _pages: [] },
    rawSource: TRANSCRIPT_PATH,
  },
];

describe('extract_atoms marks its atoms as dream output (#5211)', () => {
  test.each(ORIGINS)('an atom from $name carries the marker and a raw trace', async ({ input, rawSource }) => {
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', ...input, _chat: stubChat });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);

    const atoms = await storedAtoms();
    expect(atoms).toHaveLength(1);
    const atom = atoms[0]!;
    expect(atom.frontmatter.dream_generated).toBe(true);
    expect(atom.frontmatter.raw_source).toBe(rawSource);

    // A dream-generated page with no raw trace is a doctor warning (#1978).
    const provenance = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(provenance.status).toBe('ok');
    // Atoms stay out of automatic fact extraction (#5831).
    expect(isFactsBackstopEligible(atom.slug, { type: 'atom', compiled_truth: atom.compiled_truth, frontmatter: atom.frontmatter }).ok).toBe(false);
  });

  test('propose_takes after extract_atoms scans the source page, never the atom', async () => {
    await runPhaseExtractAtoms(engine, { sourceId: 'default', ...ORIGINS[0]!.input, _chat: stubChat });
    expect(await storedAtoms()).toHaveLength(1);

    const scannedPages: string[] = [];
    const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
      scannedPages.push(pagePath);
      return [];
    };
    const ctx: OperationContext = {
      engine,
      config: {} as never,
      logger: { info() {}, warn() {}, error() {} } as never,
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
    const result = await runPhaseProposeTakes(ctx, { extractor });

    expect(scannedPages).toEqual([SOURCE_SLUG]);
    expect((result.details as Record<string, unknown>).pages_scanned).toBe(1);
  });
});

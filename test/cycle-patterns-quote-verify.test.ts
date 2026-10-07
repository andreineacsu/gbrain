/**
 * The patterns phase grounds quotes on the pattern pages its subagent wrote
 * against the full reflection pages, right after the writes and before
 * provenance stamping. A pattern page an earlier crashed run left without
 * `quote_verified_at` is verified on the next run. Quotes only: a pattern
 * counts its evidence, so numbers are not checked. Opt-in: dream.quote_verify
 * (default off).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { groundPatternPages } from '../src/core/cycle/patterns.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('dream.quote_verify', 'true');
  for (const [slug, body] of [
    ['wiki/personal/reflections/r1', 'I keep saying "ship smaller pieces" when projects stall.'],
    ['wiki/personal/reflections/r2', 'Again I told myself to ship smaller pieces.'],
  ]) await importFromContent(engine, slug!, `---\ntype: note\ntitle: ${slug}\n---\n${body}\n`, { noEmbed: true, sourceId: 'default' });
  await importFromContent(engine, 'wiki/personal/patterns/small-pieces',
    '---\ntype: note\ntitle: Small pieces\ndream_generated: true\n---\nAcross 2 reflections you repeat "ship smaller pieces".\n\nYou also wrote "never ship on Fridays".\n',
    { noEmbed: true, sourceId: 'default' });
});
afterAll(async () => { await engine.disconnect(); });

describe('patterns quote grounding', () => {
  test('an unverified quote moves to unverified_claims; a leftover page is picked up; counts stay', async () => {
    const reflections = [
      { slug: 'wiki/personal/reflections/r1', title: 'r1', excerpt: '', updatedAt: new Date(), seat: null },
      { slug: 'wiki/personal/reflections/r2', title: 'r2', excerpt: '', updatedAt: new Date(), seat: null },
    ];
    const stats = await groundPatternPages(engine, null, [], reflections, 'wiki/personal/patterns', 'default', '2026-10-04');
    expect(stats).toEqual({ pages: 1, quarantined: 1, repaired: 0 });
    const page = await engine.getPage('wiki/personal/patterns/small-pieces');
    expect(page!.compiled_truth).toContain('Across 2 reflections');
    expect(page!.compiled_truth).not.toContain('never ship on Fridays');
    expect(page!.frontmatter.quote_verified_at).toBe('2026-10-04');
    expect((page!.frontmatter.unverified_claims as unknown[]).length).toBe(1);
    const again = await groundPatternPages(engine, null, [], reflections, 'wiki/personal/patterns', 'default', '2026-10-05');
    expect(again).toEqual({ pages: 0, quarantined: 0, repaired: 0 });
  });

  test('#6236: a claim record counts the reflections it was checked against instead of listing each one, and a listing record is compacted', async () => {
    const reflections = ['r1', 'r2'].map(name => ({ slug: `wiki/personal/reflections/${name}`, title: name, excerpt: '', updatedAt: new Date(), seat: null }));
    const listing = { text: 'You said "an older quote".', reason: 'quote_not_in_source', detail: 'not found',
      sources: ['wiki/personal/reflections/r1', 'wiki/personal/reflections/r2', 'wiki/personal/reflections/r3'], detected_at: '2026-10-01' };
    const single = { ...listing, text: 'You said "a synthesized quote".', sources: ['wiki/personal/reflections/r1'] };
    await importFromContent(engine, 'wiki/personal/patterns/fridays',
      `---\ntype: note\ntitle: Fridays\ndream_generated: true\nunverified_claims: ${JSON.stringify([listing, single])}\n---\nYou wrote "never deploy on Fridays".\n`,
      { noEmbed: true, sourceId: 'default' });
    await groundPatternPages(engine, null, [{ slug: 'wiki/personal/patterns/fridays', source_id: 'default' }], reflections,
      'wiki/personal/patterns', 'default', '2026-10-07');
    expect((await engine.getPage('wiki/personal/patterns/fridays'))!.frontmatter.unverified_claims).toEqual([
      { ...listing, sources: ['3 reflections'] },
      single,
      expect.objectContaining({ text: expect.stringContaining('never deploy on Fridays'), reason: 'quote_not_in_source', sources: ['2 reflections'], detected_at: '2026-10-07' }),
    ]);
  });
});

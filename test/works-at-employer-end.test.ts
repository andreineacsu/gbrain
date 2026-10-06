import { afterAll, beforeAll, expect, test } from 'bun:test';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// #6191: the stored-page path a live brain re-derives on. Target types come
// from the pages table and the pack from the brain's config; the pure cases
// live in test/link-inference-constraints.test.ts.

const alice = 'people/alice-example';
const bob = 'people/bob-example';
const meeting = 'meetings/2026-04-03';
const acme = 'companies/acme-example';
const widget = 'companies/widget-co';
const deal = 'deals/acme-seed';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}, 60_000);
afterAll(async () => {
  await engine.disconnect();
});

async function worksAtTargets(from: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND l.link_type = 'works_at' ORDER BY 1`, [from]);
  return rows.map(row => row.slug);
}

async function linkTypes(from: string, to: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ link_type: string }>(
    `SELECT DISTINCT l.link_type FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND t.slug = $2 ORDER BY 1`, [from, to]);
  return rows.map(row => row.link_type);
}

test('pages extracted before the rule re-extract: works_at survives only where one end can employ', async () => {
  const page = (type: string, title: string, body: string) => `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`;
  await importFromContent(engine, bob, page('person', 'Bob Example', 'Bob Example.'), { noEmbed: true });
  await importFromContent(engine, meeting, page('meeting', 'Quarterly', 'Quarterly review.'), { noEmbed: true });
  await importFromContent(engine, acme, page('company', 'Acme Example', 'Acme Example.'), { noEmbed: true });
  await importFromContent(engine, deal, page('deal', 'Acme Seed', 'Seed round.'), { noEmbed: true });
  await importFromContent(engine, alice, page('person', 'Alice Example', [
    'Acme client call with its VP of Sales: [Quarterly](../meetings/2026-04-03.md).',
    'Discussed the Head of Platform role with [Bob](bob-example.md).',
    'Alice is an engineer at [Acme](../companies/acme-example.md).',
    'Bob is a director at [Seed](../deals/acme-seed.md).',
  ].join('\n\n')), { noEmbed: true });
  await importFromContent(engine, widget, page('company', 'Widget Co',
    'Leadership: [Bob](../people/bob-example.md), VP of Sales.'), { noEmbed: true });

  // What the earlier extractor stored for the first two links, on pages stamped before the bump.
  await engine.addLink(alice, meeting, 'VP of Sales', 'works_at', 'markdown');
  await engine.addLink(alice, bob, 'Head of Platform', 'works_at', 'markdown');
  await engine.executeRaw(`UPDATE pages SET updated_at = '2026-10-05T10:00:00Z', links_extracted_at = '2026-10-05T12:00:00Z'`);
  expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(6);

  await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });

  expect(await worksAtTargets(alice)).toEqual([acme]);
  expect(await linkTypes(alice, meeting)).toEqual(['mentions']);
  expect(await linkTypes(alice, bob)).toEqual(['mentions']);
  // A deal is a dated record only because the brain's pack says so.
  expect(await linkTypes(alice, deal)).toEqual(['mentions']);
  // An employer's page naming one of its people keeps the row graph reads flip.
  expect(await worksAtTargets(widget)).toEqual([bob]);
});

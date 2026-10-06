import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { inferLinkTypeFromPack } from '../src/core/schema-pack/link-inference.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { extractPageLinks, inferLinkType } from '../src/core/link-extraction.ts';
import { extractLinksFromFile, resolveCandidateSources } from '../src/commands/extract.ts';

const pack = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1', name: 'synthetic-graph', version: '1.0.0', extends: null,
  page_types: [
    { name: 'competitor', primitive: 'entity', path_prefixes: ['rivals/'] },
    { name: 'company', primitive: 'entity', path_prefixes: ['organizations/'] },
    { name: 'decision', primitive: 'entity', path_prefixes: ['choices/'] },
    { name: 'meeting', primitive: 'temporal', path_prefixes: ['sessions/'] },
    { name: 'person', primitive: 'entity', path_prefixes: ['members/'] },
  ],
  link_types: [
    { name: 'competes_with', inference: { page_type: 'competitor', target_type: 'company', regex: 'competes with' } },
    { name: 'decided_in', inference: { page_type: 'decision', target_type: 'meeting', regex: 'decided in' } },
    { name: 'champion', inference: { page_type: 'customer', target_type: 'person', regex: 'champion' } },
    { name: 'attended', inference: { page_type: 'meeting', target_type: 'person' } },
    { name: 'works_at', inference: { page_type: 'person', target_type: 'company', regex: 'works at' } },
  ],
  frontmatter_links: [{ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' }],
});

describe('conjunctive link inference', () => {
  test.each([
    ['competitor', 'company', 'competes with', 'competes_with'],
    ['decision', 'meeting', 'decided in', 'decided_in'],
    ['customer', 'person', 'champion', 'champion'],
  ])('%s requires its page type, target type and phrase together', (page, target, phrase, verb) => {
    expect(inferLinkTypeFromPack(pack, page, phrase, undefined, target)).toBe(verb);
    expect(inferLinkTypeFromPack(pack, 'note', phrase, undefined, target)).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, phrase, undefined, 'note')).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, phrase)).toBeNull();
    expect(inferLinkTypeFromPack(pack, page, 'unrelated text', undefined, target)).toBeNull();
  });

  test('target-only rules fire only when the target is known and matches', () => {
    const targetOnly = { link_types: [{ name: 'about_company', inference: { target_type: 'company' } }] };
    expect(inferLinkTypeFromPack(targetOnly, 'note', '', undefined, 'company')).toBe('about_company');
    expect(inferLinkTypeFromPack(targetOnly, 'note', '', undefined, 'person')).toBeNull();
    expect(inferLinkTypeFromPack(targetOnly, 'note', '')).toBeNull();
  });

  test('legacy meeting inference does not label decision or unknown links attended', async () => {
    expect(inferLinkType('meeting', 'Attendees', undefined, 'decisions/choice')).toBe('mentions');
    for (const active of [null, pack, { ...pack, link_types: [{ name: 'attended', inference: { page_type: 'meeting' } }] }]) {
      const result = await extractPageLinks('sessions/weekly', 'Attendees: [[choices/choice]], [[members/alice-example]]', {}, 'meeting',
        { resolve: async () => null }, { pack: active, targetType: slug => slug.startsWith('members/') ? 'person' : 'decision' });
      expect(result.candidates.find(c => c.targetSlug === 'choices/choice')?.linkType).toBe('mentions');
      expect(result.candidates.find(c => c.targetSlug === 'members/alice-example')?.linkType).toBe('attended');
      const withoutEvidence = await extractPageLinks('sessions/weekly', 'See [[choices/choice]] and [[members/alice-example]].', {}, 'meeting',
        { resolve: async () => null }, { pack: active, targetType: slug => slug.startsWith('members/') ? 'person' : 'decision' });
      expect(withoutEvidence.candidates.find(c => c.targetSlug === 'choices/choice')?.linkType).toBe('mentions');
      expect(withoutEvidence.candidates.find(c => c.targetSlug === 'members/alice-example')?.linkType).toBe('mentions');
    }
  });

  test('legacy fallback cannot bypass a mismatched constrained rule', async () => {
    const result = await extractPageLinks('members/alice-example', 'Works at [Company Example](organizations/company-example).', {}, 'person',
      { resolve: async () => null }, { pack, targetType: () => 'decision' });
    expect(result.candidates[0].linkType).toBe('mentions');
  });

  test('qualified duplicate slugs retain their source and get the correct target type', async () => {
    const result = await extractPageLinks('rivals/rival-example', 'competes with [[alpha:organizations/shared]] and [[beta:organizations/shared]].', {}, 'competitor',
      { resolve: async () => null }, { pack, targetType: (_slug, source) => source === 'alpha' ? 'company' : 'person' });
    expect(result.candidates.map(c => [c.targetSourceId, c.linkType])).toEqual([['alpha', 'competes_with'], ['beta', 'mentions']]);
    const resolved = resolveCandidateSources(result.candidates[1], 'rivals/rival-example', 'alpha',
      new Set(['rivals/rival-example', 'organizations/shared']),
      new Map([['rivals/rival-example', ['alpha']], ['organizations/shared', ['alpha', 'beta']]]), true);
    expect(resolved).toEqual({ ok: true, fromSlug: 'rivals/rival-example', fromSourceId: 'alpha', toSourceId: 'beta' });
  });

  test('pack attendees keep the declared incoming direction without inverse duplicates', async () => {
    const result = await extractPageLinks('sessions/weekly', '', { attendees: ['members/alice-example'] }, 'meeting',
      { resolve: async name => name }, { pack, targetType: () => 'person' });
    expect(result.candidates.map(c => [c.fromSlug, c.targetSlug, c.linkType])).toEqual([
      ['members/alice-example', 'sessions/weekly', 'attended'],
    ]);
  });

  test('structured attendees reject wrong or unknown target types instead of using the legacy mapping', async () => {
    for (const targetType of [undefined, () => 'decision']) {
      const result = await extractPageLinks('sessions/weekly', '', { attendees: ['choices/choice'] }, 'meeting',
        { resolve: async name => name }, { pack, targetType });
      expect(result.candidates).toEqual([]);
      expect(result.unresolved).toEqual([{ field: 'attendees', name: 'choices/choice', reason: 'target_type_mismatch' }]);
    }
  });

  test('filesystem inference prefers explicit type, then pack prefixes, and reads phrase context', async () => {
    const slugs = new Set(['choices/choice', 'rivals/rival-example', 'organizations/company-example']);
    const body = 'competes with [Company Example](../organizations/company-example.md).';
    const explicit = await extractLinksFromFile(`---\ntype: competitor\n---\n${body}`, 'choices/choice.md', slugs, { pack });
    expect(explicit[0].link_type).toBe('competes_with');
    const prefix = await extractLinksFromFile(body, 'rivals/rival-example.md', slugs, { pack });
    expect(prefix[0].link_type).toBe('competes_with');
    const wrong = await extractLinksFromFile(body, 'rivals/rival-example.md', slugs,
      { pack, pageTypes: new Map([['organizations/company-example', 'decision']]) });
    expect(wrong[0].link_type).toBe('mentions');
  });
});

// #6191: employment wording near a link types it works_at only when one end of the link can be the employer.
describe('works_at needs an end that can employ', () => {
  const bundled = (name: string) => loadPackFromFile(join(import.meta.dir, `../src/core/schema-pack/base/${name}.yaml`));
  const v1 = bundled('gbrain-base');
  const v2 = bundled('gbrain-base-v2');
  const english = (slug: string) => `Alice is the head of platform and an engineer at [Target](${slug})`;
  const chinese = (slug: string) => `她任职于 [Target](${slug})`;
  const unlinked = () => 'Alice is the head of platform and an engineer at Target'; // the link is not in the window

  test.each([
    ['person page -> meeting', english, 'person', 'meetings/2026-04-03', 'meeting', null, 'mentions'],
    ['person page -> person', english, 'person', 'people/bob-example', 'person', null, 'mentions'],
    ['person page -> company', english, 'person', 'companies/acme-example', 'company', null, 'works_at'],
    ['company page -> person (graph reads flip it)', english, 'company', 'people/bob-example', 'person', null, 'works_at'],
    ['company page -> meeting', english, 'company', 'meetings/2026-04-03', 'meeting', null, 'mentions'],
    ['concept page -> person', english, 'concept', 'people/bob-example', 'person', null, 'works_at'],
    ['target of unknown type', english, 'person', 'people/bob-example', null, null, 'works_at'],
    ['target whose type nobody supplied', english, 'person', 'meetings/2026-04-03', undefined, null, 'works_at'],
    ['person page -> a pack type with the temporal primitive', english, 'person', 'deals/acme-seed', 'deal', v2, 'mentions'],
    ['person page -> an alias of a temporal type', english, 'person', 'emails/thread-1', 'email-thread', v2, 'mentions'],
    ['person page -> an alias of person', english, 'person', 'people/bob-example', 'founder', v2, 'mentions'],
    ['an alias-of-person page -> person', english, 'founder', 'people/bob-example', 'person', v2, 'mentions'],
    ['a temporal page -> person', english, 'email', 'people/bob-example', 'person', v2, 'mentions'],
    ['person page -> another entity type', english, 'person', 'accounts/acme-example', 'account', v2, 'works_at'],
    ['person page -> the type an unmapped path defaults to', english, 'person', 'funds/fund-a', 'concept', v2, 'works_at'],
    ['person page -> a type the pack does not declare', english, 'person', 'funds/fund-a', 'fund', v2, 'works_at'],
    ['person page -> meeting, Chinese wording', chinese, 'person', 'meetings/2026-04-03', 'meeting', null, 'mentions'],
    ['person page -> company, Chinese wording', chinese, 'person', 'companies/acme-example', 'company', null, 'works_at'],
    ['person page -> person, link outside the window', unlinked, 'person', 'people/bob-example', 'person', null, 'mentions'],
    ['person page -> company, link outside the window', unlinked, 'person', 'companies/acme-example', 'company', null, 'works_at'],
  ] as const)('%s', (_label, wording, pageType, slug, targetType, pack, expected) => {
    expect(inferLinkType(pageType as never, wording(slug), undefined, slug, targetType, undefined, pack)).toBe(expected);
  });

  // The page-role prior types a companies/ link from the page's bio alone; it follows the same rule.
  test.each([
    ['a meeting filed under a company', 'companies/acme-example/meetings/2026-q1', 'meeting', 'mentions'],
    ['a person filed under a company', 'companies/acme-example/people/bob-example', 'person', 'mentions'],
    ['the company', 'companies/acme-example', 'company', 'works_at'],
  ] as const)('page-role prior toward %s', (_label, slug, targetType, expected) => {
    expect(inferLinkType('person', `See [Target](${slug})`, 'Alice is a senior engineer at Acme.', slug, targetType)).toBe(expected);
  });

  const types: Record<string, string> = {
    'meetings/2026-04-03': 'meeting', 'people/bob-example': 'person', 'companies/acme-example': 'company', 'deals/acme-seed': 'deal',
  };
  const page = (meeting: string, person: string, company: string, deal: string) => [
    `Acme client call with its VP of Sales: [Quarterly](${meeting}).`,
    `Discussed the Head of Platform role with [Bob](${person}).`,
    `Alice is an engineer at [Acme](${company}).`,
    `Bob is a director at [Seed](${deal}).`,
  ].join('\n\n');
  const packs = [['no pack', null], ['gbrain-base', v1], ['gbrain-base-v2', v2]] as const;
  // The same four links on a person's page and on a company's page: only the person target differs by page,
  // and only the deal differs by pack (a deal is a dated record where a pack says so).
  const pages = [
    ['people/alice-example', 'person', 'mentions'],
    ['companies/widget-co', 'company', 'works_at'],
  ] as const;
  const cases = packs.flatMap(([name, pack]) => pages.map(([slug, pageType, person]) => [name, slug, pack, pageType, {
    'meetings/2026-04-03': 'mentions', 'people/bob-example': person, 'companies/acme-example': 'works_at',
    'deals/acme-seed': pack ? 'mentions' : 'works_at',
  }] as const));

  test.each(cases)('page extraction with %s on %s', async (_name, slug, pack, pageType, expected) => {
    const { candidates } = await extractPageLinks(slug,
      page('meetings/2026-04-03', 'people/bob-example', 'companies/acme-example', 'deals/acme-seed'), {}, pageType,
      { resolve: async () => null }, { pack, skipFrontmatter: true, targetType: target => types[target] });
    expect(Object.fromEntries(candidates.map(c => [c.targetSlug, c.linkType]))).toEqual(expected);
  });

  test.each(cases)('filesystem extraction with %s on %s', async (_name, slug, pack, _pageType, expected) => {
    const links = await extractLinksFromFile(
      page('../meetings/2026-04-03.md', '../people/bob-example.md', '../companies/acme-example.md', '../deals/acme-seed.md'),
      `${slug}.md`, new Set(Object.keys(types)), { pack });
    expect(Object.fromEntries(links.map(l => [l.to_slug, l.link_type]))).toEqual(expected);
  });
});

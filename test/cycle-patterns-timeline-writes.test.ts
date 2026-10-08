/**
 * #6302: the patterns child updates existing pattern pages mostly with
 * add_timeline_entry. Those pages are part of the run's written list. The
 * entries this run appended are grounded one by one; the rest of a page the
 * child only appended to keeps the grounding of the runs that wrote it, against
 * reflections this run may not have. A failing entry is removed from the
 * timeline in one piece (marker, bullet, detail) for unverified_claims, and its
 * timeline row goes with it, so a later preserving write cannot render it back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { __testing } from '../src/core/cycle/patterns.ts';
import { groundAppendedEntries } from '../src/core/cycle/pattern-appended-entries.ts';
import { groundSource } from '../src/core/cycle/synthesize-verify.ts';
import { materializedMarker } from '../src/core/timeline-marker.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

const { collectChildWrites, stampPatternOutputs } = __testing;
const sourceId = 'patterns-timeline';
const PREFIX = 'wiki/personal/patterns';
const R1 = 'wiki/personal/reflections/r1';
const PATTERN = `${PREFIX}/small-pieces`;
const REWRITTEN = `${PREFIX}/rewritten`;
const LEFTOVER = `${PREFIX}/leftover`;
const USER_PAGE = `${PREFIX}/user-notes`;
const OUTSIDE = 'wiki/people/someone';
const OLD_QUOTE = 'an older quote from a reflection outside this run';
const UNFOUNDED = 'deploy every friday night without tests';
const entry = (slug: string, date: string, summary: string, detail = '') => ({ slug, date, summary, source: R1, ...(detail ? { detail } : {}) });
const GOOD = entry(PATTERN, '2026-10-08', 'You said "Ship smaller pieces" again', 'It came up when projects stalled.');
const BAD = entry(PATTERN, '2026-10-07', `You wrote "${UNFOUNDED}"`);
const appendedBad = (slug: string) => entry(slug, '2026-10-06', `You wrote "${UNFOUNDED}" here too`);
const reflections = ['r1', 'r2'].map(r => ({ slug: `wiki/personal/reflections/${r}`, title: r, excerpt: '', updatedAt: new Date(), seat: null }));

let engine: PGLiteEngine;
let ctx: OperationContext;
const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
const page = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.page;
const put = (slug: string, frontmatter: string, body: string) => submit('put_page', { slug, content: `---\ntype: note\ntitle: ${slug}\n${frontmatter}---\n${body}\n` });

beforeAll(async () => {
  engine = new PGLiteEngine();
  ctx = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  await engine.connect({}); await engine.initSchema();
  await engine.setConfig('dream.quote_verify', 'true');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await put(R1, '', 'I keep saying "ship smaller pieces" when projects stall.');
  await put('wiki/personal/reflections/r2', '', 'Again I told myself to ship smaller pieces before the launch.');
  await put(PATTERN, "dream_generated: true\nquote_verified_at: '2026-10-01'\n", `Across reflections you repeat "${OLD_QUOTE}".`);
  await put(REWRITTEN, "dream_generated: true\nquote_verified_at: '2026-10-01'\n", 'An earlier body.');
  // An earlier run's entry: timeline history this run's grounding leaves alone.
  await submit('add_timeline_entry', entry(REWRITTEN, '2026-10-02', 'An earlier run noted "a quote from an older reflection" then'));
  await put(LEFTOVER, 'dream_generated: true\n', 'You repeat "ship smaller pieces". Earlier you wrote "a leftover quote nobody wrote".');
  await put(USER_PAGE, '', 'A user note quoting "something the user read elsewhere".');
  // The child's writes, through the real write path, and the tool rows its loop records for them.
  const before = (await engine.readPageSnapshot(REWRITTEN, { sourceId }))!;
  await submit('put_page', { slug: REWRITTEN, expected_revision: before.revision,
    content: serializePageToMarkdown({ ...before.page, compiled_truth: 'You repeat "ship smaller pieces".' }, before.tags) });
  for (const params of [GOOD, BAD, appendedBad(REWRITTEN), appendedBad(LEFTOVER), appendedBad(USER_PAGE)]) await submit('add_timeline_entry', params);
  const duplicate = await submit('add_timeline_entry', { ...GOOD, detail: undefined });
  expect(duplicate).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, id, queue, name, data, status)
    VALUES ('{"version":1,"kind":"application"}'::jsonb, 6302, 'default', 'subagent', '{}'::jsonb, 'completed')`);
  const rows: Array<[string, unknown, unknown]> = [
    ['brain_put_page', { slug: REWRITTEN, content: 'body' }, { status: 'ok' }],
    ['brain_add_timeline_entry', GOOD, { status: 'ok' }],
    // #745: some drivers stored the input double-encoded, as a jsonb string scalar.
    ['brain_add_timeline_entry', JSON.stringify(BAD), { status: 'ok' }],
    ['brain_add_timeline_entry', { ...GOOD, detail: undefined }, duplicate],
    ...[REWRITTEN, LEFTOVER, USER_PAGE].map(slug => ['brain_add_timeline_entry', appendedBad(slug), { status: 'ok' }] as [string, unknown, unknown]),
    ['brain_add_timeline_entry', entry(OUTSIDE, '2026-10-08', 'Met again'), { status: 'ok' }],
  ];
  for (const [i, [tool, input, output]] of rows.entries()) {
    await engine.executeRaw(`INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input, output)
      VALUES (6302, $1, $2, $3, 'complete', $4::text::jsonb, $5::text::jsonb)`, [i, `tool-${i}`, tool, JSON.stringify(input), JSON.stringify(output)]);
  }
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

describe('#6302: timeline writes of the patterns child', () => {
  test('timeline-only pages join the written list; duplicates and pages outside the output prefix stay out', async () => {
    const refs = await collectChildWrites(engine, [6302], sourceId, `${PREFIX}/`);
    expect(refs.map(r => r.slug)).toEqual([LEFTOVER, REWRITTEN, PATTERN, USER_PAGE]);
    expect(refs.every(r => r.source_id === sourceId)).toBe(true);
    const bySlug = new Map(refs.map(r => [r.slug, r]));
    expect(bySlug.get(PATTERN)).toEqual({ slug: PATTERN, source_id: sourceId, appended: [
      { date: GOOD.date, summary: GOOD.summary, source: R1, detail: GOOD.detail },
      { date: BAD.date, summary: BAD.summary, source: R1, detail: '' },
    ] });
    expect(bySlug.get(REWRITTEN)).toMatchObject({ rewritten: true, appended: [{ summary: appendedBad(REWRITTEN).summary }] });
    expect((await collectChildWrites(engine, [6302], sourceId)).map(r => r.slug)).toContain(OUTSIDE);
  });

  test('only appended entries are judged on a checked or non-dream page; a failing one leaves with its row; C-8 stamps dream pages only', async () => {
    const refs = await collectChildWrites(engine, [6302], sourceId, `${PREFIX}/`);
    const { quoteVerify } = await stampPatternOutputs(engine, null, refs, reflections, { outputSlugPrefix: PREFIX, sourceSlugPrefix: 'wiki/personal/reflections' },
      sourceId, '2026-10-08');
    expect(quoteVerify).toEqual({ pages: 4, quarantined: 5, repaired: 1 });

    const pattern = await page(PATTERN);
    expect(pattern.compiled_truth).toContain(OLD_QUOTE);
    expect(pattern.frontmatter).toMatchObject({ quote_verified_at: '2026-10-08', raw_trace_exempt: true });
    const claims = pattern.frontmatter.unverified_claims as Array<{ text: string; reason: string }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ reason: 'quote_not_in_source' });
    expect(claims[0]!.text).toContain(UNFOUNDED);
    // The grounded entry takes the reflection's words, under a marker for its repaired tuple.
    expect(pattern.timeline).toContain(`${materializedMarker({ date: GOOD.date, source: R1, summary: 'You said "ship smaller pieces" again' })}\n`
      + `- **${GOOD.date}** | ${R1} — You said "ship smaller pieces" again\n  It came up when projects stalled.`);
    expect(pattern.timeline.match(/gbrain:materialized/g)).toHaveLength(1);

    // A rewritten page is checked whole, except its timeline history.
    const rewritten = await page(REWRITTEN);
    expect(rewritten.timeline).toContain('a quote from an older reflection');
    expect(rewritten.frontmatter.raw_trace_exempt).toBe(true);
    // A dream page no run has checked is checked whole.
    const leftover = await page(LEFTOVER);
    expect(leftover.compiled_truth).not.toContain('a leftover quote nobody wrote');
    expect((leftover.frontmatter.unverified_claims as unknown[])).toHaveLength(2);
    // A page that is not dream output keeps its own content and identity.
    const userPage = await page(USER_PAGE);
    expect(userPage.compiled_truth).toContain('something the user read elsewhere');
    expect(userPage.frontmatter.dream_generated).toBeUndefined();
    expect(userPage.frontmatter.raw_trace_exempt).toBeUndefined();

    for (const slug of [PATTERN, REWRITTEN, LEFTOVER, USER_PAGE]) {
      expect((await page(slug)).timeline).not.toContain(UNFOUNDED);
      expect((await engine.getTimeline(slug, { sourceId })).some(row => row.summary.includes(UNFOUNDED))).toBe(false);
      // A later preserving write renders nothing back.
      await submit('add_timeline_entry', entry(slug, '2026-10-09', 'A later entry'));
      expect((await page(slug)).timeline).not.toContain(UNFOUNDED);
    }
    expect((await page(PATTERN)).timeline).not.toContain('"Ship smaller pieces"');
  });
});

describe('#6302: groundAppendedEntries', () => {
  const sources = [groundSource(R1, 'I keep saying "ship smaller pieces" when projects stall.', { tolerant: true })];
  const bullet = (summary: string) => `- **2026-10-08** | ${R1} — ${summary}`;
  const input = (summary: string, detail = '') => ({ date: '2026-10-08', summary, source: R1, detail });
  const unfounded = `You wrote "${UNFOUNDED}"`;
  const cases: Array<{ name: string; timeline: string; entry: ReturnType<typeof input>; body: string; quarantined: number; repaired: number }> = [
    { name: 'an entry no longer on the page is skipped', timeline: `${bullet('Other')}\n`, entry: input(unfounded),
      body: `${bullet('Other')}\n`, quarantined: 0, repaired: 0 },
    { name: 'a failing entry without a marker is removed alone', timeline: `${bullet('Before')}\n${bullet(unfounded)}\n${bullet('After')}`,
      entry: input(unfounded), body: `${bullet('Before')}\n${bullet('After')}`, quarantined: 1, repaired: 0 },
    { name: 'a failing marked entry leaves with its marker and detail', entry: input(unfounded, 'Said twice.'),
      timeline: `${bullet('Before')}\n${materializedMarker({ date: '2026-10-08', source: R1, summary: unfounded })}\n${bullet(unfounded)}\n  Said twice.\n${bullet('After')}`,
      body: `${bullet('Before')}\n${bullet('After')}`, quarantined: 1, repaired: 0 },
    { name: 'a repaired entry without a marker gains none', timeline: bullet('You said "Ship smaller pieces"'), entry: input('You said "Ship smaller pieces"'),
      body: bullet('You said "ship smaller pieces"'), quarantined: 0, repaired: 1 },
    { name: 'the head of a longer entry is not this entry', timeline: `${bullet(unfounded)}\n  Detail of an earlier entry.`, entry: input(unfounded),
      body: `${bullet(unfounded)}\n  Detail of an earlier entry.`, quarantined: 0, repaired: 0 },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const result = groundAppendedEntries(c.timeline, PATTERN, [c.entry], sources);
      expect(result.body).toBe(c.body);
      expect(result.quarantined).toHaveLength(c.quarantined);
      expect(result.normalized + result.near).toBe(c.repaired);
    });
  }

  test('a long quarantined entry is cut without splitting a surrogate pair (the record lands in JSONB)', () => {
    const head = `**2026-10-08** | ${R1} — ${unfounded} `;
    const detail = `${'x'.repeat(1996 - head.length)}\u{1F600}${'y'.repeat(50)}`;
    const [claim] = groundAppendedEntries(`${bullet(unfounded)}\n  ${detail}`, PATTERN, [input(unfounded, detail)], sources).quarantined;
    expect(claim!.text.endsWith('...')).toBe(true);
    expect(claim!.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

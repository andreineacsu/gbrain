// v0.42 Type Unification (T31) — 3 new onboard checks.
//
// Coverage: pack_upgrade_available fires on gbrain-base brain;
// type_proliferation pack-aware ratio (D16); dangling_aliases source-scoped
// JOIN (F12); manual_only RemediationStep flag round-trips through render.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import {
  checkPackUpgradeAvailable,
  checkTypeProliferation,
  checkDanglingAliases,
} from '../src/core/onboard/checks.ts';
import { toOnboardRecommendation } from '../src/core/onboard/render.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  // Defensive reset: sibling test files in the same shard process
  // (test/schema-pack-sync.test.ts) call __setPackLocatorForTests to
  // stub the disk-loader. The mutation persists module-level across
  // files; without this reset, the stubbed locator returns null for
  // gbrain-base / gbrain-base-v2 and findPackSuccessors silently returns
  // []. Repros only when sync.test.ts runs first in the same shard, so
  // local single-file runs pass but CI shard 6 fails.
  _resetPackLocatorForTests();
});

async function seedPages(types: string[]) {
  for (let i = 0; i < types.length; i++) {
    await engine.putPage(`p${i}`, {
      title: `p${i}`,
      type: types[i] as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `p${i}.md`,
    });
  }
}

/** One page per entry of `types` in `sourceId`; a repeated type gives that label more pages. */
async function seedIn(sourceId: string, types: string[]) {
  for (let i = 0; i < types.length; i++) {
    await engine.putPage(`${sourceId}-p${i}`, {
      title: `${sourceId} p${i}`,
      type: types[i] as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `${sourceId}-p${i}.md`,
    }, { sourceId });
  }
}

/** Registers a source; `pack` binds it through `schema_pack.source.<id>`, omitted leaves it on the brain-wide pack. */
async function addSource(id: string, pack?: string) {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [id]);
  if (pack) await engine.setConfig(`schema_pack.source.${id}`, pack);
}

async function packOf(sourceId: string) {
  const { loadActivePackForLocalEngine } = await import('../src/core/schema-pack/best-effort.ts');
  const pack = await loadActivePackForLocalEngine(engine, { sourceId });
  if (!pack) throw new Error(`pack for ${sourceId} did not resolve`);
  return pack.manifest;
}

const inIsolatedHome = <T>(fn: () => Promise<T>) =>
  withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, fn);

describe('checkPackUpgradeAvailable', () => {
  it('fires on gbrain-base brain with gbrain-base-v2 available', async () => {
    // Default active pack is gbrain-base; gbrain-base-v2 declares
    // migration_from: {pack: gbrain-base, version: "1.x"}.
    // Sandbox GBRAIN_HOME: the check reads file-plane config, so a dev
    // machine whose real ~/.gbrain/config.json sets schema_pack would
    // flip this assertion.
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkPackUpgradeAvailable(engine);
      expect(result.check.name).toBe('pack_upgrade_available');
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toContain('gbrain-base-v2');
      expect(result.remediations.length).toBe(1);
      expect(result.remediations[0].job).toBe('unify-types');
      expect(result.remediations[0].protected).toBe(true);
      expect(result.remediations[0].params.target_pack).toBe('gbrain-base-v2');
    });
  });

  it('#6196: a managed brain gets an honest info row and no apply remediation it cannot run', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const result = await checkPackUpgradeAvailable(engine);
        expect(result.check.status).toBe('ok');
        expect(result.check.severity).toBe('info');
        expect(result.check.message).toContain('gbrain-base-v2');
        expect(result.check.message).toContain('managed brain');
        expect(result.remediations).toEqual([]);
        expect(result.check.fix?.argv).toEqual(['gbrain', 'onboard', '--check', '--explain']);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    });
  });

  it('honors file-plane schema_pack when DB config is unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-pack-upgrade-'));
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ schema_pack: 'gbrain-base-v2' }, null, 2),
    );

    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      _resetPackCacheForTests();
      const result = await checkPackUpgradeAvailable(engine);
      expect(result.check.name).toBe('pack_upgrade_available');
      expect(result.check.status).toBe('ok');
      expect(result.check.message).toContain('gbrain-base-v2');
      expect(result.remediations).toEqual([]);
    });
  });

  it('manual_only routing via render.ts allowlist (D17)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkPackUpgradeAvailable(engine);
      const step = result.remediations[0];
      const rec = toOnboardRecommendation(step);
      expect(rec.apply_policy).toBe('manual_only');
    });
  });
});

describe('checkTypeProliferation (D16 pack-aware ratio)', () => {
  it('returns ok when distinct types under declared+5 threshold', async () => {
    await seedPages(['note', 'meeting', 'slack']);
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('ok');
    });
  });

  it('warns when distinct types exceed declared+5', async () => {
    // Threshold-relative (v0.42.56.0): read `declared` from the pack the
    // default source resolves, as checkTypeProliferation does, then seed
    // declared+6 so the test keeps passing when the base pack grows (e.g.
    // #2390 added event + diary and silently moved the fixed threshold).
    await inIsolatedHome(async () => {
      const declared = (await packOf('default')).page_types.length;
      const seedCount = declared + 6; // one past the warn threshold (declared+5)
      const types: string[] = [];
      for (let i = 0; i < seedCount; i++) types.push(`custom-type-${i}`);
      await seedPages(types);
      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toMatch(new RegExp(`${seedCount} distinct`));
    });
  });
});

describe('checkTypeProliferation classifies each source against its own pack (#6289)', () => {
  type PackRow = {
    pack: string; sources: string[]; status: string;
    retype_pending_labels: string[]; undeclared_types: Array<{ type: string }>;
  };
  const perPackOf = (result: Awaited<ReturnType<typeof checkTypeProliferation>>) =>
    result.check.details?.per_pack as PackRow[];

  it('a source whose labels its own pack declares does not warn against the brain-wide pack', async () => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await addSource('side-src', 'gbrain-everything');
      const sideTypes = (await packOf('side-src')).page_types.map((t) => t.name);
      await seedIn('default', ['note']);
      await seedIn('side-src', sideTypes);
      const rawDistinct = new Set(['note', ...sideTypes]).size;

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('ok');
      // The raw literal count stays in the message.
      expect(result.check.message).toContain(`${rawDistinct} distinct`);
      expect(perPackOf(result).map((g) => [g.pack, g.sources])).toEqual([
        ['gbrain-base-v2', ['default']],
        ['gbrain-everything', ['side-src']],
      ]);
      expect(perPackOf(result).every((g) => g.undeclared_types.length === 0)).toBe(true);
    });
  });

  it("labels a source's own pack does not declare still warn and are named", async () => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await addSource('side-src', 'gbrain-everything');
      const sideTypes = (await packOf('side-src')).page_types.map((t) => t.name);
      // Two pages put the control-character label first in the sample.
      const escaped = 'x\x1b[31my';
      const undeclared = [...Array.from({ length: 5 }, (_, i) => `custom-label-${i}`), escaped];
      await seedIn('default', ['note']);
      await seedIn('side-src', [...sideTypes, ...undeclared, escaped]);

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toContain('gbrain-everything');
      expect(result.check.message).toContain("'custom-label-0' (1)");
      expect(result.check.message).toContain("'x[31my' (2)");
      expect(result.check.message).not.toContain('\x1b');
      const side = perPackOf(result).find((g) => g.pack === 'gbrain-everything');
      expect(side?.undeclared_types.map((t) => t.type).sort()).toEqual([...undeclared].sort());
    });
  });

  it('sources resolving to one pack are graded together', async () => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await addSource('alt');
      const canonical = (await packOf('default')).page_types.map((t) => t.name);
      // Neither source crosses declared + 5 alone; their six undeclared labels together do.
      await seedIn('default', [...canonical, 'extra-a', 'extra-b', 'extra-c']);
      await seedIn('alt', ['extra-d', 'extra-e', 'extra-f']);

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('warn');
      expect(perPackOf(result).map((g) => [g.pack, g.sources, g.undeclared_types.length])).toEqual([
        ['gbrain-base-v2', ['alt', 'default'], 6],
      ]);
    });
  });

  // One past the old literal warn threshold: every declared type plus six alias labels.
  it.each([
    {
      name: 'an alias the pack does not retype counts as its declared type',
      retyped: false, status: 'ok', says: '6 alias label(s) as their declared type',
    },
    {
      name: "an alias the pack's mapping_rules retype still counts: unification is pending",
      retyped: true, status: 'warn', says: "6 alias label(s) the pack's mapping_rules retype",
    },
  ])('$name', async ({ retyped, status, says }) => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      const manifest = await packOf('default');
      const canonical = manifest.page_types.map((t) => t.name);
      const retypeSources = new Set((manifest.mapping_rules ?? []).map((r) => r.from_type));
      const aliases = manifest.page_types.flatMap((t) => t.aliases ?? [])
        .filter((a) => !canonical.includes(a) && retypeSources.has(a) === retyped).slice(0, 6);
      expect(aliases.length).toBe(6);
      await seedIn('default', [...canonical, ...aliases]);

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe(status);
      expect(result.check.message).toContain(`${canonical.length + aliases.length} distinct`);
      expect(result.check.message).toContain(says);
      expect(perPackOf(result)[0].retype_pending_labels).toEqual(retyped ? [...aliases].sort() : []);
    });
  });

  // declared × 2 + 1 undeclared labels fail; the advice follows the pack that failed.
  it.each([
    {
      name: 'a failing brain-wide pack points at the pack-upgrade preview',
      source: 'default', advice: 'gbrain onboard --check --explain', absent: 'review-orphans',
    },
    {
      name: "a failing per-source pack points at that source's own listing",
      source: 'side-src', advice: 'For side-src, on a pack of their own', absent: 'onboard --check --explain',
    },
  ])('$name', async ({ source, advice, absent }) => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await addSource('side-src', 'gbrain-everything');
      const declared = (await packOf(source)).page_types.length;
      await seedIn(source, Array.from({ length: declared * 2 + 1 }, (_, i) => `sprawl-${i}`));

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('fail');
      expect(result.check.message).toContain(advice);
      expect(result.check.message).not.toContain(absent);
    });
  });

  it("a source whose pack does not resolve is reported, not graded against another source's pack", async () => {
    await inIsolatedHome(async () => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await addSource('side-src', 'no-such-pack-6289');
      await seedIn('default', ['note']);
      await seedIn('side-src', ['note']);

      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toContain('Not verified for 1 source(s) (side-src)');
      expect(result.check.message).toContain('gbrain schema active --source <id>');
      expect(result.check.details).toMatchObject({ unresolved_sources: ['side-src'], code: 'not_verified', verified: false });
      expect(perPackOf(result).map((g) => g.sources)).toEqual([['default']]);
    });
  });

  it('a page query that fails reports not verified instead of 0 types', async () => {
    const failing = {
      executeRaw: async () => { throw new Error('relation "pages" does not exist'); },
      getConfig: async () => null,
    } as unknown as PGLiteEngine;
    const result = await checkTypeProliferation(failing);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('Not verified');
    expect(result.check.details?.code).toBe('not_verified');
  });
});

describe('checkDanglingAliases (F12 source-scoped JOIN)', () => {
  it('returns ok when no aliases exist', async () => {
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('returns ok when alias points at active canonical', async () => {
    await seedPages(['note']);  // creates p0
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'p0')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('warns when alias points at missing canonical', async () => {
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'wiki/concepts/deleted')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
    expect(result.check.message).toContain('1 slug redirects');
    expect(result.check.message).toContain('0 free-text page aliases');
  });

  it('warns when a free-text alias points at a missing page', async () => {
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'alice example', 'people/alice-example')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
    expect(result.check.message).toContain('0 slug redirects');
    expect(result.check.message).toContain('1 free-text page aliases');
  });

  it('returns ok when a free-text alias points at an active page', async () => {
    await seedPages(['note']);
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'page zero', 'p0')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('warns when a free-text alias points at a soft-deleted page', async () => {
    await seedPages(['note']);
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'old page', 'p0')`,
    );
    await engine.softDeletePage('p0', { sourceId: 'default' });
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 free-text page aliases');
  });

  it('does not let another source satisfy a free-text alias target', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('shared-page', {
      title: 'shared', type: 'note' as never,
      compiled_truth: 'body that is long enough to pass any min-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'shared-page.md',
    }, { sourceId: 'alt' });
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'shared', 'shared-page')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 free-text page aliases');
  });

  it('does NOT false-positive across sources (F12 regression)', async () => {
    // Insert a canonical page in source A
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await engine.putPage('shared-slug', {
      title: 'shared', type: 'note' as never,
      compiled_truth: 'body that is long enough to pass any min-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'shared-slug.md',
    }, { sourceId: 'alt' });
    // Insert an alias in source 'default' that points at the same slug —
    // which exists ONLY in source 'alt'. The source-scoped JOIN MUST flag
    // this as dangling (not satisfied by the alt-source canonical).
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old', 'shared-slug')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
  });
});

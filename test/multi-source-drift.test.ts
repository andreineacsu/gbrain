/**
 * v0.31.8 — multi_source_drift doctor check (D8 + D14 + D17 + OV12 + OV13).
 *
 * Heuristic: a non-default source X with local_path set, where the FS at
 * local_path contains a markdown file whose slug exists at (default, slug)
 * in DB but is missing from (X, slug). Surfaces evidence of pre-v0.30.3
 * putPage misroutes OR an incomplete initial sync.
 *
 * Test cases (5):
 *   1. Single-source brain → check skipped (no row in checks output).
 *   2. Multi-source brain, no misroutes → status `ok`.
 *   3. Multi-source brain, 2 misrouted slugs → status `warn` with sample.
 *   4. Multi-source brain, healthy same-slug-across-sources (file at X has
 *      DB row at X AND default has its own legitimate slug) → ok (NOT a
 *      false positive).
 *   5. FS walk hits limit → status `warn 'check skipped, walk too large'`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { writeSlugRootMode } from '../src/core/sync-anchor.ts';
import { multiSourceDriftCheck } from '../src/commands/doctor/schema-pack-checks.ts';

let engine: PGLiteEngine;
const TMP_ROOTS: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const dir of TMP_ROOTS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmpRoot(label: string): string {
  const dir = join(tmpdir(), `gbrain-drift-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

function seedFile(root: string, relPath: string, content = 'placeholder\n'): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('findMisroutedPages — heuristic correctness', () => {
  test('case 1: no non-default sources → returns empty result (caller skips check)', async () => {
    // Findfn is called by doctor only when at least one non-default source
    // with local_path exists; passing an empty array is the equivalent.
    const result = await findMisroutedPages(engine, []);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 2: multi-source brain, no misroutes → count=0', async () => {
    const root = makeTmpRoot('case2');
    seedFile(root, 'people/alice.md');
    seedFile(root, 'people/bob.md');

    // Register the source via runSources, then update local_path directly.
    await runSources(engine, ['add', 'src-case2', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case2'],
    );
    // Both slugs land in (src-case2, *), NOT in (default, *). Healthy.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '.' }, { sourceId: 'src-case2' });
    await engine.putPage('people/bob',   { type: 'person', title: 'Bob',   compiled_truth: '.' }, { sourceId: 'src-case2' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case2', local_path: root }]);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 3: multi-source brain, 2 misrouted slugs → warn with sample', async () => {
    const root = makeTmpRoot('case3');
    seedFile(root, 'people/charlie.md');
    seedFile(root, 'people/dana.md');

    await runSources(engine, ['add', 'src-case3', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case3'],
    );
    // Both slugs land in (default, *) — the misroute shape.
    await engine.putPage('people/charlie', { type: 'person', title: 'Charlie', compiled_truth: '.' });
    await engine.putPage('people/dana',    { type: 'person', title: 'Dana',    compiled_truth: '.' });
    // src-case3 has neither.

    const result = await findMisroutedPages(engine, [{ id: 'src-case3', local_path: root }]);
    expect(result.count).toBe(2);
    expect(result.sample.length).toBe(2);
    const slugs = result.sample.map(s => s.slug).sort();
    expect(slugs).toEqual(['people/charlie', 'people/dana']);
    for (const s of result.sample) {
      expect(s.intended_source).toBe('src-case3');
      expect(s.local_path).toBe(root);
    }
  });

  test('case 4: healthy same-slug-across-sources is NOT a false positive (OV4 redesign)', async () => {
    const root = makeTmpRoot('case4');
    seedFile(root, 'topics/widget.md');

    await runSources(engine, ['add', 'src-case4', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case4'],
    );
    // Page exists at BOTH sources — the v0.18.0 supported state. The FS file
    // at src-case4 has a row at (src-case4, ...) AND default has its own.
    await engine.putPage('topics/widget', { type: 'concept', title: 'Default widget', compiled_truth: '.' });
    await engine.putPage('topics/widget', { type: 'concept', title: 'Src widget',     compiled_truth: '.' }, { sourceId: 'src-case4' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case4', local_path: root }]);
    // Heuristic requires "(default, slug) AND NOT (X, slug)". Since both
    // exist, it's NOT misroute. Count must be 0 — this is the codex OV4 fix
    // case, the original "same-slug-across-sources = corruption" heuristic
    // would have false-positived here.
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 5: FS walk hits limit → walk_truncated=true', async () => {
    const root = makeTmpRoot('case5');
    // Seed 12 files with a limit of 5 to force truncation.
    for (let i = 0; i < 12; i++) {
      seedFile(root, `topics/file-${i}.md`);
    }

    const result = await findMisroutedPages(engine, [{ id: 'src-case5-fake', local_path: root }], {
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.walk_truncated).toBe(true);
  });

  test('case 6 (OV13): unreadable local_path does NOT crash; returns empty', async () => {
    const result = await findMisroutedPages(engine, [
      { id: 'src-fake', local_path: '/nonexistent/path/that/does/not/exist' },
    ]);
    // Walk silently returns zero files; count=0, NOT throw.
    expect(result.count).toBe(0);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 7 (OV13): .mdx files are walked alongside .md', async () => {
    const root = makeTmpRoot('case7');
    seedFile(root, 'topics/mdx-page.mdx');

    await runSources(engine, ['add', 'src-case7', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case7'],
    );
    // Misroute the slug into default.
    await engine.putPage('topics/mdx-page', { type: 'concept', title: 'mdx', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case7', local_path: root }]);
    expect(result.count).toBe(1);
    expect(result.sample[0].slug).toBe('topics/mdx-page');
  });

  test('case 8 (#4712, #5862): a git-root-pinned source outside any git repository is skipped, and doctor says why', async () => {
    // Not a git repository: the git-root prefix sync used cannot be derived.
    const root = makeTmpRoot('case8');
    seedFile(root, 'page.md');

    await runSources(engine, ['add', 'src-case8', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case8'],
    );
    await writeSlugRootMode(engine, 'src-case8', 'git-root');
    // Sync actually produced the git-root-prefixed slug (what import.ts's
    // importRelPath would derive) — NOT local_path-relative 'page'.
    await engine.putPage('src-case8/page', { type: 'concept', title: 'p', compiled_truth: '.' }, { sourceId: 'src-case8' });
    // An unrelated page legitimately owns the local_path-relative slug at
    // default — this is exactly the #4712 false-positive shape pre-fix.
    await engine.putPage('page', { type: 'concept', title: 'unrelated', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case8', local_path: root }]);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.git_root_skipped).toEqual(['src-case8']);
    const check = multiSourceDriftCheck(result, 1, 'local');
    expect(check).toMatchObject({ status: 'warn', details: { code: 'not_verified', verified: false } });
    expect(check.message).toContain('git toplevel of local_path could not be resolved');
    expect(check.message).not.toContain('#4712');
  });

  test('case 8b (#5862): a skipped git-root source keeps doctor at not verified when a sibling is checked clean', async () => {
    const skippedRoot = makeTmpRoot('case8b-skipped');
    seedFile(skippedRoot, 'page.md');
    await runSources(engine, ['add', 'src-case8b-gr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [skippedRoot, 'src-case8b-gr']);
    await writeSlugRootMode(engine, 'src-case8b-gr', 'git-root');
    const cleanRoot = makeTmpRoot('case8b-clean');
    seedFile(cleanRoot, 'topics/clean.md');
    await runSources(engine, ['add', 'src-case8b-sr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [cleanRoot, 'src-case8b-sr']);

    const result = await findMisroutedPages(engine, [
      { id: 'src-case8b-gr', local_path: skippedRoot },
      { id: 'src-case8b-sr', local_path: cleanRoot },
    ]);
    expect(result).toMatchObject({ count: 0, git_root_skipped: ['src-case8b-gr'], unreadable_sources: [] });
    const check = multiSourceDriftCheck(result, 2, 'local');
    expect(check).toMatchObject({ status: 'warn', details: { code: 'not_verified', verified: false } });
    expect(check.message).toStartWith('No cross-source slug drift among checked sources.');
    expect(check.message).toContain('src-case8b-gr');
  });

  test('case 8c (#5862): a git-root source whose local_path is missing reports root_unreadable, not a git-root skip', async () => {
    await runSources(engine, ['add', 'src-case8c', '--no-federated']);
    const missing = join(makeTmpRoot('case8c'), 'gone');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [missing, 'src-case8c']);
    await writeSlugRootMode(engine, 'src-case8c', 'git-root');

    const result = await findMisroutedPages(engine, [{ id: 'src-case8c', local_path: missing }]);
    expect(result.git_root_skipped).toEqual([]);
    expect(result.unreadable_sources).toEqual([{ source_id: 'src-case8c', reason: 'root_unreadable', dirs: 1 }]);
  });

  test('case 9 (#4712): git-root skip does not mask real drift on a sibling source-root source', async () => {
    const gitRootRoot = makeTmpRoot('case9-gitroot');
    seedFile(gitRootRoot, 'page.md');
    await runSources(engine, ['add', 'src-case9-gr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [gitRootRoot, 'src-case9-gr']);
    await writeSlugRootMode(engine, 'src-case9-gr', 'git-root');
    await engine.putPage('src-case9-gr/page', { type: 'concept', title: 'p', compiled_truth: '.' }, { sourceId: 'src-case9-gr' });
    await engine.putPage('page', { type: 'concept', title: 'unrelated', compiled_truth: '.' });

    const sourceRootRoot = makeTmpRoot('case9-srcroot');
    seedFile(sourceRootRoot, 'people/eve.md');
    await runSources(engine, ['add', 'src-case9-sr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [sourceRootRoot, 'src-case9-sr']);
    // Genuine misroute: exists at default, missing from the intended source.
    await engine.putPage('people/eve', { type: 'person', title: 'Eve', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [
      { id: 'src-case9-gr', local_path: gitRootRoot },
      { id: 'src-case9-sr', local_path: sourceRootRoot },
    ]);
    expect(result.count).toBe(1);
    expect(result.sample[0]).toMatchObject({ slug: 'people/eve', intended_source: 'src-case9-sr' });
    expect(result.git_root_skipped).toEqual(['src-case9-gr']);
  });

  // #5862: inside a git repository every pin is checkable. A 'git-root' pin
  // means sync minted slugs from the git-root-relative path: no prefix when
  // local_path is the repo root (what managed sync pins there), the subdir
  // in slug spelling otherwise. Each row seeds a healthy page at the source,
  // a misrouted one at default, and an unrelated default page at the
  // local_path-relative slug that only the wrong slug shape would flag.
  const GIT_REPO_CASES: Array<{ label: string; scope: string; pin: 'git-root' | 'source-root' | null; slugPrefix: string; viaSymlink?: boolean }> = [
    { label: 'unpinned source at the repo root', scope: '', pin: null, slugPrefix: '' },
    { label: 'git-root source at the repo root (empty prefix)', scope: '', pin: 'git-root', slugPrefix: '' },
    { label: 'git-root source in a subdir (prefixed slugs)', scope: 'Team Notes', pin: 'git-root', slugPrefix: 'team-notes/' },
    { label: 'git-root source whose local_path is a symlink into a subdir', scope: 'Team Notes', pin: 'git-root', slugPrefix: 'team-notes/', viaSymlink: true },
    { label: 'source-root source in a subdir', scope: 'Team Notes', pin: 'source-root', slugPrefix: '' },
  ];
  for (const [i, c] of GIT_REPO_CASES.entries()) {
    test(`case 10.${i} (#5862): ${c.label}: misroute detected, no false positive`, async () => {
      const repo = makeTmpRoot(`case10-${i}`);
      execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'pipe' });
      const root = c.scope ? join(repo, c.scope) : repo;
      seedFile(root, 'people/alice.md');
      seedFile(root, 'people/bob.md');
      // Sync derives the prefix from the realpath, so a symlinked local_path must too.
      const localPath = c.viaSymlink ? join(makeTmpRoot(`case10-${i}-link`), 'link') : root;
      if (c.viaSymlink) symlinkSync(root, localPath);
      const id = `src-case10-${i}`;
      await runSources(engine, ['add', id, '--no-federated']);
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [localPath, id]);
      if (c.pin) await writeSlugRootMode(engine, id, c.pin);
      await engine.putPage(`${c.slugPrefix}people/alice`, { type: 'person', title: 'Alice', compiled_truth: '.' }, { sourceId: id });
      await engine.putPage('people/alice', { type: 'person', title: 'Unrelated', compiled_truth: '.' });
      await engine.putPage(`${c.slugPrefix}people/bob`, { type: 'person', title: 'Bob', compiled_truth: '.' });

      const result = await findMisroutedPages(engine, [{ id, local_path: localPath }]);
      expect(result.git_root_skipped).toEqual([]);
      expect(result.count).toBe(1);
      expect(result.sample).toEqual([{ slug: `${c.slugPrefix}people/bob`, intended_source: id, local_path: localPath }]);
    });
  }
});

/**
 * #5634: unify-types apply is refused up front on a managed brain.
 *
 * Its retype phase runs a raw `UPDATE pages SET type ...` outside the
 * persistence coordinator, which the managed writer guard refuses; the dry
 * run showed a plan apply could never execute and the job burned every
 * attempt before going dead.
 *
 * Pins: apply refuses with `writer_coordinator_required` before the unify
 * lock, any retype or the active-pack flip; the dry run still previews and
 * says apply is unsupported on this brain; the job handler dead-letters on
 * the first attempt instead of retrying.
 *
 * #6196: the surfaces that offer the apply follow the same refusal. On a
 * managed brain the `pack_upgrade_available` finding is information with no
 * remediation step and `gbrain onboard --check --explain` previews without
 * the apply command; an unmanaged brain keeps both.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runUnifyTypes } from '../src/core/schema-pack/unify-types-handler.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { makeUnifyTypesHandler } from '../src/core/minions/handlers/unify-types.ts';
import { checkPackUpgradeAvailable } from '../src/core/onboard/checks.ts';
import { runOnboard } from '../src/commands/onboard.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

async function seed({ engine }: { engine: BrainEngine }) {
  for (const [slug, type] of [['books/x', 'book'], ['analysis/y', 'competitive-intel'], ['note/civic-1', 'civic']]) {
    await engine.putPage(slug, { title: slug, type: type as never, compiled_truth: 'A body long enough for every minimum-length guard in the codebase.', frontmatter: {} });
  }
}

const types = (engine: BrainEngine) => engine.executeRaw<{ slug: string; type: string }>('SELECT slug, type FROM pages ORDER BY slug');

const APPLY_COMMAND = `gbrain jobs submit unify-types --params '{"target_pack":"gbrain-base-v2","apply":true}'`;

/** What `gbrain onboard --check --explain` prints to stdout. */
async function onboardExplain(engine: BrainEngine): Promise<string> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runOnboard(engine, ['--check', '--explain']); } finally { process.stdout.write = write; }
  return out;
}

test('managed apply refuses before any mutation; the dry run previews and names the limit', async () => {
  const unifyHome = mkdtempSync(join(tmpdir(), 'gbrain-unify-managed-'));
  try {
    await managedBrain(async ({ ctx, engine }) => {
      _resetPackCacheForTests();
      const before = await types(engine);
      await withEnv({ GBRAIN_HOME: unifyHome }, async () => {
        const dry = await runUnifyTypes(ctx, { target_pack: 'gbrain-base-v2', apply: false });
        expect(dry.per_phase.retype_explicit.would_apply).toBeGreaterThan(0);
        expect(dry.warnings.join('\n')).toContain('apply is not supported on a managed brain');

        await expect(runUnifyTypes(ctx, { target_pack: 'gbrain-base-v2', apply: true }))
          .rejects.toMatchObject({ code: 'writer_coordinator_required' });
        const handler = makeUnifyTypesHandler(engine);
        const job = { data: { target_pack: 'gbrain-base-v2', apply: true }, updateProgress: async () => {} } as never;
        const error = await handler(job).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnrecoverableError);
        expect(String((error as Error).message)).toContain('writer_coordinator_required');
      });
      expect(await types(engine)).toEqual(before);
      expect(await engine.executeRaw("SELECT 1 FROM gbrain_cycle_locks WHERE id='gbrain-unify'")).toEqual([]);
    }, { setup: seed });
  } finally {
    rmSync(unifyHome, { recursive: true, force: true });
    _resetPackCacheForTests();
  }
}, 120_000);

test('on a managed brain the pack-upgrade finding and onboard --explain offer no apply', async () => {
  const unifyHome = mkdtempSync(join(tmpdir(), 'gbrain-unify-managed-finding-'));
  try {
    await managedBrain(async ({ engine }) => {
      _resetPackCacheForTests();
      await withEnv({ GBRAIN_HOME: unifyHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
        const finding = await checkPackUpgradeAvailable(engine);
        expect(finding.check).toMatchObject({ name: 'pack_upgrade_available', status: 'ok', severity: 'info', readiness_state: 'not_applicable',
          details: { target_pack: 'gbrain-base-v2' } });
        expect(finding.check.message).toContain('Successor available: gbrain-base-v2@');
        expect(finding.check.message).toContain('not supported on a managed brain');
        expect(finding.remediations).toEqual([]);

        const out = await onboardExplain(engine);
        expect(out).toContain('Pack upgrade plan: → gbrain-base-v2');
        expect(out).toContain('Would apply (dry-run)');
        expect(out).toContain('apply is not supported on a managed brain');
        expect(out).not.toContain('(manual) unify-types');
        expect(out).not.toContain('Run the migration with');
        expect(out).not.toContain('"apply":true');
      });
    }, { setup: seed });
  } finally {
    rmSync(unifyHome, { recursive: true, force: true });
    _resetPackCacheForTests();
  }
}, 120_000);

test('an unmanaged brain keeps the apply: no managed warning, the finding carries the step, --explain prints the command', async () => {
  const { engine, close } = await isolatedSharedSkillsEngine();
  const unifyHome = mkdtempSync(join(tmpdir(), 'gbrain-unify-unmanaged-'));
  try {
    await seed({ engine });
    _resetPackCacheForTests();
    const ctx = { engine, config: {}, remote: false } as unknown as OperationContext;
    await withEnv({ GBRAIN_HOME: unifyHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const dry = await runUnifyTypes(ctx, { target_pack: 'gbrain-base-v2', apply: false });
      expect(dry.warnings.join('\n')).not.toContain('managed brain');

      const finding = await checkPackUpgradeAvailable(engine);
      expect(finding.check).toMatchObject({ status: 'warn', details: { target_pack: 'gbrain-base-v2' } });
      expect(finding.remediations.map((r) => [r.job, r.params, r.status]))
        .toEqual([['unify-types', { target_pack: 'gbrain-base-v2', apply: true }, 'remediable']]);

      const out = await onboardExplain(engine);
      expect(out).toContain('(manual) unify-types');
      expect(out).toContain(`Run the migration with:\n  ${APPLY_COMMAND}`);
    });
  } finally {
    await close();
    rmSync(unifyHome, { recursive: true, force: true });
    _resetPackCacheForTests();
  }
}, 60_000);

test('onboard --explain has nothing to preview once the active pack is the successor', async () => {
  const { engine, close } = await isolatedSharedSkillsEngine();
  const unifyHome = mkdtempSync(join(tmpdir(), 'gbrain-unify-current-'));
  try {
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    _resetPackCacheForTests();
    const out = await withEnv({ GBRAIN_HOME: unifyHome, GBRAIN_SCHEMA_PACK: undefined }, () => onboardExplain(engine));
    expect(out).toContain('(--explain: no pack upgrade to preview: Active pack gbrain-base-v2@');
    expect(out).toContain('is current (no successor declared))');
    expect(out).not.toContain('Pack upgrade plan');
    expect(out).not.toContain('Would apply (dry-run)');
  } finally {
    await close();
    rmSync(unifyHome, { recursive: true, force: true });
    _resetPackCacheForTests();
  }
}, 60_000);

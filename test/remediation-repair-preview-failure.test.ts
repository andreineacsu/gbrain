/**
 * #6000: the remediation plan previews every automatic repair kind, and one
 * kind's preview can fail on a large brain (a statement timeout). That kind is
 * reported with its error and preview command, and every other kind is still
 * planned, by `doctor --remediation-plan` and by `doctor --remediate`, which
 * exits 1 because the failed kind did not run. A caller that records nothing
 * still gets the error.
 *
 * Protects: the plan and the run completing around one failing preview, and
 * the failure staying visible (plan JSON, run result, exit status).
 * Fails when: one kind's preview aborts the plan or the run again, or a failed
 * preview disappears from the output.
 * Seams: none; the failing and the pending preview are the registered
 * handlers' own `plan` methods, replaced for the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { RepairHandler, RepairKind } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairSpec } from '../src/core/repair/registry.ts';
import { planRepairSteps, type RepairPreviewFailure } from '../src/core/remediation/repairs.ts';
import { computeRemediationPlan, runRemediation } from '../src/core/remediation/index.ts';
import { remediationExitStatus, renderRemediationPlanLines } from '../src/commands/doctor/remediate.ts';
import { withEnv } from './helpers/with-env.ts';

const TIMEOUT = 'canceling statement due to statement timeout';
const FAILURE: RepairPreviewFailure = { kind: 'attribution-backfill', message: TIMEOUT, preview_command: 'gbrain repair attribution-backfill' };

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-preview-failure-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** Runs `fn` with the given kinds' previews replaced, restoring the registered ones afterwards. */
async function withPreviews<T>(previews: Partial<Record<RepairKind, RepairHandler['plan']>>, fn: () => Promise<T>): Promise<T> {
  const originals = Object.keys(previews).map(kind => [repairSpec(kind as RepairKind).handler, repairSpec(kind as RepairKind).handler.plan] as const);
  for (const [kind, plan] of Object.entries(previews)) repairSpec(kind as RepairKind).handler.plan = plan!;
  try { return await withEnv({ GBRAIN_HOME: home }, fn); } finally { for (const [handler, plan] of originals) handler.plan = plan; }
}

/** attribution-backfill times out; planner-stats, which previews after it, has one table to analyze. */
const PREVIEWS: Partial<Record<RepairKind, RepairHandler['plan']>> = {
  'attribution-backfill': async () => { throw new Error(TIMEOUT); },
  'planner-stats': async () => ({ items: [{ cursor: { phase: 0, id: 1 }, source_id: '(brain)', slug: 'pages', chars: 0, action: 'analyze (fixture)' }], residuals: {} }),
};

describe('a repair preview that fails (#6000)', () => {
  test('the fixture previews planner-stats after attribution-backfill', () => {
    const order = AUTO_REPAIR_REGISTRY.map(spec => spec.kind);
    expect(order.indexOf('planner-stats')).toBeGreaterThan(order.indexOf('attribution-backfill'));
  });

  test('doctor --remediation-plan lists the failed kind with its error and still plans the others', async () => {
    const plan = await withPreviews(PREVIEWS, () => computeRemediationPlan(engine, { repairs: {} }));
    expect(plan.repair_preview_failures).toEqual([FAILURE]);
    expect(plan.repair_steps!.map(step => [step.kind, step.affected])).toContainEqual(['planner-stats', 1]);
    expect(plan.repair_steps!.some(step => step.kind === 'attribution-backfill')).toBe(false);
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Repair previews that failed');
    expect(text).toContain(`  attribution-backfill: ${TIMEOUT} (preview: gbrain repair attribution-backfill)`);
    // A caller that records nothing still sees the error.
    await expect(withPreviews(PREVIEWS, () => planRepairSteps(engine))).rejects.toThrow(TIMEOUT);
  });

  test('doctor --remediate plans the other repairs, reports the failed kind, and a run with one exits 1', async () => {
    const result = await withPreviews(PREVIEWS, () => runRemediation(engine, { dryRun: true, repairs: { include: true, remote: false, noEmbed: true } }));
    expect(result.repair_preview_failures).toEqual([FAILURE]);
    expect(result.submitted.map(step => step.id)).toContain('repair:planner-stats');
    expect(result.submitted.map(step => step.id)).not.toContain('repair:attribution-backfill');
    expect(remediationExitStatus(result, [])).toBe(1);
  });
});

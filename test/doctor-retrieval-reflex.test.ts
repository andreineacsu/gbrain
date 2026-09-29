/**
 * Doctor retrieval_reflex_health check (#1981, T8).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRetrievalReflexCheck } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

describe('buildRetrievalReflexCheck', () => {
  test('disabled via env → ok intentional-off, names the right check', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'false' }, async () => {
      const c = buildRetrievalReflexCheck(null);
      expect(c.name).toBe('retrieval_reflex_health');
      expect(c.status).toBe('ok');
      expect(c.message).toContain('intentionally disabled');
      expect((c.details as any)?.enabled).toBe(false);
    });
  });

  test('enabled → reports policy-skill install state in details', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-'));
      mkdirSync(join(dir, 'retrieval-reflex'), { recursive: true });
      writeFileSync(join(dir, 'retrieval-reflex', 'SKILL.md'), '# stub\n');
      const c = buildRetrievalReflexCheck(dir);
      expect(c.name).toBe('retrieval_reflex_health');
      expect((c.details as any)?.enabled).toBe(true);
      expect((c.details as any)?.policy_skill_installed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test('enabled, policy skill absent → message includes the install hint', async () => {
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-2-'));
      const c = buildRetrievalReflexCheck(dir);
      expect((c.details as any)?.policy_skill_installed).toBe(false);
      expect(c.message).toContain('gbrain integrations install retrieval-reflex');
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test('reads the heartbeat under GBRAIN_HOME, not $HOME/.gbrain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rr-doctor-home-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'rr-doctor-gbhome-'));
    // A ts no real heartbeat carries, so a reader pointed elsewhere cannot match it.
    const ts = new Date(Date.now() - 1234).toISOString();
    const hbDir = join(gbrainHome, '.gbrain', 'integrations', 'retrieval-reflex');
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(join(hbDir, 'heartbeat.jsonl'), JSON.stringify({ ts, event: 'inject', pointers: 1 }) + '\n');
    try {
      await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true', HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        const c = buildRetrievalReflexCheck(null);
        expect((c.details as any)?.last_fired).toBe(ts);
        expect((c.details as any)?.fired_recently).toBe(true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });

  // A host process running without GBRAIN_HOME (or old code until restart)
  // writes to the legacy $HOME/.gbrain path; the newest heartbeat wins.
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date(Date.now() - 1_000).toISOString();
  test.each([
    { label: 'legacy only', legacyTs: newer, gbrainTs: null, expected: newer },
    { label: 'both, legacy newer', legacyTs: newer, gbrainTs: older, expected: newer },
    { label: 'both, GBRAIN_HOME newer', legacyTs: older, gbrainTs: newer, expected: newer },
  ])('reads the legacy HOME/.gbrain heartbeat too: $label', async ({ legacyTs, gbrainTs, expected }) => {
    const home = mkdtempSync(join(tmpdir(), 'rr-doctor-legacy-home-'));
    const gbrainHome = mkdtempSync(join(tmpdir(), 'rr-doctor-legacy-gbhome-'));
    const writeHeartbeat = (root: string, ts: string) => {
      const dir = join(root, '.gbrain', 'integrations', 'retrieval-reflex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'heartbeat.jsonl'), JSON.stringify({ ts, event: 'inject', pointers: 1 }) + '\n');
    };
    writeHeartbeat(home, legacyTs);
    if (gbrainTs) writeHeartbeat(gbrainHome, gbrainTs);
    try {
      await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true', HOME: home, GBRAIN_HOME: gbrainHome }, async () => {
        const c = buildRetrievalReflexCheck(null);
        expect((c.details as any)?.last_fired).toBe(expected);
        expect((c.details as any)?.fired_recently).toBe(true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });
});

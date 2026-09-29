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
});

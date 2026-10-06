/**
 * Agent contract v1 (D2): the --json successes that need Postgres — a
 * healthy `db-repair --json` report, `jobs supervisor start --detach
 * --json` (one document naming the detached pid, pid file, status and log)
 * and `edge-proposals list|show --json` over a BIGSERIAL proposal id, which
 * only the Postgres driver returns as a bigint (#6193).
 * The failure shapes run keyless in test/cli-json-commands.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;

function postgresHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }));
  return home;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describeDatabase('D2 --json successes against Postgres', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('db-repair --json on a healthy database: one healthy report document (exit 0)', async () => {
    const home = postgresHome('gbrain-json-dbrepair-');
    try {
      const r = await runCli(['db-repair', '--json'], { home, cwd: home, timeoutMs: 60_000 });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ schema_version: 1, reason: 'healthy', fixed: true, plan: [], applied: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test('jobs supervisor start --detach --json: one document naming the detached pid, pid file, status and log', async () => {
    const home = postgresHome('gbrain-json-detach-');
    const pidFile = join(home, 'supervisor.pid');
    let pid: number | undefined;
    try {
      const r = await runCli(['jobs', 'supervisor', 'start', '--detach', '--json', '--pid-file', pidFile,
        '--queue', `json-detach-${process.pid}`, '--concurrency', '1', '--health-interval', '0', '--max-rss', '0'],
      { home, cwd: home, timeoutMs: 60_000 });
      expect(r.exitCode, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(doc).toMatchObject({ event: 'started', status: 'started', pid_file: pidFile, detached: true });
      expect(typeof doc.supervisor_pid).toBe('number');
      pid = doc.supervisor_pid as number;
      if (doc.stderr_log !== undefined) expect(typeof doc.stderr_log).toBe('string');
    } finally {
      if (pid !== undefined) {
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        for (let i = 0; i < 40 && alive(pid); i++) await new Promise(res => setTimeout(res, 250));
        if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test('edge-proposals list and show --json: one document with the numeric id of a BIGSERIAL proposal (#6193)', async () => {
    const engine = getEngine();
    const page = (slug: string, type: string, title: string) =>
      engine.putPage(slug, { type, title, compiled_truth: `${title}.`, timeline: '', frontmatter: {} });
    const person = await page('people/alice-example', 'person', 'Alice Example');
    const acme = await page('companies/acme-example', 'company', 'Acme Example');
    const widget = await page('companies/widget-co', 'company', 'Widget Co');
    const [seeded] = await engine.executeRaw<{ id: unknown }>(
      `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status,
         ending_to_page_id, close_date, model, confidence, generated_line)
       VALUES ('default', $1, $2, $3, 'works_at', 'json-bigint-e2e', 'proposed', $2, '2024-05-01', 'test-model', 0.9, 'Left Acme Example.')
       RETURNING id`, [person.id, acme.id, widget.id]);
    // The premise of this case: the Postgres driver returns the BIGSERIAL id as a bigint.
    expect(typeof seeded!.id).toBe('bigint');
    const id = Number(seeded!.id);
    const expected = {
      id, status: 'proposed', link_type: 'works_at', subject: 'people/alice-example',
      a_target: 'companies/acme-example', b_target: 'companies/widget-co', ending: 'companies/acme-example',
      close_date: '2024-05-01', born_closed: false, model: 'test-model', confidence: 0.9, generated_line: 'Left Acme Example.',
    };
    const home = postgresHome('gbrain-json-edgeprop-');
    try {
      const list = await runCli(['edge-proposals', 'list', '--json'], { home, cwd: home, timeoutMs: 60_000 });
      expect(list.exitCode, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout)).toMatchObject([expected]);
      const show = await runCli(['edge-proposals', 'show', String(id), '--json'], { home, cwd: home, timeoutMs: 60_000 });
      expect(show.exitCode, show.stderr).toBe(0);
      expect(JSON.parse(show.stdout)).toMatchObject(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);

});

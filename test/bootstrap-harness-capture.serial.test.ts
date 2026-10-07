/**
 * bootstrap-harness-capture.serial.test.ts: registrar-mode remote session
 * capture (#5577 story 03), against applyHarness/removeHarness/statusHarness
 * with injected deps: a recording claude CLI, a stubbed capability read (the
 * `gbrain://capabilities` answer), sandboxed settings and gbrain home.
 *
 *  - capture on: exactly the Stop/PreCompact/SessionEnd harness hooks, the
 *    credential at 0600, a receipt that records capture and never the bearer
 *  - capture off, one table per cause: one explanatory line, no hooks, no
 *    credential, MCP kept; the host command the line names
 *  - consent: the capture statement and the `egress` effect; a
 *    persistent_install preapproval alone does not authorize it
 *  - rollback: a failed credential write, a failed smoke test and a missing
 *    MCP registration leave no capture hook and no credential
 *  - idempotency and convergence: re-run, lost scope, a later local-mode run,
 *    a run that dies after its hooks, the Codex SessionEnd hook
 *  - removal, including a credential that cannot be deleted and an unreadable
 *    receipt; `--status` with the host's recorded stops
 *  - answers built by the serve's own describeAuthCapabilities (legacy token
 *    and OAuth client shapes)
 *
 * Serial: one case sets GBRAIN_HOME for the consent preapproval read.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import {
  applyHarness,
  parseHarnessArgs,
  removeHarness,
  statusHarness,
  type HarnessDeps,
} from '../src/core/bootstrap/harness.ts';
import { parseCaptureGrant } from '../src/core/bootstrap/harness-capture.ts';
import { CODEX_HOOK_OWNERSHIP_TOKEN, writeCodexHooks } from '../src/core/bootstrap/codex-hooks.ts';
import { readHarnessReceiptState, harnessReceiptPath, type HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { GBRAIN_HARNESS_MARKER_VALUE, GBRAIN_HOOK_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import {
  captureCredentialIdentity,
  captureCredentialPath,
  readCaptureCredential,
  recordCaptureStop,
  writeCaptureCredential,
} from '../src/core/context/capture-remote.ts';
import { describeAuthCapabilities } from '../src/core/harness/capabilities.ts';
import { opAllowedForBoundClient, operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import type { ConnectProbeResult } from '../src/core/connect-probe.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const TOKEN = `gbrain_${'c'.repeat(64)}`;
const REMOTE = 'https://brain.example.test/mcp';
const CAPTURE_EVENTS = ['PreCompact', 'SessionEnd', 'Stop'];

/** A grant that may capture, in the shape the serve sends (legacy token). */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'legacy',
    client_id: 'laptop-a',
    scopes: ['read', 'write', 'session_capture'],
    allowed_operations: null,
    available_operations: ['get_brain_identity', 'search', 'corpus_append'],
    source_id: 'default',
    ...over,
  };
}
/** The same grant without session_capture: the serve then lists no corpus_append either. */
const UNSCOPED = { scopes: ['read', 'write'], available_operations: ['get_brain_identity', 'search'] };

interface Rig {
  deps: HarnessDeps;
  out: string[];
  err: string[];
  calls: string[][];
  reads: number;
  home: string;
  userSettings: string;
  codexConfig: string;
  setAnswer: (a: unknown | Error) => void;
}

function makeRig(opts: {
  answer?: unknown | Error;
  probeOk?: boolean;
  mcpAddCode?: number;
  write?: HarnessDeps['writeCaptureCredential'];
  /** Codex detected, so `--harness all` wires it too. */
  codex?: boolean;
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'gb-capture-'));
  const home = join(dir, '.gbrain');
  mkdirSync(home, { recursive: true });
  const userSettings = join(dir, 'claude', 'settings.json');
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const registrations = new Map<string, { url: string; token: string }>();
  let current: unknown = opts.answer ?? answer();
  const runner: ExecRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'claude' && argv[2] === 'get') {
      const reg = registrations.get(argv[3]);
      return reg
        ? { code: 0, stdout: `Scope: User\nType: http\nURL: ${reg.url}\nHeaders:\n  Authorization: Bearer ${reg.token}`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'No MCP server found' };
    }
    if (argv[0] === 'claude' && argv[2] === 'add') {
      if (opts.mcpAddCode) return { code: opts.mcpAddCode, stdout: '', stderr: 'add failed' };
      const url = argv.find((v) => /^https?:\/\//.test(v))!;
      const header = argv.find((v) => v.startsWith('Authorization: Bearer '))!;
      registrations.set(argv[3], { url, token: header.slice('Authorization: Bearer '.length) });
    }
    if (argv[0] === 'claude' && argv[2] === 'remove') registrations.delete(argv[3]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const codexConfig = join(dir, 'codex', 'config.toml');
  const rig: Rig = {
    out, err, calls, home, userSettings, codexConfig, reads: 0,
    setAnswer: (a) => { current = a; },
    deps: {
      runner,
      gbrainHome: home,
      isTTY: false,
      fetchFn: (async () => new Response(JSON.stringify({ status: 'ok', version: VERSION, engine: 'postgres' }), { status: 200 })) as unknown as typeof fetch,
      probeIdentity: async (_url: string, token: string): Promise<ConnectProbeResult> =>
        token === TOKEN && (opts.probeOk ?? true)
          ? { ok: true, identity: 'brain "remote" (source default)' }
          : { ok: false, reason: 'auth', message: 'HTTP 401' },
      readCapabilities: async () => {
        rig.reads++;
        if (current instanceof Error) throw current;
        return current;
      },
      ...(opts.write ? { writeCaptureCredential: opts.write } : {}),
      userSettingsPath: userSettings,
      codexConfig,
      opencodeConfig: join(dir, 'opencode.jsonc'),
      loadFileConfig: () => null,
      mint: async () => { throw new Error('a supplied-token run never mints'); },
      revokeById: async () => true,
      installSharedSkills: async () => ({ status: 'pending', reason: 'shared_skills_unsupported' }),
      pgliteLiveServe: () => false,
      resolveHookSource: async () => ({ source_id: 'default', grant: ['default'] }),
      detectClaude: () => true,
      detectCodex: () => opts.codex ?? false,
      detectOpencode: () => false,
      gbrainBin: '/opt/fake/gbrain',
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
    },
  };
  return rig;
}

const registrar = (extra: string[] = [], url = REMOTE, harness = 'claude-code') =>
  parseHarnessArgs(['--yes', '--url', url, '--token', TOKEN, '--harness', harness, '--skills', 'memory-only', ...extra]);

/** gbrain's SessionEnd groups in the codex hooks.json beside a config. */
function codexHookGroups(codexConfig: string): number {
  const path = join(dirname(codexConfig), 'hooks.json');
  if (!existsSync(path)) return 0;
  const groups = (JSON.parse(readFileSync(path, 'utf8')) as { hooks?: { SessionEnd?: Array<{ hooks?: Array<{ command?: string }> }> } }).hooks?.SessionEnd ?? [];
  return groups.filter((g) => (g.hooks ?? []).some((h) => h.command?.includes(CODEX_HOOK_OWNERSHIP_TOKEN))).length;
}

/** Harness-marker hook entries per event in a settings file. */
function harnessEvents(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  const hooks = (JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>> }).hooks ?? {};
  const counts: Record<string, number> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const n = groups.flatMap((g) => g.hooks ?? []).filter((h) => h._gbrain === GBRAIN_HARNESS_MARKER_VALUE).length;
    if (n > 0) counts[event] = n;
  }
  return counts;
}

function receiptOf(home: string): HarnessReceipt {
  const state = readHarnessReceiptState(home);
  if (state.state !== 'ok') throw new Error(`receipt ${state.state}`);
  return state.receipt;
}

describe('capture on', () => {
  test('wires exactly Stop/PreCompact/SessionEnd, stores the credential at 0600, records capture without the bearer', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);

    expect(harnessEvents(r.userSettings)).toEqual({ PreCompact: 1, SessionEnd: 1, Stop: 1 });
    const settingsText = readFileSync(r.userSettings, 'utf8');
    expect(settingsText).not.toContain(TOKEN);
    expect(settingsText).not.toMatch(/hook (session-start|user-prompt)/);

    const credPath = captureCredentialPath(r.home);
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    expect(readCaptureCredential(r.home)).toEqual({ version: 1, mcp_url: REMOTE, access_token: TOKEN });

    const receiptText = readFileSync(harnessReceiptPath(r.home), 'utf8');
    expect(receiptText).not.toContain(TOKEN);
    const receipt = receiptOf(r.home);
    const capture = receipt.targets.find((t) => t.kind === 'capture');
    expect(capture).toMatchObject({ host: 'claude-code', state: 'confirmed', path: credPath, grant: 'laptop-a' });
    expect(receipt.targets.filter((t) => t.kind === 'hooks').every((t) => t.mechanism === 'capture' && t.state === 'confirmed')).toBe(true);

    // R9: the summary names the grant the host attributes sessions to.
    expect(r.out.join('\n')).toMatch(/remote capture: ON\..*grant laptop-a .*one grant per machine/s);
    expect(r.out.join('\n')).not.toMatch(/hooks are NOT wired/);
  });

  test.each([
    ['a legacy token (no source reported)', { source_id: null }],
    ['a grant on source default', { source_id: 'default' }],
    ['an OAuth client whose snapshot holds the operation', { transport: 'oauth', client_id: 'client-1', allowed_operations: ['search', 'corpus_append'] }],
  ])('capture on for %s', async (_label, over) => {
    const r = makeRig({ answer: answer(over) });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(Object.keys(harnessEvents(r.userSettings)).sort()).toEqual(CAPTURE_EVENTS);
    expect(existsSync(captureCredentialPath(r.home))).toBe(true);
  });

  test('--project wires the capture hooks in the project settings, not user scope, and consent, summary and --status say so', async () => {
    const r = makeRig();
    const proj = mkdtempSync(join(tmpdir(), 'gb-capture-proj-'));
    expect(await applyHarness(registrar(['--project', proj]), r.deps)).toBe(0);
    expect(Object.keys(harnessEvents(join(proj, '.claude', 'settings.local.json'))).sort()).toEqual(CAPTURE_EVENTS);
    expect(harnessEvents(r.userSettings)).toEqual({});
    // [X7] reach: the hooks fire only in the listed dir, so no statement claims every session on the machine.
    const onLine = `remote capture: ON. The capture hooks upload every Claude Code session in ${proj} to ${REMOTE};`;
    const all = r.out.join('\n');
    expect(all).toContain(`PreCompact and SessionEnd hooks bank every Claude Code session in ${proj} into it`);
    expect(all).toContain(`Capture hooks run in every Claude Code session in ${proj} and upload to ${REMOTE}.`);
    expect(all).toContain(onLine);
    expect(all).not.toContain('every Claude Code session on this machine');
    r.out.length = 0;
    await statusHarness(parseHarnessArgs(['--status']), r.deps);
    expect(r.out.join('\n')).toContain(onLine);
    expect(r.out.join('\n')).not.toContain('every Claude Code session on this machine');
  });

  test('--json carries remote_capture on, off and the reason code', async () => {
    const on = makeRig();
    expect(await applyHarness(registrar(['--json']), on.deps)).toBe(0);
    expect(JSON.parse(on.out.at(-1)!).remote_capture).toEqual({ state: 'on', grant: 'laptop-a', credential_path: captureCredentialPath(on.home) });
    const off = makeRig({ answer: answer(UNSCOPED) });
    expect(await applyHarness(registrar(['--json']), off.deps)).toBe(0);
    expect(JSON.parse(off.out.at(-1)!).remote_capture).toEqual({ state: 'off', reason: 'scope_missing' });
  });
});

describe('capture off', () => {
  test.each([
    ['scope missing (legacy token)', answer({ scopes: ['read', 'write'], allowed_operations: ['search'], available_operations: ['search'] }),
      'scope_missing', /gbrain auth rescope --token laptop-a --scopes 'read,write,session_capture' --refresh-operations --add corpus_append`, then re-run this command here\./, null],
    // An OAuth answer reports the access token's scopes, which can be narrower than the client's: inspect, then a placeholder.
    // The inspect step is `auth clients --json`: `auth rescope --client <id>` with no grant flag refuses to run.
    ['scope missing (OAuth client)', answer({ transport: 'oauth', client_id: 'client-1', scopes: ['read', 'write'], allowed_operations: ['search', 'remember'], available_operations: ['search'] }),
      'scope_missing', /read the client's stored scopes with `gbrain auth clients --json` \(its entry in clients\), then run `gbrain auth rescope --client client-1 --scopes '<COMPLETE_SCOPES_INCLUDING_session_capture>' --operations 'search,remember,corpus_append'` with the placeholder replaced.*then issue a new access token/,
      /read,write|rescope --client client-1`/],
    // A token's scopes are printed by `auth list`; `auth rescope --token <name>` alone prints its sources and operations only.
    ['no usable scope at all (legacy token)', answer({ scopes: [], available_operations: [] }),
      'scope_missing', /inspect it with `gbrain auth list`, then re-run this command here\./, /--scopes|auth rescope/],
    ['no usable scope at all (OAuth client)', answer({ transport: 'oauth', client_id: 'client-1', scopes: [], available_operations: [] }),
      'scope_missing', /inspect it with `gbrain auth clients --json`, then re-run this command here\./, /--scopes|auth rescope/],
    ['operation missing from the snapshot', answer({ allowed_operations: ['search'], available_operations: ['search'] }),
      'operation_not_granted', /refresh the snapshot: `gbrain auth rescope --token laptop-a --refresh-operations --add corpus_append`/, null],
    ['operation unavailable on the serve', answer({ available_operations: ['search'] }),
      'operation_unavailable', /does not offer corpus_append/, null],
    ['grant on a non-default source (OAuth)', answer({ transport: 'oauth', client_id: 'client-1', source_id: 'work' }),
      'grant_source', /writes to source work.*`gbrain auth rescope-client client-1 --source default`/, null],
    ['grant on a non-default source (legacy)', answer({ source_id: 'work' }),
      'grant_source', /writes to source work.*`gbrain auth clients --json`/, null],
    ['capability read timeout', new Error('capability read timeout after 15000ms'),
      'grant_unreadable', /could not read the grant from https:\/\/brain\.example\.test\/mcp \(timeout:/, null],
    // The bearer inside the error must be redacted out of the printed line.
    ['capability read refused the token', new Error(`Error POSTing to endpoint (HTTP 401): invalid_token ${TOKEN}`),
      'grant_auth', /rejected the supplied token/, null],
    ['malformed answer', { transport: 'legacy', client_id: 'laptop-a', scopes: 'read' },
      'grant_unreadable', /has no valid scopes/, null],
    ['answer without available_operations (older serve)', answer({ available_operations: undefined }),
      'grant_unreadable', /has no valid available_operations/, null],
    // The serve always sends source_id (null for a legacy token): an absent one is an unknown shape, not default.
    ['answer without source_id', answer({ source_id: undefined }),
      'grant_unreadable', /has no valid source_id/, null],
  ])('%s', async (_label, given, reason, hint, absent) => {
    const r = makeRig({ answer: given });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const lines = r.out.filter((l) => l.startsWith('capture not wired'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`(${reason})`);
    expect(lines[0]).toMatch(hint);
    if (absent) expect(lines[0]).not.toMatch(absent);
    expect([...r.out, ...r.err].join('\n')).not.toContain(TOKEN);
    expect(r.out.join('\n')).toMatch(/registrar mode.*hooks are NOT wired/s);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    // MCP registration is kept and the receipt records no capture.
    expect(r.calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(true);
    expect(receiptOf(r.home).targets.map((t) => t.kind)).toEqual(['mcp', 'permission']);
  });

  test('plain HTTP on a non-loopback host: off before any capability read', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar([], 'http://192.168.1.50:3131/mcp'), r.deps)).toBe(0);
    expect(r.reads).toBe(0);
    expect(r.out.find((l) => l.startsWith('capture not wired'))).toMatch(/\(insecure_endpoint\).*needs HTTPS/);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
  });

  test.each([['--no-hooks'], ['--no-capture']])('%s keeps capture off with a scoped grant, and reads no grant', async (flag) => {
    const r = makeRig();
    expect(await applyHarness(registrar([flag]), r.deps)).toBe(0);
    expect(r.reads).toBe(0);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(r.out.some((l) => l.startsWith('capture not wired'))).toBe(false);
  });

  test('harness hooks another install wrote: capture refused with the double-fire explanation, its entries untouched', async () => {
    const r = makeRig();
    mkdirSync(join(r.userSettings, '..'), { recursive: true });
    const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'env /other/gbrain hook stop', _gbrain: GBRAIN_HARNESS_MARKER_VALUE }] }] } };
    writeFileSync(r.userSettings, JSON.stringify(foreign));
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(r.out.find((l) => l.startsWith('capture not wired'))).toMatch(/\(local_hooks_present\).*double-fire every event/);
    expect(r.reads).toBe(0);
    expect(JSON.parse(readFileSync(r.userSettings, 'utf8')).hooks).toEqual(foreign.hooks);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
  });
});

describe('consent', () => {
  test('the block names the serve, the upload, the spool, the three hooks and the credential; the bearer is in no output', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).toContain('Wire the three session-capture hooks (Stop/PreCompact/SessionEnd) in user scope');
    expect(all).toContain(`Every session artifact in ${join(r.home, 'transcripts', 'corpus')} (this machine's session corpus directory, the upload spool)`);
    expect(all).toContain(`secret-scanned locally and uploaded to ${REMOTE}, starting with every session artifact already there`);
    expect(all).toContain(`${captureCredentialPath(r.home)} (0600)`);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('Wire the five lifecycle hooks');
    // Item 1 names the capture copy of the supplied bearer; gbrain does keep one.
    expect(all).toContain(`written into the host registrations below and the session-capture credential ${captureCredentialPath(r.home)} (0600).`);
    expect(all).not.toContain('gbrain keeps no copy');
    // `claude mcp remove` stops MCP, not the upload: the capture off-ramps are named.
    expect(all).toContain('Session-upload off-ramps: re-run this command with --no-capture (MCP stays), or `gbrain bootstrap harness --remove`');
  });

  test('capture off keeps the no-copy wording and the plain off-ramps', async () => {
    const r = makeRig({ answer: answer(UNSCOPED) });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const all = r.out.join('\n');
    expect(all).toContain('written ONLY into the host registrations below (gbrain keeps no copy).');
    expect(all).not.toContain('Session-upload off-ramps');
  });

  test('without --yes a non-interactive run stops at the gate: egress declared, the statement in risk and user_message, nothing written', async () => {
    const r = makeRig();
    const parent = mkdtempSync(join(tmpdir(), 'gb-capture-pre-'));
    mkdirSync(join(parent, '.gbrain'), { recursive: true });
    // A persistent_install preapproval alone must not authorize a session upload.
    writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', consent: { preapprove: { persistent_install: true } } }));
    let stdout = '';
    const write = process.stdout.write;
    process.stdout.write = ((c: string | Uint8Array) => { stdout += String(c); return true; }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await withEnv({ GBRAIN_HOME: parent }, () =>
        applyHarness(parseHarnessArgs(['--json', '--url', REMOTE, '--token', TOKEN, '--harness', 'claude-code', '--skills', 'memory-only']), r.deps));
    } finally {
      process.stdout.write = write;
      setCliExitVerdict(0);
    }
    expect(code).toBe(3);
    const payload = JSON.parse(stdout);
    expect(payload.effects).toEqual(['persistent_install', 'egress']);
    expect(payload.risk).toContain(`uploaded to ${REMOTE}`);
    expect(payload.user_message).toContain(`uploaded to ${REMOTE}`);
    expect(stdout).not.toContain(TOKEN);
    expect(existsSync(r.userSettings)).toBe(false);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(readHarnessReceiptState(r.home)).toEqual({ state: 'absent' });
  });

  test('the same preapproval still covers a registrar run with capture off (no egress)', async () => {
    const r = makeRig({ answer: answer(UNSCOPED) });
    const parent = mkdtempSync(join(tmpdir(), 'gb-capture-pre-'));
    mkdirSync(join(parent, '.gbrain'), { recursive: true });
    writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', consent: { preapprove: { persistent_install: true } } }));
    const code = await withEnv({ GBRAIN_HOME: parent }, () =>
      applyHarness(parseHarnessArgs(['--url', REMOTE, '--token', TOKEN, '--harness', 'claude-code', '--skills', 'memory-only']), r.deps));
    setCliExitVerdict(0);
    expect(code).toBe(0);
  });
});

describe('never half-wired', () => {
  test('a credential write that fails rolls the capture hooks back and fails both targets', async () => {
    // The writer's error carries the bearer, so the redaction is what keeps it out.
    const r = makeRig({ write: () => { throw new Error(`ENOSPC: no space left on device, write '${TOKEN}'`); } });
    expect(await applyHarness(registrar(), r.deps)).toBe(1);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    const receipt = receiptOf(r.home);
    for (const t of receipt.targets.filter((x) => x.kind === 'hooks' || x.kind === 'capture')) {
      expect(t.state).toBe('failed');
      expect(t.error).toMatch(/upload credential could not be written \(ENOSPC/);
    }
    expect(r.out.join('\n')).toMatch(/remote capture: failed/);
    expect(readFileSync(harnessReceiptPath(r.home), 'utf8')).not.toContain(TOKEN);
    expect([...r.out, ...r.err].join('\n')).not.toContain(TOKEN);
  });

  test('a capture hooks target that fails: no credential, the confirmed capture hooks removed, every capture target failed', async () => {
    const r = makeRig();
    const ok = mkdtempSync(join(tmpdir(), 'gb-capture-proj-'));
    const refused = mkdtempSync(join(tmpdir(), 'gb-capture-proj-'));
    // A workspace-lane Stop hook: the harness writer refuses to double-wire that event there.
    const workspace = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'env /opt/fake/gbrain hook stop', _gbrain: GBRAIN_HOOK_MARKER_VALUE }] }] } };
    mkdirSync(join(refused, '.claude'), { recursive: true });
    writeFileSync(join(refused, '.claude', 'settings.local.json'), JSON.stringify(workspace));
    expect(await applyHarness(registrar(['--project', ok, '--project', refused]), r.deps)).toBe(1);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(harnessEvents(join(ok, '.claude', 'settings.local.json'))).toEqual({});
    expect(JSON.parse(readFileSync(join(refused, '.claude', 'settings.local.json'), 'utf8')).hooks).toEqual(workspace.hooks);
    const targets = receiptOf(r.home).targets;
    expect(targets.find((t) => t.kind === 'hooks' && t.path === join(ok, '.claude', 'settings.local.json')))
      .toMatchObject({ state: 'failed', error: 'capture rolled back: the capture hooks did not all land' });
    expect(targets.find((t) => t.kind === 'hooks' && t.path === join(refused, '.claude', 'settings.local.json'))?.state).toBe('failed');
    expect(targets.find((t) => t.kind === 'capture')).toMatchObject({ state: 'failed', error: 'capture rolled back: the capture hooks did not all land' });
  });

  test('a failed smoke test removes the capture wiring this run added', async () => {
    const r = makeRig({ probeOk: false });
    expect(await applyHarness(registrar(), r.deps)).toBe(1);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    const capture = receiptOf(r.home).targets.find((t) => t.kind === 'capture');
    expect(capture).toMatchObject({ state: 'failed', error: 'capture removed after the failed smoke' });
  });

  test('a Claude Code MCP registration that does not land leaves no capture hook and no credential', async () => {
    const r = makeRig({ mcpAddCode: 1 });
    expect(await applyHarness(registrar(), r.deps)).toBe(1);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(receiptOf(r.home).targets.find((t) => t.kind === 'capture')?.error).toMatch(/MCP registration did not land/);
  });
});

describe('re-runs', () => {
  test('a second run changes nothing: same hooks, same credential, no duplicate entries', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const settings = JSON.parse(readFileSync(r.userSettings, 'utf8'));
    const credential = readFileSync(captureCredentialPath(r.home), 'utf8');
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(JSON.parse(readFileSync(r.userSettings, 'utf8'))).toEqual(settings);
    expect(readFileSync(captureCredentialPath(r.home), 'utf8')).toBe(credential);
    expect(harnessEvents(r.userSettings)).toEqual({ PreCompact: 1, SessionEnd: 1, Stop: 1 });
    expect(receiptOf(r.home).targets.filter((t) => t.kind === 'capture')).toHaveLength(1);
  });

  test('a grant that lost the scope returns the machine to MCP only', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    r.setAnswer(answer(UNSCOPED));
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(receiptOf(r.home).targets.map((t) => t.kind)).toEqual(['mcp', 'permission']);
    expect(r.out.join('\n')).toMatch(/capture credential removed from .*capture is not wired by this run/);
  });

  test('a later local-mode run removes the credential and keeps its own hooks', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    // --force: the registration now points at the remote serve, which the local run replaces.
    expect(await applyHarness(parseHarnessArgs(['--yes', '--force', '--port', '3131', '--token', TOKEN, '--harness', 'claude-code', '--skills', 'memory-only']), r.deps)).toBe(0);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(Object.keys(harnessEvents(r.userSettings)).sort()).toEqual(['PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(receiptOf(r.home).targets.some((t) => t.kind === 'capture')).toBe(false);
  });

  test('a run that plans no capture removes the credential before its hooks: one that dies after writing them leaves none', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    // The run dies between the apply loop and the converge step (the smoke throws).
    r.deps.probeIdentity = async () => { throw new Error('killed during the smoke test'); };
    await expect(applyHarness(parseHarnessArgs(['--yes', '--force', '--port', '3131', '--token', TOKEN, '--harness', 'claude-code', '--skills', 'memory-only']), r.deps))
      .rejects.toThrow('killed during the smoke test');
    expect(harnessEvents(r.userSettings).Stop).toBe(1); // the local-mode hooks landed
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
  });

  test.each([['all'], ['claude-code']])('registrar mode wires no Codex SessionEnd hook, and a re-run with --harness %s removes one an earlier run wrote', async (harness) => {
    const r = makeRig({ codex: true });
    expect(await applyHarness(registrar([], REMOTE, 'all'), r.deps)).toBe(0);
    expect(receiptOf(r.home).targets.some((t) => t.host === 'codex' && t.kind === 'mcp' && t.state === 'confirmed')).toBe(true);
    expect(codexHookGroups(r.codexConfig)).toBe(0);
    expect(Object.keys(harnessEvents(r.userSettings)).sort()).toEqual(CAPTURE_EVENTS);
    // What a registrar run wrote before this rule (the same entry, beside the recorded codex config), next to a foreign group.
    const hooksPath = join(dirname(r.codexConfig), 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-tool', timeout: 3 }] }] } }));
    expect(writeCodexHooks({ gbrainBin: '/opt/fake/gbrain', configPath: r.codexConfig, hooksPath }).ok).toBe(true);
    expect(codexHookGroups(r.codexConfig)).toBe(1);
    expect(await applyHarness(registrar([], REMOTE, harness), r.deps)).toBe(0);
    expect(codexHookGroups(r.codexConfig)).toBe(0);
    expect(readFileSync(hooksPath, 'utf8')).toContain('/usr/local/bin/other-tool');
    expect(readFileSync(r.codexConfig, 'utf8')).not.toContain('gbrain:codex-hooks-trust');
    expect(r.out.join('\n')).toContain(`Codex SessionEnd hook removed from ${hooksPath}`);
    expect(existsSync(captureCredentialPath(r.home))).toBe(true);
  });

  test('a credential no receipt records (a crashed run) is removed by the next run that plans no capture', async () => {
    const r = makeRig({ answer: answer(UNSCOPED) });
    writeCaptureCredential(r.home, { mcp_url: REMOTE, access_token: TOKEN });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
  });

  test('a receipt written before capture existed parses and reads as capture off', async () => {
    const r = makeRig();
    mkdirSync(join(r.home, 'bootstrap'), { recursive: true });
    const legacy = {
      harness_receipt_version: 1, created_at: '2026-01-01T00:00:00.000Z', created_by: 'gbrain@0.60.0.0', url: REMOTE,
      source_id: 'default', token: { name: 'bootstrap-harness', minted: false },
      targets: [{ host: 'claude-code', kind: 'mcp', state: 'confirmed', scope: 'user', name: 'gbrain', mechanism: 'claude-cli' }],
    };
    writeFileSync(harnessReceiptPath(r.home), JSON.stringify(legacy));
    expect(readHarnessReceiptState(r.home).state).toBe('ok');
    await statusHarness(parseHarnessArgs(['--status']), r.deps);
    expect(r.out.some((l) => l.startsWith('remote capture:'))).toBe(false);
  });
});

describe('status and removal', () => {
  test('--status shows capture on with the upload record, and reads failed once the credential is gone', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    r.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status']), r.deps)).toBe(0);
    expect(r.out.join('\n')).toContain(`remote capture: ON. The capture hooks upload every Claude Code session on this machine to ${REMOTE}`);
    expect(r.out.join('\n')).toContain(join(r.home, 'integrations', 'hooks', 'heartbeat.jsonl'));
    expect(r.out.join('\n')).not.toContain(TOKEN);
    writeCaptureCredential(r.home, { mcp_url: 'https://other.example.test/mcp', access_token: TOKEN });
    r.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status']), r.deps)).toBe(1);
    expect(r.out.join('\n')).toMatch(/claude-code\/capture \(user\): failed .+the capture credential names https:\/\/other\.example\.test\/mcp/);
  });

  // The stops the uploader records: a sweep on another source stops session+segment, writeback off stops writeback.
  const SWEEP = { code: 'source_not_ingestable', reason: 'sweep_source' };
  const STOP_AT = '\\(source_not_ingestable:sweep_source since \\S+\\)';
  test.each([
    ['a stopped kind is named on the ON line', [[['session'], SWEEP]] as const, 0,
      new RegExp(`remote capture: ON\\..*The host stopped session uploads ${STOP_AT}; the other kinds still upload`, 's')],
    ['a stopped lane is not ON', [[['lane'], { code: 'insufficient_scope' }]] as const, 1,
      /remote capture: failed \(the host stopped every upload \(insufficient_scope since \S+\); nothing uploads until re-running/],
    // No kind left open is a lane stop too: --status must not read ON with "the other kinds still upload".
    ['every kind stopped one by one is not ON', [[['session', 'segment'], SWEEP], [['writeback'], { code: 'writeback_off' }]] as const, 1,
      new RegExp(`remote capture: failed \\(the host stopped every upload \\(session uploads ${STOP_AT}, segment uploads ${STOP_AT}, ` +
        'writeback uploads \\(writeback_off since \\S+\\)\\); nothing uploads until re-running')],
  ])('--status surfaces the stops the upload recorded: %s', async (_label, stops, code, line) => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const identity = captureCredentialIdentity(r.home)!;
    for (const [scopes, stop] of stops) recordCaptureStop(r.home, scopes, stop, identity);
    r.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status']), r.deps)).toBe(code);
    const all = r.out.join('\n');
    expect(all).toMatch(line);
    if (code === 1) expect(all).not.toContain('remote capture: ON');
    // Registering again clears the stops.
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    r.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status']), r.deps)).toBe(0);
    expect(r.out.join('\n')).not.toContain('The host stopped');
  });

  test('--remove with an unreadable receipt still removes the capture credential, or names it among the stragglers', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    writeFileSync(harnessReceiptPath(r.home), '{ not json');
    const dir = join(r.home, 'capture-remote');
    chmodSync(dir, 0o500);
    try {
      expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), r.deps)).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(existsSync(captureCredentialPath(r.home))).toBe(true);
    expect(r.err.join('\n')).toMatch(new RegExp(`unreadable .*hook entries / the capture credential at ${captureCredentialPath(r.home).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(`, 's'));
    r.err.length = 0;
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), r.deps)).toBe(1);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(r.out.join('\n')).toContain(`capture credential removed from ${captureCredentialPath(r.home)} (the receipt that would record it is unreadable).`);
    expect(r.err.join('\n')).not.toContain('the capture credential at');
  });

  test('--remove deletes the capture hooks and the credential with the rest of the install', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), r.deps)).toBe(0);
    expect(harnessEvents(r.userSettings)).toEqual({});
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    expect(existsSync(join(r.home, 'capture-remote'))).toBe(false);
    expect(readHarnessReceiptState(r.home)).toEqual({ state: 'absent' });
  });

  test('a credential that cannot be deleted is reported as a failed target and kept on the receipt', async () => {
    const r = makeRig();
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const dir = join(r.home, 'capture-remote');
    chmodSync(dir, 0o500);
    try {
      expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), r.deps)).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(r.err.join('\n')).toMatch(/could not remove claude-code\/capture/);
    expect(receiptOf(r.home).targets).toEqual([expect.objectContaining({ kind: 'capture', state: 'failed' })]);
    expect(harnessEvents(r.userSettings)).toEqual({});
  });

  test('--remove with no capture on the receipt still removes a credential at the fixed path', async () => {
    const r = makeRig({ answer: answer(UNSCOPED) });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    writeCaptureCredential(r.home, { mcp_url: REMOTE, access_token: TOKEN });
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), r.deps)).toBe(0);
    expect(existsSync(captureCredentialPath(r.home))).toBe(false);
  });
});

describe('answers the serve builds', () => {
  /** What serve-http-mcp's capabilities resource returns, minus publish gates and readiness. */
  function serveAnswer(auth: AuthInfo, transport: 'oauth' | 'legacy') {
    const visible = filterOpsForSurface(operations.filter((op) => !op.localOnly), 'full')
      .filter((op) => operationScopesAllowed(auth.scopes, op) && opAllowedForBoundClient(auth, op)).map((op) => op.name);
    return { transport, client_id: auth.clientId, ...describeAuthCapabilities(auth, { surface: 'full', visibleOperations: visible }) };
  }
  const base = { token: 'x', expiresAt: 0 } as const;

  test.each([
    ['legacy token with session_capture', 'legacy' as const,
      { ...base, clientId: 'laptop-a', principal: { kind: 'legacy_token', id: '1' }, scopes: ['read', 'write', 'session_capture'], sourceId: 'default' }, null],
    ['legacy token without it', 'legacy' as const,
      { ...base, clientId: 'laptop-a', principal: { kind: 'legacy_token', id: '1' }, scopes: ['read', 'write'], sourceId: 'default' }, 'scope_missing'],
    ['OAuth client with the scope and the operation, no source', 'oauth' as const,
      { ...base, clientId: 'client-1', principal: { kind: 'oauth_client', id: 'client-1' }, scopes: ['read', 'write', 'session_capture'], allowedOperations: ['search', 'corpus_append'] }, null],
    ['OAuth client whose snapshot lacks the operation', 'oauth' as const,
      { ...base, clientId: 'client-1', principal: { kind: 'oauth_client', id: 'client-1' }, scopes: ['read', 'write', 'session_capture'], allowedOperations: ['search'] }, 'operation_not_granted'],
    ['OAuth client on another source', 'oauth' as const,
      { ...base, clientId: 'client-1', principal: { kind: 'oauth_client', id: 'client-1' }, scopes: ['read', 'write', 'session_capture'], allowedOperations: null, sourceId: 'work' }, 'grant_source'],
  ])('%s', async (_label, transport, auth, reason) => {
    const built = serveAnswer(auth as unknown as AuthInfo, transport);
    expect(parseCaptureGrant(built).ok).toBe(true);
    const r = makeRig({ answer: built });
    expect(await applyHarness(registrar(), r.deps)).toBe(0);
    const line = r.out.find((l) => l.startsWith('capture not wired'));
    if (reason === null) {
      expect(line).toBeUndefined();
      expect(existsSync(captureCredentialPath(r.home))).toBe(true);
    } else {
      expect(line).toContain(`(${reason})`);
      expect(existsSync(captureCredentialPath(r.home))).toBe(false);
    }
  });
});

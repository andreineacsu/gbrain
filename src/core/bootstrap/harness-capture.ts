/**
 * harness-capture.ts: remote session capture in registrar mode (#5577).
 *
 * `gbrain bootstrap harness --url <non-loopback> --token <bearer>` registers a
 * REMOTE serve. The capture hooks (Stop, PreCompact, SessionEnd) bank into this
 * machine's session corpus directory and, when `<gbrain home>/capture-remote/
 * credentials.json` exists, a detached child uploads what they banked through
 * the serve's `corpus_append` operation (corpus-upload.ts). This module decides
 * whether a registrar run wires that lane, and owns its rollback:
 *
 *   - The host decides. Capture is wired only on the serve's answer about the
 *     supplied grant (`gbrain://capabilities`, read through the bearer): the
 *     operation is available to the grant, its operation snapshot (if any)
 *     holds it, and its source is `default` (or none reported, which HTTP
 *     dispatch files under `default`). Anything else, an unreadable or
 *     malformed answer included, leaves capture off with one line naming the
 *     cause and the host-side step. Hooks are never wired on a guess.
 *   - Plain HTTP on a non-loopback host keeps capture off before any read: the
 *     credential would carry the bearer in clear (the writer's own rule).
 *   - Harness hooks that another install wrote into a settings file the
 *     capture hooks would use refuse capture (double-fire, [C6]).
 *   - All or nothing. The capture hooks are ordinary `hooks` targets marked
 *     `mechanism: 'capture'`; the credential is a `capture` target planned
 *     after them. The credential is written only when every capture hooks
 *     target and the Claude Code MCP registration confirmed; a failed write,
 *     a failed smoke test or a missing registration removes the capture hooks
 *     this run wrote and fails every capture target.
 *   - A run that plans no capture removes the credential at its fixed path
 *     before it writes any hook, and after the smoke test (which removing
 *     capture does not wait for: it never disconnects MCP) the capture hooks
 *     a prior run recorded that this run does not rewrite.
 *   - Registrar mode wires no Codex SessionEnd hook ([X13]: no local brain),
 *     and removes one an earlier harness run on this home wrote: it would
 *     bank Codex sessions into the spool the credential uploads.
 *
 * The bearer reaches only the credential file (0600) and the capability read's
 * Authorization header: never the receipt, a hook command, the consent text or
 * a printed line.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAPABILITIES_URI } from '../../mcp/capabilities.ts';
import type { GBrainConfig } from '../config.ts';
import { classifyProbeError, DEFAULT_PROBE_TIMEOUT_MS } from '../connect-probe.ts';
import { captureCredentialPath, captureStatePath, openCaptureKinds, readCaptureCredential, readCaptureStops, type CaptureStop, type CaptureStops } from '../context/capture-remote.ts';
import { assertSecureEndpoint } from '../harness/credentials.ts';
import { redactToken, shellQuote } from '../mcp-registration.ts';
import type { Scope } from '../scope.ts';
import { removeCodexHooks } from './codex-hooks.ts';
import type { HarnessReceipt, HarnessTarget } from './format.ts';
import { claudeSettingsPath, removeClaudeHooksAt } from './hooks.ts';
import { GBRAIN_HARNESS_MARKER_VALUE, type ClaudeHookEvent } from './host-specs.ts';
import { acquireBootstrapLock } from './lock.ts';

const CAPTURE_SCOPE: Scope = 'session_capture';
/** The serve operation the upload calls (src/core/ops/transcripts.ts). */
const CAPTURE_OPERATION = 'corpus_append';
/** `mechanism` of the hooks targets that carry the capture lane. */
const CAPTURE_MECHANISM = 'capture';
/** The events whose hooks bank session artifacts. SessionStart and UserPromptSubmit need a local serve's socket. */
export const CAPTURE_HOOK_EVENTS: readonly ClaudeHookEvent[] = ['Stop', 'SessionEnd', 'PreCompact'];

/** Why remote capture is off. Stable codes: the `--json` document carries them. */
export type CaptureOffReason =
  | 'not_registrar'
  | 'claude_code_not_wired'
  | 'opted_out'
  | 'insecure_endpoint'
  | 'local_hooks_present'
  | 'grant_unreadable'
  | 'grant_auth'
  | 'scope_missing'
  | 'operation_not_granted'
  | 'operation_unavailable'
  | 'grant_source';

export type RemoteCapturePlan =
  /** `projects`: the `--project` dirs the capture hooks fire in; empty means user scope (every session on this machine). */
  | { on: true; url: string; grant: string; credentialPath: string; spoolDir: string; projects: readonly string[] }
  | { on: false; reason: CaptureOffReason };

/** The serve's answer about the supplied grant, after validation. */
export interface CaptureGrant {
  transport: 'oauth' | 'legacy';
  clientId: string;
  scopes: string[];
  allowedOperations: string[] | null;
  availableOperations: string[];
  sourceId: string | null;
}

const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_RE.test(v);
const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && NAME_RE.test(x));

/**
 * Validate the `gbrain://capabilities` answer (external input). Returns the
 * grant, or the first field that does not have the shape the serve sends.
 */
export function parseCaptureGrant(answer: unknown): { ok: true; grant: CaptureGrant } | { ok: false; field: string } {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, field: 'answer' };
  const a = answer as Record<string, unknown>;
  if (a.transport !== 'oauth' && a.transport !== 'legacy') return { ok: false, field: 'transport' };
  if (!isText(a.client_id, 200)) return { ok: false, field: 'client_id' };
  if (!isNameList(a.scopes)) return { ok: false, field: 'scopes' };
  if (a.allowed_operations !== null && !isNameList(a.allowed_operations)) return { ok: false, field: 'allowed_operations' };
  if (!isNameList(a.available_operations)) return { ok: false, field: 'available_operations' };
  // The serve always sends source_id: null is a grant with no source (a
  // legacy token, filed under default); an absent field is an unknown shape.
  if (a.source_id !== null && !isText(a.source_id, 128)) return { ok: false, field: 'source_id' };
  return {
    ok: true,
    grant: {
      transport: a.transport,
      clientId: a.client_id,
      scopes: a.scopes,
      allowedOperations: a.allowed_operations as string[] | null,
      availableOperations: a.available_operations,
      sourceId: a.source_id,
    },
  };
}

/**
 * Read `gbrain://capabilities` through the bearer: the read
 * src/core/harness/verify.ts makes, which answers for OAuth-client and
 * legacy-token bearers alike. A real timer race bounds it (an abort signal
 * alone does not cover a stalled handshake), and no redirect is followed: the
 * endpoint check covers the registered URL only. Throws on any failure.
 */
export async function readGrantCapabilities(url: string, token: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (u, init) => fetch(u, { ...init, redirect: 'error' }),
  });
  const client = new Client({ name: 'gbrain-harness-capture-check', version: '1' }, { capabilities: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`capability read timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const read = async () => {
    await client.connect(transport);
    const result = await client.readResource({ uri: CAPABILITIES_URI });
    const content = result.contents[0];
    return JSON.parse(content && 'text' in content && typeof content.text === 'string' ? content.text : '') as unknown;
  };
  try {
    return await Promise.race([read(), guard]);
  } finally {
    clearTimeout(timer);
    // Closing aborts a read the timer abandoned; the answer (or its error) is already settled.
    void client.close().catch(() => { /* already closed */ });
  }
}

/** This machine's session corpus directory (the upload spool): the hook's own resolution, file plane only. */
function captureSpoolDir(home: string, cfg: GBrainConfig | null): string {
  const configured = cfg?.dream?.synthesize?.session_corpus_dir;
  return configured && isAbsolute(configured) ? configured : join(home, 'transcripts', 'corpus');
}

/** `gbrain auth rescope --token|--client <grant>`: the start of every rescope line. */
const grantArgv = (g: CaptureGrant): string[] => ['gbrain', 'auth', 'rescope', g.transport === 'oauth' ? '--client' : '--token', g.clientId];
/**
 * The host command that prints the grant's stored scopes: every client's
 * grant (scopes, source, operations), or every token's scopes. `auth rescope`
 * is no inspect step: with no grant flag it refuses a client, and prints a
 * token's sources and operations without its scopes.
 */
const inspectArgv = (g: CaptureGrant): string[] => g.transport === 'oauth' ? ['gbrain', 'auth', 'clients', '--json'] : ['gbrain', 'auth', 'list'];
const shellLine = (argv: readonly string[]): string => argv.map(shellQuote).join(' ');
/** The operator fills in an OAuth client's complete scope list (the delegation-repair precedent in capabilities.ts). */
const CLIENT_SCOPES_PLACEHOLDER = `<COMPLETE_SCOPES_INCLUDING_${CAPTURE_SCOPE}>`;

/** `gbrain auth rescope …` that gives the grant the capture scope and/or the operation, as one shell line. */
function rescopeCommand(g: CaptureGrant, addScope: boolean): string {
  const argv = grantArgv(g);
  // --scopes replaces the set. A legacy token's answer reports its scopes in
  // full, so the line carries them; an OAuth answer reports this access
  // token's, which can be narrower than the client's, so it gets a placeholder.
  if (addScope) argv.push('--scopes', g.transport === 'oauth' ? CLIENT_SCOPES_PLACEHOLDER : [...new Set([...g.scopes, CAPTURE_SCOPE])].join(','));
  if (g.allowedOperations && !g.allowedOperations.includes(CAPTURE_OPERATION)) {
    // A token widens its snapshot by name; a client's --operations replaces the list.
    if (g.transport === 'oauth') argv.push('--operations', [...g.allowedOperations, CAPTURE_OPERATION].join(','));
    else argv.push('--refresh-operations', '--add', CAPTURE_OPERATION);
  }
  return shellLine(argv);
}

/** Why the grant cannot capture, with the host step; null when it can. */
function grantRefusal(g: CaptureGrant): { reason: CaptureOffReason; text: string } | null {
  const grant = `grant ${shellQuote(g.clientId)}`;
  const opAllowed = g.allowedOperations === null || g.allowedOperations.includes(CAPTURE_OPERATION);
  if (!g.availableOperations.includes(CAPTURE_OPERATION) || !opAllowed) {
    if (!g.scopes.includes(CAPTURE_SCOPE)) {
      if (g.scopes.length === 0) {
        return { reason: 'scope_missing', text: `the serve reports no usable scope for ${grant} (an inactive source?). ` +
          `On the brain host, inspect it with \`${shellLine(inspectArgv(g))}\`, then re-run this command here.` };
      }
      if (g.transport === 'oauth') {
        return { reason: 'scope_missing', text: `${grant} lacks the ${CAPTURE_SCOPE} scope. On the brain host read the client's stored scopes ` +
          `with \`${shellLine(inspectArgv(g))}\` (its entry in clients), then run \`${rescopeCommand(g, true)}\` with the placeholder replaced by the client's complete ` +
          `scope list plus ${CAPTURE_SCOPE} (--scopes replaces the set, and this token's scopes can be narrower than the client's), then issue ` +
          'a new access token for that client (a token keeps the scopes it was issued with) and re-run this command here with it.' };
      }
      return { reason: 'scope_missing', text: `${grant} lacks the ${CAPTURE_SCOPE} scope. On the brain host run \`${rescopeCommand(g, true)}\`, then re-run this command here.` };
    }
    if (!opAllowed) {
      return { reason: 'operation_not_granted', text: `${grant} holds ${CAPTURE_SCOPE}, but its operation snapshot lacks ${CAPTURE_OPERATION}. ` +
        `On the brain host refresh the snapshot: \`${rescopeCommand(g, false)}\`, then re-run this command here.` };
    }
    return { reason: 'operation_unavailable', text: `the serve does not offer ${CAPTURE_OPERATION} to ${grant} (a serve older than this gbrain, a narrowed --surface, ` +
      'or a slug-prefix-bound grant). Upgrade or re-check the serve on the brain host, then re-run this command here.' };
  }
  if (g.sourceId !== null && g.sourceId !== 'default') {
    // The step the serve's own source_not_ingestable refusal (reason grant_source) names.
    const step = g.transport === 'oauth' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(g.clientId)
      ? ['gbrain', 'auth', 'rescope-client', g.clientId, '--source', 'default']
      : ['gbrain', 'auth', 'clients', '--json'];
    return { reason: 'grant_source', text: `${grant} writes to source ${shellQuote(g.sourceId)}, and the host captures sessions only from grants on source default. ` +
      `On the brain host run \`${step.map(shellQuote).join(' ')}\` (binds the grant to default), then re-run this command here.` };
  }
  return null;
}

/** A settings file the capture hooks would write that carries harness hooks this home's receipt did not record. */
function foreignHarnessHooks(prior: HarnessReceipt | null, paths: readonly string[]): string | null {
  for (const path of paths) {
    let raw: string;
    try {
      if (!existsSync(path)) continue;
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // unreadable: the hook writer's own fail-closed path refuses it
    }
    if (!raw.includes(`"${GBRAIN_HARNESS_MARKER_VALUE}"`)) continue;
    if (!prior?.targets.some((t) => t.kind === 'hooks' && t.path === path)) return path;
  }
  return null;
}

export interface RemoteCaptureInput {
  registrarMode: boolean;
  wireClaude: boolean;
  noHooks: boolean;
  noCapture: boolean;
  url: string;
  token: string | undefined;
  home: string;
  prior: HarnessReceipt | null;
  userSettingsPath: string;
  projects: readonly string[];
  fileConfig: GBrainConfig | null;
}

/**
 * Decide whether this run wires remote capture. Logs the registrar note and
 * one line naming why capture is off (none for the operator's own opt-out).
 * Never throws: a failed or malformed grant read is capture off.
 */
export async function planRemoteCapture(
  input: RemoteCaptureInput,
  d: { readCapabilities: (url: string, token: string) => Promise<unknown>; log: (line: string) => void },
): Promise<RemoteCapturePlan> {
  if (!input.registrarMode) return { on: false, reason: 'not_registrar' };
  if (!input.wireClaude) return { on: false, reason: 'claude_code_not_wired' };
  const off = (reason: CaptureOffReason, text?: string): RemoteCapturePlan => {
    if (!input.noHooks) {
      d.log(
        'registrar mode (non-loopback url): hooks are NOT wired — they would talk to the LOCAL brain, ' +
          'not the registered remote serve. MCP registration only.',
      );
    }
    if (text) d.log(`capture not wired (${reason}): ${text}`);
    return { on: false, reason };
  };
  if (input.noHooks || input.noCapture || input.token === undefined) return off('opted_out');
  try {
    assertSecureEndpoint(input.url);
  } catch {
    return off('insecure_endpoint', `${input.url} is plain HTTP on a non-loopback host, and session upload needs HTTPS ` +
      '(the upload sends the bearer and the sessions). Register the serve\'s HTTPS URL to turn capture on.');
  }
  const hookPaths = input.projects.length > 0 ? input.projects.map(claudeSettingsPath) : [input.userSettingsPath];
  const foreign = foreignHarnessHooks(input.prior, hookPaths);
  if (foreign) {
    return off('local_hooks_present', `${foreign} already carries harness hooks from another gbrain install (another GBRAIN_HOME); ` +
      'capture hooks there would double-fire every event or take over that install\'s entries (Claude Code merges the scopes). ' +
      'Remove that install first (`gbrain bootstrap harness --remove` under its home), then re-run this command.');
  }
  let answer: unknown;
  try {
    answer = await d.readCapabilities(input.url, input.token);
  } catch (e) {
    const message = redactToken(e instanceof Error ? e.message : String(e), input.token).slice(0, 200);
    const kind = classifyProbeError(message);
    return kind === 'auth'
      ? off('grant_auth', `the serve rejected the supplied token when asked for its grant (${message}). Check the token, then re-run this command.`)
      : off('grant_unreadable', `could not read the grant from ${input.url} (${kind}: ${message}). MCP registration continues; re-run this command once the serve answers.`);
  }
  const parsed = parseCaptureGrant(answer);
  if (!parsed.ok) {
    return off('grant_unreadable', `could not read the grant from ${input.url}: its capability answer has no valid ${parsed.field} ` +
      '(a serve older than this gbrain?). MCP registration continues; re-run this command after upgrading the serve.');
  }
  const refusal = grantRefusal(parsed.grant);
  if (refusal) return off(refusal.reason, refusal.text);
  return {
    on: true,
    url: input.url,
    grant: parsed.grant.clientId,
    credentialPath: captureCredentialPath(input.home),
    spoolDir: captureSpoolDir(input.home, input.fileConfig),
    projects: input.projects,
  };
}

type CapturePlanOn = Extract<RemoteCapturePlan, { on: true }>;

/** The sessions hooks in these `--project` dirs fire in; none listed means user scope, every session ([X7] reach). */
function sessionReach(projects: readonly string[]): string {
  return projects.length > 0 ? `every Claude Code session in ${projects.join(', ')}` : 'every Claude Code session on this machine';
}

/** The sessions the planned capture hooks fire in, for the consent block. */
export function captureHookReach(p: CapturePlanOn): string {
  return sessionReach(p.projects);
}

/** The capture statement the consent block, the consent request's `risk` and its `user_message` all carry. */
export function captureConsentStatement(p: CapturePlanOn): string {
  // The spool is the whole directory: anything a capture hook banks there is
  // uploaded, so the statement names the directory, not one harness.
  return `Every session artifact in ${p.spoolDir} (this machine's session corpus directory, the upload spool) is ` +
    `secret-scanned locally and uploaded to ${p.url}, starting with every session artifact already there; the Stop, ` +
    `PreCompact and SessionEnd hooks bank ${captureHookReach(p)} into it. The serve URL and the ` +
    `bearer are stored in ${p.credentialPath} (0600).`;
}

/** The consent block's capture off-ramps: removing the MCP registration does not stop the upload. */
export const CAPTURE_OFF_RAMPS = 'Session-upload off-ramps: re-run this command with --no-capture (MCP stays), or ' +
  '`gbrain bootstrap harness --remove`; `claude mcp remove` stops MCP only, not the upload.';

/** The numbered consent-block items for registrar-mode capture (the caller numbers them). */
export function captureConsentLines(p: CapturePlanOn, hookScope: string): string[] {
  return [
    `Wire the three session-capture hooks (Stop/PreCompact/SessionEnd) in ${hookScope}; SessionStart and UserPromptSubmit ` +
      'stay unwired (they need a local serve).',
    `Remote session capture: ${captureConsentStatement(p)} The host attributes these sessions to grant ${shellQuote(p.grant)}. ` +
      'Opt out with --no-capture.',
  ];
}

/** Mark the planned hooks targets as the capture lane and plan the credential after them. */
export function planCaptureTargets(targets: HarnessTarget[], p: RemoteCapturePlan): void {
  if (!p.on) return;
  for (const t of targets) if (t.host === 'claude-code' && t.kind === 'hooks') t.mechanism = CAPTURE_MECHANISM;
  targets.push({ host: 'claude-code', kind: 'capture', state: 'pending', scope: 'user', path: p.credentialPath, grant: p.grant, mechanism: 'credential-file' });
}

/**
 * Remove the capture credential and the upload's stop state from their fixed
 * paths, and the capture directory when nothing else is left in it. True when
 * a credential was there. Throws on an fs failure, or when the capture
 * directory is a symlink (rm would act on its target).
 */
export function removeCaptureCredential(home: string): boolean {
  const path = captureCredentialPath(home);
  const dir = dirname(path);
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error(`refusing to remove the capture credential through a non-directory or symlink at ${dir}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // nothing was ever stored
    throw e;
  }
  const present = existsSync(path);
  rmSync(path, { force: true });
  rmSync(captureStatePath(home), { force: true });
  try {
    rmdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
  }
  return present;
}

interface CaptureWiringCtx {
  home: string;
  failTarget: (t: HarnessTarget, err: string) => void;
  log: (line: string) => void;
}

/**
 * Fail every capture target not already failed with `note`, removing what it
 * stands for, in target order: the capture hooks first (planned before the
 * credential; only a confirmed hooks target has entries to remove), then the
 * credential. The credential at its fixed path is deleted whether its target
 * is confirmed or still pending, so a credential a prior run stored never
 * outlives the hooks this run removed. A removal that fails leaves the target
 * failed with the converge step named.
 */
export function undoCaptureWiring(targets: HarnessTarget[], ctx: CaptureWiringCtx, note: string): void {
  for (const t of targets) {
    const capture = t.kind === 'capture' || (t.kind === 'hooks' && t.mechanism === CAPTURE_MECHANISM);
    if (!capture || t.state === 'failed') continue;
    try {
      if (t.kind === 'capture') removeCaptureCredential(ctx.home);
      else if (t.state === 'confirmed' && t.path) {
        const r = removeClaudeHooksAt(t.path, GBRAIN_HARNESS_MARKER_VALUE);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
      }
      ctx.failTarget(t, note);
    } catch (e) {
      ctx.failTarget(t, `${note}; it could not be removed (${e instanceof Error ? e.message : String(e)}); run \`gbrain bootstrap harness --remove\` to converge`);
    }
  }
}

/**
 * Apply the `capture` target: write the credential once the Claude Code MCP
 * registration and every capture hooks target confirmed, else (or when the
 * write fails) undo the capture hooks this run wrote. The bearer stays out of
 * every message.
 */
export function wireCaptureCredential(
  t: HarnessTarget,
  targets: HarnessTarget[],
  ctx: CaptureWiringCtx & {
    url: string;
    token: string;
    write: (home: string, input: { mcp_url: string; access_token: string }) => string;
    confirm: (t: HarnessTarget) => void;
  },
): void {
  const mcp = targets.find((x) => x.host === 'claude-code' && x.kind === 'mcp');
  const hooks = targets.filter((x) => x.kind === 'hooks' && x.mechanism === CAPTURE_MECHANISM);
  const blocker = mcp?.state !== 'confirmed'
    ? 'the Claude Code MCP registration did not land'
    : hooks.length === 0 || hooks.some((h) => h.state !== 'confirmed') ? 'the capture hooks did not all land' : null;
  if (blocker) {
    undoCaptureWiring(targets, ctx, `capture rolled back: ${blocker}`);
    return;
  }
  try {
    ctx.write(ctx.home, { mcp_url: ctx.url, access_token: ctx.token });
  } catch (e) {
    const msg = redactToken(e instanceof Error ? e.message : String(e), ctx.token);
    undoCaptureWiring(targets, ctx, `capture rolled back: the upload credential could not be written (${msg})`);
    return;
  }
  ctx.confirm(t);
  ctx.log(`capture credential stored in ${t.path} (0600); the capture hooks upload to ${ctx.url}.`);
}

/**
 * Before the apply loop writes any hook. A run that plans no capture removes
 * the credential at its fixed path (a crashed run may have left one no
 * receipt records), so no hook this run writes uploads under a credential its
 * receipt does not record, even when the run dies before `convergeCaptureOff`.
 * A registrar run removes gbrain's Codex SessionEnd hook beside every codex
 * config the prior receipt records, under that directory's lock [X11]: an
 * earlier harness run on this home wrote it, and registrar mode wires none.
 * Returns the credential's failed target, or null; `convergeCaptureOff`
 * records it after the loop, which would apply a `capture` target on the
 * receipt now.
 */
export async function convergeBeforeApply(
  input: { plan: RemoteCapturePlan; registrarMode: boolean; prior: HarnessReceipt | null },
  ctx: { home: string; log: (line: string) => void; logError: (line: string) => void },
): Promise<HarnessTarget | null> {
  const codexConfigs = input.registrarMode ? (input.prior?.targets ?? []).filter((t) => t.host === 'codex' && t.kind === 'mcp' && t.path) : [];
  for (const configPath of new Set(codexConfigs.map((t) => t.path!))) {
    const dir = dirname(configPath);
    if (!existsSync(dir)) continue;
    const hooksPath = join(dir, 'hooks.json');
    try {
      const lock = await acquireBootstrapLock(dir);
      try {
        const r = removeCodexHooks({ configPath, hooksPath });
        if (r.removed) ctx.log(`Codex SessionEnd hook removed from ${hooksPath} (registrar mode wires none: it would bank Codex sessions into the upload spool).`);
        for (const note of r.notes) ctx.logError(note);
      } finally {
        lock.release();
      }
    } catch (e) {
      ctx.logError(`could not remove the Codex SessionEnd hook beside ${configPath} (${e instanceof Error ? e.message : String(e)}); ` +
        `remove gbrain's SessionEnd group from ${hooksPath} and its trust entry from ${configPath} by hand.`);
    }
  }
  return input.plan.on ? null : removeOrphanCaptureCredential(ctx.home, ctx.log, 'capture is not wired by this run');
}

/**
 * A run that plans no capture, after the apply loop: remove the capture hooks
 * the prior receipt records at a path this run does not write hooks to, and
 * record the credential removal `convergeBeforeApply` could not do. Handled
 * prior targets leave `prior.targets`, so the stale-target cleanup does not
 * act on them again; a failure is recorded as a failed target on `receipt`.
 */
export async function convergeCaptureOff(
  prior: HarnessReceipt | null,
  receipt: HarnessReceipt,
  credentialFailure: HarnessTarget | null,
  ctx: { userSettingsPath: string; log: (line: string) => void; logError: (line: string) => void; save: () => void },
): Promise<void> {
  const fail = (t: HarnessTarget, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    receipt.targets.push({ ...t, state: 'failed', error: `converge-off: ${msg}` });
    ctx.save();
    ctx.logError(`could not remove the capture ${t.kind === 'capture' ? 'credential' : `hooks in ${t.path}`}: ${msg} (kept on the receipt for retry).`);
  };
  const planned = new Set(receipt.targets.filter((t) => t.kind === 'hooks').map((t) => t.path));
  const stale = (prior?.targets ?? []).filter((t) => t.kind === 'hooks' && t.mechanism === CAPTURE_MECHANISM && t.path && !planned.has(t.path));
  if (stale.length > 0) {
    // The lock the apply loop and the stale-target cleanup take [X11].
    mkdirSync(dirname(ctx.userSettingsPath), { recursive: true });
    const lock = await acquireBootstrapLock(dirname(ctx.userSettingsPath));
    try {
      for (const t of stale) {
        try {
          const r = removeClaudeHooksAt(t.path!, GBRAIN_HARNESS_MARKER_VALUE);
          if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
          if (r.removed > 0) ctx.log(`capture hooks removed from ${t.path} (capture is not wired by this run).`);
        } catch (e) {
          fail(t, e);
        }
      }
    } finally {
      lock.release();
    }
  }
  if (prior) prior.targets = prior.targets.filter((t) => !stale.includes(t) && t.kind !== 'capture');
  if (credentialFailure) fail(credentialFailure, credentialFailure.error);
}

/** Remove a credential at the fixed path that no `capture` target accounts for (`why` ends the log line). A failed target, or null. */
export function removeOrphanCaptureCredential(home: string, log: (line: string) => void, why = 'no receipt entry recorded it'): HarnessTarget | null {
  const path = captureCredentialPath(home);
  try {
    if (removeCaptureCredential(home)) log(`capture credential removed from ${path} (${why}).`);
    return null;
  } catch (e) {
    return { host: 'claude-code', kind: 'capture', state: 'failed', scope: 'user', path, mechanism: 'credential-file', error: e instanceof Error ? e.message : String(e) };
  }
}

/** A host refusal the upload recorded, as `code[:reason] since <when>`. */
function stopText(s: CaptureStop): string {
  return `${s.code}${s.reason ? `:${s.reason}` : ''}${s.at ? ` since ${s.at}` : ''}`;
}

/** The artifact kinds the host stopped, as `<kind> uploads (<stop>)`, comma-joined; '' when none. */
function kindStopsText(stops: CaptureStops): string {
  const kinds = Object.entries(stops).filter(([scope]) => scope !== 'lane') as Array<[string, CaptureStop]>;
  return kinds.map(([kind, s]) => `${kind} uploads (${stopText(s)})`).join(', ');
}

/**
 * `--status`: a confirmed `capture` target reads failed when the credential is
 * gone, unreadable or names another serve, or when the host left no artifact
 * kind open: it stopped the whole lane, or each kind one by one (nothing
 * uploads until registering again clears the stops).
 */
export function liveCaptureTarget(t: HarnessTarget, home: string, url: string): HarnessTarget {
  if (t.kind !== 'capture' || t.state !== 'confirmed') return t;
  const credential = readCaptureCredential(home);
  if (credential?.mcp_url !== url) {
    return { ...t, state: 'failed', error: credential ? `the capture credential names ${credential.mcp_url}, not ${url}; re-run to converge`
      : 'the capture credential is missing or unreadable (0600, no symlink); re-run `gbrain bootstrap harness` to restore it' };
  }
  // The capture hooks' own question, so --status and the hooks agree on "nothing uploads".
  if (openCaptureKinds(home).length > 0) return t;
  const stops = readCaptureStops(home);
  return { ...t, state: 'failed', error: `the host stopped every upload (${stops.lane ? stopText(stops.lane) : kindStopsText(stops)}); ` +
    'nothing uploads until re-running `gbrain bootstrap harness` after the host-side fix clears the stop' };
}

/** Where upload outcomes land, for the summary and `--status`. */
function heartbeatPath(home: string): string {
  return join(home, 'integrations', 'hooks', 'heartbeat.jsonl');
}

/**
 * The capture line of `--status` and the final summary; null when the receipt
 * records no capture. An ON line names the sessions the capture hooks
 * targets reach (their `scope`: user, or each `--project` dir) and the
 * artifact kinds the host stopped.
 */
export function captureStatusLine(targets: readonly HarnessTarget[], home: string, url: string): string | null {
  const t = targets.find((x) => x.kind === 'capture');
  if (!t) return null;
  if (t.state !== 'confirmed') return `remote capture: ${t.state} (${t.error ?? 'not wired yet'})`;
  const hooks = targets.filter((x) => x.kind === 'hooks' && x.mechanism === CAPTURE_MECHANISM);
  const reach = sessionReach(hooks.some((h) => h.scope === 'user') ? [] : hooks.map((h) => h.scope));
  const kinds = kindStopsText(readCaptureStops(home));
  const stopped = kinds === '' ? '' : ` The host stopped ${kinds}; ` +
    'the other kinds still upload, and re-running `gbrain bootstrap harness` after the host-side fix clears the stop.';
  return `remote capture: ON. The capture hooks upload ${reach} to ${url}; the host attributes them to grant ` +
    `${shellQuote(t.grant ?? '(unnamed)')} (use one grant per machine so sessions can be told apart). Upload outcomes: ` +
    `${heartbeatPath(home)} (event capture-upload).${stopped}`;
}

/** The `remote_capture` member of the apply `--json` document. */
export function captureJson(p: RemoteCapturePlan, targets: readonly HarnessTarget[]): Record<string, unknown> {
  if (!p.on) return { state: 'off', reason: p.reason };
  const t = targets.find((x) => x.kind === 'capture');
  return t?.state === 'confirmed'
    ? { state: 'on', grant: p.grant, credential_path: p.credentialPath }
    : { state: 'failed', grant: p.grant, error: t?.error ?? null };
}

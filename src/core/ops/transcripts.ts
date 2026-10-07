/**
 * Recent-transcripts operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3). Op const stays module-private; `transcriptsOperations`
 * below is spliced into the canonical `operations` array in ../operations.ts
 * at the cluster's original position (right after the salience spread). Never
 * import from '../operations.ts' here (cycle). `corpus_append` (#5577) is the
 * remote session-capture transport: the writer is context/corpus-remote.ts.
 */

import { OperationError, opError, type Operation, type OperationContext, type ParamDef } from './contract.ts';
import { hostFix, hostOnlyError, invalidParam } from './op-fix.ts';
import { GET_RECENT_TRANSCRIPTS_DESCRIPTION } from '../operations-descriptions.ts';
import type { Action } from '../agent-output.ts';
import type { CorpusArtifactRefusal } from '../context/corpus-remote.ts';

const get_recent_transcripts: Operation = {
  name: 'get_recent_transcripts',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  scope: 'read',
  // Local-only: rejects HTTP-borne MCP traffic at tool-list time
  // (serve-http.ts filters on `localOnly`) AND at runtime via the in-handler
  // ctx.remote check. Defense in depth: hidden + rejected.
  localOnly: true, cliOnly: { argv: ['gbrain', 'transcripts', 'recent'] },
  params: {
    days: { type: 'number', description: 'Window in days. Default 7.' },
    summary: {
      type: 'boolean',
      description: 'When true (default), return first ~300 chars per transcript. When false, full content (capped at 100 KB per file).',
    },
    limit: { type: 'number', description: 'Max transcripts (default 50).' },
  },
  handler: async (ctx, p) => {
    // Trust gate (eng review D2 + codex C3): MCP / HTTP callers (`remote=true`)
    // are blocked. Local CLI callers (`remote=false`) and the trusted-workspace
    // dream cycle pass through. This op is intentionally NOT in the subagent
    // allow-list (subagents always run with remote=true; they would always be
    // rejected, which is a footgun if the op is visible).
    if (ctx.remote === true) {
      const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : undefined);
      const days = n(p.days);
      const limit = n(p.limit);
      throw hostOnlyError(ctx, 'permission_denied', 'get_recent_transcripts is local-only — call via the gbrain CLI.',
        ['gbrain', 'transcripts', 'recent', ...(days ? ['--days', days] : []), ...(limit ? ['--limit', limit] : []),
          ...(p.summary === false ? ['--full'] : []), '--json'],
        'Raw transcripts are private host files; only the trusted local CLI reads them.');
    }
    const { listRecentTranscripts } = await import('../transcripts.ts');
    return listRecentTranscripts(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      summary: typeof p.summary === 'boolean' ? p.summary : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'transcripts', hidden: true },
};

// --- corpus_append: remote session capture (#5577) ---

const CORPUS_APPEND_PARAMS: Record<'kind' | 'session_id' | 'text', ParamDef> = {
  kind: {
    type: 'string', required: true, enum: ['session', 'segment', 'writeback'],
    description: 'session (a session-end corpus file), segment (a checkpoint segment) or writeback (one user turn).',
  },
  session_id: { type: 'string', required: true, description: "The client's session id: 1-100 letters, digits, dot, underscore or hyphen." },
  text: { type: 'string', required: true, description: "The artifact's redacted text, at most 1,572,864 UTF-8 bytes; the host scans it again before storing it." },
};

/**
 * The source this serve's sweeps file a session file or segment into. The
 * serve resolves the source ladder once at start and binds its resolve-IPC
 * lane and delegated sweep runner to the result (serve-http.ts), so that
 * bound value is the answer even after the ladder moves: its sole-non-default
 * tier ends once `default` holds a page. With no serve bound in this process
 * (tests, a direct dispatch) the ladder is resolved per call; its
 * GBRAIN_SOURCE tier is the one the --http corpus drain reads.
 */
async function sweepSourceId(ctx: OperationContext): Promise<string> {
  const { serveBoundSourceId } = await import('../../mcp/resolve-ipc-binding.ts');
  const bound = serveBoundSourceId();
  if (bound) return bound;
  const { resolveMcpStdioSourceScope } = await import('../../mcp/server.ts');
  return (await resolveMcpStdioSourceScope(ctx.engine)).sourceId;
}

const describeError = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** A thrown value's name and `code` only: a scanner error's message can quote the scanned text (R12). */
function errorIdentity(e: unknown): string {
  if (!(e instanceof Error)) return `non-Error ${typeof e}`;
  const safe = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : undefined);
  const code = safe((e as { code?: unknown }).code);
  return `${safe(e.name) ?? 'unnamed'}${code ? ` (code ${code})` : ''}`;
}

/** A host-side step no gbrain command performs: the agent reports it and relays the message to the user. */
function hostStep(why: string, userMessage: string): Action {
  return { consent: [], actor: 'host_admin', why, user_message: userMessage, requires_exclusive: false };
}

/** The serve's log (its stderr) holds the op's `[corpus_append]` error line: a storage error in full, a scanner error as its class and code only. */
const serverLogStep = (why: string) => hostStep(why,
  "The brain host refused to store this session artifact. Please ask whoever runs that gbrain server to read its log (the serve's stderr) for the [corpus_append] error line.");

function artifactRefusal(ctx: OperationContext, refusal: CorpusArtifactRefusal): OperationError {
  if (refusal.code === 'invalid_params') {
    return invalidParam(ctx, 'corpus_append', refusal.field, `corpus_append: ${refusal.problem}.`, { def: CORPUS_APPEND_PARAMS[refusal.field] });
  }
  if (refusal.code === 'payload_too_large') {
    return opError('payload_too_large', `corpus_append: text is ${refusal.bytes} UTF-8 bytes, over the ${refusal.cap}-byte cap.`,
      `Send text of at most ${refusal.cap} UTF-8 bytes. The host never cuts an artifact, so this one stays unsent; sending it again cannot succeed.`);
  }
  return opError('scan_unavailable', 'The brain host could not load its secret scanner, so it stored nothing.',
    "Keep the artifact and send it again after the host operator repairs the install; the brain host's server log gives the scanner error's class and any code it carries, not its message.",
    { fix: serverLogStep("The host refuses to store text it cannot scan; its server log gives the scanner error's class and any code it carries, not its message.") });
}

/**
 * Requirement 8: extract_atoms, the stdio and delegated sweeps and dream
 * synthesis file a corpus file into their own source, so only a grant on
 * `default` captures (reason `grant_source`: no kind lands). A session file or
 * segment names no source, so it is also refused when the serve's sweep
 * ingests another one (reason `sweep_source`); a writeback turn names
 * `.src-default` and is filed into `default` anyway, so it still lands.
 */
function sourceRefusal(ctx: OperationContext, kind: string, sweepSource?: string): OperationError {
  if (sweepSource) {
    return opError('source_not_ingestable',
      `corpus_append: this serve's sweep files ${kind} artifacts into source ${sweepSource}, not into source default.`,
      'This serve stores no session files or checkpoint segments; writeback turns from this grant are accepted while ambient writeback is on. The host operator restarts the serve bound to source default (GBRAIN_SOURCE=default) to store the other kinds too.',
      { reason: 'sweep_source', fix: hostStep("The serve's sweeps ingest the source the serve bound when it started (GBRAIN_SOURCE, else the .gbrain-source dotfile, a registered local_path, sources.default, or the only non-default source with a local_path while default held no page); a session file or segment names no source, so a sweep would file it there.",
        'This gbrain server does not store whole sessions from this machine, because its sweep ingests another source. Please ask whoever runs it to restart the serve with GBRAIN_SOURCE=default.') });
  }
  const clientId = ctx.auth?.clientId;
  const oauth = ctx.auth?.principal?.kind === 'oauth_client' && !!clientId && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(clientId);
  return opError('source_not_ingestable',
    `corpus_append: this grant writes to source ${ctx.sourceId}, and the host captures sessions only from grants on source default.`,
    'Nothing from this grant is stored, whatever its kind. The host operator binds this grant to source default to capture its sessions (command in fix).',
    { reason: 'grant_source', fix: oauth
      ? hostFix(ctx, ['gbrain', 'auth', 'rescope-client', clientId!, '--source', 'default'],
        'Binds this grant to source default, the only source captured sessions are filed into; it changes where every write from this grant lands.', { consent: ['credentials'] })
      : hostFix(ctx, ['gbrain', 'auth', 'clients', '--json'], "Shows each grant's write source so the operator can bind this one to source default.") });
}

/** The host's authoritative writeback gate, read the way the sweep's corpus pass reads it. */
async function assertWritebackOn(ctx: OperationContext): Promise<void> {
  const { resolveWritebackConfig } = await import('../facts/writeback-config.ts');
  const { loadConfig } = await import('../config.ts');
  const wb = await resolveWritebackConfig(ctx.engine, loadConfig(), { gate: true });
  const unresolved = wb.read_error ? 'read_error' : wb.enabled ? null : wb.plane_drift ? 'plane_drift' : wb.mode_valid ? null : 'mode_invalid';
  if (unresolved) {
    throw opError('writeback_gate_unresolved', 'The brain host could not resolve its ambient-writeback setting, so it did not store the writeback turn.',
      'Keep the writeback turn and send it again later; doctor on the brain host names the setting to repair (command in fix).',
      { reason: unresolved, fix: hostFix(ctx, ['gbrain', 'doctor', '--json'], "Doctor's memory_writeback check names the command that makes the setting coherent again.") });
  }
  if (!wb.enabled) {
    throw opError('writeback_off', 'Ambient writeback is off on the brain host, so it stores no writeback turns.',
      'Stop sending writeback turns to this host; this setting does not affect session files or checkpoint segments. The host operator decides whether to turn writeback on (command in fix).',
      { fix: hostFix(ctx, ['gbrain', 'config', 'set', 'memory.auto_writeback', 'salient'],
        'Ambient writeback is opt-in on the brain host; turning it on lets the sweep extract facts from writeback turns.') });
  }
}

async function appendCorpusArtifact(ctx: OperationContext, p: Record<string, unknown>): Promise<{ status: 'stored' | 'duplicate'; kind: string; bytes: number }> {
  const principal = ctx.remote === false ? undefined : ctx.auth?.principal;
  if (!principal) {
    throw opError('permission_denied', 'corpus_append accepts artifacts only from an authenticated remote grant; this caller carries no principal.',
      'On the brain host the capture hooks write the session corpus directly. A registered machine calls corpus_append over HTTP MCP with a grant that holds the session_capture scope.',
      { reason: 'principal_required', fix: hostFix(ctx, ['gbrain', 'auth', 'clients', '--json'], 'Lists the grants; the operator gives session_capture to the grant of the machine that uploads.') });
  }
  const remote = await import('../context/corpus-remote.ts');
  const checked = remote.validateCorpusArtifact(p);
  if (!checked.ok) throw artifactRefusal(ctx, checked.refusal);
  const { artifact } = checked;
  if (ctx.sourceId !== 'default') throw sourceRefusal(ctx, artifact.kind);
  if (artifact.kind === 'writeback') await assertWritebackOn(ctx);
  else {
    const sweepSource = await sweepSourceId(ctx);
    if (sweepSource !== 'default') throw sourceRefusal(ctx, artifact.kind, sweepSource);
  }
  const { resolveSweepCorpusDir } = await import('../sweep.ts');
  const dir = await resolveSweepCorpusDir(ctx.engine);
  let written: Awaited<ReturnType<typeof remote.writeRemoteCorpusArtifact>>;
  try {
    written = await remote.writeRemoteCorpusArtifact({ dir, artifact, principal, seatLabel: remote.remoteSeatLabel(ctx.auth?.clientName, principal) });
  } catch (e) {
    ctx.logger.error(`[corpus_append] corpus write failed in ${dir}: ${describeError(e)}`);
    throw opError('storage_error', 'The brain host could not write the artifact to its session corpus.',
      "Keep the artifact and send it again later. The brain host's server log names the failure, such as a corpus directory that is not writable or a full disk.",
      { fix: serverLogStep('The host logs the full storage error; the client gets none of it.') });
  }
  if (written.status === 'refused') {
    if (written.refusal.code === 'scan_unavailable') ctx.logger.error(`[corpus_append] host secret scanner failed: ${errorIdentity(written.refusal.error)}`);
    throw artifactRefusal(ctx, written.refusal);
  }
  return { status: written.status, kind: artifact.kind, bytes: written.bytes };
}

const corpus_append: Operation = {
  name: 'corpus_append',
  description: 'Transport for the capture hooks on a registered machine (remote session capture), not a conversation tool. '
    + 'Stores one redacted session-corpus artifact on the brain host, where its sweep extracts facts and dream synthesis reads it. '
    + 'The host scans the text again, files it under this grant\'s source and credits this grant as its seat. '
    + 'Idempotent: the same content again returns status duplicate. Needs the session_capture scope.',
  mutating: true,
  idempotent: true,
  writeInference: 'none',
  outputRedaction: 'no_stored_text',
  scope: 'write',
  requiredScopes: ['session_capture'],
  area: 'memory',
  params: CORPUS_APPEND_PARAMS,
  // One structured line per call that reaches the handler: client, kind,
  // byte count and outcome code, never the text (schema refusals are logged
  // by the serve's request log before dispatch reaches here).
  handler: async (ctx, p) => {
    const kind = typeof p.kind === 'string' && ['session', 'segment', 'writeback'].includes(p.kind) ? p.kind : 'invalid';
    const bytes = typeof p.text === 'string' ? Buffer.byteLength(p.text, 'utf8') : 0;
    const line = (outcome: string) => `[corpus_append] ${JSON.stringify({ client_id: ctx.auth?.clientId ?? 'none', kind, bytes, outcome })}`;
    try {
      const result = await appendCorpusArtifact(ctx, p);
      ctx.logger.info(line(result.status));
      return result;
    } catch (e) {
      ctx.logger.warn(line(e instanceof OperationError ? e.canonicalCode : 'internal_error'));
      throw e;
    }
  },
  cliHints: { name: 'corpus-append', hidden: true },
};

export const transcriptsOperations: Operation[] = [get_recent_transcripts, corpus_append];

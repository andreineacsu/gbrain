/**
 * corpus-upload.ts: a registered machine's upload of banked session artifacts
 * to its serve (#5577 remote session capture). The capture hooks (stop,
 * compact, session-end) bank redacted files into the local corpus directory
 * exactly as on a brain host, and that directory is the spool. After an event
 * banks, the hook spawns `gbrain hook capture-upload` detached; that child
 * runs `runCaptureUpload` here, outside every hook budget.
 *
 * On a brain host that directory also holds what `corpus_append` stored for
 * remote grants, under `rc-<16 hex>-` (corpus-remote.ts). The listing skips
 * that namespace, so a host that is itself a capture client forwards its own
 * sessions and never another grant's.
 *
 * ENGINE-FREE: fs, the credential file (capture-remote.ts) and one MCP session
 * to the serve's `corpus_append` operation (ops/transcripts.ts). The MCP SDK
 * is imported lazily, by a run that has something to send, so the hook
 * command does not load it on every event.
 *
 * Marker: `<artifact>.uploaded` beside the artifact records what the serve
 * settled, `sent` (stored or duplicate) or `refused` (this artifact can never
 * land), with the sha256 of the LOCAL FILE BYTES read for that send, never of
 * the redacted payload. A later run skips the artifact while the file still
 * has those bytes; a session file rewritten by a resumed session no longer
 * matches and is sent again. Size and mtime are stored as the cheap first
 * check, so a settled corpus is verified again without reading it.
 *
 * Order is send, then mark: a crash between the two sends again, the host
 * answers `duplicate`, and the marker is written then.
 *
 * Nothing leaves unscanned: every artifact goes through the secret scanner
 * here, whatever scanned it when it was banked (session-end writes its file
 * even when the scanner cannot load). No scanner, nothing sent.
 *
 * Heartbeat: each run appends ONE entry (event `capture-upload`) holding
 * counts and one reason code, never text, a session id or the bearer. Codes:
 *   upload_timeout / upload_unreachable / upload_auth   the serve did not
 *       answer, or rejected the bearer; the artifact stays pending
 *   upload_error               an answer this client cannot read, or a
 *       redirect (never followed); pending
 *   upload_no_credential       the credential file is missing or rejected
 *   upload_credential_changed  the credential file was removed or replaced
 *       during the run; nothing more is sent under the one the run read
 *   upload_skipped_unscanned   the secret scanner could not run
 *   upload_busy                another run holds the claim
 *   upload_stopped             the host stopped this lane earlier
 *   <code>[:<reason>]          the serve's own refusal, as it spelled it
 *   exception:<errno or class> an fs failure: on one artifact (one that
 *       cannot be read stays pending, and the run goes on), on a marker
 *       (that artifact stays pending and the run sends nothing more), or of
 *       the run itself (outcome error)
 * The hook command adds upload_spawn_failed when it cannot start the child.
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGbrainHome } from '../gbrain-home.ts';
import { acquirePushLock, type PushLockHandle } from '../workspace-push.ts';
import {
  captureCredentialIdentity,
  openCaptureKinds,
  readCaptureCredential,
  recordCaptureStop,
  type CaptureCredential,
  type CaptureStopScope,
} from './capture-remote.ts';
import { CORPUS_APPEND_MAX_TEXT_BYTES, isRemoteNamespaced, type CorpusArtifactKind, type HostScanner } from './corpus-remote.ts';
import { corpusFileSessionId, parseSegmentFileName, parseWbFileName } from './corpus-segments.ts';
import { writeHeartbeat, type HookHeartbeatEntry } from './hook-heartbeat.ts';

/** The hook command's internal event, and this lane's heartbeat event name. */
export const CAPTURE_UPLOAD_EVENT = 'capture-upload';
/** Marker sidecar suffix (`<artifact>.txt.uploaded`). The hook's corpus GC reaps it with its artifact. */
export const CAPTURE_UPLOAD_MARKER_SUFFIX = '.uploaded';

export interface CaptureUploadLimits {
  /** Sends one run starts, so a backlog goes out in batches. An artifact that never reaches a send (it cannot be read or scanned, or is over the cap) uses none. */
  maxArtifacts: number;
  /** A run takes up no further artifact once it has lasted this long: the one bound on artifacts that never reach a send. */
  budgetMs: number;
  /** Timeout of the MCP handshake, and the base timeout of one send. */
  callTimeoutMs: number;
  /** How long a run waits for another run's claim before it gives up as busy. */
  claimWaitMs: number;
}

/**
 * The claim wait is longer than one call timeout. A session-end hook fires
 * right after the session's last stop hook, so its run usually finds the stop
 * hook's run holding the claim; it waits for that run, even one sitting out a
 * timeout, so the session file is not left for the next session's first event.
 */
export const CAPTURE_UPLOAD_LIMITS: CaptureUploadLimits = {
  maxArtifacts: 20,
  budgetMs: 60_000,
  callTimeoutMs: 15_000,
  claimWaitMs: 20_000,
};
/** A send's timeout grows by one second per this many payload bytes (pro rata), so a large session file on a slow uplink is not cut at the handshake's limit. */
const SEND_BYTES_PER_EXTRA_SECOND = 64 * 1024;
const CLAIM_POLL_MS = 250;
const CLOSE_TIMEOUT_MS = 1_000;

/** The arguments of one `corpus_append` call. */
export interface CorpusAppendArgs {
  kind: CorpusArtifactKind;
  session_id: string;
  text: string;
}

/** One MCP session against the registered serve. */
export interface CaptureSession {
  /** One `corpus_append` round trip. Rejects on a transport failure. */
  call(args: CorpusAppendArgs): Promise<{ isError?: boolean; content?: unknown }>;
  close(): Promise<void>;
}

/** Opens the session. `signal` aborts its requests: the run fires it on a timeout and after it closes the session. */
export type CaptureConnect = (credential: CaptureCredential, signal: AbortSignal) => Promise<CaptureSession>;

export interface CaptureUploadOpts {
  /** The local corpus directory the capture hooks bank into. */
  dir: string;
  /** Transport. Default: the MCP SDK's streamable-HTTP client with the bearer header. Tests stub the round trip. */
  connect?: CaptureConnect;
  /** Loads the secret scanner. Default: the lazy secret-scan.ts import. */
  loadScanner?: () => Promise<HostScanner>;
  limits?: Partial<CaptureUploadLimits>;
}

type Counts = { sent: number; duplicate: number; pending: number; refused: number };

interface RunState {
  /** Null until the run has listed the corpus: an early exit counted nothing. */
  counts: Counts | null;
  reason?: string;
  rank: number;
  degraded: boolean;
}

/**
 * Which code a run's one heartbeat entry names when several things happened.
 * A stop comes first: the entry of its run is the only place the heartbeat
 * ever names it. Then what ended or skipped the whole run, then what happened
 * to one artifact.
 */
const RANK = { artifact: 1, run: 2, stop: 3 } as const;

/** Keep the code of the highest rank, and the first one noted at that rank. */
function note(run: RunState, code: string, rank: number, degraded = true): void {
  if (rank <= run.rank) return;
  run.reason = code;
  run.rank = rank;
  run.degraded = degraded;
}

interface UploadMarker {
  version: 1;
  status: 'sent' | 'refused';
  /** sha256 of the local file bytes read for the send this marker settles. */
  hash: string;
  size: number;
  mtime_ms: number;
  at: string;
  /** The refusal code, on a `refused` marker. */
  code?: string;
}

interface PendingArtifact {
  file: string;
  name: string;
  kind: CorpusArtifactKind;
  sessionId: string;
  mtimeMs: number;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '');

/**
 * The artifact's bytes with the size and mtime of the very file they came
 * from (one descriptor, so a concurrent rewrite cannot pair old bytes with
 * the new file's stat). Null when the file is gone or is not a plain file.
 */
function readArtifact(file: string): { bytes: Buffer; size: number; mtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? { bytes: readFileSync(fd), size: st.size, mtimeMs: st.mtimeMs } : null;
  } finally {
    closeSync(fd);
  }
}

function readMarker(file: string): UploadMarker | null {
  try {
    const m = JSON.parse(readFileSync(file + CAPTURE_UPLOAD_MARKER_SUFFIX, 'utf8')) as Partial<UploadMarker> | null;
    if (
      m && m.version === 1 && (m.status === 'sent' || m.status === 'refused') &&
      typeof m.hash === 'string' && /^[0-9a-f]{64}$/.test(m.hash) &&
      typeof m.size === 'number' && typeof m.mtime_ms === 'number'
    ) return m as UploadMarker;
  } catch {
    /* absent or torn: the artifact counts as unsent, and the host answers a repeat with `duplicate` */
  }
  return null;
}

function writeMarker(file: string, marker: UploadMarker): void {
  const path = file + CAPTURE_UPLOAD_MARKER_SUFFIX;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** True while the artifact still has the bytes its marker settled. Throws when those bytes cannot be read. */
function isSettled(file: string, st: { size: number; mtimeMs: number }, onFsError: (e: unknown) => void): boolean {
  const marker = readMarker(file);
  if (!marker) return false;
  if (st.size === marker.size && st.mtimeMs === marker.mtime_ms) return true;
  const read = readArtifact(file);
  if (!read || sha256(read.bytes) !== marker.hash) return false;
  // Same bytes under a new mtime (a resumed session that added nothing): refresh the cheap check.
  try {
    writeMarker(file, { ...marker, size: read.size, mtime_ms: read.mtimeMs });
  } catch (e) {
    onFsError(e); // settled either way: without the refresh the next run hashes the file again
  }
  return true;
}

function artifactKind(name: string): CorpusArtifactKind {
  return parseSegmentFileName(name) ? 'segment' : parseWbFileName(name) ? 'writeback' : 'session';
}

/**
 * Every corpus artifact with no marker for its current bytes, oldest first, so
 * a backlog is sent in the order it was banked. A name under the host
 * writer's `rc-<16 hex>-` namespace is never listed: `corpus_append` stored
 * it for a remote grant, so it is not this machine's session to forward.
 * `onFsError` gets an fs failure on one artifact; the listing goes on.
 */
function listPending(dir: string, onFsError: (e: unknown) => void): PendingArtifact[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  const present = new Set(names);
  const pending: PendingArtifact[] = [];
  for (const name of names) {
    if (!name.endsWith('.txt') || isRemoteNamespaced(name)) continue;
    const file = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(file);
    } catch (e) {
      if (isMissing(e)) continue; // reaped between the listing and the stat
      throw e;
    }
    // lstat: a symlink in the spool is never followed, so what is read is a regular file in this directory.
    if (!st.isFile()) continue;
    try {
      if (present.has(name + CAPTURE_UPLOAD_MARKER_SUFFIX) && isSettled(file, st, onFsError)) continue;
    } catch (e) {
      onFsError(e); // these bytes cannot be read (EACCES, EIO): the artifact is listed, so it counts as pending
    }
    pending.push({ file, name, kind: artifactKind(name), sessionId: corpusFileSessionId(name), mtimeMs: st.mtimeMs });
  }
  return pending.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
}

/** A registry code or reason as the serve spells it. The serve's answer is external input: anything else is not recorded. */
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const codeOf = (v: unknown): string | undefined => (typeof v === 'string' && CODE_RE.test(v) ? v : undefined);
const labelOf = (code: string, reason?: string): string => (reason && code.length + reason.length < 48 ? `${code}:${reason}` : code);

type Verdict =
  | { type: 'sent' }
  | { type: 'duplicate' }
  /** This artifact can never land: marked, not retried. */
  | { type: 'refused'; code: string }
  /** Retrying cannot heal it for these scopes: recorded once in the stop state. */
  | { type: 'stop'; scopes: CaptureStopScope[]; code: string; reason?: string }
  | { type: 'pending'; code: string };

/**
 * Read one `corpus_append` answer. The classes key on the codes the serve
 * returns (story-01's registry): a grant that lost the scope or the operation
 * stops the lane, as does a grant off the `default` source; `writeback_off`
 * stops writeback turns; a sweep bound to another source stops session files
 * and segments only; invalid input and the size cap refuse that one artifact.
 * Every other code leaves the artifact pending.
 */
function readVerdict(result: { isError?: boolean; content?: unknown }, bodyText: (content: unknown) => string): Verdict {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText(result.content));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: falls through to upload_error below */
  }
  if (result.isError !== true) {
    if (body?.status === 'stored') return { type: 'sent' };
    if (body?.status === 'duplicate') return { type: 'duplicate' };
    return { type: 'pending', code: 'upload_error' };
  }
  const code = codeOf(body?.code);
  const reason = codeOf(body?.reason);
  if (!code) return { type: 'pending', code: 'upload_error' };
  if (code === 'insufficient_scope' || code === 'unknown_tool') return { type: 'stop', scopes: ['lane'], code };
  if (code === 'writeback_off') return { type: 'stop', scopes: ['writeback'], code };
  if (code === 'source_not_ingestable' && reason === 'grant_source') return { type: 'stop', scopes: ['lane'], code, reason };
  if (code === 'source_not_ingestable' && reason === 'sweep_source') return { type: 'stop', scopes: ['session', 'segment'], code, reason };
  if (code === 'invalid_params' || code === 'payload_too_large') return { type: 'refused', code };
  return { type: 'pending', code: labelOf(code, reason) };
}

/** Reject after `ms` (a real timer race: an abort signal alone does not cover a stalled handshake), calling `onTimeout` first. */
function withTimeout<T>(ms: number, work: Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`upload timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** The MCP SDK's streamable-HTTP client with a static bearer header: the connect-probe.ts round trip, kept open for the batch. */
const sdkConnect: CaptureConnect = async (credential, signal) => {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const transport = new StreamableHTTPClientTransport(new URL(credential.mcp_url), {
    requestInit: { headers: { Authorization: `Bearer ${credential.access_token}` } },
    // The endpoint check (HTTPS, or HTTP on loopback) covers the stored URL
    // only, so no redirect is followed: a 307 or 308 would send the bearer
    // and the transcript again, to a URL nothing validated.
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  });
  // The transport installs its own abort signal over one passed in
  // requestInit, so the run's abort closes the transport instead, which
  // cancels its in-flight requests.
  signal.addEventListener('abort', () => { void transport.close().catch(() => { /* already closed */ }); }, { once: true });
  const client = new Client({ name: 'gbrain-capture-upload', version: '1' }, { capabilities: {} });
  const close = async () => {
    try { await client.close(); } catch { /* best effort: the run aborts the session's requests next */ }
  };
  try {
    await client.connect(transport);
  } catch (e) {
    await close();
    throw e;
  }
  return {
    call: async (args) => (await client.callTool({ name: 'corpus_append', arguments: { ...args } })) as { isError?: boolean; content?: unknown },
    close,
  };
};

/** Take the run claim, waiting up to `waitMs` for a live holder to finish. Null when it is still held. */
async function claimRun(dir: string, waitMs: number): Promise<PushLockHandle | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // The push lock's rule, keyed on the corpus directory: a holder is taken
    // over only when its pid is dead AND the claim is older than
    // PUSH_LOCK_STALE_MS; a live holder is never stolen.
    const lock = acquirePushLock(dir);
    if (lock.acquired) return lock.handle;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
  }
}

const TRANSPORT_CODES: Record<string, string> = {
  timeout: 'upload_timeout',
  auth: 'upload_auth',
  unreachable: 'upload_unreachable',
};

interface SendContext {
  credential: CaptureCredential;
  /** The identity of the credential file `credential` was read from (captureCredentialIdentity). */
  identity: string;
  /** The kinds this run still sends. A kind the host stops, or answers with a retryable refusal, is removed. */
  open: Set<CorpusArtifactKind>;
  home: string;
  opts: CaptureUploadOpts;
  limits: CaptureUploadLimits;
  run: RunState;
  counts: Counts;
  t0: number;
}

/**
 * Scan, send and mark the queue, inside the run's bounds. An artifact whose
 * bytes cannot be read, or whose scan throws, stays pending and the run goes
 * on. A marker that cannot be written ends the run's sends: what keeps one
 * marker from being written (a full disk, an unwritable spool) usually keeps
 * them all, so each further send would be one more artifact the run cannot
 * mark. The function throws only on an fs failure of the run itself (the
 * stop state).
 */
async function sendArtifacts(queue: PendingArtifact[], ctx: SendContext): Promise<void> {
  const { credential, identity, open, home, opts, limits, run, counts, t0 } = ctx;
  let scanner: HostScanner;
  try {
    scanner = await (opts.loadScanner ?? (() => import('../secret-scan.ts')))();
  } catch {
    return note(run, 'upload_skipped_unscanned', RANK.run); // fail closed: every artifact stays pending
  }
  const { classifyProbeError, resultBodyText } = await import('../connect-probe.ts');
  const transportCode = (e: unknown) =>
    TRANSPORT_CODES[classifyProbeError(e instanceof Error ? e.message : String(e))] ?? 'upload_error';
  const connect = opts.connect ?? sdkConnect;

  let live: { session: CaptureSession; abort: AbortController } | null = null;
  const closeSession = async () => {
    if (!live) return;
    const { session, abort } = live;
    live = null;
    try {
      await withTimeout(CLOSE_TIMEOUT_MS, session.close(), () => {});
    } catch {
      /* best effort: the abort below ends whatever the close left open */
    }
    abort.abort();
  };

  let attempts = 0;
  try {
    for (const artifact of queue) {
      if (!open.has(artifact.kind)) continue; // a kind closed earlier in this run
      if (attempts >= limits.maxArtifacts || Date.now() - t0 >= limits.budgetMs) break;
      let read: ReturnType<typeof readArtifact>;
      try {
        read = readArtifact(artifact.file);
      } catch (e) {
        // These bytes cannot be read (EACCES, EIO): the artifact stays pending and the ones banked after it still go.
        note(run, exceptionCode(e), RANK.artifact);
        continue;
      }
      if (!read) {
        counts.pending--; // reaped since the listing
        continue;
      }
      const { bytes, size, mtimeMs } = read;
      /**
       * Write the marker. False when it cannot be written: the artifact then
       * stays pending (a repeat of a stored one is answered `duplicate`), and
       * the caller ends the run's sends.
       */
      const settle = (status: UploadMarker['status'], code?: string): boolean => {
        try {
          writeMarker(artifact.file, {
            version: 1, status, hash: sha256(bytes), size, mtime_ms: mtimeMs,
            at: new Date().toISOString(), ...(code ? { code } : {}),
          });
        } catch (e) {
          note(run, exceptionCode(e), RANK.run);
          return false;
        }
        counts.pending--;
        return true;
      };

      let text: string;
      try {
        text = scanner.redactFindings(bytes.toString('utf8')).text;
      } catch {
        note(run, 'upload_skipped_unscanned', RANK.artifact); // nothing sent for this one; it stays pending
        continue;
      }
      const payloadBytes = Buffer.byteLength(text, 'utf8');
      if (payloadBytes > CORPUS_APPEND_MAX_TEXT_BYTES) {
        // The host's own cap, checked here so megabytes are not sent to be
        // refused: far enough past it the transport answers HTTP 413, not the
        // typed refusal.
        if (!settle('refused', 'payload_too_large')) break;
        counts.refused++;
        note(run, 'payload_too_large', RANK.artifact);
        continue;
      }

      if (captureCredentialIdentity(home) !== identity) {
        // The credential file was removed (teardown) or replaced (a new
        // registration) since this run read it: nothing more leaves under
        // the one it holds. The next run reads the file in place.
        note(run, 'upload_credential_changed', RANK.run);
        break;
      }
      // A send starts here, and only here does the artifact use one of the
      // run's attempts. Counted earlier, a batch of old artifacts that cannot
      // be read or scanned would use up every run, and nothing banked after
      // them would go until retention reaped them.
      attempts++;
      if (!live) {
        const abort = new AbortController();
        try {
          live = { session: await withTimeout(limits.callTimeoutMs, connect(credential, abort.signal), () => abort.abort()), abort };
        } catch (e) {
          // No session: the serve is unreachable or rejects the bearer, for every artifact alike.
          note(run, transportCode(e), RANK.run);
          break;
        }
      }
      let result: { isError?: boolean; content?: unknown };
      try {
        const sendTimeoutMs = limits.callTimeoutMs + Math.floor((payloadBytes * 1000) / SEND_BYTES_PER_EXTRA_SECOND);
        result = await withTimeout(
          sendTimeoutMs,
          live.session.call({ kind: artifact.kind, session_id: artifact.sessionId, text }),
          () => {},
        );
      } catch (e) {
        // This send failed; the next artifact gets a fresh session, so one
        // artifact that always fails cannot hold the ones banked after it.
        note(run, transportCode(e), RANK.artifact);
        await closeSession();
        continue;
      }

      const verdict = readVerdict(result, resultBodyText);
      if (verdict.type === 'sent' || verdict.type === 'duplicate') {
        if (!settle('sent')) break;
        counts[verdict.type]++;
      } else if (verdict.type === 'refused') {
        if (!settle('refused', verdict.code)) break;
        counts.refused++;
        note(run, verdict.code, RANK.artifact);
      } else if (verdict.type === 'stop') {
        recordCaptureStop(home, verdict.scopes, verdict, identity);
        note(run, labelOf(verdict.code, verdict.reason), RANK.stop);
        if (verdict.scopes.includes('lane')) break;
        for (const scope of verdict.scopes) open.delete(scope as CorpusArtifactKind);
      } else {
        // The serve answered and the artifact stays pending. The cause is the
        // host's, so every other artifact of this kind would get the same
        // answer: the kind waits for the next run (nothing is recorded),
        // and the run's attempts go to the other kinds.
        note(run, verdict.code, RANK.artifact);
        open.delete(artifact.kind);
      }
    }
  } finally {
    await closeSession();
  }
}

async function uploadPending(opts: CaptureUploadOpts, run: RunState, t0: number): Promise<void> {
  const limits = { ...CAPTURE_UPLOAD_LIMITS, ...opts.limits };
  const home = resolveGbrainHome();
  const claim = await claimRun(opts.dir, limits.claimWaitMs);
  if (!claim) return note(run, 'upload_busy', RANK.run, false);
  try {
    // Read under the claim: a run that waited sees the credential and the
    // stops as the holder (or a registration in between) left them. The
    // file's identity is taken BEFORE the read: should a registration land
    // between the two, the run holds an identity the file no longer has, so
    // it sends nothing and no stop it records is read.
    const identity = captureCredentialIdentity(home);
    const credential = identity ? readCaptureCredential(home) : null;
    if (!identity || !credential) return note(run, 'upload_no_credential', RANK.run);
    const open = new Set(openCaptureKinds(home));
    if (open.size === 0) return note(run, 'upload_stopped', RANK.run, false);
    const pending = listPending(opts.dir, (e) => note(run, exceptionCode(e), RANK.artifact));
    // `pending` counts every artifact still unsent when the run ends: failed,
    // past the run's bounds, or of a kind the host stopped.
    const counts: Counts = { sent: 0, duplicate: 0, pending: pending.length, refused: 0 };
    run.counts = counts;
    const queue = pending.filter((a) => open.has(a.kind));
    if (queue.length > 0) await sendArtifacts(queue, { credential, identity, open, home, opts, limits, run, counts, t0 });
  } finally {
    claim.release();
  }
}

/** A thrown failure as a code: the errno when there is one, else the error's class. Never its message. */
function exceptionCode(e: unknown): string {
  const errno = (e as NodeJS.ErrnoException | null)?.code;
  const name = typeof errno === 'string' && /^[A-Z0-9_]{1,24}$/.test(errno) ? errno : e instanceof Error ? e.constructor.name : typeof e;
  return /^[A-Za-z0-9_]{1,36}$/.test(name) ? `exception:${name}` : 'exception:unknown';
}

/**
 * One upload run. Never throws; appends exactly one heartbeat entry and
 * returns it.
 *
 *   claim the run (one at a time per machine; a dead holder's stale claim
 *   is taken over, a live one is waited for, then left alone)
 *         |
 *   read the credential and the stop state  -- rejected --> upload_no_credential
 *         |
 *   for each pending artifact, oldest first, until the run has started its
 *   count of sends or spent its time:
 *      read ---- bytes cannot be read ----------> stays pending, exception:<errno>
 *        |
 *      scan ---- scanner cannot run -----------> nothing sent, upload_skipped_unscanned
 *        |
 *      credential file still the one read? -- no --> the run ends, upload_credential_changed
 *        |
 *      send ---- timeout / unreachable / auth --> stays pending, code recorded
 *        |  \--- invalid_params, payload_too_large --> marked refused
 *        |  \--- writeback_off, source_not_ingestable,
 *        |       insufficient_scope, unknown_tool ---> that kind or the lane stops
 *        |  \--- any other code ----------------> stays pending, and its kind
 *        |                                         waits for the next run
 *        v
 *      stored | duplicate --> marker with the hash of the local bytes
 *                             (no marker written: stays pending, the run
 *                             sends nothing more, exception:<errno>)
 *         |
 *   one heartbeat entry: sent, duplicate, pending, refused and one code
 *
 * Four paths:
 *   happy          sendArtifacts: stored or duplicate, then the marker
 *   nil            no credential file, or a rejected one: upload_no_credential;
 *                  a missing corpus directory lists as empty
 *   empty          nothing pending: no scanner load, no connection, zero counts
 *   upstream error the transport catch blocks and readVerdict in sendArtifacts;
 *                  an fs failure of this run itself is the catch below
 */
export async function runCaptureUpload(opts: CaptureUploadOpts): Promise<HookHeartbeatEntry> {
  const t0 = Date.now();
  const run: RunState = { counts: null, rank: 0, degraded: false };
  let failure: string | undefined;
  try {
    await uploadPending(opts, run, t0);
  } catch (e) {
    failure = exceptionCode(e); // counts so far are kept; unmarked artifacts are sent again next run
  }
  const reason = failure ?? run.reason;
  const entry: HookHeartbeatEntry = {
    ts: new Date().toISOString(),
    event: CAPTURE_UPLOAD_EVENT,
    outcome: failure ? 'error' : run.degraded ? 'degraded' : 'ok',
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
    ...(run.counts ?? {}),
  };
  await writeHeartbeat(entry);
  return entry;
}

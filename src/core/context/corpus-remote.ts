/**
 * corpus-remote.ts: the host-side writer for remote session capture (#5577).
 * One redacted corpus artifact sent by an authenticated grant lands in the
 * host's session corpus directory under the file-name grammar the local hook
 * produces, so the sweep's corpus pass and dream synthesis read it unchanged.
 *
 * ENGINE-FREE, pure fs given a corpus dir (the corpus-segments.ts posture).
 * The `corpus_append` operation (ops/transcripts.ts) resolves the directory,
 * the grant's identity and the host's gates; this module validates the input,
 * namespaces the session id by the principal, stamps the seat, re-scans,
 * writes atomically and invalidates the sidecars.
 *
 * Isolation: the stored session id is `rc-<16 hex>-<client session id>`. The
 * hex is a hash of the verifier-derived principal (kind and id), never of
 * request data or the display name, and the prefix has a fixed length, so one
 * principal's names never equal another's. The caller never supplies a path:
 * every name is built from validated components and parsed back with the
 * sweep's own parsers, and must come back as exactly the requested kind,
 * namespaced id, hash and source.
 *
 * Source: only a grant on `default` captures (the operation refuses every
 * other one), so a writeback turn always names `.src-default` and every
 * sweep files it into `default`, whatever source that sweep ingests.
 *
 * Content address: the hash in a segment or writeback-turn name is computed
 * over the text the host stores after its own scan, so the name always
 * addresses the bytes on disk and a repeat of the same content maps to the
 * same name (duplicate, no second file, no second extraction).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  corpusFileSessionId,
  parseSegmentFileName,
  parseWbFileName,
  segmentFileName,
  segmentHash,
  wbFileName,
} from './corpus-segments.ts';
import { normalizeSeatLabel, writeSeatSidecar } from './seat.ts';

/** The artifact kinds a remote client sends: a session-end file, a checkpoint segment, a writeback turn. */
export const CORPUS_ARTIFACT_KINDS = ['session', 'segment', 'writeback'] as const;
export type CorpusArtifactKind = (typeof CORPUS_ARTIFACT_KINDS)[number];

/**
 * Size cap on `text`, in UTF-8 bytes (1.5 MiB). Measured on one host corpus
 * (3,887 files, 2026-10-07): the largest session file was 1,041,591 bytes,
 * the largest checkpoint segment 367,463 and the largest writeback turn
 * 8,101. JSON encoding at most doubles text without C0 control characters,
 * so a call carrying text just over this cap still fits the MCP transport's
 * 4 MiB request-body limit and gets the typed refusal instead of HTTP 413.
 */
export const CORPUS_APPEND_MAX_TEXT_BYTES = 1_572_864;

const NAMESPACE_PREFIX = 'rc-';
const NAMESPACE_HASH_LEN = 16;
/** The corpus-segments component cap (120) less the 20-character `rc-<16 hex>-` prefix. */
export const REMOTE_SESSION_ID_MAX = 100;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Completion and claim sidecars (sweep.ts CORPUS_INGESTED_SUFFIX / CORPUS_CLAIM_SUFFIX; duplicated to stay engine-free). */
const INGESTED_SUFFIX = '.ingested';
const CLAIM_SUFFIX = '.in-progress';

/** The durable, verifier-derived identity of the sending grant (`AuthInfo.principal`). */
export interface CorpusPrincipal {
  kind: string;
  id: string;
}

export interface CorpusArtifact {
  kind: CorpusArtifactKind;
  /** The client's own session id, validated (not yet namespaced). */
  sessionId: string;
  text: string;
}

export type CorpusArtifactRefusal =
  | { code: 'invalid_params'; field: 'kind' | 'session_id' | 'text'; problem: string }
  | { code: 'payload_too_large'; field: 'text'; bytes: number; cap: number }
  /** `error` is the scanner's own failure, for the server log only. */
  | { code: 'scan_unavailable'; error: unknown };

export type CorpusArtifactValidation =
  | { ok: true; artifact: CorpusArtifact }
  | { ok: false; refusal: CorpusArtifactRefusal };

function principalHash(principal: CorpusPrincipal): string {
  return createHash('sha256').update(`${principal.kind}\0${principal.id}`, 'utf8').digest('hex');
}

/** `rc-<16 hex>-`: the stored-id prefix every artifact of this principal carries. */
export function remoteSessionNamespace(principal: CorpusPrincipal): string {
  return `${NAMESPACE_PREFIX}${principalHash(principal).slice(0, NAMESPACE_HASH_LEN)}-`;
}

/**
 * The seat label for a grant: its display name made into a seat label
 * (lowercase, runs of other characters to `-`, at most 64 characters), or
 * `grant-<8 hex>` from the principal when the name is absent, normalizes to
 * nothing, or is the reserved `off`. Attribution only: two grants with the
 * same name share a label, never a namespace.
 */
export function remoteSeatLabel(clientName: string | undefined, principal: CorpusPrincipal): string {
  if (clientName) {
    const slug = clientName.trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 64)
      .replace(/-+$/, '');
    const label = normalizeSeatLabel(slug);
    if (label && label !== 'off') return label;
  }
  return `grant-${principalHash(principal).slice(0, 8)}`;
}

/**
 * Boundary validation, before any file is touched. Nothing is cut or
 * dropped: an id outside the corpus-safe set or over the component cap, and
 * text that is empty, not well-formed UTF-16 (so not encodable as UTF-8) or
 * over the cap, are refused with the field named. The caller's value is
 * never echoed.
 */
export function validateCorpusArtifact(raw: { kind?: unknown; session_id?: unknown; text?: unknown }): CorpusArtifactValidation {
  const refuse = (field: 'kind' | 'session_id' | 'text', problem: string): CorpusArtifactValidation =>
    ({ ok: false, refusal: { code: 'invalid_params', field, problem } });
  const { kind, session_id: sessionId, text } = raw;
  if (typeof kind !== 'string' || !(CORPUS_ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    return refuse('kind', `kind must be one of: ${CORPUS_ARTIFACT_KINDS.join(', ')}`);
  }
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || /^\.+$/.test(sessionId)) {
    return refuse('session_id', 'session_id must be letters, digits, dot, underscore or hyphen, and not dots only');
  }
  if (sessionId.length > REMOTE_SESSION_ID_MAX) {
    return refuse('session_id', `session_id must be at most ${REMOTE_SESSION_ID_MAX} characters`);
  }
  if (typeof text !== 'string' || !text.trim()) return refuse('text', 'text must be non-empty');
  if (!text.isWellFormed()) return refuse('text', 'text must be valid UTF-8 (it holds an unpaired surrogate)');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CORPUS_APPEND_MAX_TEXT_BYTES) {
    return { ok: false, refusal: { code: 'payload_too_large', field: 'text', bytes, cap: CORPUS_APPEND_MAX_TEXT_BYTES } };
  }
  return { ok: true, artifact: { kind: kind as CorpusArtifactKind, sessionId, text } };
}

/** The host scanner's one call this writer makes (secret-scan.ts `redactFindings`). */
export interface HostScanner {
  redactFindings(text: string): { text: string };
}

export interface WriteRemoteArtifactOpts {
  /** The corpus dir the sweep reads (created 0700 when absent). */
  dir: string;
  artifact: CorpusArtifact;
  principal: CorpusPrincipal;
  seatLabel: string;
  /** Test seam: loads the host scanner. Default: the lazy secret-scan.ts import. */
  loadScanner?: () => Promise<HostScanner>;
}

export type WriteRemoteArtifactResult =
  | { status: 'stored' | 'duplicate'; name: string; bytes: number }
  | { status: 'refused'; refusal: CorpusArtifactRefusal };

/** The source every uploaded writeback turn names; wbFileName omits `.src-` for it, so it is added here. */
const WRITEBACK_SOURCE = 'default';

function storedName(kind: CorpusArtifactKind, sessionId: string, hash: string): string {
  if (kind === 'segment') return segmentFileName(sessionId, hash);
  if (kind === 'writeback') return wbFileName(sessionId, hash).replace(/\.txt$/, `.src-${WRITEBACK_SOURCE}.txt`);
  return `${sessionId}.txt`;
}

/** True when the sweep's parsers read `name` back as exactly this kind, id, hash and source. */
function roundTrips(kind: CorpusArtifactKind, name: string, sessionId: string, hash: string): boolean {
  const seg = parseSegmentFileName(name);
  const wb = parseWbFileName(name);
  if (corpusFileSessionId(name) !== sessionId) return false;
  if (kind === 'session') return !seg && !wb;
  if (kind === 'segment') return !wb && seg?.hash === hash;
  return !seg && wb?.hash === hash && wb.sourceId === WRITEBACK_SOURCE;
}

/**
 * Write one validated artifact. Order mirrors the local hook: host scan
 * (nothing is written when the scanner cannot load), duplicate check, seat
 * sidecar BEFORE the corpus file, atomic tmp+rename at 0600, then (session
 * files only) removal of the `.ingested` and `.in-progress` sidecars so the
 * sweep ingests the new turns. A failure after the rename leaves a changed
 * file the sweep re-reads on its own. Throws only on an fs failure; a scanner
 * failure is a refusal that carries the error for the caller's server log.
 */
export async function writeRemoteCorpusArtifact(opts: WriteRemoteArtifactOpts): Promise<WriteRemoteArtifactResult> {
  const { dir, artifact, principal, seatLabel } = opts;
  const sessionId = `${remoteSessionNamespace(principal)}${artifact.sessionId}`;
  let stored: string;
  try {
    const scanner = await (opts.loadScanner ?? (() => import('../secret-scan.ts')))();
    stored = scanner.redactFindings(artifact.text).text;
  } catch (error) {
    return { status: 'refused', refusal: { code: 'scan_unavailable', error } };
  }
  const hash = segmentHash(stored);
  const name = storedName(artifact.kind, sessionId, hash);
  if (!roundTrips(artifact.kind, name, sessionId, hash)) {
    return {
      status: 'refused',
      refusal: { code: 'invalid_params', field: 'session_id', problem: `session_id would be read back as another kind of corpus file than ${artifact.kind}` },
    };
  }
  const bytes = Buffer.byteLength(stored, 'utf8');
  const file = join(dir, name);
  const duplicate = artifact.kind === 'session'
    ? existsSync(file) && readFileSync(file, 'utf8') === stored
    : existsSync(file) || existsSync(file + INGESTED_SUFFIX);
  if (duplicate) return { status: 'duplicate', name, bytes };

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // First seat wins: a later upload of the same session keeps the first label.
  writeSeatSidecar(dir, sessionId, { seat: seatLabel, seat_source: 'grant', reasons: [] }, { harness: 'remote', hookLane: 'corpus_append' });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, stored, { mode: 0o600 });
  renameSync(tmp, file);
  if (artifact.kind === 'session') {
    rmSync(file + INGESTED_SUFFIX, { force: true });
    rmSync(file + CLAIM_SUFFIX, { force: true });
  }
  return { status: 'stored', name, bytes };
}

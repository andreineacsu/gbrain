/**
 * capture-remote.ts: a registered machine's record of remote session capture
 * (#5577). Two small files under `<gbrain home>/capture-remote/`:
 *
 *   credentials.json  the serve's MCP URL and the bearer the upload sends:
 *                     0600, never a symlink, HTTPS unless loopback. Written
 *                     at registration and opened only by the detached upload
 *                     child (corpus-upload.ts). The capture hooks ask whether
 *                     it exists and never read it, so the bearer reaches no
 *                     command line, environment, log or heartbeat.
 *   state.json        what the host turned off: the whole lane, or one
 *                     artifact kind. Recorded once, by the upload run that
 *                     got the refusal, with the identity of the credential
 *                     file that run read; registering again clears it, and
 *                     a stop under any other credential file is not read.
 *
 * ENGINE-FREE, pure fs. `openCaptureKinds` is the capture hooks' one
 * question and costs a single lstat on a machine with no capture configured.
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSymlinks } from '../agent-install/state.ts';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { assertSecureEndpoint, readPrivateText } from '../harness/credentials.ts';
import { normalizeMcpUrl, validateToken } from '../mcp-registration.ts';
import { CORPUS_ARTIFACT_KINDS, type CorpusArtifactKind } from './corpus-remote.ts';

const CAPTURE_DIR = 'capture-remote';
const CREDENTIAL_FILE = 'credentials.json';
const STATE_FILE = 'state.json';

/** The serve a registered machine uploads to, and the static bearer of its grant. */
export interface CaptureCredential {
  version: 1;
  /** Normalized `<scheme>//<host>/mcp`. */
  mcp_url: string;
  access_token: string;
}

/** What a host refusal stops: every upload (`lane`) or one artifact kind. */
export type CaptureStopScope = 'lane' | CorpusArtifactKind;
const CAPTURE_STOP_SCOPES: readonly CaptureStopScope[] = ['lane', ...CORPUS_ARTIFACT_KINDS];

/** The serve's refusal that stopped a scope: its code, its reason when it sent one, and when. */
export interface CaptureStop {
  code: string;
  reason?: string;
  at: string;
  /** The identity (`captureCredentialIdentity`) of the credential file the refused run had read. */
  credential: string;
}
export type CaptureStops = Partial<Record<CaptureStopScope, CaptureStop>>;

/** A registry code or reason as the serve spells it; anything else is not recorded. */
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The credential file's fixed path under a gbrain home. */
export function captureCredentialPath(home: string): string {
  return join(home, CAPTURE_DIR, CREDENTIAL_FILE);
}

/** The stop state's fixed path under a gbrain home. */
export function captureStatePath(home: string): string {
  return join(home, CAPTURE_DIR, STATE_FILE);
}

/** Schema of the credential file. Throws a fixed message that never echoes the URL or the bearer. */
function validateCaptureCredential(value: unknown): CaptureCredential {
  if (!value || typeof value !== 'object') throw new Error('Invalid capture credential');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.mcp_url !== 'string' || typeof v.access_token !== 'string') {
    throw new Error('Unsupported or incomplete capture credential');
  }
  const url = normalizeMcpUrl(v.mcp_url);
  if (!url.ok) throw new Error('Invalid serve URL in the capture credential');
  assertSecureEndpoint(url.url);
  if (!validateToken(v.access_token).ok) throw new Error('Invalid bearer in the capture credential');
  return { version: 1, mcp_url: url.url, access_token: v.access_token };
}

/**
 * The credential, or null when the file is missing or rejected (a symlink at
 * or below the capture directory, a mode wider than 0600, an oversized file,
 * a URL that is neither HTTPS nor loopback HTTP, a malformed bearer). One
 * answer for all of them: the upload run sends nothing and records
 * `upload_no_credential`. The home is canonicalized first, so a home that
 * sits under a symlinked ancestor still reads.
 */
export function readCaptureCredential(home: string): CaptureCredential | null {
  try {
    return validateCaptureCredential(JSON.parse(readPrivateText(captureCredentialPath(realpathSync(home)))));
  } catch {
    return null;
  }
}

/**
 * Which credential file is in place: its inode and mtime, or null when there
 * is none. Registering replaces the file (tmp + rename), so the identity
 * changes even when the URL and the bearer do not. An upload run takes it
 * before it reads the credential and compares it before every send; a stop
 * is read back only under the identity it was recorded with.
 */
export function captureCredentialIdentity(home: string): string | null {
  try {
    const st = lstatSync(captureCredentialPath(home), { bigint: true });
    return `${st.ino}-${st.mtimeNs}`;
  } catch {
    return null; // no file in place, or one that cannot be reached: no credential to hold
  }
}

/**
 * Store the serve URL and bearer (0600, directory 0700, atomic) and clear the
 * stop state, so the next capture event uploads again even when the URL and
 * bearer are the ones already stored. Throws on an invalid credential, a
 * symlink in the managed path or an fs failure; the caller owns the rollback.
 * Returns the credential file's path.
 */
export function writeCaptureCredential(home: string, input: { mcp_url: string; access_token: string }): string {
  const credential = validateCaptureCredential({ version: 1, ...input });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(home);
  const target = captureCredentialPath(canonical);
  mkdirSync(join(canonical, CAPTURE_DIR), { recursive: true, mode: 0o700 });
  assertNoSymlinks(target);
  chmodSync(join(canonical, CAPTURE_DIR), 0o700);
  atomicWriteTextFile(target, `${JSON.stringify(credential, null, 2)}\n`, { forceMode: 0o600 });
  rmSync(captureStatePath(canonical), { force: true });
  return captureCredentialPath(home);
}

/**
 * The scopes the host stopped for the credential file in place. A missing,
 * unreadable or malformed state file reads as nothing stopped: the host
 * refuses the next upload again and the run records the stop again. A stop
 * recorded under another credential file is not read: the run that got it
 * had read a credential a registration has since replaced, so its refusal
 * says nothing about the one in place.
 */
export function readCaptureStops(home: string): CaptureStops {
  const stops: CaptureStops = {};
  const credential = captureCredentialIdentity(home);
  if (!credential) return stops;
  let state: { version?: unknown; stopped?: unknown } | null;
  try {
    state = JSON.parse(readFileSync(captureStatePath(home), 'utf8')) as { version?: unknown; stopped?: unknown } | null;
  } catch {
    return stops;
  }
  if (!state || typeof state !== 'object' || state.version !== 1 || !state.stopped || typeof state.stopped !== 'object') return stops;
  for (const scope of CAPTURE_STOP_SCOPES) {
    const entry = (state.stopped as Record<string, unknown>)[scope] as Partial<CaptureStop> | null | undefined;
    if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string' || !CODE_RE.test(entry.code)) continue;
    if (entry.credential !== credential) continue;
    stops[scope] = {
      code: entry.code,
      ...(typeof entry.reason === 'string' && CODE_RE.test(entry.reason) ? { reason: entry.reason } : {}),
      at: typeof entry.at === 'string' ? entry.at : '',
      credential,
    };
  }
  return stops;
}

/**
 * Record that the host stopped these scopes, stamped with `credential`: the
 * identity of the credential file the refused run had read. A scope already
 * stopped under the file in place keeps its first record. Called only by the
 * upload run that holds the run claim, so runs write one at a time; a
 * registration takes no claim, which is why the stamp exists: a stop written
 * after a registration cleared the state carries the replaced file's
 * identity and is never read. Throws on an fs failure.
 */
export function recordCaptureStop(
  home: string,
  scopes: readonly CaptureStopScope[],
  stop: { code: string; reason?: string },
  credential: string,
): void {
  const stopped = readCaptureStops(home);
  const at = new Date().toISOString();
  for (const scope of scopes) {
    stopped[scope] ??= { code: stop.code, ...(stop.reason ? { reason: stop.reason } : {}), at, credential };
  }
  atomicWriteTextFile(captureStatePath(home), `${JSON.stringify({ version: 1, stopped }, null, 2)}\n`, { forceMode: 0o600 });
}

/**
 * The artifact kinds this machine can still upload: none when no credential
 * file is present (capture is not configured) or the host stopped the lane,
 * else every kind the host has not stopped. A credential file that is present
 * but would be rejected still counts as present, so the upload run starts and
 * records why it sent nothing. Never throws.
 */
export function openCaptureKinds(home: string): CorpusArtifactKind[] {
  try {
    lstatSync(captureCredentialPath(home));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    // Any other failure leaves the file possibly present: the upload run decides.
  }
  const stopped = readCaptureStops(home);
  return stopped.lane ? [] : CORPUS_ARTIFACT_KINDS.filter((kind) => !stopped[kind]);
}

/**
 * #5577 remote session capture: the registered machine's upload run
 * (src/core/context/corpus-upload.ts), over a temp gbrain home and corpus.
 *
 * Two layers:
 *   - a stubbed MCP session (the `connect` option), for the cases a real
 *     serve cannot be made to produce on demand: every refusal class, a
 *     stalled or refused connection, a rewrite during a send, concurrency;
 *   - the default SDK transport against `gbrain serve --http` on a loopback
 *     port, so the codes the classifier keys on are the ones the serve
 *     really returns, and an upload really lands in the host's corpus.
 *
 * Protects: an artifact is sent once and only after the local scan; a failed
 * send stays pending for the next run; a refusal retrying cannot heal stops
 * that artifact, kind or lane and is recorded once; two runs never send the
 * same artifact twice; each run writes one heartbeat entry of counts and
 * codes, never text or the bearer; only this machine's own sessions leave,
 * to the registered URL alone, under the credential file still in place.
 * Fails when: a marker is keyed on the redacted payload, a settled artifact
 * is sent again, an unscanned artifact leaves, a stopped kind keeps being
 * sent, the bearer, a session id or session text reaches the heartbeat, a
 * remote grant's artifact is forwarded, a redirect is followed, a run keeps
 * sending under a credential that was removed or replaced, a refusal on old
 * artifacts, or old artifacts that cannot be read or scanned, keep newer
 * ones from going, a run keeps sending into a spool it cannot mark, or a
 * stop from a replaced credential closes the lane.
 * Why new: no test exercised a client-side caller of corpus_append;
 * test/session-capture-operation.test.ts owns the serve side.
 * Seam: `connect` and `loadScanner`; the hook command passes neither.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_UPLOAD_LIMITS,
  CAPTURE_UPLOAD_MARKER_SUFFIX,
  runCaptureUpload,
  type CaptureConnect,
  type CaptureUploadOpts,
  type CorpusAppendArgs,
} from '../src/core/context/corpus-upload.ts';
import {
  captureCredentialIdentity, captureCredentialPath, captureStatePath, openCaptureKinds, readCaptureStops, recordCaptureStop, writeCaptureCredential,
} from '../src/core/context/capture-remote.ts';
import { CORPUS_APPEND_MAX_TEXT_BYTES, remoteSessionNamespace, type CorpusArtifactKind } from '../src/core/context/corpus-remote.ts';
import { HEARTBEAT_ALLOWED_KEYS, heartbeatPath, readHeartbeatTail, type HookHeartbeatEntry } from '../src/core/context/hook-heartbeat.ts';
import { PUSH_LOCK_STALE_MS, pushLockDir } from '../src/core/workspace-push.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { clientCredentialsToken, legacyToken, ownerCookie, startServeHttp, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';

const BEARER = 'gbrain_at_synthetic-capture-bearer';
const SID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SECRET = 'sk-' + 'FAKEfakeFAKEfake1234567890';
// Root ignores file modes, so a permission failure cannot be arranged there.
const noFileModes = process.platform === 'win32' || process.getuid?.() === 0;

let root: string;
let gbHome: string;
let corpus: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gb-upload-'));
  gbHome = join(root, '.gbrain');
  corpus = join(gbHome, 'transcripts', 'corpus');
  mkdirSync(corpus, { recursive: true, mode: 0o700 });
  writeCaptureCredential(gbHome, { mcp_url: 'https://brain.example/mcp', access_token: BEARER });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Every test body runs with the temp home as the gbrain home (heartbeat, run claim, credential). */
const inHome = <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  (...args: A) => withEnv({ GBRAIN_HOME: root, GBRAIN_SOURCE: undefined }, () => fn(...args));

const hex = (n: number) => n.toString(16).padStart(24, '0');
const segName = (n: number, sid = SID) => `${sid}.seg-${hex(n)}.txt`;
const wbName = (n: number, sid = SID) => `${sid}.wb-${hex(n)}.txt`;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Bank one artifact as the hooks would, `ageSeconds` old (older artifacts are sent first). */
function bank(name: string, text: string, ageSeconds = 0): string {
  const file = join(corpus, name);
  writeFileSync(file, text, { mode: 0o600 });
  const at = Date.now() / 1000 - ageSeconds;
  utimesSync(file, at, at);
  return file;
}

/** A session file (oldest), a writeback turn and a segment (newest). */
function bankOneOfEach(): void {
  bank(`${SID}.txt`, '[user]\nsession text', 30);
  bank(wbName(1), 'I prefer tea\n', 20);
  bank(segName(2), '[user]\nwindow text', 10);
}

const ok = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const stored = () => ok({ status: 'stored', kind: 'session', bytes: 1 });
const refusal = (code: string, reason?: string) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: code, code, ...(reason ? { reason } : {}), message: 'synthetic refusal', retryable: false }) }],
});

interface Stub {
  connect: CaptureConnect;
  calls: CorpusAppendArgs[];
  connects: number;
  closes: number;
  credentials: unknown[];
}

/** A stubbed MCP session. `answer` returns the tool result, or an Error to reject the call with. */
function stub(answer: (args: CorpusAppendArgs, n: number) => unknown = stored, connecting?: () => Promise<void>): Stub {
  const s: Stub = {
    calls: [], connects: 0, closes: 0, credentials: [],
    connect: async (credential) => {
      s.connects++;
      s.credentials.push(credential);
      await connecting?.();
      return {
        call: async (args) => {
          s.calls.push(args);
          const result = await answer(args, s.calls.length);
          if (result instanceof Error) throw result;
          return result as { isError?: boolean; content?: unknown };
        },
        close: async () => { s.closes++; },
      };
    },
  };
  return s;
}

const run = (s: Stub, over: Partial<CaptureUploadOpts> = {}) =>
  runCaptureUpload({ dir: corpus, connect: s.connect, ...over, limits: { claimWaitMs: 0, ...over.limits } });

const beats = async () => (await readHeartbeatTail(200)).filter((e) => e.event === 'capture-upload');
const counts = (e: HookHeartbeatEntry) => ({ sent: e.sent, duplicate: e.duplicate, pending: e.pending, refused: e.refused });
const marker = (name: string) => JSON.parse(readFileSync(join(corpus, name + CAPTURE_UPLOAD_MARKER_SUFFIX), 'utf8')) as Record<string, unknown>;
const markers = () => readdirSync(corpus).filter((n) => n.endsWith(CAPTURE_UPLOAD_MARKER_SUFFIX)).sort();

describe('sends each pending artifact once', () => {
  test('a backlog goes out oldest first in bounded batches, and a settled corpus opens no connection', inHome(async () => {
    const total = CAPTURE_UPLOAD_LIMITS.maxArtifacts + 5;
    for (let i = 0; i < total; i++) bank(segName(i), `window ${i}`, total - i);
    const s = stub();

    const first = await run(s);
    expect(counts(first)).toEqual({ sent: CAPTURE_UPLOAD_LIMITS.maxArtifacts, duplicate: 0, pending: 5, refused: 0 });
    expect(first.outcome).toBe('ok');
    expect(first.reason).toBeUndefined();
    expect(s.calls.map((c) => c.text)).toEqual(Array.from({ length: CAPTURE_UPLOAD_LIMITS.maxArtifacts }, (_, i) => `window ${i}`));
    expect(s.connects).toBe(1);
    expect(s.closes).toBe(1);

    const second = await run(s);
    expect(counts(second)).toEqual({ sent: 5, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls).toHaveLength(total);

    const third = await run(s);
    expect(counts(third)).toEqual({ sent: 0, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls).toHaveLength(total);
    expect(s.connects).toBe(2);
    expect(await beats()).toHaveLength(3);
  }));

  type Spoil = (file: string) => void;
  test.each<[string, Spoil, string]>([
    ['cannot be scanned', () => {}, 'upload_skipped_unscanned'],
    ...(noFileModes ? [] : [['cannot be read', (file) => chmodSync(file, 0o000), 'exception:EACCES'] as [string, Spoil, string]]),
  ])("a full batch of old artifacts that %s uses none of the run's attempts: the ones banked after them still go", inHome(async (_label, spoil, reason) => {
    const batch = CAPTURE_UPLOAD_LIMITS.maxArtifacts;
    for (let i = 0; i < batch; i++) spoil(bank(segName(i), 'a window the scanner throws on', 100 + batch - i));
    bank(`${SID}.txt`, 'session text', 20);
    bank(wbName(batch), 'I prefer tea\n', 10);
    const s = stub();
    const entry = await run(s, {
      loadScanner: async () => ({
        redactFindings: (text: string) => { if (text.includes('scanner throws')) throw new Error('synthetic scan failure'); return { text }; },
      }),
    });
    expect(s.calls.map((c) => c.kind)).toEqual(['session', 'writeback']);
    expect(entry).toMatchObject({ outcome: 'degraded', reason, sent: 2, duplicate: 0, pending: batch, refused: 0 });
  }));

  test.each(['stored', 'duplicate'] as const)('a %s answer writes a marker holding the hash of the local bytes', inHome(async (status) => {
    const text = '[user]\nsession text';
    bank(`${SID}.txt`, text);
    const s = stub(() => ok({ status, kind: 'session', bytes: text.length }));
    const entry = await run(s);
    expect(counts(entry)).toEqual({ sent: status === 'stored' ? 1 : 0, duplicate: status === 'duplicate' ? 1 : 0, pending: 0, refused: 0 });
    expect(marker(`${SID}.txt`)).toMatchObject({ version: 1, status: 'sent', hash: sha256(text), size: Buffer.byteLength(text) });
    expect(statSync(join(corpus, `${SID}.txt${CAPTURE_UPLOAD_MARKER_SUFFIX}`)).mode & 0o777).toBe(0o600);
    await run(s);
    expect(s.calls).toHaveLength(1);
  }));

  test('the session uses the stored URL and bearer, and each artifact is sent as its kind under its own session id', inHome(async () => {
    bank(`${SID}.txt`, 'session', 40);
    bank(segName(7), 'segment', 30);
    bank(wbName(8), 'turn\n', 20);
    bank(`${SID}.wb-${hex(9)}.src-team-a.txt`, 'turn in a client source\n', 10);
    const s = stub();
    await run(s);
    expect(s.credentials).toEqual([{ version: 1, mcp_url: 'https://brain.example/mcp', access_token: BEARER }]);
    expect(s.calls).toEqual([
      { kind: 'session', session_id: SID, text: 'session' },
      { kind: 'segment', session_id: SID, text: 'segment' },
      { kind: 'writeback', session_id: SID, text: 'turn\n' },
      { kind: 'writeback', session_id: SID, text: 'turn in a client source\n' },
    ]);
  }));

  test('a session file a resumed session rewrote is sent again; the same bytes under a new mtime are not', inHome(async () => {
    const file = bank(`${SID}.txt`, 'first pass', 60);
    const s = stub();
    await run(s);
    // Same bytes, new mtime: settled by the hash, and the marker's cheap check is refreshed.
    utimesSync(file, Date.now() / 1000 - 30, Date.now() / 1000 - 30);
    expect(counts(await run(s))).toEqual({ sent: 0, duplicate: 0, pending: 0, refused: 0 });
    expect(marker(`${SID}.txt`).mtime_ms).toBe(statSync(file).mtimeMs);
    expect(s.calls).toHaveLength(1);

    bank(`${SID}.txt`, 'first pass\n\nresumed pass');
    expect(counts(await run(s))).toEqual({ sent: 1, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls.map((c) => c.text)).toEqual(['first pass', 'first pass\n\nresumed pass']);
    expect(marker(`${SID}.txt`).hash).toBe(sha256('first pass\n\nresumed pass'));
  }));

  test('a rewrite while the old content is in flight leaves the new content pending', inHome(async () => {
    bank(`${SID}.txt`, 'content in flight', 60);
    const s = stub((_args, n) => {
      if (n === 1) bank(`${SID}.txt`, 'content written during the send');
      return stored();
    });
    await run(s);
    expect(marker(`${SID}.txt`).hash).toBe(sha256('content in flight'));
    const next = await run(s);
    expect(counts(next)).toEqual({ sent: 1, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls.map((c) => c.text)).toEqual(['content in flight', 'content written during the send']);
  }));

  test('a symlink in the corpus directory is never followed', inHome(async () => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'a file the hooks did not bank');
    symlinkSync(outside, join(corpus, 'linked.txt'));
    const s = stub();
    expect(counts(await run(s))).toEqual({ sent: 0, duplicate: 0, pending: 0, refused: 0 });
    expect(s.connects).toBe(0);
  }));

  test('what corpus_append stored for a remote grant is never listed: a host that is also a capture client forwards its own sessions only', inHome(async () => {
    // The names the host writer gives another grant's session file, segment and writeback turn.
    const theirs = `${remoteSessionNamespace({ kind: 'oauth_client', id: 'synthetic-other-grant' })}${SID}`;
    bank(`${theirs}.txt`, 'a session another grant uploaded', 50);
    bank(segName(1, theirs), 'a window another grant uploaded', 40);
    bank(`${theirs}.wb-${hex(2)}.src-default.txt`, 'a turn another grant uploaded\n', 30);
    // `rc-` without the 16-hex principal hash is an ordinary local session id.
    bank('rc-notes.txt', 'a local session whose id starts with rc-', 20);
    bank(`${SID}.txt`, 'a local session', 10);
    const s = stub();
    expect(counts(await run(s))).toEqual({ sent: 2, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls.map((c) => c.session_id)).toEqual(['rc-notes', SID]);
    expect(markers()).toEqual([`${SID}.txt`, 'rc-notes.txt'].map((n) => n + CAPTURE_UPLOAD_MARKER_SUFFIX));
  }));

  test('a run stops starting sends once its time budget is spent', inHome(async () => {
    bankOneOfEach();
    // The first send outlasts the whole budget, so the run starts no second one.
    const s = stub(async () => { await new Promise((r) => setTimeout(r, 1_100)); return stored(); });
    const entry = await run(s, { limits: { budgetMs: 1_000 } });
    expect(counts(entry)).toEqual({ sent: 1, duplicate: 0, pending: 2, refused: 0 });
    expect(entry.outcome).toBe('ok');
  }));

  test('the time budget also ends a run on an artifact that never reaches a send, which uses none of its attempts', inHome(async () => {
    bankOneOfEach();
    // The oldest artifact's scan outlasts the whole budget and throws; the two after it would scan and send.
    let scans = 0;
    const entry = await run(stub(), {
      limits: { budgetMs: 1_000 },
      loadScanner: async () => ({
        redactFindings: (text: string) => {
          if (++scans > 1) return { text };
          Bun.sleepSync(1_100);
          throw new Error('synthetic scan failure');
        },
      }),
    });
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_skipped_unscanned', sent: 0, duplicate: 0, pending: 3, refused: 0 });
    // The run took up no further artifact: the other two were not even read.
    expect(scans).toBe(1);
  }));
});

describe('scan before anything leaves', () => {
  test('a vendor-prefixed secret is sent redacted, and the marker still addresses the local bytes', inHome(async () => {
    const text = `[user]\nmy key is ${SECRET}, keep it`;
    bank(`${SID}.txt`, text);
    const s = stub();
    await run(s);
    expect(s.calls[0]!.text).not.toContain(SECRET);
    expect(s.calls[0]!.text).toContain('<REDACTED:openai>');
    expect(marker(`${SID}.txt`).hash).toBe(sha256(text));
    expect(marker(`${SID}.txt`).hash).not.toBe(sha256(s.calls[0]!.text));
  }));

  test('with no scanner the session is never opened and every artifact stays pending', inHome(async () => {
    bankOneOfEach();
    const s = stub();
    const entry = await run(s, { loadScanner: async () => { throw new Error('synthetic: scanner module missing'); } });
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_skipped_unscanned', sent: 0, pending: 3 });
    expect(s.connects).toBe(0);
    expect(markers()).toEqual([]);
    // The next run, with a scanner, sends them.
    expect(counts(await run(s))).toEqual({ sent: 3, duplicate: 0, pending: 0, refused: 0 });
  }));

  test('a scan that throws on one artifact sends nothing for it and still sends the others', inHome(async () => {
    bankOneOfEach();
    const s = stub();
    const entry = await run(s, {
      loadScanner: async () => ({
        redactFindings: (text: string) => { if (text.includes('window text')) throw new Error('synthetic scan failure'); return { text }; },
      }),
    });
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_skipped_unscanned', sent: 2, pending: 1 });
    expect(s.calls.map((c) => c.kind)).toEqual(['session', 'writeback']);
    expect(markers()).not.toContain(segName(2) + CAPTURE_UPLOAD_MARKER_SUFFIX);
  }));

  test('an artifact over the host cap is refused here, never sent and not tried again', inHome(async () => {
    bank(`${SID}.txt`, 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 1), 20);
    bank(segName(1), 'small window', 10);
    const s = stub();
    const entry = await run(s);
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'payload_too_large', sent: 1, pending: 0, refused: 1 });
    expect(s.calls.map((c) => c.kind)).toEqual(['segment']);
    expect(marker(`${SID}.txt`)).toMatchObject({ status: 'refused', code: 'payload_too_large' });
    const again = await run(s);
    expect(again.reason).toBeUndefined();
    expect(counts(again)).toEqual({ sent: 0, duplicate: 0, pending: 0, refused: 0 });
  }));
});

describe('refusal classes', () => {
  // The queue is a session file, then a writeback turn, then a segment.
  const refuse = (kind: string, answer: unknown) => (args: CorpusAppendArgs) => (args.kind === kind ? answer : stored());
  const ALL: CorpusArtifactKind[] = ['session', 'segment', 'writeback'];
  const cases: Array<{
    name: string;
    answer: (args: CorpusAppendArgs) => unknown;
    /** The heartbeat code. */
    reason: string;
    /** The kinds the run called the serve for, in order. */
    sent: CorpusArtifactKind[];
    counts: { sent: number; duplicate: number; pending: number; refused: number };
    /** The kinds still open afterwards. */
    open: CorpusArtifactKind[];
    refusedMarker?: string;
  }> = [
    {
      name: 'insufficient_scope stops the lane', answer: () => refusal('insufficient_scope'),
      reason: 'insufficient_scope', sent: ['session'], counts: { sent: 0, duplicate: 0, pending: 3, refused: 0 }, open: [],
    },
    {
      name: 'unknown_tool stops the lane', answer: () => refusal('unknown_tool'),
      reason: 'unknown_tool', sent: ['session'], counts: { sent: 0, duplicate: 0, pending: 3, refused: 0 }, open: [],
    },
    {
      name: 'source_not_ingestable with grant_source stops the lane', answer: () => refusal('source_not_ingestable', 'grant_source'),
      reason: 'source_not_ingestable:grant_source', sent: ['session'], counts: { sent: 0, duplicate: 0, pending: 3, refused: 0 }, open: [],
    },
    {
      name: 'source_not_ingestable with sweep_source stops session files and segments, and writeback turns still land',
      answer: refuse('session', refusal('source_not_ingestable', 'sweep_source')),
      reason: 'source_not_ingestable:sweep_source', sent: ['session', 'writeback'], counts: { sent: 1, duplicate: 0, pending: 2, refused: 0 }, open: ['writeback'],
    },
    {
      name: 'source_not_ingestable with no reason stops nothing', answer: refuse('session', refusal('source_not_ingestable')),
      reason: 'source_not_ingestable', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
    {
      name: 'writeback_off stops writeback turns only', answer: refuse('writeback', refusal('writeback_off')),
      reason: 'writeback_off', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ['session', 'segment'],
    },
    {
      name: 'invalid_params refuses that one artifact', answer: refuse('session', refusal('invalid_params')),
      reason: 'invalid_params', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 0, refused: 1 }, open: ALL,
      refusedMarker: `${SID}.txt`,
    },
    {
      name: 'payload_too_large refuses that one artifact', answer: refuse('segment', refusal('payload_too_large')),
      reason: 'payload_too_large', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 0, refused: 1 }, open: ALL,
      refusedMarker: segName(2),
    },
    {
      name: 'a retryable host refusal leaves the artifact pending', answer: refuse('writeback', refusal('writeback_gate_unresolved', 'plane_drift')),
      reason: 'writeback_gate_unresolved:plane_drift', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
    {
      name: 'a code this client does not know leaves the artifact pending', answer: refuse('session', refusal('storage_error')),
      reason: 'storage_error', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
    {
      name: 'an error whose code is not a code is recorded as upload_error, never echoed',
      answer: refuse('session', { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'Session said: my private phrase', message: 'x' }) }] }),
      reason: 'upload_error', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
    {
      name: 'an error body that is not JSON leaves the artifact pending', answer: refuse('session', { isError: true, content: [{ type: 'text', text: 'Bad Gateway' }] }),
      reason: 'upload_error', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
    {
      name: 'a success with no stored or duplicate status is not taken as sent', answer: refuse('session', ok({ status: 'accepted' })),
      reason: 'upload_error', sent: ['session', 'writeback', 'segment'], counts: { sent: 2, duplicate: 0, pending: 1, refused: 0 }, open: ALL,
    },
  ];

  test.each(cases)('$name', inHome(async (c) => {
    bankOneOfEach();
    const s = stub(c.answer);
    const entry = await run(s);
    expect(entry.outcome).toBe('degraded');
    expect(entry.reason).toBe(c.reason);
    expect(counts(entry)).toEqual(c.counts);
    expect(s.calls.map((call) => call.kind)).toEqual(c.sent);
    expect(openCaptureKinds(gbHome).sort()).toEqual([...c.open].sort());
    if (c.refusedMarker) expect(marker(c.refusedMarker)).toMatchObject({ status: 'refused', code: c.reason });
    expect(markers()).toHaveLength(c.counts.sent + c.counts.refused);
    const written = await beats();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ outcome: 'degraded', reason: c.reason, ...c.counts });
  }));

  test.each<[string, unknown, string]>([
    ['writeback_gate_unresolved', refusal('writeback_gate_unresolved', 'plane_drift'), 'writeback_gate_unresolved:plane_drift'],
    ['storage_error', refusal('storage_error'), 'storage_error'],
    ['an answer this client cannot read', { isError: true, content: [{ type: 'text', text: 'Bad Gateway' }] }, 'upload_error'],
  ])("after %s for a kind's oldest artifact, the rest of that kind waits for the next run and the newer artifacts of other kinds still go", inHome(async (_label, answer, reason) => {
    // More turns than one run attempts, every one older than the session file and the segment.
    const turns = CAPTURE_UPLOAD_LIMITS.maxArtifacts + 2;
    for (let i = 0; i < turns; i++) bank(wbName(i), `turn ${i}\n`, 100 + turns - i);
    bank(`${SID}.txt`, 'session text', 20);
    bank(segName(1), 'window text', 10);
    const s = stub((args) => (args.kind === 'writeback' ? answer : stored()));

    const entry = await run(s);
    expect(s.calls.map((c) => c.kind)).toEqual(['writeback', 'session', 'segment']);
    expect(entry).toMatchObject({ outcome: 'degraded', reason, sent: 2, duplicate: 0, pending: turns, refused: 0 });
    // Nothing is recorded: the kind is open again for the next run, which asks once more.
    expect(readCaptureStops(gbHome)).toEqual({});
    expect(openCaptureKinds(gbHome)).toHaveLength(3);
    const again = await run(s);
    expect(s.calls.slice(3).map((c) => c.text)).toEqual(['turn 0\n']);
    expect(again).toMatchObject({ reason, sent: 0, pending: turns });
  }));

  test('the entry of the run that got a stop names the stop, even when the connection is lost afterwards', inHome(async () => {
    bankOneOfEach();
    bank(segName(3), 'a newer window');
    let connects = 0;
    const s = stub(
      (args) => (args.kind === 'writeback' ? refusal('writeback_off') : args.text === '[user]\nwindow text' ? new Error('fetch failed') : stored()),
      async () => { if (++connects > 1) throw new Error('fetch failed: ECONNREFUSED'); },
    );
    const entry = await run(s);
    // session stored, writeback stopped, one segment's send failed, and the reconnect for the last one was refused.
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'writeback_off', sent: 1, pending: 3 });
    expect(s.connects).toBe(2);
  }));

  test('a stopped lane is recorded once: the stop names the refusal, and a later run sends nothing and repeats no code', inHome(async () => {
    bankOneOfEach();
    await run(stub(() => refusal('insufficient_scope')));
    expect(readCaptureStops(gbHome).lane).toMatchObject({ code: 'insufficient_scope' });
    const later = stub();
    const entry = await run(later);
    expect(entry).toMatchObject({ outcome: 'ok', reason: 'upload_stopped' });
    expect(entry.pending).toBeUndefined();
    expect(later.connects).toBe(0);
    expect((await beats()).map((e) => e.reason)).toEqual(['insufficient_scope', 'upload_stopped']);
  }));

  test('a stopped kind is recorded once: later runs skip it, name no code, and still count it as unsent', inHome(async () => {
    bankOneOfEach();
    await run(stub((args) => (args.kind === 'writeback' ? refusal('writeback_off') : stored())));
    expect(readCaptureStops(gbHome)).toMatchObject({ writeback: { code: 'writeback_off' } });
    bank(wbName(5), 'another turn\n');
    const later = stub();
    const entry = await run(later);
    expect(entry.outcome).toBe('ok');
    expect(entry.reason).toBeUndefined();
    expect(counts(entry)).toEqual({ sent: 0, duplicate: 0, pending: 2, refused: 0 });
    expect(later.connects).toBe(0);
  }));

  test('registering again reopens a stopped kind, and its artifacts go out', inHome(async () => {
    bankOneOfEach();
    await run(stub((args) => (args.kind === 'writeback' ? refusal('writeback_off') : stored())));
    writeCaptureCredential(gbHome, { mcp_url: 'https://brain.example/mcp', access_token: BEARER });
    const s = stub();
    expect(counts(await run(s))).toEqual({ sent: 1, duplicate: 0, pending: 0, refused: 0 });
    expect(s.calls.map((c) => c.kind)).toEqual(['writeback']);
  }));

  test('a lane stop that comes back after a registration replaced the credential the run had read does not stop the new registration', inHome(async () => {
    bankOneOfEach();
    // The registration (same URL and bearer) lands while the first send is in flight; that send's refusal comes back after it.
    const stale = stub(() => {
      writeCaptureCredential(gbHome, { mcp_url: 'https://brain.example/mcp', access_token: BEARER });
      return refusal('insufficient_scope');
    });
    await run(stale);
    expect(stale.calls).toHaveLength(1);
    expect(readCaptureStops(gbHome)).toEqual({});
    expect(openCaptureKinds(gbHome)).toHaveLength(3);
    expect(counts(await run(stub()))).toEqual({ sent: 3, duplicate: 0, pending: 0, refused: 0 });
  }));

  test('a refused artifact is not sent again until its file changes', inHome(async () => {
    bank(`${SID}.txt`, 'refused content');
    const s = stub((_args, n) => (n === 1 ? refusal('invalid_params') : stored()));
    await run(s);
    await run(s);
    expect(s.calls).toHaveLength(1);
    bank(`${SID}.txt`, 'new content');
    expect(counts(await run(s))).toEqual({ sent: 1, duplicate: 0, pending: 0, refused: 0 });
    expect(marker(`${SID}.txt`)).toMatchObject({ status: 'sent', hash: sha256('new content') });
  }));
});

describe('transport failures', () => {
  test.each([
    ['a refused connection', () => Promise.reject(new Error('fetch failed: ECONNREFUSED 127.0.0.1:1')), 'upload_unreachable'],
    ['a rejected bearer', () => Promise.reject(new Error('Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}')), 'upload_auth'],
    ['a handshake that never answers', () => new Promise<void>(() => {}), 'upload_timeout'],
    ['a failure this client cannot name', () => Promise.reject(new Error('synthetic protocol mismatch')), 'upload_error'],
  ] as const)('%s leaves every artifact pending, and the next run sends them', inHome(async (_label, connecting, code) => {
    bankOneOfEach();
    const down = stub(stored, connecting);
    const entry = await run(down, { limits: { callTimeoutMs: 40 } });
    expect(entry).toMatchObject({ outcome: 'degraded', reason: code, sent: 0, duplicate: 0, pending: 3, refused: 0 });
    expect(down.connects).toBe(1);
    expect(down.calls).toEqual([]);
    expect(markers()).toEqual([]);
    expect(openCaptureKinds(gbHome)).toHaveLength(3);
    expect(await beats()).toHaveLength(1);

    const up = stub();
    expect(counts(await run(up))).toEqual({ sent: 3, duplicate: 0, pending: 0, refused: 0 });
  }));

  test('a send that times out is left pending and does not hold the artifacts banked after it', inHome(async () => {
    bankOneOfEach();
    const s = stub((args) => (args.kind === 'session' ? new Promise(() => {}) : stored()));
    const entry = await run(s, { limits: { callTimeoutMs: 40 } });
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_timeout', sent: 2, pending: 1 });
    expect(s.calls.map((c) => c.kind)).toEqual(['session', 'writeback', 'segment']);
    // The failed send's session was dropped; the next artifact got a fresh one.
    expect(s.connects).toBe(2);
    expect(s.closes).toBe(2);
    expect(markers()).not.toContain(`${SID}.txt${CAPTURE_UPLOAD_MARKER_SUFFIX}`);
  }));
});

describe('the registered URL only', () => {
  test('a serve that answers with a redirect is not followed: nothing reaches the other URL and the artifacts stay pending', inHome(async () => {
    const elsewhere: string[] = [];
    const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => { elsewhere.push(req.method); return new Response('{}'); } });
    let asked = 0;
    const front = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => { asked++; return new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/mcp` } }); },
    });
    try {
      writeCaptureCredential(gbHome, { mcp_url: `http://127.0.0.1:${front.port}/mcp`, access_token: BEARER });
      bankOneOfEach();
      // The default transport, as the hook command runs it.
      const entry = await runCaptureUpload({ dir: corpus, limits: { claimWaitMs: 0 } });
      expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_error', sent: 0, duplicate: 0, pending: 3, refused: 0 });
      expect(asked).toBeGreaterThan(0);
      expect(elsewhere).toEqual([]);
      expect(markers()).toEqual([]);
      expect(openCaptureKinds(gbHome)).toHaveLength(3);
    } finally {
      await front.stop(true);
      await target.stop(true);
    }
  }), 30_000);
});

describe('one run at a time', () => {
  test('two runs started together send each artifact once', inHome(async () => {
    for (let i = 0; i < 6; i++) bank(segName(i), `window ${i}`, 10 - i);
    const s = stub(async () => { await new Promise((r) => setTimeout(r, 5)); return stored(); });
    const [a, b] = await Promise.all([run(s, { limits: { claimWaitMs: 5_000 } }), run(s, { limits: { claimWaitMs: 5_000 } })]);
    expect(s.calls.map((c) => c.text).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `window ${i}`));
    expect((a.sent ?? 0) + (b.sent ?? 0)).toBe(6);
    expect(await beats()).toHaveLength(2);
  }));

  test('a run that cannot take the claim sends nothing and says it was busy', inHome(async () => {
    bankOneOfEach();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = stub(async () => { await held; return stored(); });
    const holding = run(holder);
    while (holder.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const loser = stub();
    const entry = await run(loser);
    expect(entry).toMatchObject({ outcome: 'ok', reason: 'upload_busy' });
    expect(entry.sent).toBeUndefined();
    expect(loser.connects).toBe(0);

    release();
    expect(counts(await holding)).toEqual({ sent: 3, duplicate: 0, pending: 0, refused: 0 });
  }));

  /** A run claim left behind, as a child that died while holding it would leave it. */
  function leaveClaim(pid: number, ageMs: number): void {
    const dir = pushLockDir(corpus);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, acquired_at: new Date(Date.now() - ageMs).toISOString(), token: 'synthetic' }));
  }
  const deadPid = () => spawnSync(process.execPath, ['--version']).pid!;

  test('a dead holder past the stale window is taken over', inHome(async () => {
    bankOneOfEach();
    leaveClaim(deadPid(), PUSH_LOCK_STALE_MS + 60_000);
    expect(counts(await run(stub()))).toEqual({ sent: 3, duplicate: 0, pending: 0, refused: 0 });
    // Released on the way out, so the next run needs no takeover.
    expect(existsSync(pushLockDir(corpus))).toBe(false);
  }));

  test.each([
    ['a dead holder inside the stale window', () => leaveClaim(deadPid(), 1_000)],
    ['a live holder, however old its claim', () => leaveClaim(process.pid, PUSH_LOCK_STALE_MS * 10)],
  ])('%s is left alone', inHome(async (_label, arrange) => {
    bankOneOfEach();
    arrange();
    const s = stub();
    expect(await run(s)).toMatchObject({ outcome: 'ok', reason: 'upload_busy' });
    expect(s.connects).toBe(0);
  }));
});

describe('credential and heartbeat', () => {
  test.each([
    ['is missing', () => rmSync(captureCredentialPath(gbHome))],
    ['is a symlink', () => {
      const real = join(root, 'elsewhere.json');
      writeFileSync(real, readFileSync(captureCredentialPath(gbHome)), { mode: 0o600 });
      rmSync(captureCredentialPath(gbHome));
      symlinkSync(real, captureCredentialPath(gbHome));
    }],
    ['is readable by others', () => chmodSync(captureCredentialPath(gbHome), 0o644)],
    ['names plain HTTP on a non-loopback host', () => writeFileSync(captureCredentialPath(gbHome), JSON.stringify({ version: 1, mcp_url: 'http://brain.example/mcp', access_token: BEARER }))],
  ])('a credential file that %s sends nothing and records one code', inHome(async (_label, arrange) => {
    bankOneOfEach();
    arrange();
    const s = stub();
    const entry = await run(s);
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_no_credential' });
    expect(entry.sent).toBeUndefined();
    expect(s.connects).toBe(0);
    expect(markers()).toEqual([]);
    expect(await beats()).toHaveLength(1);
  }));

  test('the heartbeat holds counts and codes only: no bearer, no session id, no session text', inHome(async () => {
    bank(`${SID}.txt`, '[user]\nzebra-capture-marker in a session', 30);
    bank(wbName(1), 'zebra-capture-marker in a turn\n', 20);
    bank(segName(2), 'zebra-capture-marker in a window', 10);
    // An unreachable serve, then a refusal, then a stopped lane: each failure text carries what must not be recorded.
    await run(stub(stored, () => Promise.reject(new Error(`fetch failed for ${BEARER} zebra-capture-marker`))));
    await run(stub((args) => (args.kind === 'writeback'
      ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'writeback_off', message: `refused zebra-capture-marker for ${SID} with ${BEARER}` }) }] }
      : stored())));
    recordCaptureStop(gbHome, ['lane'], { code: 'insufficient_scope' }, captureCredentialIdentity(gbHome)!);
    await run(stub());
    expect((await beats()).map((e) => e.reason)).toEqual(['upload_unreachable', 'writeback_off', 'upload_stopped']);

    const raw = readFileSync(await heartbeatPath(), 'utf8');
    for (const forbidden of [BEARER, SID, 'zebra-capture-marker', 'brain.example']) expect(raw).not.toContain(forbidden);
    const allowed = new Set<string>(HEARTBEAT_ALLOWED_KEYS);
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    for (const line of lines) for (const key of Object.keys(JSON.parse(line))) expect(allowed.has(key)).toBe(true);
  }));

  test.each<[string, () => void, Partial<HookHeartbeatEntry>, string[]]>([
    [
      'replaced by a new registration',
      () => { writeCaptureCredential(gbHome, { mcp_url: 'https://brain.example/mcp', access_token: `${BEARER}-rotated` }); },
      { outcome: 'ok', sent: 2, pending: 0 }, [`${BEARER}-rotated`],
    ],
    ['removed by a teardown', () => rmSync(captureCredentialPath(gbHome)), { outcome: 'degraded', reason: 'upload_no_credential' }, []],
  ])('a credential file %s during a run: the run sends nothing more under the credential it read', inHome(async (_label, change, next, bearers) => {
    bankOneOfEach();
    const s = stub((_args, n) => { if (n === 1) change(); return stored(); });
    const entry = await run(s);
    expect(s.calls).toHaveLength(1);
    expect(entry).toMatchObject({ outcome: 'degraded', reason: 'upload_credential_changed', sent: 1, duplicate: 0, pending: 2, refused: 0 });
    // The next run goes by the file in place.
    const later = stub();
    expect(await run(later)).toMatchObject(next);
    expect(later.credentials.map((c) => (c as { access_token: string }).access_token)).toEqual(bearers);
  }));

  // The three places a marker is written: after a stored or duplicate answer, after a refusal, and for an artifact over the cap.
  test.each<[string, string, unknown, CorpusArtifactKind[]]>([
    ['the serve stored', 'session text', stored(), ['segment', 'session']],
    ['the serve refused', 'session text', refusal('payload_too_large'), ['segment', 'session']],
    ['over the host cap, which is never sent', 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 1), stored(), ['segment']],
  ])("a marker that cannot be written, for an artifact %s, ends the run's sends: it stays pending with the errno, and nothing banked after it is sent", inHome(async (_label, text, answer, called) => {
    bank(segName(1), 'window text', 30);
    bank(`${SID}.txt`, text, 20);
    bank(wbName(2), 'I prefer tea\n', 10);
    // The marker cannot be written where a directory holds its name.
    mkdirSync(join(corpus, `${SID}.txt${CAPTURE_UPLOAD_MARKER_SUFFIX}`));
    // The segment is refused first, so the entry already holds a code when the marker write fails.
    const s = stub((args) => (args.kind === 'segment' ? refusal('invalid_params') : args.kind === 'session' ? answer : stored()));
    const entry = await run(s);
    expect(s.calls.map((c) => c.kind)).toEqual(called);
    expect(entry.outcome).toBe('degraded');
    // The errno of what ended the run, not the code of the artifact refused before it.
    expect(entry.reason).toMatch(/^exception:[A-Z]+$/);
    expect(counts(entry)).toEqual({ sent: 0, duplicate: 0, pending: 2, refused: 1 });
    expect(marker(segName(1))).toMatchObject({ status: 'refused', code: 'invalid_params' });
    expect(await beats()).toHaveLength(1);
  }));

  describe.skipIf(noFileModes)('permission failures', () => {
    test('an unwritable spool sends one artifact per run, not a full batch, and the batch goes once it can be written', inHome(async () => {
      const batch = CAPTURE_UPLOAD_LIMITS.maxArtifacts;
      for (let i = 0; i < batch; i++) bank(segName(i), `window ${i}`, batch - i);
      const s = stub();
      chmodSync(corpus, 0o500);
      try {
        for (const sends of [1, 2]) {
          const entry = await run(s);
          expect(entry).toMatchObject({ outcome: 'degraded', reason: 'exception:EACCES', sent: 0, duplicate: 0, pending: batch, refused: 0 });
          expect(s.calls).toHaveLength(sends);
        }
      } finally {
        chmodSync(corpus, 0o700);
      }
      // Each run sent the oldest artifact again; nothing was marked, so the whole batch is still to send.
      expect(s.calls.map((c) => c.text)).toEqual(['window 0', 'window 0']);
      expect(counts(await run(s))).toEqual({ sent: batch, duplicate: 0, pending: 0, refused: 0 });
    }));

    test.each([
      ['never sent', false],
      ['sent earlier, then touched', true],
    ])('an artifact whose bytes cannot be read (%s) stays pending with the errno, and the ones banked after it still go', inHome(async (_label, sentEarlier) => {
      const locked = bank(`${SID}.txt`, 'session text', 30);
      const s = stub();
      if (sentEarlier) {
        await run(s);
        // A new mtime sends the listing back to the bytes, which it can no longer read.
        utimesSync(locked, Date.now() / 1000 - 20, Date.now() / 1000 - 20);
      }
      chmodSync(locked, 0o000);
      bank(segName(1), 'window text', 10);
      const entry = await run(s);
      expect(entry).toMatchObject({ outcome: 'degraded', reason: 'exception:EACCES', sent: 1, duplicate: 0, pending: 1, refused: 0 });
      expect(s.calls).toHaveLength(sentEarlier ? 2 : 1);
      expect(s.calls.at(-1)).toMatchObject({ kind: 'segment' });
      expect(marker(segName(1))).toMatchObject({ status: 'sent' });
      if (sentEarlier) {
        // The listing is what asks for those bytes first, so the errno is recorded even by a run that reaches no artifact.
        expect(await run(s, { limits: { maxArtifacts: 0 } })).toMatchObject({ outcome: 'degraded', reason: 'exception:EACCES', sent: 0, pending: 1 });
      }
    }));

    test('the same bytes under a new mtime stay settled when the marker cannot be refreshed, and the errno is recorded', inHome(async () => {
      const file = bank(`${SID}.txt`, 'session text', 60);
      const s = stub();
      await run(s);
      utimesSync(file, Date.now() / 1000 - 30, Date.now() / 1000 - 30);
      chmodSync(corpus, 0o500);
      try {
        const entry = await run(s);
        expect(entry).toMatchObject({ outcome: 'degraded', reason: 'exception:EACCES', sent: 0, duplicate: 0, pending: 0, refused: 0 });
        expect(s.calls).toHaveLength(1);
      } finally {
        chmodSync(corpus, 0o700);
      }
    }));
  });

  test('an fs failure of the run itself is one error entry with the errno, never a throw', inHome(async () => {
    bank(`${SID}.txt`, 'session text');
    // The stop cannot be recorded where a directory holds the state file's name.
    mkdirSync(captureStatePath(gbHome));
    const entry = await run(stub(() => refusal('insufficient_scope')));
    expect(entry.outcome).toBe('error');
    expect(entry.reason).toMatch(/^exception:[A-Z]+$/);
    expect(await beats()).toHaveLength(1);
  }));
});

describe('against gbrain serve --http, with the default transport', () => {
  let engine: PGLiteEngine;
  let serve: LiveServeHttp;
  let serveHome: string;
  let hostCorpusRoot: string;
  let hostCorpus: string;
  let seq = 0;

  beforeAll(async () => {
    serveHome = mkdtempSync(join(tmpdir(), 'gb-upload-serve-'));
    hostCorpusRoot = mkdtempSync(join(tmpdir(), 'gb-upload-host-'));
    await withEnv({ GBRAIN_HOME: serveHome, GBRAIN_SOURCE: undefined }, async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      serve = await startServeHttp(engine);
    });
  }, 120_000);

  afterAll(async () => {
    await serve?.close();
    await engine.disconnect();
    rmSync(serveHome, { recursive: true, force: true });
    rmSync(hostCorpusRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hostCorpus = join(hostCorpusRoot, `c${++seq}`);
    await engine.setConfig('dream.synthesize.session_corpus_dir', hostCorpus);
    await engine.unsetConfig('memory.auto_writeback');
  });

  const register = (token: string, url = serve.mcpUrl) => writeCaptureCredential(gbHome, { mcp_url: url, access_token: token });
  const upload = () => runCaptureUpload({ dir: corpus, limits: { claimWaitMs: 0 } });
  const hostFiles = () => (existsSync(hostCorpus) ? readdirSync(hostCorpus).filter((n) => n.endsWith('.txt')).sort() : []);

  test('a session file lands in the host corpus redacted, once; a resend the host already holds is a duplicate', inHome(async () => {
    register(await legacyToken(engine, ['read', 'write', 'session_capture']));
    const text = `[user]\nthe key is ${SECRET}\n\n[assistant]\nnoted`;
    bank('sess-live.txt', text);

    expect(await upload()).toMatchObject({ outcome: 'ok', sent: 1, duplicate: 0, pending: 0, refused: 0 });
    const files = hostFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^rc-[0-9a-f]{16}-sess-live\.txt$/);
    const landed = readFileSync(join(hostCorpus, files[0]!), 'utf8');
    expect(landed).not.toContain(SECRET);
    expect(landed).toContain('<REDACTED:openai>');
    expect(marker('sess-live.txt')).toMatchObject({ status: 'sent', hash: sha256(text) });

    expect(await upload()).toMatchObject({ sent: 0, duplicate: 0, pending: 0 });
    // A crash between the send and the marker: the next run sends again and the host answers duplicate.
    rmSync(join(corpus, `sess-live.txt${CAPTURE_UPLOAD_MARKER_SUFFIX}`));
    expect(await upload()).toMatchObject({ outcome: 'ok', sent: 0, duplicate: 1, pending: 0 });
    expect(hostFiles()).toHaveLength(1);
  }), 60_000);

  test('a grant without the capture scope: the serve answers insufficient_scope and the lane stops', inHome(async () => {
    register(await legacyToken(engine, ['read', 'write']));
    bankOneOfEach();
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'insufficient_scope', sent: 0, pending: 3 });
    expect(openCaptureKinds(gbHome)).toEqual([]);
    expect(hostFiles()).toEqual([]);
  }), 60_000);

  test('the operation outside the grant snapshot: the serve answers unknown_tool and the lane stops', inHome(async () => {
    const cookie = await ownerCookie(serve);
    const res = await fetch(`${serve.base}/admin/api/register-client`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'capture-upload-snapshot', grantTypes: ['client_credentials'], scopes: 'read write session_capture', surface: 'starter', allowedOperations: ['whoami'] }),
    });
    expect(res.status).toBe(200);
    const { clientId, clientSecret } = await res.json() as { clientId: string; clientSecret: string };
    register(await clientCredentialsToken(serve, clientId, clientSecret, 'read write session_capture'));
    bankOneOfEach();
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'unknown_tool', sent: 0, pending: 3 });
    expect(readCaptureStops(gbHome).lane).toMatchObject({ code: 'unknown_tool' });
  }), 60_000);

  test('ambient writeback off on the host: writeback turns stop, the other kinds land', inHome(async () => {
    register(await legacyToken(engine, ['read', 'write', 'session_capture']));
    bankOneOfEach();
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'writeback_off', sent: 2, pending: 1, refused: 0 });
    expect(openCaptureKinds(gbHome)).toEqual(['session', 'segment']);
    expect(hostFiles()).toHaveLength(2);
  }), 60_000);

  test('a session id over the host limit: the serve answers invalid_params and that artifact is refused for good', inHome(async () => {
    register(await legacyToken(engine, ['read', 'write', 'session_capture']));
    const long = `${'a'.repeat(110)}.txt`;
    bank(long, 'session under an over-long id', 20);
    bank('sess-ok.txt', 'session under a valid id', 10);
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'invalid_params', sent: 1, pending: 0, refused: 1 });
    expect(marker(long)).toMatchObject({ status: 'refused', code: 'invalid_params' });
    expect(await upload()).toMatchObject({ outcome: 'ok', sent: 0, pending: 0, refused: 0 });
  }), 60_000);

  test('a bearer the serve rejects is an auth failure: pending, nothing stopped', inHome(async () => {
    register('gbrain_at_synthetic-unknown-bearer');
    bankOneOfEach();
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'upload_auth', sent: 0, pending: 3 });
    expect(openCaptureKinds(gbHome)).toHaveLength(3);
    expect(markers()).toEqual([]);
  }), 60_000);

  test('a serve that is not listening is unreachable: pending, nothing stopped', inHome(async () => {
    // Loopback port 1 has no listener: the connection is refused at once.
    register(await legacyToken(engine, ['read', 'write', 'session_capture']), 'http://127.0.0.1:1/mcp');
    bankOneOfEach();
    expect(await upload()).toMatchObject({ outcome: 'degraded', reason: 'upload_unreachable', sent: 0, pending: 3 });
    expect(openCaptureKinds(gbHome)).toHaveLength(3);
  }), 60_000);
});

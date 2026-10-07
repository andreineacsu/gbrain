/**
 * #5577 remote session capture: the host-side corpus writer
 * (src/core/context/corpus-remote.ts). Engine-free, pure fs over a temp
 * corpus dir.
 *
 * Protects: an uploaded artifact lands under the file-name grammar the local
 * hook produces (the sweep's own parsers read it back), atomically at 0600,
 * namespaced by the authenticated principal (two principals never share or
 * address each other's files, nor a host-local one), attributed to the
 * grant's seat (first seat wins), idempotent per content, host-rescanned, and
 * refused with the field named before anything is written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS_APPEND_MAX_TEXT_BYTES,
  REMOTE_SESSION_ID_MAX,
  remoteSeatLabel,
  remoteSessionNamespace,
  validateCorpusArtifact,
  writeRemoteCorpusArtifact,
  type CorpusArtifact,
  type CorpusArtifactKind,
  type CorpusPrincipal,
  type WriteRemoteArtifactOpts,
} from '../src/core/context/corpus-remote.ts';
import { corpusFileSessionId, parseSegmentFileName, parseWbFileName, segmentHash } from '../src/core/context/corpus-segments.ts';
import { readSeatSidecar } from '../src/core/context/seat.ts';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';

const ALICE: CorpusPrincipal = { kind: 'oauth_client', id: 'gbrain_cl_alice-example' };
const BOB: CorpusPrincipal = { kind: 'oauth_client', id: 'gbrain_cl_bob-example' };
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gb-corpus-remote-')); });
afterEach(() => {
  try { chmodSync(dir, 0o700); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

function artifact(kind: CorpusArtifactKind, text: string, sessionId = SID): CorpusArtifact {
  return { kind, sessionId, text };
}

function write(a: CorpusArtifact, over: Partial<WriteRemoteArtifactOpts> = {}) {
  return writeRemoteCorpusArtifact({ dir, artifact: a, principal: ALICE, seatLabel: 'alice-laptop', ...over });
}

const files = () => readdirSync(dir).sort();

describe('stored names round-trip through the sweep parsers', () => {
  const ns = remoteSessionNamespace(ALICE);
  const cases: Array<{ kind: CorpusArtifactKind; text: string; check(name: string, hash: string): void }> = [
    {
      kind: 'session', text: '[user]\nhello\n\n[assistant]\nhi',
      check: (name) => {
        expect(name).toBe(`${ns}${SID}.txt`);
        expect(parseSegmentFileName(name)).toBeNull();
        expect(parseWbFileName(name)).toBeNull();
      },
    },
    {
      kind: 'segment', text: '[user]\nwindow one',
      check: (name, hash) => expect(parseSegmentFileName(name)).toEqual({ sessionId: `${ns}${SID}`, hash }),
    },
    {
      // Named `.src-default` explicitly, so every sweep files it into default
      // whatever source that sweep ingests (Requirement 8).
      kind: 'writeback', text: 'I prefer tea in the morning\n',
      check: (name, hash) => {
        expect(name).toBe(`${ns}${SID}.wb-${hash}.src-default.txt`);
        expect(parseWbFileName(name)).toEqual({ sessionId: `${ns}${SID}`, hash, sourceId: 'default' });
      },
    },
  ];
  for (const c of cases) {
    test(c.kind, async () => {
      const r = await write(artifact(c.kind, c.text));
      expect(r.status).toBe('stored');
      if (r.status !== 'stored') return;
      const hash = segmentHash(c.text);
      c.check(r.name, hash);
      expect(corpusFileSessionId(r.name)).toBe(`${ns}${SID}`);
      expect(readFileSync(join(dir, r.name), 'utf8')).toBe(c.text);
      expect(statSync(join(dir, r.name)).mode & 0o777).toBe(0o600);
      expect(files().filter(n => n.includes('.tmp-'))).toEqual([]);
      expect(r.bytes).toBe(Buffer.byteLength(c.text, 'utf8'));
    });
  }
});

describe('isolation by principal namespace', () => {
  test('two principals sending the same session id produce two files', async () => {
    const a = await write(artifact('session', 'alice text'));
    const b = await write(artifact('session', 'bob text'), { principal: BOB, seatLabel: 'bob-laptop' });
    expect(a.status).toBe('stored');
    expect(b.status).toBe('stored');
    if (a.status !== 'stored' || b.status !== 'stored') return;
    expect(a.name).not.toBe(b.name);
    expect(readFileSync(join(dir, a.name), 'utf8')).toBe('alice text');
    expect(readFileSync(join(dir, b.name), 'utf8')).toBe('bob text');
  });

  test("choosing another principal's stored id or a host-local id addresses a new file of one's own", async () => {
    writeFileSync(join(dir, `${SID}.txt`), 'host-local session');
    const bob = await write(artifact('session', 'bob text'), { principal: BOB });
    if (bob.status !== 'stored') throw new Error('expected stored');
    const bobId = corpusFileSessionId(bob.name);
    const forged = await write(artifact('session', 'alice overwrite attempt', bobId));
    if (forged.status !== 'stored') throw new Error('expected stored');
    expect(forged.name).toBe(`${remoteSessionNamespace(ALICE)}${bobId}.txt`);
    expect(readFileSync(join(dir, bob.name), 'utf8')).toBe('bob text');
    expect(readFileSync(join(dir, `${SID}.txt`), 'utf8')).toBe('host-local session');
  });

  test('the namespace has a fixed length and depends on the principal kind and id only', () => {
    expect(remoteSessionNamespace(ALICE)).toMatch(/^rc-[0-9a-f]{16}-$/);
    expect(remoteSessionNamespace(ALICE)).toBe(remoteSessionNamespace({ ...ALICE }));
    expect(remoteSessionNamespace(ALICE)).not.toBe(remoteSessionNamespace(BOB));
    expect(remoteSessionNamespace(ALICE)).not.toBe(remoteSessionNamespace({ kind: 'legacy_token', id: ALICE.id }));
  });
});

describe('seat attribution', () => {
  test('the sidecar names the grant label; a later upload under another label keeps the first seat', async () => {
    await write(artifact('segment', 'first window'));
    await write(artifact('segment', 'second window'), { seatLabel: 'renamed-grant' });
    const seat = readSeatSidecar(dir, `${remoteSessionNamespace(ALICE)}${SID}`);
    expect(seat).toMatchObject({ version: 1, seat: 'alice-laptop', seat_source: 'grant', hook_lane: 'corpus_append' });
  });

  test("dream discovery (the seat sidecar's only reader) credits every uploaded kind to the grant seat", async () => {
    await write(artifact('session', '[user]\nsession body'));
    await write(artifact('segment', '[user]\nsegment body'));
    await write(artifact('writeback', 'writeback body\n'));
    const found = discoverTranscripts({ corpusDir: dir, minChars: 1 });
    expect(found).toHaveLength(3);
    expect(found.map(t => t.seat)).toEqual(['alice-laptop', 'alice-laptop', 'alice-laptop']);
    expect(found.some(t => t.filePath.endsWith('.seat.json'))).toBe(false);
  });

  test.each([
    ['My Laptop', 'my-laptop'],
    ['  Work.Box_2  ', 'work.box_2'],
    ['--Team Mac', 'team-mac'],
    ['x'.repeat(80), 'x'.repeat(64)],
  ])('grant name %p becomes seat label %p', (name, label) => {
    expect(remoteSeatLabel(name, ALICE)).toBe(label);
  });

  test.each([[undefined], [''], ['!!!'], ['off'], ['OFF']])('grant name %p falls back to the principal-derived label', (name) => {
    expect(remoteSeatLabel(name, ALICE)).toMatch(/^grant-[0-9a-f]{8}$/);
    expect(remoteSeatLabel(name, ALICE)).not.toBe(remoteSeatLabel(name, BOB));
  });

  test('two grants with the same name share a label, never a namespace', () => {
    expect(remoteSeatLabel('Laptop', ALICE)).toBe(remoteSeatLabel('Laptop', BOB));
    expect(remoteSessionNamespace(ALICE)).not.toBe(remoteSessionNamespace(BOB));
  });
});

describe('idempotency', () => {
  test.each(['session', 'segment', 'writeback'] as const)('%s: the same content twice is one file and a duplicate', async (kind) => {
    const first = await write(artifact(kind, 'same content\n'));
    const second = await write(artifact(kind, 'same content\n'));
    expect(first.status).toBe('stored');
    expect(second.status).toBe('duplicate');
    expect(files().filter(n => n.endsWith('.txt'))).toHaveLength(1);
  });

  test.each(['segment', 'writeback'] as const)('%s: an .ingested sidecar alone is a duplicate (already extracted)', async (kind) => {
    const first = await write(artifact(kind, 'extracted once\n'));
    if (first.status !== 'stored') throw new Error('expected stored');
    rmSync(join(dir, first.name));
    writeFileSync(join(dir, `${first.name}.ingested`), '{}\n');
    expect((await write(artifact(kind, 'extracted once\n'))).status).toBe('duplicate');
    expect(existsSync(join(dir, first.name))).toBe(false);
  });

  test('a session file with new content replaces the old one and drops its completion and claim sidecars', async () => {
    const first = await write(artifact('session', '[user]\nturn one'));
    if (first.status !== 'stored') throw new Error('expected stored');
    const file = join(dir, first.name);
    writeFileSync(`${file}.ingested`, '{}\n');
    writeFileSync(`${file}.in-progress`, '{}\n');
    writeFileSync(`${file}.progress`, '{}\n');
    const second = await write(artifact('session', '[user]\nturn one\n\n[user]\nturn two'));
    expect(second.status).toBe('stored');
    expect(readFileSync(file, 'utf8')).toBe('[user]\nturn one\n\n[user]\nturn two');
    expect(existsSync(`${file}.ingested`)).toBe(false);
    expect(existsSync(`${file}.in-progress`)).toBe(false);
    // The window-progress sidecar stays, as on the local hook's resume rewrite.
    expect(existsSync(`${file}.progress`)).toBe(true);
  });

  test('a duplicate session file keeps its sidecars', async () => {
    const first = await write(artifact('session', 'stable'));
    if (first.status !== 'stored') throw new Error('expected stored');
    writeFileSync(join(dir, `${first.name}.ingested`), '{}\n');
    expect((await write(artifact('session', 'stable'))).status).toBe('duplicate');
    expect(existsSync(join(dir, `${first.name}.ingested`))).toBe(true);
  });
});

describe('host scan', () => {
  const token = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

  test('the host redacts what the client missed; the stored text and its hash are the host version', async () => {
    const r = await write(artifact('segment', `[user]\nmy token is ${token}`));
    if (r.status !== 'stored') throw new Error('expected stored');
    const stored = readFileSync(join(dir, r.name), 'utf8');
    expect(stored).not.toContain(token);
    expect(stored).toContain('<REDACTED:github_token>');
    expect(parseSegmentFileName(r.name)?.hash).toBe(segmentHash(stored));
  });

  test.each(['session', 'segment', 'writeback'] as const)('%s: a scanner that cannot load refuses and writes nothing', async (kind) => {
    const failure = new Error('module missing');
    const r = await write(artifact(kind, 'anything'), { loadScanner: () => Promise.reject(failure) });
    // The scanner's own error rides the refusal for the server log.
    expect(r).toEqual({ status: 'refused', refusal: { code: 'scan_unavailable', error: failure } });
    expect(files()).toEqual([]);
  });
});

describe('boundary validation', () => {
  const lone = 'ab\uD800cd';
  const rows: Array<[string, Record<string, unknown>, string, string]> = [
    ['empty text', { kind: 'session', session_id: SID, text: '' }, 'invalid_params', 'text'],
    ['whitespace text', { kind: 'session', session_id: SID, text: ' \n\t' }, 'invalid_params', 'text'],
    ['missing text', { kind: 'session', session_id: SID }, 'invalid_params', 'text'],
    ['non-UTF-8 text', { kind: 'session', session_id: SID, text: lone }, 'invalid_params', 'text'],
    ['text over the cap', { kind: 'session', session_id: SID, text: 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 1) }, 'payload_too_large', 'text'],
    ['multi-byte text over the cap', { kind: 'session', session_id: SID, text: 'é'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES / 2 + 1) }, 'payload_too_large', 'text'],
    ['unknown kind', { kind: 'transcript', session_id: SID, text: 'x' }, 'invalid_params', 'kind'],
    ['missing kind', { session_id: SID, text: 'x' }, 'invalid_params', 'kind'],
    ['id with a slash', { kind: 'session', session_id: '../escape', text: 'x' }, 'invalid_params', 'session_id'],
    ['id with a backslash', { kind: 'session', session_id: 'a\\b', text: 'x' }, 'invalid_params', 'session_id'],
    ['id of dots only', { kind: 'session', session_id: '..', text: 'x' }, 'invalid_params', 'session_id'],
    ['empty id', { kind: 'session', session_id: '', text: 'x' }, 'invalid_params', 'session_id'],
    ['id over the component cap', { kind: 'session', session_id: 'a'.repeat(REMOTE_SESSION_ID_MAX + 1), text: 'x' }, 'invalid_params', 'session_id'],
  ];
  test.each(rows)('%s is refused with the field named', (_label, raw, code, field) => {
    const v = validateCorpusArtifact(raw);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.refusal.code).toBe(code as never);
    expect((v.refusal as { field: string }).field).toBe(field);
    expect(files()).toEqual([]);
  });

  test('the over-cap refusal reports the byte count and the cap', () => {
    const v = validateCorpusArtifact({ kind: 'segment', session_id: SID, text: 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 5) });
    expect(v).toEqual({ ok: false, refusal: { code: 'payload_too_large', field: 'text', bytes: CORPUS_APPEND_MAX_TEXT_BYTES + 5, cap: CORPUS_APPEND_MAX_TEXT_BYTES } });
  });

  test('text at the cap and an id at the component cap are accepted, and the stored name stays within it', async () => {
    const v = validateCorpusArtifact({ kind: 'session', session_id: 'a'.repeat(REMOTE_SESSION_ID_MAX), text: 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES) });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = await write(v.artifact);
    if (r.status !== 'stored') throw new Error('expected stored');
    expect(corpusFileSessionId(r.name)).toHaveLength(120);
  });

  test.each([
    ['session', 'x.seg-0123456789ab'],
    ['session', 'x.wb-0123456789ab'],
    ['session', 'x.wb-0123456789ab.src-other'],
  ] as const)('a %s id that would parse as another kind (%s) is refused and writes nothing', async (kind, id) => {
    const r = await write(artifact(kind, 'disguised', id));
    expect(r).toMatchObject({ status: 'refused', refusal: { code: 'invalid_params', field: 'session_id' } });
    expect(files()).toEqual([]);
  });

  test.each([
    ['segment', 'x.wb-0123456789ab'],
    ['writeback', 'x.seg-0123456789ab'],
    ['writeback', 'y.wb-0123456789ab.src-evil'],
  ] as const)('a %s id holding another grammar (%s) still round-trips as its own kind and id', async (kind, id) => {
    const r = await write(artifact(kind, 'plain turn\n', id));
    if (r.status !== 'stored') throw new Error(`expected stored, got ${JSON.stringify(r)}`);
    expect(corpusFileSessionId(r.name)).toBe(`${remoteSessionNamespace(ALICE)}${id}`);
    expect(parseWbFileName(r.name)?.sourceId).toBe(kind === 'writeback' ? 'default' : undefined);
  });
});

describe('storage failure', () => {
  test('an unwritable corpus dir throws and leaves no corpus file', async () => {
    chmodSync(dir, 0o500);
    await expect(write(artifact('session', 'cannot land'))).rejects.toThrow();
    chmodSync(dir, 0o700);
    expect(files().filter(n => n.endsWith('.txt'))).toEqual([]);
  });
});

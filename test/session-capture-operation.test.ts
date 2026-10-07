/**
 * #5577 remote session capture: the `corpus_append` operation end to end.
 *
 * Two layers, both production code over an in-memory keyless PGLite brain:
 *   - shared dispatch (`dispatchToolCall`, remote http-shaped): the handler's
 *     gates and refusals (principal, validation, source, the host writeback
 *     gate, storage failure), the result shape, the one structured log line
 *     per call, and the grant-derived seat;
 *   - `gbrain serve --http` (`buildServeHttpApp`) on a loopback port: the
 *     authorization matrix of Requirement 3 (scope, operation snapshot,
 *     starter surface, tool listing) with real OAuth client grants, and the
 *     request log and SSE feed under --log-full-params.
 *
 * Protects: an unscoped grant neither lists nor calls the op, its denial names
 * session_capture, a snapshot miss looks like a nonexistent tool, and an
 * accepted artifact lands where the sweep reads, attributed to the grant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { bindResolveIpcForServe, serveBoundSourceId, type ResolveIpcBinding } from '../src/mcp/resolve-ipc-binding.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import { configDir } from '../src/core/config.ts';
import * as secretScan from '../src/core/secret-scan.ts';
import { getBrainHotMemoryMeta, __hotMemoryCacheForTests, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { CORPUS_APPEND_MAX_TEXT_BYTES, remoteSessionNamespace } from '../src/core/context/corpus-remote.ts';
import { readSeatSidecar } from '../src/core/context/seat.ts';
import { CODES } from '../src/core/error-registry.ts';
import { parseWbFileName } from '../src/core/context/corpus-segments.ts';
import {
  callTool, clientCredentialsToken, envelopeOf, legacyToken, ownerCookie, rpc, startServeHttp, type LiveServeHttp,
} from './helpers/live-mcp-servers.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-session-capture-home-'));
const corpusRoot = mkdtempSync(join(tmpdir(), 'gbrain-session-capture-corpus-'));
const SID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PRINCIPAL = { kind: 'oauth_client' as const, id: 'gbrain_cl_alice-example' };
const env = { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined };
const inEnv = (fn: () => Promise<void>) => () => withEnv(env, fn);

let engine: PGLiteEngine;
let corpus: string;
let corpusSeq = 0;
const logs: Array<{ level: string; msg: string }> = [];
const logger = {
  info: (msg: string) => { logs.push({ level: 'info', msg }); },
  warn: (msg: string) => { logs.push({ level: 'warn', msg }); },
  error: (msg: string) => { logs.push({ level: 'error', msg }); },
};

function auth(over: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'synthetic', clientId: PRINCIPAL.id, clientName: 'Alice Laptop', principal: PRINCIPAL,
    scopes: ['read', 'write', 'session_capture'], sourceId: 'default', ...over,
  };
}

async function call(params: Record<string, unknown>, opts: { auth?: AuthInfo | null; sourceId?: string; dispatch?: Partial<DispatchOpts>; on?: BrainEngine } = {}) {
  const a = opts.auth === undefined ? auth({ sourceId: opts.sourceId ?? 'default' }) : opts.auth;
  const r = await dispatchToolCall(opts.on ?? engine, 'corpus_append', params, {
    remote: true, transport: 'http', sourceId: opts.sourceId ?? 'default', takesHoldersAllowList: ['world'], logger,
    ...(a ? { auth: a } : {}), ...opts.dispatch,
  });
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, any> };
}

const corpusFiles = () => (existsSync(corpus) ? readdirSync(corpus).filter(n => n.endsWith('.txt')).sort() : []);
const ns = remoteSessionNamespace(PRINCIPAL);

beforeAll(inEnv(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  rmSync(corpusRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  logs.length = 0;
  // No serve is bound in this process unless a test binds one, so the op reads the source ladder per call.
  expect(serveBoundSourceId()).toBeNull();
  corpus = join(corpusRoot, `c${++corpusSeq}`);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  await engine.unsetConfig('memory.auto_writeback');
});

describe('corpus_append through shared dispatch', () => {
  test('stores a session file where the sweep reads it, reports stored then duplicate, echoes no content', inEnv(async () => {
    const text = '[user]\nsynthetic private phrase about tea\n\n[assistant]\nnoted';
    const first = await call({ kind: 'session', session_id: SID, text });
    expect(first).toEqual({ isError: false, body: { status: 'stored', kind: 'session', bytes: Buffer.byteLength(text) } });
    expect(corpusFiles()).toEqual([`${ns}${SID}.txt`]);
    expect(readFileSync(join(corpus, `${ns}${SID}.txt`), 'utf8')).toBe(text);
    const again = await call({ kind: 'session', session_id: SID, text });
    expect(again.body.status).toBe('duplicate');
    expect(corpusFiles()).toHaveLength(1);
    expect(JSON.stringify([first.body, again.body])).not.toContain('synthetic private phrase');
  }));

  test('the seat is the grant label, whatever seat the request names', inEnv(async () => {
    const r = await call({ kind: 'segment', session_id: SID, text: '[user]\nwindow', seat: 'forged-seat' });
    expect(r.isError).toBe(false);
    expect(readSeatSidecar(corpus, `${ns}${SID}`)).toMatchObject({ seat: 'alice-laptop', seat_source: 'grant' });
  }));

  test('one structured log line per call with client, kind, bytes and outcome, never the text', inEnv(async () => {
    const text = 'synthetic private phrase for the log test';
    await call({ kind: 'session', session_id: SID, text });
    await call({ kind: 'session', session_id: '../escape', text });
    const lines = logs.filter(l => l.msg.startsWith('[corpus_append] {'));
    expect(lines.map(l => [l.level, JSON.parse(l.msg.slice('[corpus_append] '.length))])).toEqual([
      ['info', { client_id: PRINCIPAL.id, kind: 'session', bytes: Buffer.byteLength(text), outcome: 'stored' }],
      ['warn', { client_id: PRINCIPAL.id, kind: 'session', bytes: Buffer.byteLength(text), outcome: 'invalid_params' }],
    ]);
    expect(logs.map(l => l.msg).join('\n')).not.toContain('synthetic private phrase');
  }));

  test.each([
    ['the trusted local CLI (no auth)', { auth: null, dispatch: { remote: false, transport: undefined } }],
    ['an http AuthInfo without a principal', { auth: auth({ principal: undefined }) }],
  ] as const)('%s is refused before any file is touched', (_label, opts) => withEnv(env, async () => {
    const r = await call({ kind: 'session', session_id: SID, text: 'x' }, opts as Parameters<typeof call>[1]);
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: 'permission_denied', reason: 'principal_required' });
    expect(existsSync(corpus)).toBe(false);
  }));

  test.each([
    ['kind outside the closed set', { kind: 'transcript', session_id: SID, text: 'x' }, 'invalid_params', 'kind'],
    ['missing text', { kind: 'session', session_id: SID }, 'invalid_params', 'text'],
    ['session id with separators', { kind: 'session', session_id: 'a/b', text: 'x' }, 'invalid_params', 'session_id'],
    ['empty text', { kind: 'session', session_id: SID, text: '' }, 'invalid_params', 'text'],
    ['text over the cap', { kind: 'session', session_id: SID, text: 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 1) }, 'payload_too_large', 'text'],
  ] as const)('%s: typed refusal naming the field, nothing written', (_label, params, code, field) => withEnv(env, async () => {
    const r = await call(params as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe(code);
    expect(`${r.body.message} ${r.body.suggestion}`).toContain(field);
    expect(r.body.retryable).toBe(false);
    expect(existsSync(corpus)).toBe(false);
  }));

  test("shared dispatch's own scope denial names session_capture, not a shared-skills grant", inEnv(async () => {
    const r = await call({ kind: 'session', session_id: SID, text: 'x' }, { auth: auth({ scopes: ['read', 'write'] }) });
    expect(r.body).toMatchObject({ code: 'insufficient_scope', message: "This operation requires an explicit 'session_capture' grant." });
    expect(r.body.why).toContain("'session_capture'");
    expect(existsSync(corpus)).toBe(false);
  }));

  test('the over-cap refusal names the cap', inEnv(async () => {
    const r = await call({ kind: 'segment', session_id: SID, text: 'x'.repeat(CORPUS_APPEND_MAX_TEXT_BYTES + 1) });
    expect(r.body.message).toContain(String(CORPUS_APPEND_MAX_TEXT_BYTES));
    expect(r.body.class).toBe('caller');
  }));
});

describe('host gates', () => {
  test('writeback off refuses a writeback turn and still accepts a session file', inEnv(async () => {
    const wb = await call({ kind: 'writeback', session_id: SID, text: 'I prefer tea\n' });
    expect(wb.body).toMatchObject({ code: 'writeback_off', class: 'host_only', retryable: false });
    expect(wb.body.suggestion).toContain('this setting does not affect session files or checkpoint segments');
    expect(wb.body.fix.argv).toEqual(['gbrain', 'config', 'set', 'memory.auto_writeback', 'salient']);
    expect(wb.body.fix.actor).toBe('host_admin');
    expect(corpusFiles()).toEqual([]);
    expect((await call({ kind: 'session', session_id: SID, text: 'session text' })).body.status).toBe('stored');
  }));

  test('writeback on stores the turn', inEnv(async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    const r = await call({ kind: 'writeback', session_id: SID, text: 'I prefer tea\n' });
    expect(r.body.status).toBe('stored');
    expect(corpusFiles().map(parseWbFileName)).toEqual([{ sessionId: `${ns}${SID}`, hash: expect.any(String), sourceId: 'default' }]);
  }));

  test('an unrecognized writeback mode is a retryable refusal distinct from writeback_off', inEnv(async () => {
    await engine.setConfig('memory.auto_writeback', 'sometimes');
    const r = await call({ kind: 'writeback', session_id: SID, text: 'turn\n' });
    expect(r.body).toMatchObject({ code: 'writeback_gate_unresolved', reason: 'mode_invalid', class: 'retryable', retryable: true });
    expect(corpusFiles()).toEqual([]);
  }));

  test('a writeback setting whose planes disagree (plane_drift) is a retryable refusal, nothing written', inEnv(async () => {
    // The DB row stays unset (beforeEach) while the config.json mirror claims salient.
    const cfgPath = join(configDir(), 'config.json');
    const prior = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
    try {
      const r = await call({ kind: 'writeback', session_id: SID, text: 'turn\n' });
      expect(r.body).toMatchObject({ code: 'writeback_gate_unresolved', reason: 'plane_drift', class: 'retryable', retryable: true });
      expect(existsSync(corpus)).toBe(false);
    } finally {
      if (prior !== null) writeFileSync(cfgPath, prior);
      else rmSync(cfgPath, { force: true });
    }
  }));

  test('an unreadable writeback setting is a retryable refusal', inEnv(async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    const flaky = new Proxy(engine, {
      get(target, key) {
        if (key === 'getConfig') {
          return async (k: string) => { if (k === 'memory.auto_writeback') throw new Error('synthetic config read failure'); return target.getConfig(k); };
        }
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const r = await call({ kind: 'writeback', session_id: SID, text: 'turn\n' }, { on: flaky as unknown as BrainEngine });
    expect(r.body).toMatchObject({ code: 'writeback_gate_unresolved', reason: 'read_error', retryable: true });
    expect(corpusFiles()).toEqual([]);
  }));

  // Requirement 8: only a grant on `default` captures, whatever the kind.
  // The reason tells a client which kinds can still land: none for
  // grant_source, writeback turns for sweep_source.
  test('source_not_ingestable registers exactly the two reasons the op sets, and conditions writeback turns on ambient writeback as the op does', () => {
    expect(CODES.source_not_ingestable.reasons).toEqual(['grant_source', 'sweep_source']);
    expect(CODES.source_not_ingestable.summary).toContain('writeback turns land only while ambient writeback is on');
  });

  test.each(['session', 'segment', 'writeback'])('a grant on another source is refused for a %s with reason grant_source; nothing written', (kind) => withEnv(env, async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    const r = await call({ kind, session_id: SID, text: 'team text\n' }, { sourceId: 'team-a' });
    expect(r.body).toMatchObject({ code: 'source_not_ingestable', reason: 'grant_source', class: 'host_only', retryable: false });
    expect(r.body.suggestion).toContain('Nothing from this grant is stored, whatever its kind.');
    expect(r.body.fix.argv).toEqual(['gbrain', 'auth', 'rescope-client', PRINCIPAL.id, '--source', 'default']);
    expect(existsSync(corpus)).toBe(false);
  }));

  test("on a serve whose GBRAIN_SOURCE is another source, a default grant's writeback turn is named .src-default and nothing else lands", async () => {
    await withEnv({ ...env, GBRAIN_SOURCE: 'team-a' }, async () => {
      await engine.setConfig('memory.auto_writeback', 'salient');
      expect((await call({ kind: 'writeback', session_id: SID, text: 'default turn\n' })).body.status).toBe('stored');
      const [name] = corpusFiles();
      expect(name).toEndWith('.src-default.txt');
      expect(parseWbFileName(name!)).toMatchObject({ sessionId: `${ns}${SID}`, sourceId: 'default' });
      for (const kind of ['session', 'segment']) {
        const r = await call({ kind, session_id: SID, text: 'default text' });
        expect(r.body).toMatchObject({ code: 'source_not_ingestable', reason: 'sweep_source', class: 'host_only', retryable: false });
        expect(r.body.suggestion).toContain('writeback turns from this grant are accepted while ambient writeback is on');
        expect(r.body.fix.argv).toBeUndefined();
      }
      // A grant on the sweep's own source is refused too: only default captures.
      expect((await call({ kind: 'session', session_id: SID, text: 'team text' }, { sourceId: 'team-a' })).body)
        .toMatchObject({ code: 'source_not_ingestable', reason: 'grant_source' });
      expect(corpusFiles()).toEqual([name]);
    });
  });

  // The serve binds its resolve-IPC lane and delegated sweep runner to the
  // source ladder, not GBRAIN_SOURCE alone: sources.default moves it too.
  test("on a serve bound to another source through sources.default, a default grant's session file is refused with reason sweep_source", inEnv(async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('team-b','team-b') ON CONFLICT DO NOTHING");
    await engine.setConfig('sources.default', 'team-b');
    await engine.setConfig('memory.auto_writeback', 'salient');
    try {
      const r = await call({ kind: 'session', session_id: SID, text: 'default text' });
      expect(r.body).toMatchObject({ code: 'source_not_ingestable', reason: 'sweep_source', class: 'host_only', retryable: false });
      expect(r.body.message).toContain('into source team-b');
      expect(existsSync(corpus)).toBe(false);
      expect((await call({ kind: 'writeback', session_id: SID, text: 'default turn\n' })).body.status).toBe('stored');
      expect(corpusFiles().map(parseWbFileName)).toEqual([{ sessionId: `${ns}${SID}`, hash: expect.any(String), sourceId: 'default' }]);
    } finally {
      await engine.unsetConfig('sources.default');
    }
  }));

  // The serve binds its delegated sweep to one source at start and keeps it,
  // while the ladder's sole-non-default tier ends once `default` holds a
  // page. The op answers from the bound value, and reads the ladder per call
  // only when no serve in this process bound one.
  test('a serve bound to a non-default source keeps refusing a session file after default gains a page; with no serve bound the ladder is read per call', async () => {
    await withEnv({ ...env, GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
      const pageSlug = 'notes/synthetic-first-default-page';
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('team-c', 'team-c', $1)", [join(corpusRoot, 'team-c-repo')]);
      let binding: ResolveIpcBinding | undefined;
      try {
        // What serve-http.ts hands the binding on a brain with nothing configured.
        const atStart = await resolveMcpStdioSourceScope(engine);
        expect(atStart).toMatchObject({ sourceId: 'team-c', tier: 'sole_non_default' });
        binding = await bindResolveIpcForServe(engine, atStart.sourceId);
        const first = await call({ kind: 'session', session_id: SID, text: 'default text' });
        expect(first.body).toMatchObject({ code: 'source_not_ingestable', reason: 'sweep_source' });
        // The operator of this serve set none of the other tiers: the fix names the one that bound it.
        expect(first.body.fix.why).toContain('the only non-default source with a local_path while default held no page');
        // A default grant's own write moves the ladder, with no operator change.
        await engine.putPage(pageSlug, { type: 'note', title: 'Synthetic', compiled_truth: 'First page in default.' }, { sourceId: 'default' });
        expect((await resolveMcpStdioSourceScope(engine)).sourceId).toBe('default');
        for (const kind of ['session', 'segment']) {
          const r = await call({ kind, session_id: SID, text: 'default text' });
          expect(r.body).toMatchObject({ code: 'source_not_ingestable', reason: 'sweep_source', retryable: false });
          expect(r.body.message).toContain('into source team-c');
        }
        expect(existsSync(corpus)).toBe(false);
        binding.close();
        expect((await call({ kind: 'session', session_id: SID, text: 'default text' })).body.status).toBe('stored');
      } finally {
        binding?.close();
        await engine.executeRaw("DELETE FROM pages WHERE source_id = 'default' AND slug = $1", [pageSlug]);
        await engine.executeRaw("DELETE FROM sources WHERE id = 'team-c'");
      }
    });
  });

  // A scanner error's message can quote the text it scanned, so the server
  // log line carries the error's name and code only (R12).
  test.each([
    ['an Error with a code', Object.assign(new Error('synthetic scanner failure quoting tea'), { code: 'ERR_SYNTHETIC_SCAN' }), 'Error (code ERR_SYNTHETIC_SCAN)'],
    ['an Error without a code', new TypeError('synthetic scanner failure quoting tea'), 'TypeError'],
    ['a thrown string', 'synthetic scanner failure quoting tea', 'non-Error string'],
  ] as const)('a scanner that fails (%s) is refused as scan_unavailable; the server log gets its name and code, never its message', (_label, thrown, logged) => withEnv(env, async () => {
    const scan = spyOn(secretScan, 'redactFindings').mockImplementation(() => { throw thrown; });
    try {
      const r = await call({ kind: 'session', session_id: SID, text: 'unscanned text' });
      expect(r.body).toMatchObject({ code: 'scan_unavailable', class: 'unavailable', fix: { actor: 'host_admin', next: 'report' } });
      expect(r.body.fix.argv).toBeUndefined();
      expect(r.body.suggestion).toContain("server log gives the scanner error's class and any code it carries, not its message");
      expect(r.body.suggestion).toBe(CODES.scan_unavailable.suggestion);
      expect(r.body.fix.why).toContain("server log gives the scanner error's class and any code it carries, not its message");
      expect(JSON.stringify(r.body)).not.toContain('synthetic scanner failure');
    } finally {
      scan.mockRestore();
    }
    expect(logs.find(l => l.level === 'error')?.msg).toBe(`[corpus_append] host secret scanner failed: ${logged}`);
    expect(logs.map(l => l.msg).join('\n')).not.toContain('synthetic scanner failure');
    expect(existsSync(corpus)).toBe(false);
  }));

  test('a storage failure is a sanitized internal refusal; the full error goes to the server log', inEnv(async () => {
    writeFileSync(join(corpusRoot, 'plain-file'), 'not a directory');
    await engine.setConfig('dream.synthesize.session_corpus_dir', join(corpusRoot, 'plain-file', 'corpus'));
    const r = await call({ kind: 'session', session_id: SID, text: 'cannot land' });
    expect(r.body).toMatchObject({ code: 'storage_error', class: 'server', fix: { actor: 'host_admin', next: 'report' } });
    expect(r.body.fix.argv).toBeUndefined();
    expect(r.body.suggestion).toContain('server log');
    expect(JSON.stringify(r.body)).not.toContain('plain-file');
    expect(logs.find(l => l.level === 'error')?.msg).toContain('plain-file');
    expect(logs.find(l => l.msg.startsWith('[corpus_append] {'))?.msg).toContain('"outcome":"storage_error"');
  }));
});

describe('hot memory', () => {
  // The capture hook sends an artifact on every Stop event and discards the
  // reply: corpus_append neither clears hot memory nor builds it.
  test('a stored or refused corpus_append keeps the hot-memory cache and builds none for its reply', inEnv(async () => {
    __resetHotMemoryCacheForTests();
    await engine.insertFact({ fact: 'Keeps bees cnrycapturehot', kind: 'fact', entity_slug: 'people/alice-example', visibility: 'world', source: 'test' },
      { source_id: 'default' });
    const opts: DispatchOpts = { remote: true, transport: 'http', sourceId: 'default', takesHoldersAllowList: ['world'], logger, auth: auth(), metaHook: getBrainHotMemoryMeta };
    expect(JSON.stringify((await dispatchToolCall(engine, 'get_stats', {}, opts))._meta ?? null)).toContain('cnrycapturehot');
    const cached = [...__hotMemoryCacheForTests().keys()];
    expect(cached).toHaveLength(1);
    const stored = await dispatchToolCall(engine, 'corpus_append', { kind: 'session', session_id: SID, text: 'stored text' }, opts);
    const refused = await dispatchToolCall(engine, 'corpus_append', { kind: 'writeback', session_id: SID, text: 'refused turn\n' }, opts);
    expect([stored.isError === true, refused.isError === true]).toEqual([false, true]);
    for (const r of [stored, refused]) expect(r._meta?.brain_hot_memory).toBeUndefined();
    expect([...__hotMemoryCacheForTests().keys()]).toEqual(cached);
  }));
});

describe('gbrain serve --http --log-full-params', () => {
  let serve: LiveServeHttp;

  beforeAll(inEnv(async () => {
    const app = express();
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const built = await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: base, logFullParams: true });
    serve = {
      base, mcpUrl: `${base}/mcp`, bootstrap: built.bootstrapToken,
      close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
  }), 60_000);
  afterAll(async () => { await serve?.close(); });

  /** The admin SSE feed's text while `act` runs, read until the corpus_append event arrives. */
  async function sseDuring(act: () => Promise<void>): Promise<string> {
    const ctl = new AbortController();
    const res = await fetch(`${serve.base}/admin/events`, { headers: { Cookie: await ownerCookie(serve) }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await act();
    let seen = '';
    let pending = reader.read();
    const deadline = Date.now() + 5_000;
    while (!seen.includes('"operation":"corpus_append"') && Date.now() < deadline) {
      const chunk = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 250))]);
      if (!chunk) continue;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
      pending = reader.read();
    }
    pending.catch(() => { /* the abort below ends the pending read */ });
    ctl.abort();
    return seen;
  }

  test('the request log and the SSE feed keep the corpus_append summary, never the text', inEnv(async () => {
    const token = await legacyToken(engine, ['read', 'write', 'session_capture']);
    const text = 'synthetic private phrase under full params';
    const feed = await sseDuring(async () => {
      const result = await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text });
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'stored' });
    });
    expect(feed).toContain('"operation":"corpus_append"');
    expect(feed).not.toContain('synthetic private phrase');
    const rows = await engine.executeRaw<{ params: Record<string, unknown> }>(
      `SELECT params FROM mcp_request_log WHERE operation = 'corpus_append' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.params).toMatchObject({ redacted: true, declared_keys: ['kind', 'session_id', 'text'] });
    expect(JSON.stringify(rows)).not.toContain('synthetic private phrase');
  }));
});

describe('authorization over gbrain serve --http (Requirement 3)', () => {
  let serve: LiveServeHttp;
  let cookie: string;
  let clientSeq = 0;

  async function grant(body: { scopes: string; surface?: string; allowedOperations?: string[] }): Promise<{ token: string; clientId: string }> {
    const res = await fetch(`${serve.base}/admin/api/register-client`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `capture-client-${++clientSeq}`, grantTypes: ['client_credentials'], ...body }),
    });
    if (res.status !== 200) throw new Error(`register-client failed: ${res.status} ${await res.text()}`);
    const { clientId, clientSecret } = await res.json() as { clientId: string; clientSecret: string };
    return { clientId, token: await clientCredentialsToken(serve, clientId, clientSecret, body.scopes) };
  }

  const listed = async (token: string) =>
    ((await rpc(serve.base, token, 'tools/list')).body.result.tools as Array<{ name: string }>).map(t => t.name);

  beforeAll(inEnv(async () => {
    serve = await startServeHttp(engine);
    cookie = await ownerCookie(serve);
  }), 60_000);
  afterAll(async () => { await serve?.close(); });

  test('read, write and session_capture on the starter surface with the op in its snapshot: listed and callable', inEnv(async () => {
    const { token, clientId } = await grant({ scopes: 'read write session_capture', surface: 'starter', allowedOperations: ['whoami', 'corpus_append'] });
    expect(await listed(token)).toContain('corpus_append');
    const result = await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text: '[user]\nover http' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'stored', kind: 'session' });
    const stored = corpusFiles();
    expect(stored).toEqual([`${remoteSessionNamespace({ kind: 'oauth_client', id: clientId })}${SID}.txt`]);
  }));

  test('without the scope: not listed, and the call gets the scope denial naming session_capture', inEnv(async () => {
    const { token, clientId } = await grant({ scopes: 'read write', surface: 'starter' });
    expect(await listed(token)).not.toContain('corpus_append');
    const env = envelopeOf(await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text: 'x' }));
    expect(env).toMatchObject({ code: 'insufficient_scope', class: 'host_only' });
    expect(env.why).toContain("'session_capture'");
    expect(env.fix.argv.slice(0, 6)).toEqual(['gbrain', 'auth', 'rescope', '--client', clientId, '--scopes']);
    expect(env.fix.argv[6].split(',').sort()).toEqual(['read', 'session_capture', 'write']);
    expect(corpusFiles()).toEqual([]);
  }));

  test('admin does not imply the capture scope', inEnv(async () => {
    const { token } = await grant({ scopes: 'read write admin' });
    expect(await listed(token)).not.toContain('corpus_append');
    const env = envelopeOf(await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text: 'x' }));
    expect(env.code).toBe('insufficient_scope');
    expect(env.why).toContain("'session_capture'");
  }));

  // Requirement 12 at the layer that decides: the op logs its own line for
  // calls that reach the handler; schema refusals before it are recorded by
  // the serve's request log. Neither layer ever holds the text.
  test('the serve request log and stderr keep keys, a digest and the outcome, never the text', inEnv(async () => {
    const { token, clientId } = await grant({ scopes: 'read write session_capture', surface: 'starter', allowedOperations: ['corpus_append'] });
    const text = 'synthetic private phrase over http';
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk)); return true;
    }) as typeof process.stderr.write);
    const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.map(String).join(' ')); });
    try {
      await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text });
      envelopeOf(await callTool(serve.base, token, 'corpus_append', { kind: 'transcript', session_id: SID, text }));
    } finally {
      write.mockRestore();
      consoleError.mockRestore();
    }
    const rows = await engine.executeRaw<{ status: string; error_message: string | null; params: Record<string, unknown> }>(
      `SELECT status, error_message, params FROM mcp_request_log WHERE token_name = $1 AND operation = 'corpus_append' ORDER BY id`, [clientId]);
    expect(rows.map(r => r.status)).toEqual(['success', 'error']);
    expect(rows[0]!.params).toMatchObject({ redacted: true, kind: 'object', declared_keys: ['kind', 'session_id', 'text'], unknown_key_count: 0 });
    expect(rows[1]!.error_message).toContain('kind');
    expect(JSON.stringify(rows)).not.toContain('synthetic private phrase');
    const out = stderr.join('\n');
    expect(out).toContain('[gbrain-serve] dispatch op=corpus_append args_sha256=');
    expect(out).toContain(`[corpus_append] {"client_id":"${clientId}","kind":"session","bytes":${Buffer.byteLength(text)},"outcome":"stored"}`);
    expect(out).not.toContain('synthetic private phrase');
  }));

  test('with the scope but outside the snapshot: the same envelope as a nonexistent tool', inEnv(async () => {
    const { token } = await grant({ scopes: 'read write session_capture', surface: 'starter', allowedOperations: ['whoami'] });
    expect(await listed(token)).not.toContain('corpus_append');
    const denied = envelopeOf(await callTool(serve.base, token, 'corpus_append', { kind: 'session', session_id: SID, text: 'x' }));
    const missing = envelopeOf(await callTool(serve.base, token, 'no_such_tool_anywhere', {}));
    expect(denied.code).toBe('unknown_tool');
    const shape = (e: Record<string, any>) => ({ error: e.error, code: e.code, class: e.class, retryable: e.retryable, keys: Object.keys(e).sort() });
    expect(shape(denied)).toEqual(shape(missing));
    expect(corpusFiles()).toEqual([]);
  }));
});

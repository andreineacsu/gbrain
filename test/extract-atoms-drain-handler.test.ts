/**
 * #1685 GAP D — extract-atoms-drain Minion handler: registration + protected
 * gate. Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { makeExtractAtomsDrainHandler } from '../src/core/minions/handlers/extract-atoms-drain.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import {
  formatDrainProviderFailure,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('extract-atoms-drain handler', () => {
  test('registerBuiltinHandlers registers the handler', async () => {
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('extract-atoms-drain');
  });

  test('queue.add rejects an untrusted submission (PROTECTED, CODEX #1)', async () => {
    await expect(queue.add('extract-atoms-drain', { sourceId: 'default' })).rejects.toThrow(
      /protected job name/i,
    );
  });

  test('queue.add accepts a trusted submission (allowProtectedSubmit)', async () => {
    const job = await queue.add(
      'extract-atoms-drain',
      { sourceId: 'default', window: 120 },
      { queue: 'default' },
      { allowProtectedSubmit: true },
    );
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe('extract-atoms-drain');
  });

  // #3813: the provider_failure throw is the job's error_text once it
  // dead-letters. It carried only batches/remaining, so a missing provider key
  // was invisible from every supported surface even though the drain result
  // has carried a sanitized representative `last_error`.
  test('provider_failure error text carries the drain\'s last_error', () => {
    const result = {
      status: 'provider_failure',
      batches: 1,
      remaining: 151,
      last_error: 'concepts/alice-example: Anthropic chat requires ANTHROPIC_API_KEY.',
    } as ExtractAtomsDrainResult;
    const msg = formatDrainProviderFailure(result);
    expect(msg).toContain('batches=1');
    expect(msg).toContain('remaining=151');
    expect(msg).toContain('ANTHROPIC_API_KEY');
    // A clean-run shape (no representative error) keeps the original message.
    expect(formatDrainProviderFailure({ ...result, last_error: null })).not.toContain('last error');
  });

  // #5809: at timeout_ms the worker aborts job.signal and dead-letters the
  // row, but an inline handler keeps running (and keeps refreshing the source's
  // cycle lock) unless the drain observes that signal.
  const drainJob = (signal: AbortSignal, deadlineAtMs: number | null = null) => ({
    id: 1, name: 'extract-atoms-drain', attempts_made: 0,
    data: { sourceId: 'default', window: 120 },
    signal, deadlineAtMs, shutdownSignal: new AbortController().signal,
  }) as unknown as MinionJobContext;

  // Before its deadline (a cancel, a worker shutdown) the abort stays an
  // ordinary error, so the worker's own abort handling decides the row.
  test('an aborted job stops the drain and leaves the cycle lock free', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const err = await makeExtractAtomsDrainHandler(engine)(drainJob(controller.signal)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('shutdown');
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    const held = await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`);
    expect(held).toEqual([]);
  });

  // The abort usually lands while a model call is in flight: the job's signal
  // must reach that call, and the interrupted page must take no failure strike.
  // At the job's deadline (the timeout) the failure is final, so the worker
  // dead-letters it instead of retrying a drain that would hold the lock again.
  test('a timeout during the model call reaches the call, charges no strike and is final', async () => {
    await engine.putPage('notes/abort-probe', {
      type: 'note', title: 'abort probe', compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
    } as never, { sourceId: 'default' });
    const controller = new AbortController();
    const callSignals: Array<AbortSignal | undefined> = [];
    __setChatTransportForTests(async (o) => {
      callSignals.push(o.abortSignal);
      controller.abort(new Error('timeout'));
      throw new Error('claude-cli adapter aborted');
    });
    try {
      const timedOut = makeExtractAtomsDrainHandler(engine)(drainJob(controller.signal, Date.now() - 1));
      await expect(timedOut).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(timedOut).rejects.toThrow('timeout');
    } finally {
      __setChatTransportForTests(null);
    }
    // The call's signal combines the job's with the cycle lock's (#5832).
    expect(callSignals).toHaveLength(1);
    expect(callSignals[0]?.reason).toBe(controller.signal.reason);
    expect(await engine.executeRaw('SELECT page_id FROM extract_atoms_page_state')).toEqual([]);
  });

  // #5832: withRefreshingLock aborts the signal it hands its work when the
  // cycle lock's lease is lost. Without it a batch keeps writing atoms while
  // another cycle holds the lock, including for a caller that passes no signal
  // of its own (gbrain dream --drain).
  test('the cycle lock signal reaches the model call when the caller passes none', async () => {
    await engine.putPage('notes/lock-probe', {
      type: 'note', title: 'lock probe', compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
    } as never, { sourceId: 'default' });
    const callSignals: Array<AbortSignal | undefined> = [];
    __setChatTransportForTests(async (o) => {
      callSignals.push(o.abortSignal);
      throw new Error('provider unavailable');
    });
    try {
      await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120 });
    } finally {
      __setChatTransportForTests(null);
    }
    expect(callSignals.length).toBeGreaterThan(0);
    for (const signal of callSignals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

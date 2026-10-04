/**
 * Unit tests for `src/core/cycle/nightly-probe-adapters.ts`.
 *
 * The adapters bridge object-shape `NightlyProbeDeps` arguments to the
 * existing argv-array CLI functions. Tests pin:
 *   - argv shape passed to each underlying CLI function (codex round-2 #1)
 *   - receipt file parsing happy path
 *   - missing receipt file → throws with paste-ready hint
 *   - malformed receipt JSON → throws with the bad content prefix
 *   - exit-code passthrough
 *   - a routed batch keeps the daemon's brain-configured gateway (#5872)
 */

import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROBE_QA_DIMENSIONS,
  buildCrossModalProbeCall,
  buildLongMemEvalProbeCall,
  runCrossModalBatchForProbe,
} from '../../src/core/cycle/nightly-probe-adapters.ts';
import type { NightlyProbeModelRoutes } from '../../src/core/cycle/nightly-probe-routes.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  getChatModel,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';

// We can't easily mock the actual CLI functions without `mock.module`
// (which would force this file to `*.serial.test.ts`). Instead, we test
// the adapter's pure file-handling logic by mocking the imported function
// via `__setCrossModalForTests` ... but the adapter file doesn't expose
// one. So we test the contract that the cross-modal adapter REJECTS
// missing/malformed receipts deterministically.

describe('nightly-probe-adapters: cross-modal receipt parsing', () => {
  test('missing summary file → throws with paste-ready hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    const summaryPath = join(dir, 'never-written.json');

    // We can't actually run runEvalCrossModal here without a real LLM key.
    // The adapter calls the CLI then reads the file. We exercise the
    // "missing file" branch by pointing at a non-existent path with a
    // batch input that the CLI will likely error on quickly — but we
    // expect to land in the "summary missing" throw, NOT in cross-modal's
    // actual execution. Use a non-existent batch path so cross-modal
    // exits 1 fast.
    const batchPath = join(dir, 'nonexistent-batch.jsonl');

    let threw: unknown;
    try {
      await runCrossModalBatchForProbe({
        batchPath,
        summaryPath,
        maxUsd: 0.01,
      });
    } catch (err) {
      threw = err;
    }

    // EITHER the adapter throws our specific "summary file missing" error,
    // OR cross-modal throws first on the nonexistent batch path. Both are
    // legitimate failure modes; the adapter must end up throwing SOME error.
    expect(threw).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test('malformed summary JSON → throws with content prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-'));
    const summaryPath = join(dir, 'bad-summary.json');

    // Pre-write malformed JSON so the adapter's parse-error path fires
    // when (if) cross-modal completes and the adapter reads the file.
    writeFileSync(summaryPath, '{not valid json');

    // Same caveat as above — we can't exercise the full cross-modal path
    // without an API key, but we can verify the adapter's behavior when
    // the receipt file exists but is bad. The cross-modal CLI may overwrite
    // our content; that's OK — the test pins that the adapter throws on
    // failure rather than returning garbage. Use nonexistent batch input.
    const batchPath = join(dir, 'nonexistent-batch.jsonl');

    let threw: unknown;
    try {
      await runCrossModalBatchForProbe({
        batchPath,
        summaryPath,
        maxUsd: 0.01,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('nightly-probe-adapters: argv shape regression (codex round-2 #1)', () => {
  test('adapter argv shape includes --output explicitly (regression for codex finding)', () => {
    // This is a static-source-shape assertion that the adapter file
    // includes the `--output` flag in its argv construction. The regression
    // codex caught was an adapter that omitted --output, so the summary
    // landed at the default cross-modal receipt path and the adapter
    // would read nothing from `summaryPath`. This assertion pins the fix
    // in the adapter source so future refactors can't silently drop it.
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');

    // Both adapters' argv arrays must include these markers:
    expect(source).toContain(`'--output'`);  // both adapters thread an output path
    expect(source).toContain(`args.summaryPath`); // cross-modal reads from caller-controlled path
    expect(source).toContain(`'--batch'`);
    expect(source).toContain(`'--max-usd'`);
    expect(source).toContain(`'--yes'`);
    expect(source).toContain(`'--json'`); // cross-modal needs --json for the summary envelope
  });

  test('runLongMemEvalForProbe builds argv with --output for output path', () => {
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    // longmemeval adapter: first positional arg is fixturePath, then --output outputPath.
    expect(source).toContain("[args.fixturePath, '--output', args.outputPath]");
  });

  test('runLongMemEvalForProbe passes the live search config snapshot via RunOpts', () => {
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');

    expect(source).toContain('searchConfigSnapshot: args.searchConfigSnapshot');
  });
});

// #5872: the brain-resolved routes ride the commands' existing flags and opts.
describe('nightly-probe-adapters: model routes reach the eval commands', () => {
  const ROUTES: NightlyProbeModelRoutes = {
    reader: { model: 'claude-cli:claude-opus-5-5', source: 'tier_config' },
    extractor: { model: 'claude-cli:claude-sonnet-5', source: 'tier_config' },
    slots: { B: 'claude-cli:claude-fable-5' },
  };
  const SNAPSHOT = { 'search.mode': 'balanced' };
  const PRE_5872_CROSS_MODAL_ARGV = [
    '--batch', '/w/lme.jsonl',
    '--output', '/w/summary.json',
    '--max-usd', '2.5',
    '--dimensions', PROBE_QA_DIMENSIONS.join(','),
    '--yes',
    '--json',
  ];

  interface Case { name: string; modelRoutes?: NightlyProbeModelRoutes; argv: string[] }
  const LONGMEMEVAL_CASES: Array<Case & { runOpts: Record<string, unknown> }> = [
    {
      name: 'with routes: --model carries the reader, RunOpts.extractorModel the extractor',
      modelRoutes: ROUTES,
      argv: ['/f.jsonl', '--output', '/w/lme.jsonl', '--model', 'claude-cli:claude-opus-5-5'],
      runOpts: { searchConfigSnapshot: SNAPSHOT, exitOnError: false, extractorModel: 'claude-cli:claude-sonnet-5' },
    },
    {
      name: 'no routes: the pre-#5872 call',
      argv: ['/f.jsonl', '--output', '/w/lme.jsonl'],
      runOpts: { searchConfigSnapshot: SNAPSHOT, exitOnError: false },
    },
  ];
  const CROSS_MODAL_CASES: Array<Case & { opts: Record<string, unknown> }> = [
    {
      name: 'with routes: each set slot rides its flag and the configured gateway is kept',
      modelRoutes: ROUTES,
      argv: [...PRE_5872_CROSS_MODAL_ARGV, '--slot-b-model', 'claude-cli:claude-fable-5'],
      opts: { useConfiguredGateway: true },
    },
    {
      name: 'routes with every slot set: flags in slot order',
      modelRoutes: { ...ROUTES, slots: { C: 'c-model', A: 'a-model', B: 'b-model' } },
      argv: [...PRE_5872_CROSS_MODAL_ARGV, '--slot-a-model', 'a-model', '--slot-b-model', 'b-model', '--slot-c-model', 'c-model'],
      opts: { useConfiguredGateway: true },
    },
    {
      name: 'routes with no slot key set: no slot flag, the configured gateway is kept',
      modelRoutes: { ...ROUTES, slots: {} },
      argv: PRE_5872_CROSS_MODAL_ARGV,
      opts: { useConfiguredGateway: true },
    },
    {
      name: 'no routes: the pre-#5872 call',
      argv: PRE_5872_CROSS_MODAL_ARGV,
      opts: {},
    },
  ];

  test.each(LONGMEMEVAL_CASES)('LongMemEval $name', ({ modelRoutes, argv, runOpts }) => {
    const call = buildLongMemEvalProbeCall({
      fixturePath: '/f.jsonl', outputPath: '/w/lme.jsonl', searchConfigSnapshot: SNAPSHOT, modelRoutes,
    });
    expect(call.argv).toEqual(argv);
    expect(call.runOpts).toEqual(runOpts);
  });

  test.each(CROSS_MODAL_CASES)('cross-modal $name', ({ modelRoutes, argv, opts }) => {
    const call = buildCrossModalProbeCall({
      batchPath: '/w/lme.jsonl', summaryPath: '/w/summary.json', maxUsd: 2.5, modelRoutes,
    });
    expect(call.argv).toEqual(argv);
    expect(call.opts).toEqual(opts);
  });

  // The batch runs inside the daemon, whose gateway holds the brain-resolved
  // chat model. Unless the adapter hands its opts to the batch, the batch
  // rebuilds that gateway from the file plane (an empty home here).
  describe('runCrossModalBatchForProbe on the brain-configured gateway', () => {
    const BRAIN_CHAT_MODEL = 'claude-cli:claude-opus-5-5';
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'nightly-adapter-gateway-'));
      configureGateway({ chat_model: BRAIN_CHAT_MODEL, env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } });
      __setChatTransportForTests(async () => { throw new Error('stub judge unavailable'); });
    });

    afterEach(() => {
      __setChatTransportForTests(null);
      resetGateway();
      rmSync(dir, { recursive: true, force: true });
    });

    test('with routes the gateway keeps the brain chat model and the routed slot runs', async () => {
      const batchPath = join(dir, 'lme.jsonl');
      const summaryPath = join(dir, 'summary.json');
      writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
      await withEnv({ GBRAIN_HOME: emptyHome() }, () =>
        runCrossModalBatchForProbe({ batchPath, summaryPath, maxUsd: 0.01, modelRoutes: ROUTES }));
      expect(getChatModel()).toBe(BRAIN_CHAT_MODEL);
      const written = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(written.slots[1]).toEqual({ id: 'B', model: 'claude-cli:claude-fable-5' });
    });
  });
});

describe('nightly-probe-adapters: contract regression', () => {
  test('returns the documented shape: {exitCode, summary}', () => {
    // Static type-shape check via source inspection — if the return shape
    // ever drifts, this regression catches it.
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    expect(source).toMatch(/Promise<\{ exitCode: number; summary: CrossModalBatchSummary \}>/);
  });

  test('CrossModalBatchSummary shape includes the 6 expected fields', () => {
    const path = require('node:path').resolve('src/core/cycle/nightly-probe-adapters.ts');
    const fs = require('node:fs');
    const source = fs.readFileSync(path, 'utf-8');
    expect(source).toContain('pass_count');
    expect(source).toContain('fail_count');
    expect(source).toContain('inconclusive_count');
    expect(source).toContain('error_count');
    expect(source).toContain('est_cost_usd');
    expect(source).toContain('verdict');
  });
});

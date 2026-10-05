/**
 * #5964: generatePerChunkSynopsis classifies a thrown chat() error by its HTTP
 * status and its timeout or abort signal, wherever the gateway's normalized
 * error carries them.
 *
 * 1. Protects the D27 P1-2 dispatch: a rate limit, an auth failure, a
 *    provider outage or a timed-out call must not classify as `malformed`,
 *    because `malformed` makes the service re-embed the whole page at the
 *    `title` tier and the job report success.
 * 2. Fails when the classifier reads only the top-level error: the claude-cli
 *    provider carries its status as `apiErrorStatus`, AI SDK providers carry
 *    `statusCode` on the wrapped error (`cause`, then RetryError's `lastError`
 *    once the SDK's retries are spent), an AI SDK timeout keeps its
 *    `TimeoutError` name on `cause`, and the claude-cli adapter rejects an
 *    aborted call with a plain "claude-cli adapter aborted" error.
 * 3. The existing synopsis tests stub chat() whole, so no thrown error ever
 *    passed through normalizeAIError on its way to the classifier.
 * 4. No new seam: it drives the real chat() through the existing
 *    generateText transport seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { generatePerChunkSynopsis } from '../src/core/page-summary.ts';
import type { SynopsisFailureKind } from '../src/core/audit-synopsis.ts';
import {
  __setGenerateTextTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { ClaudeCliProcessError } from '../src/core/ai/providers/claude-cli-language-model.ts';

const CLAUDE_CLI = 'claude-cli:claude-haiku-4-5';
const ANTHROPIC_API = 'anthropic:claude-haiku-4-5';

function claudeCliError(status: number | undefined, text: string): ClaudeCliProcessError {
  const message = status === undefined ? text : `claude-cli API error ${status}: ${text}`;
  return new ClaudeCliProcessError(message, { apiErrorStatus: status, exitCode: 1 });
}

function sdkError(statusCode: number): APICallError {
  return new APICallError({
    message: `synthetic provider error ${statusCode}`,
    url: 'https://provider.example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

/** The AI SDK's shape once its retries on a retryable status are spent. */
function sdkRetriesExhausted(statusCode: number): RetryError {
  const errors = [sdkError(statusCode), sdkError(statusCode), sdkError(statusCode)];
  return new RetryError({
    message: `Failed after 3 attempts. Last error: synthetic provider error ${statusCode}`,
    reason: 'maxRetriesExceeded',
    errors,
  });
}

beforeEach(() => {
  configureGateway({ env: { ANTHROPIC_API_KEY: 'fake-anthropic' } });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('generatePerChunkSynopsis classifies thrown chat errors by status and timeout (#5964)', () => {
  const cases: Array<{ name: string; model: string; error: () => unknown; kind: SynopsisFailureKind }> = [
    { name: 'claude-cli subscription limit (429)', model: CLAUDE_CLI, error: () => claudeCliError(429, "You've hit your session limit · resets 3:00am (UTC)"), kind: 'rate_limit' },
    { name: 'claude-cli rejected credentials (401)', model: CLAUDE_CLI, error: () => claudeCliError(401, 'Invalid authentication credentials'), kind: 'auth_failure' },
    { name: 'claude-cli forbidden (403)', model: CLAUDE_CLI, error: () => claudeCliError(403, 'Request not allowed'), kind: 'auth_failure' },
    { name: 'claude-cli overloaded (529)', model: CLAUDE_CLI, error: () => claudeCliError(529, 'Overloaded'), kind: 'provider_5xx' },
    { name: 'claude-cli failure with no status', model: CLAUDE_CLI, error: () => claudeCliError(undefined, 'claude-cli returned an unexpected result'), kind: 'malformed' },
    { name: 'API provider rejected key (401, not retried)', model: ANTHROPIC_API, error: () => sdkError(401), kind: 'auth_failure' },
    { name: 'API provider rate limit after retries (429)', model: ANTHROPIC_API, error: () => sdkRetriesExhausted(429), kind: 'rate_limit' },
    { name: 'API provider outage after retries (529)', model: ANTHROPIC_API, error: () => sdkRetriesExhausted(529), kind: 'provider_5xx' },
    { name: 'API provider request-shaped 400', model: ANTHROPIC_API, error: () => sdkError(400), kind: 'malformed' },
    // The reason AbortSignal.timeout() rejects with when the gateway's default chat timeout fires.
    { name: 'API provider call timed out', model: ANTHROPIC_API, error: () => new DOMException('The operation timed out.', 'TimeoutError'), kind: 'timeout' },
    { name: 'API provider call aborted', model: ANTHROPIC_API, error: () => new DOMException('The operation was aborted.', 'AbortError'), kind: 'timeout' },
    { name: 'claude-cli call timed out or aborted', model: CLAUDE_CLI, error: () => new Error('claude-cli adapter aborted'), kind: 'timeout' },
  ];

  for (const c of cases) {
    test(`${c.name} -> ${c.kind}`, async () => {
      __setGenerateTextTransportForTests((async () => {
        throw c.error();
      }) as never);

      const result = await generatePerChunkSynopsis({
        documentText: 'Full document text about widget-co.',
        chunkText: 'The chunk about the widget-co launch.',
        pageTitle: 'Widget Co',
        pageSlug: 'companies/widget-co',
        sourceId: 'default',
        chunkIndex: 0,
        model: c.model,
      });

      expect(result.kind).toBe(c.kind);
    });
  }
});

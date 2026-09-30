/**
 * #5530: the consumer leaves a fresh single-file Git effect unclaimed for a
 * bounded window so a sequential writer's files publish as one batch, and its
 * idle probe agrees with that claim rule. Tier: plain (fast loop); window
 * cases backdate `updated_at` and never sleep.
 * Postgres arm: test/e2e/persistence-git-coalescing-postgres.test.ts.
 */
import { test } from 'bun:test';
import {
  claimedAtOnceCases, freshGitEffectWaitsOutTheWindow, fullBatchIsNotHeld, gitEffectClaimedAtOnce, oldestGitEffectIsNotHeldByLaterWrites,
  stopPassClaimsOnlySingleFileGitEffects, stopPassEndsWithinItsBudget, stoppingConsumerPublishesHeldGitEffects,
} from './helpers/git-coalescing-scenarios.ts';

// The remote's receive-pack wrapper is a POSIX shell script.
const posix = test.skipIf(process.platform === 'win32');
posix('a fresh Git effect waits out the window, then publishes; the idle probe agrees', () => freshGitEffectWaitsOutTheWindow(), 120_000);
for (const scenario of claimedAtOnceCases) posix(scenario.name, () => gitEffectClaimedAtOnce(scenario), 120_000);
posix('the oldest Git effect publishes once it ages, with the fresh effects of a writer that never pauses', () => oldestGitEffectIsNotHeldByLaterWrites(), 120_000);
posix('a full batch of fresh Git effects publishes at once and one fewer stays held', () => fullBatchIsNotHeld(), 180_000);
posix('a consumer stopped inside the window publishes the Git effect it was holding', () => stoppingConsumerPublishesHeldGitEffects(), 120_000);
posix('the stop pass ends within its budget while a push holds the push lock and leaves the effect claimable', () => stopPassEndsWithinItsBudget(), 120_000);
posix('the stop pass claims only single-file Git effects, never embeddings or recoveries', () => stopPassClaimsOnlySingleFileGitEffects(), 120_000);

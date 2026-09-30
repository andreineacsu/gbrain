/**
 * Postgres arms of the Git coalescing window scenarios and the managed
 * grandfather regression (#5530). Each run gets a fresh isolated database from
 * the persistence Postgres helper.
 */
import { describe, test } from 'bun:test';
import {
  claimedAtOnceCases, freshGitEffectWaitsOutTheWindow, fullBatchIsNotHeld, gitEffectClaimedAtOnce, grandfatherPublishesInBatches,
  oldestGitEffectIsNotHeldByLaterWrites, stopPassClaimsOnlySingleFileGitEffects, stopPassEndsWithinItsBudget, stoppingConsumerPublishesHeldGitEffects,
} from '../helpers/git-coalescing-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url || process.platform === 'win32')('Postgres Git coalescing window', () => {
  test('a fresh Git effect waits out the window', () => freshGitEffectWaitsOutTheWindow(url), 180_000);
  for (const scenario of claimedAtOnceCases) test(scenario.name, () => gitEffectClaimedAtOnce(scenario, url), 180_000);
  test('the oldest Git effect is not held by later writes', () => oldestGitEffectIsNotHeldByLaterWrites(url), 180_000);
  test('a full batch publishes at once', () => fullBatchIsNotHeld(url), 180_000);
  test('a consumer stopped inside the window publishes the Git effect it was holding', () => stoppingConsumerPublishesHeldGitEffects(url), 180_000);
  test('the stop pass ends within its budget and leaves the effect claimable', () => stopPassEndsWithinItsBudget(url), 180_000);
  test('the stop pass claims only single-file Git effects', () => stopPassClaimsOnlySingleFileGitEffects(url), 180_000);
  test('managed grandfathering with a slow push publishes in batches', () => grandfatherPublishesInBatches(url), 180_000);
});

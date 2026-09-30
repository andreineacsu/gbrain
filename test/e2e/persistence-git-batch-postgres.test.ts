/**
 * Postgres arms of the batched Git publication scenarios (#5530). Each run
 * gets a fresh isolated database from the persistence Postgres helper.
 */
import { describe, test } from 'bun:test';
import {
  concurrentPushesOnOneWorktreeNeverOverlap, crashAtEveryGitBoundaryResumesWithoutDuplicates, eachEffectKeepsItsOwnOutcome,
  oneCommitAndOnePushForReadyEffects, pushFailureKeepsTheCommitAndRetriesWithoutAnother, pushRunsAfterTheWorktreeLockIsReleased,
  settleFailureCases, settleFailureInABatch, walkPushWaitsForThePushLock,
} from '../helpers/git-batch-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url || process.platform === 'win32')('Postgres batched Git publication', () => {
  test('one commit and one push per batch', () => oneCommitAndOnePushForReadyEffects(url), 180_000);
  test('push outside the worktree lock', () => pushRunsAfterTheWorktreeLockIsReleased(url), 180_000);
  test('per-effect outcomes in one batch', () => eachEffectKeepsItsOwnOutcome(url), 180_000);
  test('push failure retries without a new commit', () => pushFailureKeepsTheCommitAndRetriesWithoutAnother(url), 180_000);
  test('crash at every Git boundary', () => crashAtEveryGitBoundaryResumesWithoutDuplicates(url), 180_000);
  test('concurrent pushes serialize', () => concurrentPushesOnOneWorktreeNeverOverlap(url), 180_000);
  test('walk push takes the push lock', () => walkPushWaitsForThePushLock(url), 180_000);
  for (const scenario of settleFailureCases) test(scenario.name, () => settleFailureInABatch(scenario, url), 180_000);
});

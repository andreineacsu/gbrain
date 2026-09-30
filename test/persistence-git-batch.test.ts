/**
 * #5530: one worker pass publishes every ready single-file Git effect of a
 * worktree in one commit and pushes once, after releasing the worktree lock.
 * Postgres arm: test/e2e/persistence-git-batch-postgres.test.ts.
 */
import { test } from 'bun:test';
import {
  concurrentPushesOnOneWorktreeNeverOverlap, crashAtEveryGitBoundaryResumesWithoutDuplicates, eachEffectKeepsItsOwnOutcome,
  oneCommitAndOnePushForReadyEffects, pushFailureKeepsTheCommitAndRetriesWithoutAnother, pushRunsAfterTheWorktreeLockIsReleased,
  settleFailureCases, settleFailureInABatch, walkPushWaitsForThePushLock,
} from './helpers/git-batch-scenarios.ts';

// The remote's receive-pack wrapper is a POSIX shell script.
const posix = test.skipIf(process.platform === 'win32');
posix('ready Git effects of one worktree publish as one commit and one push', () => oneCommitAndOnePushForReadyEffects(), 120_000);
posix('a publication commits on the worktree while the batch push is still in flight', () => pushRunsAfterTheWorktreeLockIsReleased(), 120_000);
posix('each effect in a batch keeps its own outcome and only the unsafe one parks', () => eachEffectKeepsItsOwnOutcome(), 120_000);
posix('a failed push keeps the batch commit and the retry pushes without another', () => pushFailureKeepsTheCommitAndRetriesWithoutAnother(), 120_000);
posix('a pass stopped at any Git boundary resumes without a duplicate commit', () => crashAtEveryGitBoundaryResumesWithoutDuplicates(), 120_000);
posix('two passes pushing one worktree never overlap and both reach the remote', () => concurrentPushesOnOneWorktreeNeverOverlap(), 120_000);
posix('a walk page push waits for the push lock a batch push holds', () => walkPushWaitsForThePushLock(), 120_000);
for (const scenario of settleFailureCases) posix(scenario.name, () => settleFailureInABatch(scenario), 120_000);

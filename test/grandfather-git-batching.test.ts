/**
 * #5530 regression: managed grandfathering on a hardened worktree with a slow
 * remote runs at database speed and publishes its pages in at most two
 * commits. Tier: plain (fast loop); the wall-time bound is half the unfixed
 * step time, and commit and push counts are the primary assertions.
 * Postgres arm: test/e2e/persistence-git-coalescing-postgres.test.ts.
 */
import { test } from 'bun:test';
import { grandfatherPublishesInBatches } from './helpers/git-coalescing-scenarios.ts';

// The remote's receive-pack wrapper is a POSIX shell script.
test.skipIf(process.platform === 'win32')('managed grandfathering with a slow push publishes pages in batches, not one push per page',
  () => grandfatherPublishesInBatches(), 180_000);

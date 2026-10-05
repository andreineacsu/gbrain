/**
 * #6069 unreliable-judge backoff schedule.
 *
 * 1. Protects: the wait after the Nth consecutive unreliable verdict, and that
 *    the marker row (30-day TTL) outlives every wait, so the attempt count is
 *    still readable when the backoff ends and the next wait can grow.
 * 2. Fails when: a step reaches the row TTL (the marker expires first and the
 *    count resets to 1), or the attempt-to-step mapping stops clamping.
 * 3. runTriagePass tests cover the first two steps through the pass; the cap
 *    and the TTL bound have no other owner.
 * 4. No seam.
 */
import { expect, test } from 'bun:test';
import { UNRELIABLE_BACKOFF_DAYS, unreliableBackoffMs } from '../src/core/cycle/triage-unreliable.ts';
import { DREAM_VERDICT_TTL_SECONDS } from '../src/core/engine.ts';

test('the wait doubles per consecutive failure, the last step repeats, and every step ends before the marker expires', () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(n => unreliableBackoffMs(n) / 86_400_000)).toEqual([3, 3, 6, 12, 24, 24, 24]);
  for (const days of UNRELIABLE_BACKOFF_DAYS) expect(days * 86_400).toBeLessThan(DREAM_VERDICT_TTL_SECONDS);
});

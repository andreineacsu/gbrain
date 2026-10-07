/**
 * Notability-filter vocabulary shared by the durable facts-absorb payload
 * writers (backstop.ts queue mode, the persistence facts-backstop effect) and
 * their only reader, the minion handler. #4870: the reader must accept every
 * value a writer can send; `coerceNotabilityFilter` is the validated
 * pass-through (unknown or absent → 'all', the documented default).
 *
 * Import-light on purpose: the persistence outbox reads it without loading
 * the extraction pipeline in backstop.ts.
 */

export const NOTABILITY_FILTERS = ['all', 'high-only', 'medium-and-up'] as const;
export type FactNotabilityFilter = typeof NOTABILITY_FILTERS[number];
export function coerceNotabilityFilter(v: unknown): FactNotabilityFilter {
  return (NOTABILITY_FILTERS as readonly unknown[]).includes(v) ? (v as FactNotabilityFilter) : 'all';
}

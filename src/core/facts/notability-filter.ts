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
import type { BrainEngine } from '../engine.ts';

export const NOTABILITY_FILTERS = ['all', 'high-only', 'medium-and-up'] as const;
export type FactNotabilityFilter = typeof NOTABILITY_FILTERS[number];
export function coerceNotabilityFilter(v: unknown): FactNotabilityFilter {
  return (NOTABILITY_FILTERS as readonly unknown[]).includes(v) ? (v as FactNotabilityFilter) : 'all';
}

/**
 * #6231: which facts the extraction queued by a page write (put_page,
 * capture, edit_page) keeps. The default keeps high and medium facts (life
 * events, major commitments, durable preferences and beliefs) and skips low
 * ones (logistics, routine scheduling). No default cycle phase extracts a
 * page's prose later, so sync's 'high-only' would lose the medium tier for
 * good; 'all' keeps every tier.
 */
export const PAGE_WRITE_NOTABILITY_FILTER_KEY = 'facts.page_write_notability_filter';
export const PAGE_WRITE_NOTABILITY_FILTER_DEFAULT: FactNotabilityFilter = 'medium-and-up';

function parseNotabilityFilter(raw: string): FactNotabilityFilter | null {
  const value = raw.trim().toLowerCase();
  return (NOTABILITY_FILTERS as readonly string[]).includes(value) ? value as FactNotabilityFilter : null;
}

/** The page-write filter in force; unset, or a value that is not a filter, reads as the default. */
export async function resolvePageWriteNotabilityFilter(engine: Pick<BrainEngine, 'getConfig'>): Promise<FactNotabilityFilter> {
  const raw = await engine.getConfig(PAGE_WRITE_NOTABILITY_FILTER_KEY);
  return (raw == null ? null : parseNotabilityFilter(raw)) ?? PAGE_WRITE_NOTABILITY_FILTER_DEFAULT;
}

/** `config set` validation for the page-write filter; the refusal text, or null when valid. */
export function validateNotabilityFilterConfigValue(key: string, value: string): string | null {
  if (key !== PAGE_WRITE_NOTABILITY_FILTER_KEY || parseNotabilityFilter(value)) return null;
  return `${key} must be ${NOTABILITY_FILTERS.join(', ')} (which facts a page write's extraction keeps; default ${PAGE_WRITE_NOTABILITY_FILTER_DEFAULT}) (got '${value}'). Nothing was written.`;
}

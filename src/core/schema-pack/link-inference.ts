// v0.38 T7b: pack-aware link verb inference.
//
// The pre-v0.38 `inferLinkType` (in src/core/link-extraction.ts) uses
// rich production regexes (FOUNDED_RE / INVESTED_RE / ADVISES_RE /
// WORKS_AT_RE / PARTNER_ROLE_RE / ADVISOR_ROLE_RE / EMPLOYEE_ROLE_RE)
// that are highly tuned against real brain content. Reproducing these
// in gbrain-base.yaml literally would require multi-line YAML escape
// jujitsu and lose the in-source comments documenting WHY each pattern
// is shaped the way it is.
//
// Pragmatic split: gbrain-base.yaml carries verb NAMES + simplified
// SKETCH regexes (sufficient for documentation + community-pack
// authors who want to copy the pattern); the production regexes stay
// where they are in link-extraction.ts. `inferLinkTypeFromPack`
// CONSULTS pack-declared verbs IN ADDITION TO the in-code matchers —
// it does not REPLACE them. User packs ADD verbs (e.g.
// `weakens`, `supports`, `replicates`) by declaring
// `link_types[].inference.regex` in their manifest; those run under
// the v0.38 ReDoS guard.
//
// Resolution order (matches legacy inferLinkType where applicable):
//   1. Page-type-bound verbs from pack (e.g. meeting → attended,
//      image → image_of). Declared via `inference.page_type` on the
//      pack link_type entry.
//   2. Pack-declared regex matchers (in declaration order from the
//      manifest; first match wins). Runs under PageRegexBudget for
//      ReDoS protection. A rule marked `ner_only` runs only for NER
//      (`opts.ner`): the bundled packs' sketch regexes label NER body
//      mentions but never override markdown links (#5882).
//   3. Fall-through to the caller's legacy `inferLinkType` for
//      gbrain-base's production-quality matching of founded /
//      invested_in / advises / works_at + page-role priors.
//
// Callers that want pack-aware behavior wrap their inference call:
//   const packVerb = inferLinkTypeFromPack(pack, pageType, context, budget, targetType);
//   if (packVerb) return packVerb;
//   return inferLinkType(pageType, context, globalContext, targetSlug, targetType, anchor, pack);
//
// Pack-driven verbs WIN over legacy inference because users opt into
// them deliberately; legacy fall-through covers the gbrain-base
// universe.

import type { SchemaPackManifest } from './manifest-v1.ts';
import { PageRegexBudget, runRegexBounded } from './redos-guard.ts';
import { classifyStoredType } from './type-usage.ts';

/**
 * #6191: can employment wording type a link from a page of `pageType` to a
 * target of `targetType` as `works_at`? The rule reads what the link points
 * at. A dated record is never an employer or an employee, so a target that is
 * a meeting, or any type the pack declares with the `temporal` primitive
 * (deal, email, conversation), is refused. A person target is refused unless
 * the page can be the employer: graph reads flip the row an employer's page
 * stores toward one of its people (search/read-enrichment.ts), while a person
 * or a dated record naming a person has no employer on either end. Aliases
 * resolve to their canonical type. A target of unknown type and every other
 * pairing keep the verb, a dated page naming an organization included: a path
 * no pack prefix maps is typed `concept`, so an organization filed there keeps
 * its employment edges.
 */
export function employmentFits(
  pageType: string,
  targetType: string | null | undefined,
  pack?: Partial<Pick<SchemaPackManifest, 'page_types'>> | null,
): boolean {
  if (!targetType) return true;
  const types = pack?.page_types ?? [];
  const side = (type: string): 'person' | 'temporal' | 'other' => {
    const cls = classifyStoredType(type, { page_types: types });
    const canonical = cls.kind === 'alias_of' ? cls.canonical : type;
    if (canonical === 'person') return 'person';
    return canonical === 'meeting' || types.find(t => t.name === canonical)?.primitive === 'temporal' ? 'temporal' : 'other';
  };
  const target = side(targetType);
  return target === 'other' || (target === 'person' && side(pageType) === 'other');
}

/**
 * Try to resolve a link verb from the active pack's declared
 * link_types. Returns the verb name on a match, or null if no
 * pack-declared rule fired (caller should fall through to the
 * legacy inferLinkType for built-in matchers).
 *
 * Pack-declared verbs MAY be the same name as a built-in (e.g. a
 * user pack declares its own `founded` regex tuned for their
 * domain). When the pack regex matches, the pack wins — that's the
 * point of letting users override.
 */
export function inferLinkTypeFromPack(
  pack: Pick<SchemaPackManifest, 'link_types'>,
  pageType: string,
  context: string,
  budget?: PageRegexBudget,
  targetType?: string,
  opts: { ner?: boolean } = {},
): string | null {
  const rules = [
    ...pack.link_types.filter(lt => lt.inference?.page_type),
    ...pack.link_types.filter(lt => !lt.inference?.page_type),
  ];
  for (const lt of rules) {
    const rule = lt.inference;
    if (!rule || (!rule.page_type && !rule.target_type && !rule.regex)) continue;
    // #5882: an NER-only sketch regex never pre-empts the tuned markdown matchers.
    if (rule.ner_only && !opts.ner) continue;
    if (rule.page_type && rule.page_type !== pageType) continue;
    if (rule.target_type && rule.target_type !== targetType) continue;
    const pattern = rule.regex;
    if (!pattern) return lt.name;
    if (budget) {
      const match = budget.runBounded(lt.name, pattern, context);
      if (match === undefined) {
        // Budget exhausted — caller's surrounding logic falls through
        // to mentions per design.
        return null;
      }
      if (match !== null) return lt.name;
    } else {
      // No budget provided (test contexts) — still route through the bounded
      // executor so the v0.41.37.0 #1569 input-length cap + vm timeout apply.
      // Previously this ran `new RegExp(pattern).test(context)` UNBOUNDED, the
      // one ReDoS hole with no timeout. runRegexBounded throws on
      // timeout/oversize/malformed → skip and continue (degrade to mentions).
      try {
        if (runRegexBounded(pattern, context) !== null) return lt.name;
      } catch {
        // Timed out, oversize input, or malformed pattern — skip and continue.
        // Pack validation + the star-height lint rule surface bad patterns.
      }
    }
  }
  return null;
}

/**
 * True when a pack decides meeting attendance itself: one of its `attended`
 * rules matches a phrase regex. A rule bound only to the meeting page type
 * (and optionally a person target), as gbrain-base and company-brain ship,
 * mirrors the in-code meeting prior, so meeting links follow canonical
 * evidence-gated attendance (person -> meeting) instead.
 */
export function ownsAttendanceInference(pack: Pick<SchemaPackManifest, 'link_types'> | null | undefined): boolean {
  return !!pack?.link_types.some(lt => lt.name === 'attended' && lt.inference?.regex);
}

/**
 * Frontmatter-field → link-verb resolution from a pack manifest.
 * Mirrors the legacy `FRONTMATTER_LINK_MAP` table; pack-aware variant
 * walks `pack.frontmatter_links[]` instead of the hardcoded array.
 *
 * Returns the link-type name for the matching (page_type, field)
 * combination, or null if no rule fires. Order: pack manifest order
 * (first match wins).
 */
export function frontmatterLinkTypeFromPack(
  pack: Pick<SchemaPackManifest, 'frontmatter_links'>,
  pageType: string | undefined,
  fieldName: string,
): string | null {
  for (const fl of pack.frontmatter_links) {
    if (fl.page_type !== undefined && fl.page_type !== pageType) continue;
    if (fl.fields.includes(fieldName)) return fl.link_type;
  }
  return null;
}

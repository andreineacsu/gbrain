/**
 * #6302: quote grounding for the timeline entries a patterns child appended to
 * a pattern page with add_timeline_entry.
 *
 * Each entry is found by the block its writer rendered for it
 * (`renderTimelineEntry`, below the entry's materialized marker on a dream
 * page), as a whole entry: a match followed by indented detail lines is the
 * head of a longer entry, not this one. Each entry is checked on its own, with
 * its quotes paired within its own block, so the entries and the body earlier
 * runs grounded against their own reflections are not judged again.
 *
 * An entry with a failing quote is removed from the timeline in one piece
 * (marker, bullet, detail) and becomes one quarantined claim: removing its
 * bullet alone would hand its detail lines to the entry above. A passing entry
 * keeps the verifier's quote repairs, under a marker for its repaired tuple.
 */
import { renderTimelineEntry, type TimelineEntryWriteInput } from '../timeline-write-through.ts';
import { extractTimelineFromContent } from '../timeline-extract.ts';
import { materializedMarker } from '../timeline-marker.ts';
import { clip, verifyBody, type BodyVerification, type GroundedSource } from './synthesize-verify.ts';

/** Same bound as verifyBody's quarantined units. */
const MAX_CLAIM_TEXT_CHARS = 2000;
/** An indented continuation line: the detail of the bullet above it. */
const DETAIL_LINE = /^[ \t]{2,}\S/;

/** First offset where `block` is a whole entry of `text` (whole lines, no detail line after it), or -1. */
function entryIndexOf(text: string, block: string): number {
  for (let at = text.indexOf(block); at >= 0; at = text.indexOf(block, at + 1)) {
    const end = at + block.length;
    if ((at === 0 || text[at - 1] === '\n') && (end === text.length || (text[end] === '\n' && !DETAIL_LINE.test(text.slice(end + 1))))) return at;
  }
  return -1;
}

/**
 * Ground `entries` where they sit in `timeline`. Returns the timeline with
 * failing entries removed and repairs applied, in verifyBody's result shape.
 * An entry no longer on the page is skipped.
 */
export function groundAppendedEntries(timeline: string, slug: string, entries: TimelineEntryWriteInput[], sources: GroundedSource[]):
  Pick<BodyVerification, 'body' | 'quarantined' | 'normalized' | 'near'> {
  let body = timeline;
  const result: Pick<BodyVerification, 'quarantined' | 'normalized' | 'near'> = { quarantined: [], normalized: 0, near: 0 };
  for (const entry of entries) {
    const rendered = renderTimelineEntry(entry, slug);
    const at = rendered ? entryIndexOf(body, rendered.block) : -1;
    if (!rendered || at < 0) continue;
    const marker = `${materializedMarker(rendered.canonical)}\n`;
    const start = body.slice(0, at).endsWith(marker) && (at === marker.length || body[at - marker.length - 1] === '\n') ? at - marker.length : at;
    const end = at + rendered.block.length;
    const checked = verifyBody(rendered.block, sources, { checks: 'quotes' });
    if (checked.quarantined.length > 0) {
      result.quarantined.push({ text: clip(rendered.block.replace(/^- /, ''), MAX_CLAIM_TEXT_CHARS),
        reason: checked.quarantined[0]!.reason, detail: checked.quarantined.map(claim => claim.detail).join('; ') });
      body = body.slice(0, start) + body.slice(body[end] === '\n' ? end + 1 : end);
      continue;
    }
    if (!checked.changed) continue;
    result.normalized += checked.normalized;
    result.near += checked.near;
    const [repaired] = extractTimelineFromContent(checked.body, slug);
    const remark = start < at && repaired ? `${materializedMarker(repaired)}\n` : body.slice(start, at);
    body = body.slice(0, start) + remark + checked.body + body.slice(end);
  }
  return { body, ...result };
}

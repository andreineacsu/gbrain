import { stripCodeBlocks } from './markdown-code.ts';

const CITATION_TIMELINE_RE = /\[Source:\s*([^\]]+?,\s*\d{4}-\d{2}-\d{2})\s*\]/g;
// One `source, YYYY-MM-DD` of a citation body (#6226). A `;` separates sources
// only right after a date, so a `;` inside a source name stays in it.
const CITATION_SOURCE_RE = /[\s;]*(.+?),\s*(\d{4}-\d{2}-\d{2})\s*(?:;|$)/gs;

export interface InlineCitationTimelineCandidate {
  date: string;
  source: string;
  summary: string;
}

interface CitationParagraph {
  text: string;
}

type CitationOpts = { skipLine?: (line: string) => boolean };

function startsMarkdownBlock(line: string): boolean {
  return /^#{1,6}\s/.test(line) || /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

/**
 * `content` with code and every closed HTML comment masked (#6184). Masking
 * keeps offsets and line breaks. An unclosed `<!--` stays text and hides
 * nothing, as before: CommonMark renders one inside a line literally.
 */
function visibleText(content: string): string {
  let unclosed = -1;
  const masked = stripCodeBlocks(content, { onHtmlComment: (start) => {
    if (content.indexOf('-->', start + 4) === -1) unclosed = start;
  } });
  return unclosed === -1 ? masked : masked.slice(0, unclosed) + stripCodeBlocks(content.slice(unclosed));
}

function citationParagraphs(content: string, opts: CitationOpts): CitationParagraph[] {
  const paragraphs: CitationParagraph[] = [];
  let lines: string[] = [];
  let skippedBlock = false;

  const flush = () => {
    if (lines.length === 0) return;
    paragraphs.push({ text: lines.map((line) => line.trim()).join(' ') });
    lines = [];
  };

  const codeOnly = stripCodeBlocks(content).split(/\r?\n/);
  visibleText(content).split(/\r?\n/).forEach((line, i) => {
    if (line.trim().length === 0) {
      // A comment-only line drops out without ending the paragraph, so a
      // citation keeps the text it annotates across one.
      if (codeOnly[i].trim().length === 0) flush();
      return;
    }
    if (opts.skipLine?.(line)) {
      flush();
      skippedBlock = true;
      return;
    }
    // Continuations belong to the already-indexed bullet, including citations.
    if (skippedBlock && /^\s/.test(line)) { flush(); return; }
    skippedBlock = false;
    if (lines.length > 0 && startsMarkdownBlock(line)) flush();
    lines.push(line);
  });
  flush();

  return paragraphs;
}

/** Each `source, date` of one citation body with a non-empty source (#6226). */
function citationSources(body: string): Array<{ date: string; source: string }> {
  return [...body.matchAll(CITATION_SOURCE_RE)]
    .map((m) => ({ date: m[2], source: m[1].trim().slice(0, 200) }))
    .filter((s) => s.source);
}

/**
 * Paired Markdown emphasis unwrapped to its text (#6226): `**strong**`,
 * `__strong__`, `*em*`, `_em_`. A star with a space after it or an underscore
 * inside a word (snake_case) is not emphasis. A pair cannot span a marker of
 * its own kind, so nested emphasis (`**a (*b*)**`) unwraps over a few passes.
 */
function stripEmphasis(text: string): string {
  for (let pass = 0; pass < 3; pass++) {
    const next = text
      .replace(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*/g, '$1')
      .replace(/(?<!\w)__([^_\s](?:[^_]*[^_\s])?)__(?!\w)/g, '$1')
      .replace(/(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1')
      .replace(/(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1');
    if (next === text) break;
    text = next;
  }
  return text;
}

export function parseInlineCitationTimelineEntries(
  content: string,
  opts: { skipLine?: (line: string) => boolean } = {},
): InlineCitationTimelineCandidate[] {
  const result: InlineCitationTimelineCandidate[] = [];
  // #6184: HTML comments are markup, never part of a summary.
  for (const paragraph of citationParagraphs(content, opts)) {
    const matches = [...paragraph.text.matchAll(CITATION_TIMELINE_RE)];
    if (matches.length === 0) continue;
    const text = paragraph.text.replace(/\[Source:[^\]]*\](?:\((?:[^()]|\([^()]*\))*\))?/g, '');
    const summary = stripEmphasis(text)
      .replace(/^[-*>#\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!summary) continue;
    for (const m of matches) {
      for (const { date, source } of citationSources(m[1])) {
        if (isValidDate(date)) result.push({ date, source, summary });
      }
    }
  }
  return result;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(new Date(0).setUTCFullYear(y, mo - 1, d)); // not Date.UTC: it maps years 0-99 to 1900-1999
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

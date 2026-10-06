/**
 * Retrieval Reflex — pure entity-salience extractor (issue #1981, Layer 1).
 *
 * Zero-LLM, zero-DB, SDK-free. Scans ONE turn's user text for candidate entity
 * surface-forms (capitalized token runs, @handles) that are worth resolving
 * against the brain index. The context engine runs this on every turn before
 * touching the brain, so it must be fast (one regex pass) and precision-biased:
 * a false candidate costs a wasted resolve and, worse, a misleading pointer.
 *
 * DELIBERATE limits (documented, not bugs — see issue #1981 / eng-review;
 * updated for the v0.46.15 identity wave + #3746 CJK pass):
 *   - Lowercase Latin names emit as WEAK candidates (v0.46.15 — resolved via
 *     the alias arm only); CJK names emit as weak n-grams (#3746). Still out
 *     of scope: pure-hiragana grams, caseless non-CJK scripts (Arabic,
 *     Hebrew, Devanagari, Thai — \\p{Lo} is invisible to both passes), and
 *     lowercase SURNAME-only mentions (weak candidates never reach the
 *     surname arm; see retrieval-reflex.ts).
 *   - A lowercase name of 2-3 words also emits whole, as a weak PHRASE
 *     candidate (#6195): alias arm, plus an exact unique entity-page title.
 *     A name written part capitalized, part lowercase ("Alice example") is
 *     not joined into one phrase.
 *   - extractCandidates is single-turn. The v0.43 (#2095) window layer
 *     (extractCandidatesFromWindow) widens extraction across the last N turns
 *     — assistant-introduced entities and "what about her?" follow-ups whose
 *     antecedent was NAMED in the window now resolve; true pronoun
 *     coreference (never-named antecedents) remains out of scope.
 * Do NOT market this as full "human-like recall". (BrainBench receipt: the
 * v1 know-to-ask failure rate 0.150 measured against these limits went to
 * 0.0000 after the v0.46.15 arms — evals/brainbench/baselines/main.json.)
 *
 * Resolution (alias/slug lookup) lives in retrieval-reflex.ts; this module only
 * decides WHAT to look up.
 */

import { normalizeAlias } from '../search/alias-normalize.ts';
import { CJK_SLUG_CHARS, hasCJK } from '../cjk.ts';

export interface EntityCandidate {
  /** Surface form for the pointer label, e.g. "Garry Tan" or "@garry". */
  display: string;
  /** Text fed to alias-normalize / slugify for resolution (no leading @, no possessive). */
  query: string;
  /**
   * Lowercase weak candidate (v0.46.15 identity wave). Emitted by the
   * lowercase pass for turns like "remind me what saoirse said" — the v1
   * capitalization-biased extractor was blind to these (the documented
   * know-to-ask limit). Weak candidates are resolution-restricted: the
   * resolver may probe them against the ALIAS table only (exact, unique,
   * live-page-verified) — never title/slug/suffix arms — so ordinary
   * lowercase words cannot fabricate pointers. A weak PHRASE (2-3 lowercase
   * words, #6195) may additionally match an entity page's title exactly.
   */
  weak?: true;
  /**
   * Single-token strong candidate seen capitalized only at the start of a
   * sentence, so the capital is no evidence that it is a name ("Met", "Raised").
   */
  sentenceStart?: true;
}

/** Max STRONG candidates returned per turn — bounds downstream DB work regardless of pointer cap. */
export const MAX_CANDIDATES = 12;

/**
 * Max lowercase WEAK candidates per turn. Separate budget from
 * MAX_CANDIDATES (weak tokens never evict or crowd out strong ones); the
 * resolver caps on alias HITS, not raw tokens, so this only bounds the
 * batched alias probe size.
 */
export const MAX_WEAK_CANDIDATES = 32;

/**
 * Max lowercase WEAK PHRASE candidates per turn (#6195): 2-3 adjacent
 * lowercase words ("alice example"), probed whole. Own budget, so phrases
 * never take a slot from single weak tokens or strong candidates. Two windows
 * start at each word, so twice the single-token budget covers the same span
 * of text. The resolver only ever matches a phrase exactly (alias, or a
 * unique entity-page title), so the cap bounds the size of the batched
 * probes, not their number.
 */
export const MAX_WEAK_PHRASE_CANDIDATES = 2 * MAX_WEAK_CANDIDATES;

/**
 * Max CJK weak n-gram candidates per turn (#3746). CJK names have no
 * capitalization signal and no whitespace tokenization, so the strong pass
 * (\p{Lu}-anchored) and the lowercase weak pass (\p{Ll}-anchored) are both
 * blind to them — 田中/김철수/王小明 extracted ZERO candidates pre-fix.
 * Own budget: n-grams are noisier than lowercase words, and the resolver
 * restricts them to exact-evidence arms (alias / exact-title / exact-slug),
 * so the cap only bounds probe size.
 */
export const MAX_CJK_WEAK_CANDIDATES = 24;

/**
 * HARD stopwords — function words that are never an entity, even capitalized
 * mid-sentence. Pronouns, articles/determiners, auxiliaries, conjunctions,
 * and the most common sentence openers. Compared in lowercase.
 */
const STOPWORDS = new Set<string>([
  // pronouns
  'i', "i'm", "i've", "i'll", 'you', "you're", 'he', 'she', 'it', "it's", 'we', "we're",
  'they', "they're", 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'their', 'our',
  'mine', 'yours', 'hers', 'theirs', 'ours', 'this', 'that', 'these', 'those', 'who', 'whom',
  // articles / determiners / conjunctions / prepositions (common openers)
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'as', 'at', 'by', 'for', 'in', 'of',
  'on', 'to', 'up', 'with', 'from', 'into', 'over', 'than', 'then', 'also', 'just',
  // question words / auxiliaries
  'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had',
  // greetings / discourse markers / polite openers
  'hi', 'hey', 'hello', 'thanks', 'thank', 'please', 'yes', 'no', 'ok', 'okay', 'sure',
  'maybe', 'well', 'oh', 'let', "let's", 'lets',
]);

/**
 * SOFT common words — frequent non-entity words that DO get capitalized at
 * sentence start. Dropped only when a single-token candidate appears solely at
 * sentence start (and is never seen capitalized mid-sentence, which would be a
 * strong name signal). Weekdays/months/time words live here. Compared lowercase.
 */
const COMMON_WORDS = new Set<string>([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'yesterday', 'now', 'soon', 'later', 'tonight', 'morning',
  'afternoon', 'evening', 'week', 'month', 'year', 'meeting', 'call', 'note', 'task',
  'here', 'there', 'every', 'some', 'any', 'all', 'one', 'two', 'three', 'first', 'last',
  'next', 'new', 'old', 'good', 'bad', 'great', 'nice', 'thing', 'something', 'anything',
]);

/** True for frequent non-entity words (weekdays, months, time words) that get capitalized. */
export function isCommonCapitalizedWord(token: string): boolean {
  return COMMON_WORDS.has(token.toLowerCase());
}

const HANDLE_RE = /@([A-Za-z0-9_]{2,})/g;
// Capitalized token runs: an uppercase-initial word, up to 4 tokens total.
// A token allows internal letters/digits/apostrophes/hyphens, plus internal
// dots ONLY when followed by a letter (so "U.S." keeps its dot but a
// sentence-ending "Apple." does NOT glue into the next sentence's word).
const CAP_TOKEN = `\\p{Lu}[\\p{L}0-9'’\\-]*(?:\\.\\p{L}[\\p{L}0-9'’\\-]*)*`;
const CAP_RUN_RE = new RegExp(`${CAP_TOKEN}(?:\\s+${CAP_TOKEN}){0,3}`, 'gu');

/** Strip a trailing possessive ("Garry's" → "Garry", "Jones’" → "Jones"). */
function stripPossessive(s: string): string {
  return s.replace(/['’]s$/i, '').replace(/['’]$/i, '');
}

/** True when the match at `idx` is the first non-space char of the text or a sentence. */
function isAtSentenceStart(text: string, idx: number): boolean {
  let i = idx - 1;
  // skip immediate whitespace
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true; // start of text
  // sentence-ending punctuation (or a list bullet / opening bracket) precedes
  return /[.!?:;\n\r•\-(["“]/.test(text[i]);
}

function isPureNumber(s: string): boolean {
  return /^[0-9][0-9.,]*$/.test(s);
}

// Lowercase-initial word of ≥3 chars, whole-word (lookarounds instead of \b —
// \b misbehaves with unicode property classes). The lookbehind also excludes
// @handles (step 1 owns those) and the lowercase TAIL of a capitalized word.
const WEAK_TOKEN_RE = /(?<![\p{L}\p{N}'’@-])\p{Ll}[\p{L}\p{N}'’-]{2,}(?![\p{L}\p{N}'’-])/gu;

// #6195: lowercase PHRASE runs, two or more lowercase-initial words on one
// line with only spaces or tabs between them, so punctuation and line breaks
// end a run. A word here has no 3-char floor ("bo example"): a phrase is only ever
// matched whole. Same leading boundary as WEAK_TOKEN_RE.
const WEAK_PHRASE_WORD = `\\p{Ll}[\\p{L}\\p{N}'’-]*`;
const WEAK_PHRASE_RUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}'’@-])${WEAK_PHRASE_WORD}(?:[^\\S\\r\\n]+${WEAK_PHRASE_WORD})+`,
  'gu',
);
const WEAK_PHRASE_GAP_RE = /[^\S\r\n]+/;

/** True for a lowercase multi-word weak candidate ("alice example", #6195). */
export function isWeakPhrase(c: EntityCandidate): boolean {
  return c.weak === true && /\s/.test(c.query);
}

/**
 * Lowercase PHRASE pass (#6195). A name typed lowercase is usually more than
 * one word ("call alice example"), and the single-token pass can never probe
 * it whole. Every 2-3 word window of each lowercase run becomes a WEAK
 * candidate on its own budget, longest first at each position. A window is
 * skipped when it starts or ends with a function word, or holds nothing but
 * function and common words ("good morning"). Windows made only of other
 * words come first, so a name late in a long lowercase message still makes
 * the budget; windows with a common or interior function word ("call alice
 * example", "bank of example") follow. The resolver matches a phrase exactly
 * or not at all, so windows that are ordinary prose cost probe size only.
 * Norms already taken by a strong candidate or an earlier weak one are
 * skipped; emitted norms are added to `weakSeen`.
 */
function weakPhraseCandidates(text: string, strongNorms: ReadonlySet<string>, weakSeen: Set<string>): EntityCandidate[] {
  const contentOnly: Array<{ raw: string; norm: string }> = [];
  const withCommonWord: Array<{ raw: string; norm: string }> = [];
  const taken = new Set<string>();
  collect: for (const m of text.matchAll(WEAK_PHRASE_RUN_RE)) {
    const words = m[0].split(WEAK_PHRASE_GAP_RE);
    for (let i = 0; i < words.length - 1; i++) {
      for (const n of [3, 2]) {
        if (i + n > words.length) continue;
        const gram = words.slice(i, i + n);
        const lcs = gram.map((w) => stripPossessive(w).toLowerCase());
        if (STOPWORDS.has(lcs[0]!) || STOPWORDS.has(lcs[n - 1]!)) continue;
        const plainWords = lcs.filter((w) => STOPWORDS.has(w) || COMMON_WORDS.has(w)).length;
        if (plainWords === n) continue;
        const raw = stripPossessive(gram.join(' '));
        const norm = normalizeAlias(raw);
        if (!norm || strongNorms.has(norm) || weakSeen.has(norm) || taken.has(norm)) continue; // covered by a strong candidate / dup
        const bucket = plainWords === 0 ? contentOnly : withCommonWord;
        if (bucket.length >= MAX_WEAK_PHRASE_CANDIDATES) continue;
        taken.add(norm);
        bucket.push({ raw, norm });
        if (contentOnly.length >= MAX_WEAK_PHRASE_CANDIDATES) break collect;
      }
    }
  }
  const kept = [...contentOnly, ...withCommonWord].slice(0, MAX_WEAK_PHRASE_CANDIDATES);
  for (const { norm } of kept) weakSeen.add(norm);
  return kept.map(({ raw }) => ({ display: raw, query: raw, weak: true as const }));
}

// #3746 — CJK runs (Han/hiragana/katakana/hangul, the shared cjk.ts ranges).
// CJK chars are \p{Lo}: invisible to both the \p{Lu}-anchored strong pass and
// the \p{Ll}-anchored lowercase weak pass above.
const CJK_RUN_RE = new RegExp(`[${CJK_SLUG_CHARS}]+`, 'gu');
// Pure-hiragana grams are overwhelmingly particles/function words (の, して,
// です) — never emitted as candidates. Names in hiragana-only form are a
// documented v1 miss (same class as the lowercase-Latin limit above).
const PURE_HIRAGANA_RE = /^[぀-ゟ]+$/u;

/**
 * Extract candidate entity surface-forms from one turn's text.
 * Deterministic, precision-biased, capped at MAX_CANDIDATES. Deduped on the
 * normalizeAlias() form (so "Garry" and "garry" collapse), first display wins.
 */
export function extractCandidates(text: string): EntityCandidate[] {
  if (!text || typeof text !== 'string') return [];

  // Track, per normalized query, its display + whether it was ever seen
  // capitalized mid-sentence (a strong "this is a real name" signal) and how
  // many tokens it spans.
  interface Acc {
    display: string;
    query: string;
    multiToken: boolean;
    seenMidSentence: boolean;
    order: number;
  }
  const acc = new Map<string, Acc>();
  let order = 0;

  const consider = (rawDisplay: string, rawQuery: string, midSentence: boolean) => {
    const display = rawDisplay.trim();
    const query = stripPossessive(rawQuery.trim());
    if (!query) return;
    const norm = normalizeAlias(query);
    if (!norm) return;
    const existing = acc.get(norm);
    if (existing) {
      if (midSentence) existing.seenMidSentence = true;
      return;
    }
    acc.set(norm, {
      display,
      query,
      multiToken: /\s/.test(query),
      seenMidSentence: midSentence,
      order: order++,
    });
  };

  // 1. @handles — strong signal; resolved as aliases. Display keeps the @.
  for (const m of text.matchAll(HANDLE_RE)) {
    const handle = m[1];
    // handles are intentional references; treat as mid-sentence (never drop on
    // the sentence-start heuristic).
    consider(`@${handle}`, handle, true);
  }

  // 2. Capitalized token runs.
  for (const m of text.matchAll(CAP_RUN_RE)) {
    const surface = m[0];
    const idx = m.index ?? 0;
    consider(surface, surface, !isAtSentenceStart(text, idx));
    // Leading-stopword trim (v0.46.15 identity wave): a sentence-start
    // auxiliary glues into the run — "Did Galewright ever…" extracts
    // "Did Galewright", which resolves to nothing. ALSO consider the
    // remainder with the leading hard-stopword tokens shed. The trimmed
    // token is positionally mid-sentence (it follows the stopword), which
    // is exactly the strong "this is a real name" signal. Keep the
    // original run too — "Will Smith" must still resolve whole.
    const tokens = surface.split(/\s+/);
    let firstKept = 0;
    while (firstKept < tokens.length && STOPWORDS.has(stripPossessive(tokens[firstKept]).toLowerCase())) {
      firstKept++;
    }
    if (firstKept > 0 && firstKept < tokens.length) {
      const trimmed = tokens.slice(firstKept).join(' ');
      consider(trimmed, trimmed, true);
    }
  }

  // 3. Filter for precision.
  const out: EntityCandidate[] = [];
  for (const c of Array.from(acc.values()).sort((a, b) => a.order - b.order)) {
    const lc = c.query.toLowerCase();
    // Single bare tokens get the strict filters; multi-token runs ("Garry Tan",
    // "Initialized Capital") are inherently high-signal and skip the soft list.
    if (!c.multiToken) {
      if (c.query.length < 2) continue;            // single char
      if (isPureNumber(c.query)) continue;          // "2026"
      if (STOPWORDS.has(lc)) continue;              // hard: never an entity
      // soft: common word AND only seen at sentence start → drop. If it also
      // appeared capitalized mid-sentence, keep it (likely a real name like
      // "Apple" or a person whose name collides with a common word).
      if (COMMON_WORDS.has(lc) && !c.seenMidSentence) continue;
    }
    out.push({ display: c.display, query: c.query, ...(!c.multiToken && !c.seenMidSentence ? { sentenceStart: true as const } : {}) });
    if (out.length >= MAX_CANDIDATES) break;
  }

  // 2.5→3.5. Lowercase WEAK pass (v0.46.15 identity wave, documented v1 limit).
  // Users type names lowercase ("remind me what saoirse said"); the alias
  // table stores normalized forms, so an exact unique alias hit is the same
  // evidence class regardless of source casing. Weak candidates ride a
  // SEPARATE budget (never evict strong), and the resolver restricts them to
  // the alias arm — a generic lowercase word only fabricates a pointer if it
  // is literally a unique registered alias.
  // Built from the EMITTED strong list, not the raw accumulator (adversarial
  // F10): a strong candidate the precision filter REJECTED (e.g. a common
  // word seen only at sentence start) must not shadow the same norm's weak
  // alias probe — that's exactly the name-collides-with-a-common-word case
  // the alias table exists to disambiguate.
  const strongNorms = new Set(out.map((c) => normalizeAlias(c.query)).filter(Boolean));
  const weakSeen = new Set<string>();
  let weakCount = 0;
  for (const m of text.matchAll(WEAK_TOKEN_RE)) {
    if (weakCount >= MAX_WEAK_CANDIDATES) break;
    const raw = stripPossessive(m[0]);
    if (raw.length < 3) continue;
    const lc = raw.toLowerCase();
    if (STOPWORDS.has(lc) || COMMON_WORDS.has(lc)) continue;
    const norm = normalizeAlias(raw);
    if (!norm) continue;
    if (strongNorms.has(norm) || weakSeen.has(norm)) continue; // covered by a strong candidate / dup
    weakSeen.add(norm);
    weakCount++;
    out.push({ display: raw, query: raw, weak: true });
  }

  // 3.6. Lowercase PHRASE pass (#6195): see weakPhraseCandidates.
  out.push(...weakPhraseCandidates(text, strongNorms, weakSeen));

  // 4. CJK weak n-gram pass (#3746). CJK scripts carry no capitalization and
  // (for JA/ZH) no whitespace tokenization, so both passes above are blind to
  // 田中 / 김철수 / 王小明. Emit 2–4-char n-grams of each CJK run as WEAK
  // candidates (own budget; position-major, longest-first per position so a
  // leading name's grams always make the cap). The resolver restricts weak
  // candidates to exact-evidence arms — alias, plus the pure-CJK
  // exact-title/exact-slug arm — so junk grams cost only probe size and can
  // never fabricate a pointer without an exact registered match.
  if (hasCJK(text)) {
    let cjkCount = 0;
    outer: for (const m of text.matchAll(CJK_RUN_RE)) {
      const run = m[0];
      if (run.length < 2) continue;
      const grams: string[] = [];
      if (run.length <= 4) {
        grams.push(run); // whole short run (KO/whitespace-tokenized names)
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          for (const n of [4, 3, 2]) {
            if (i + n <= run.length) grams.push(run.slice(i, i + n));
          }
        }
      }
      for (const g of grams) {
        if (cjkCount >= MAX_CJK_WEAK_CANDIDATES) break outer;
        if (PURE_HIRAGANA_RE.test(g)) continue; // particles/function words
        const norm = normalizeAlias(g);
        if (!norm) continue;
        if (strongNorms.has(norm) || weakSeen.has(norm)) continue;
        weakSeen.add(norm);
        cjkCount++;
        out.push({ display: g, query: g, weak: true });
      }
    }
  }
  return out;
}

// ── Rolling-window extraction (v0.43, #2095 push-based context) ──────────

export interface WindowTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * A window candidate with the salience metadata the volunteer layer's
 * confidence boost reads: how many turns mentioned it, whether the NEWEST
 * turn did, and whether the USER (vs only the assistant) ever said it.
 */
export interface WindowEntityCandidate extends EntityCandidate {
  /** Number of distinct turns that mentioned this candidate. */
  occurrences: number;
  /** Mentioned in the newest (last) turn of the window. */
  inNewestTurn: boolean;
  /** Mentioned in at least one USER turn (assistant-only mentions rank lower). */
  userMention: boolean;
}

/**
 * Extract candidates across the last N turns (oldest → newest). Pure,
 * zero-LLM: runs the per-turn extractor on each turn and merges by the
 * normalizeAlias form. Ordering is salience-aware — recency of last mention,
 * cross-turn frequency, and a user-role boost — so when the merged set
 * exceeds MAX_CANDIDATES, the dropped tail is the stalest assistant-only
 * chatter, not the entity the user just named.
 */
export function extractCandidatesFromWindow(turns: WindowTurn[]): WindowEntityCandidate[] {
  if (!turns?.length) return [];
  interface WAcc extends WindowEntityCandidate {
    lastTurnIdx: number;
    order: number;
  }
  const acc = new Map<string, WAcc>();
  let order = 0;
  const lastIdx = turns.length - 1;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn?.text) continue;
    for (const c of extractCandidates(turn.text)) {
      const norm = normalizeAlias(c.query);
      if (!norm) continue;
      const existing = acc.get(norm);
      if (existing) {
        existing.occurrences += 1;
        existing.lastTurnIdx = i;
        existing.inNewestTurn = existing.inNewestTurn || i === lastIdx;
        // A strong sighting upgrades a weak-born candidate: the weak flag
        // clears (it may now use all resolution arms) and the capitalized
        // surface beats the lowercase one (unless a user-said label already
        // won and this sighting is assistant-only).
        if (existing.weak && !c.weak) {
          delete existing.weak;
          if (!existing.userMention || turn.role === 'user') existing.display = c.display;
        }
        if (turn.role === 'user' && !existing.userMention) {
          // First USER-said surface form beats an assistant-introduced one
          // for the display label.
          existing.display = c.display;
          existing.userMention = true;
        }
      } else {
        acc.set(norm, {
          display: c.display,
          query: c.query,
          ...(c.weak ? { weak: true as const } : {}),
          occurrences: 1,
          lastTurnIdx: i,
          inNewestTurn: i === lastIdx,
          userMention: turn.role === 'user',
          order: order++,
        });
      }
    }
  }

  // Salience weight: recency dominates, then frequency, then user-role.
  // Deterministic tie-break on first-seen order. Strong candidates rank
  // STRICTLY above weak ones (separate budgets too) — recent weak noise can
  // never evict an older strong candidate. Lowercase phrases keep their own
  // budget here as well, so a wordy newest turn's phrases never push an
  // older turn's single weak tokens out of the window.
  const weight = (c: WAcc) =>
    (c.lastTurnIdx + 1) / turns.length + Math.min(c.occurrences, 4) * 0.1 + (c.userMention ? 0.15 : 0);
  const sorted = Array.from(acc.values()).sort(
    (a, b) => (a.weak ? 1 : 0) - (b.weak ? 1 : 0) || weight(b) - weight(a) || a.order - b.order,
  );
  const strong = sorted.filter((c) => !c.weak).slice(0, MAX_CANDIDATES);
  const weak = sorted.filter((c) => c.weak && !isWeakPhrase(c)).slice(0, MAX_WEAK_CANDIDATES);
  const phrases = sorted.filter(isWeakPhrase).slice(0, MAX_WEAK_PHRASE_CANDIDATES);
  return [...strong, ...weak, ...phrases].map(({ lastTurnIdx: _l, order: _o, ...rest }) => rest);
}

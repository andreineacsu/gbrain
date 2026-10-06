/**
 * Unit tests for the Retrieval Reflex pure extractor (#1981, T1).
 * No DB, no SDK — just the deterministic candidate extraction + precision filters.
 */
import { describe, test, expect } from 'bun:test';
import {
  extractCandidates,
  extractCandidatesFromWindow,
  MAX_CANDIDATES,
  MAX_WEAK_CANDIDATES,
  MAX_WEAK_PHRASE_CANDIDATES,
  type EntityCandidate,
} from '../../src/core/context/entity-salience.ts';

/** STRONG candidate queries only (the v1 contract most tests pin). */
function queries(text: string): string[] {
  return extractCandidates(text)
    .filter((c) => !c.weak)
    .map((c) => c.query);
}

function weakQueries(text: string): string[] {
  return extractCandidates(text)
    .filter((c) => c.weak)
    .map((c) => c.query);
}

/** A weak candidate spanning several words (the lowercase phrase pool). */
const isPhrase = (c: EntityCandidate): boolean => c.weak === true && /\s/.test(c.query);
/** A weak candidate of one token (lowercase word or CJK gram). */
const isSingleWeak = (c: EntityCandidate): boolean => c.weak === true && !/\s/.test(c.query);

function weakPhrases(text: string): string[] {
  return extractCandidates(text).filter(isPhrase).map((c) => c.query);
}

describe('extractCandidates', () => {
  test('multi-word capitalized run', () => {
    expect(queries('what do you think about Garry Tan?')).toContain('Garry Tan');
  });

  test('@handles are captured without the @ in the query, with @ in display', () => {
    const c = extractCandidates('ping @garry about it');
    const handle = c.find((x) => x.display === '@garry');
    expect(handle).toBeDefined();
    expect(handle!.query).toBe('garry');
  });

  test('drops hard stopwords even capitalized', () => {
    const q = queries('What should We do? The plan is set.');
    expect(q).not.toContain('What');
    expect(q).not.toContain('We');
    expect(q).not.toContain('The');
  });

  test('drops weekday/common words seen only at sentence start', () => {
    // Re-pinned for the v0.46.15 identity wave: STRONG extraction still drops
    // these; the lowercase pass may emit weak candidates ("ship", "busy"),
    // which are alias-arm-restricted and cannot fabricate pointers.
    expect(queries('Monday we ship. Today is busy.')).toEqual([]);
  });

  test('keeps a real name even at sentence start', () => {
    expect(queries('Sarah went home early.')).toContain('Sarah');
  });

  test('keeps a common-looking word if also seen capitalized mid-sentence', () => {
    // "Apple" appears mid-sentence → strong entity signal, kept despite being common-ish.
    expect(queries('I love Apple. Apple makes phones.')).toContain('Apple');
  });

  test('rejects single chars and pure numbers', () => {
    const q = queries('A 2026 plan');
    expect(q).not.toContain('A');
    expect(q).not.toContain('2026');
  });

  test('strips possessive', () => {
    expect(queries("Garry's idea")).toContain('Garry');
  });

  test('dedups on normalized form', () => {
    const q = queries('Garry and Garry again');
    expect(q.filter((x) => x.toLowerCase() === 'garry')).toHaveLength(1);
  });

  test('caps at MAX_CANDIDATES', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Person${String.fromCharCode(65 + (i % 26))}x${i}`).join(' ');
    expect(extractCandidates(many).length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  test('empty / non-string input → []', () => {
    expect(extractCandidates('')).toEqual([]);
    // @ts-expect-error intentional bad input
    expect(extractCandidates(null)).toEqual([]);
  });

  test('lowercase names are now detected as WEAK candidates (v1 limit lifted at extraction)', () => {
    // Re-pinned for the v0.46.15 identity wave (was: "lowercase names are NOT
    // detected"). The lowercase pass emits weak, alias-arm-restricted
    // candidates; strong extraction stays capitalization-biased.
    expect(queries('what about garry tan')).toEqual([]);
    const weak = weakQueries('what about garry tan');
    expect(weak).toContain('garry');
    expect(weak).toContain('tan');
  });

  test('leading-stopword trim: surname escapes a glued auxiliary', () => {
    // "Did Galewright" is the raw run; the trimmed remainder must ALSO be a
    // strong candidate (kta-pos variant 4, the documented surname-only limit).
    const q = queries('Did Galewright ever follow up on that intro?');
    expect(q).toContain('Galewright');
    expect(q).toContain('Did Galewright'); // original run preserved
  });

  test('trim keeps multi-token remainders whole', () => {
    expect(queries('Did Garry Tan reply?')).toContain('Garry Tan');
  });

  test('weak candidates: possessives stripped, stopwords/common excluded, deduped vs strong', () => {
    const weak = weakQueries("remind me what saoirse's take on the round was");
    expect(weak).toContain('saoirse');
    expect(weak).not.toContain('the'); // stopword
    expect(weak).not.toContain('me');  // stopword (and <3 chars)
    const both = extractCandidates('Apple and apple again');
    // lowercase "apple" is covered by the strong "Apple" candidate — no weak dup
    expect(both.filter((c) => c.weak).map((c) => c.query)).not.toContain('apple');
  });

  test('weak candidates ride a separate budget and never evict strong ones', () => {
    const strongPart = Array.from({ length: 20 }, (_, i) => `Personx${i}q`).join('. ');
    const weakPart = Array.from({ length: 50 }, (_, i) => `wkword${i}xy`).join(' ');
    const out = extractCandidates(`${strongPart}. ${weakPart}`);
    const strong = out.filter((c) => !c.weak);
    expect(strong.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(strong.length).toBe(MAX_CANDIDATES); // weak never displaces strong
    // Single lowercase words and lowercase phrases each fill their own pool.
    expect(out.filter(isSingleWeak).length).toBe(MAX_WEAK_CANDIDATES);
    expect(out.filter(isPhrase).length).toBe(MAX_WEAK_PHRASE_CANDIDATES);
    // strong candidates come first in the output
    expect(out.findIndex((c) => c.weak)).toBeGreaterThanOrEqual(strong.length);
  });
});

describe('extractCandidatesFromWindow — weak threading (v0.46.15)', () => {
  test('weak flag survives the window merge', () => {
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'remind me what saoirse said' },
    ]);
    const saoirse = out.find((c) => c.query === 'saoirse');
    expect(saoirse).toBeDefined();
    expect(saoirse!.weak).toBe(true);
  });

  test('a strong sighting upgrades a weak-born candidate and takes its surface', () => {
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'remind me what saoirse said' },
      { role: 'user', text: 'I met Saoirse yesterday' },
    ]);
    const c = out.find((x) => x.query.toLowerCase() === 'saoirse');
    expect(c).toBeDefined();
    expect(c!.weak).toBeUndefined();
    expect(c!.display).toBe('Saoirse');
  });

  test('strong candidates rank strictly above weak, with separate budgets', () => {
    const weakTurn = Array.from({ length: 40 }, (_, i) => `wkword${i}xy`).join(' ');
    const out = extractCandidatesFromWindow([
      { role: 'assistant', text: 'Galewright shipped the memo' }, // old strong
      { role: 'user', text: weakTurn },                            // fresh weak noise
    ]);
    const strongIdx = out.findIndex((c) => c.query === 'Galewright');
    expect(strongIdx).toBe(0); // recent weak noise never outranks an older strong candidate
    expect(out.filter((c) => !c.weak).length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(out.filter(isSingleWeak).length).toBeLessThanOrEqual(MAX_WEAK_CANDIDATES);
    expect(out.filter(isPhrase).length).toBeLessThanOrEqual(MAX_WEAK_PHRASE_CANDIDATES);
  });
});

describe('#6195: lowercase phrase pass (2-3 word weak candidates)', () => {
  test('adjacent lowercase words emit whole phrases, longest first at each position', () => {
    expect(weakPhrases('did alice sample reply')).toEqual(['alice sample reply', 'alice sample', 'sample reply']);
    // Windows holding a common word ("call") follow the content-only ones.
    expect(weakPhrases('call alice example')).toEqual(['alice example', 'call alice example', 'call alice']);
    // The single lowercase words are still emitted on their own.
    const weak = weakQueries('call alice example');
    expect(weak).toContain('alice');
    expect(weak).toContain('example');
  });

  const PHRASE_CASES: Array<{ name: string; text: string; expected?: string[]; present?: string[]; absent?: string[] }> = [
    { name: 'function words only', text: 'so what about that', expected: [] },
    { name: 'common words only', text: 'good morning, see you next week', absent: ['good morning', 'next week'] },
    { name: 'a function word may sit inside a phrase, never at its edge', text: 'bank of example', expected: ['bank of example'] },
    { name: 'a full stop ends the phrase', text: 'thanks alice. example numbers attached', absent: ['alice example'] },
    { name: 'a comma ends the phrase', text: 'alice, example', expected: [] },
    { name: 'a line break ends the phrase', text: 'thanks alice\nexample numbers attached', absent: ['alice example'] },
    { name: 'a trailing possessive is stripped', text: "read alice example's memo", present: ['alice example'] },
    { name: 'name parts shorter than three letters still form a phrase', text: 'ping bo example today', present: ['bo example'] },
    { name: 'a phrase already extracted capitalized is not repeated', text: 'Alice Example joined. ping alice example', absent: ['alice example'] },
  ];
  for (const c of PHRASE_CASES) {
    test(c.name, () => {
      const phrases = weakPhrases(c.text);
      if (c.expected) expect(phrases).toEqual(c.expected);
      for (const p of c.present ?? []) expect(phrases).toContain(p);
      for (const p of c.absent ?? []) expect(phrases).not.toContain(p);
    });
  }

  test('a name late in a long lowercase message still makes the phrase budget', () => {
    // Note-style text with few function words: every adjacent pair is a window.
    const prefix =
      'notes from today product sync design review pricing update vendor follow up hiring pipeline ' +
      'budget forecast roadmap draft launch checklist onboarding flow analytics dashboard churn report ' +
      'support backlog and then remind me what';
    const phrases = weakPhrases(`${prefix} alice example said`);
    expect(phrases.indexOf('alice example')).toBeGreaterThan(24);
    expect(phrases.length).toBeLessThanOrEqual(MAX_WEAK_PHRASE_CANDIDATES);
  });

  test('a strong sighting in the window upgrades a weak-born phrase', () => {
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'call alice example' },
      { role: 'user', text: 'Alice Example called back' },
    ]);
    const c = out.find((x) => x.query.toLowerCase() === 'alice example');
    expect(c).toBeDefined();
    expect(c!.weak).toBeUndefined();
    expect(c!.display).toBe('Alice Example');
  });

  test('phrases from the newest turn never push an older single lowercase word out of the window', () => {
    const newest = Array.from({ length: 25 }, (_, i) => `wkword${i}xy`).join(' ');
    const out = extractCandidatesFromWindow([
      { role: 'user', text: 'remind me what saoirse said' },
      { role: 'user', text: newest },
    ]);
    // 25 newest words plus the newest turn's phrases exceed the single-word
    // pool; the older "saoirse" survives because phrases are capped apart.
    expect(25 + out.filter(isPhrase).length).toBeGreaterThan(MAX_WEAK_CANDIDATES);
    expect(out.some((c) => c.query === 'saoirse' && c.weak)).toBe(true);
  });
});

describe('v0.46.15 ship-review F10 — rejected strong candidates do not shadow weak probes', () => {
  test('a name pushed past MAX_CANDIDATES still gets its lowercase weak probe', () => {
    // 12 strong names consume the strong cap; the 13th name appears ONLY
    // beyond the cap plus once lowercase. strongNorms built from the raw
    // accumulator would suppress the weak probe for a name that was never
    // actually emitted as strong.
    const names = Array.from({ length: 13 }, (_, i) => `Zed Persona${i}`);
    const text = names.map((n) => `${n} joined.`).join(' ') + ' later persona12 pinged me again';
    const out = extractCandidates(text);
    const strong = out.filter((c) => !c.weak);
    expect(strong.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    const weak = out.filter((c) => c.weak);
    expect(weak.some((c) => c.query === 'persona12')).toBe(true);
  });
});

describe('#3746 — CJK weak n-gram pass (JA/KO/ZH)', () => {
  test('japanese: name grams extracted as weak candidates (pre-fix: zero)', () => {
    const weak = weakQueries('田中さんの会議のメモを見せて');
    expect(weak.length).toBeGreaterThan(0);
    expect(weak).toContain('田中');
  });

  test('korean: whitespace-tokenized name run extracted whole', () => {
    const weak = weakQueries('김철수 미팅 노트 보여줘');
    expect(weak).toContain('김철수');
  });

  test('chinese: name grams extracted from an unsegmented sentence', () => {
    const weak = weakQueries('给我看看王小明的笔记');
    expect(weak).toContain('王小明');
  });

  test('every CJK candidate is weak (never strong)', () => {
    const cands = extractCandidates('田中さんの会議');
    for (const c of cands) expect(c.weak).toBe(true);
  });

  test('pure-hiragana grams (particles/function words) are skipped', () => {
    const weak = weakQueries('それをしてください');
    expect(weak).toEqual([]);
  });

  test('CJK pass honors its own cap', () => {
    const long = '漢'.repeat(40) + '字'.repeat(40);
    const weak = weakQueries(long);
    expect(weak.length).toBeLessThanOrEqual(24);
  });

  test('no CJK in text → pass is inert (latin-only output unchanged)', () => {
    const cands = extractCandidates('what do you think about Garry Tan?');
    expect(cands.some((c) => /[一-鿿぀-ゟ゠-ヿ가-힯]/.test(c.query))).toBe(false);
  });

  test('grams deduplicate against strong candidates and each other', () => {
    const weak = weakQueries('田中 田中');
    expect(weak.filter((q) => q === '田中')).toHaveLength(1);
  });
});

/**
 * Tolerant decode of a JSON object (or array) embedded in LLM output. A leaf
 * util with no provider/gateway imports so any layer can reuse it without a
 * dependency cycle.
 *
 * Strategies, in order:
 *   1. Strip ```json...``` fences if present, then JSON.parse.
 *   2. Direct JSON.parse.
 *   3. Find the first {...} substring (or [...] when array=true) and parse.
 *   4. When a fence was found and 1-3 failed on its extract, retry 2-3 on the
 *      whole text: a ``` inside a JSON string value (a verbatim quote of a
 *      code block) ends the non-greedy fence extract early.
 *   5. Retry 1-4 with reasoning blocks stripped (see stripReasoningBlocks).
 *   6. Return null.
 *
 * Adversarial input throws are swallowed; callers get null on any failure.
 */
/**
 * Strip a reasoning model's chain-of-thought block.
 *
 * Reasoning models (DeepSeek-R1, MiniMax M2.x/M3, and any model configured to
 * emit visible thinking) put a reasoning block BEFORE the answer, in the same
 * text channel. That reasoning routinely contains braces, because the model
 * drafts its JSON while thinking. This defeats strategy 3 in parseLlmJson: the
 * greedy `/\{[\s\S]*\}/` spans from the FIRST brace inside the reasoning to
 * the LAST brace of the real answer, so the parse fails and the caller records
 * an "unparseable" result even though a perfectly good object was returned.
 *
 * Also strips `<thinking>`, emitted by some models/proxies that render
 * reasoning as a tag in the text channel. Deliberately NOT covered:
 * `<reasoning>` and MiniMax's `◁think▷` sentinel — neither appears in this
 * repo's providers or fixtures, and this helper is a recovery path, not a
 * general sanitiser; add a tag only with a captured payload that shows it.
 *
 * Handles both shapes: a closed `<think(ing)>…</think(ing)>` pair, and a
 * truncated block that was opened and never closed (the model exhausted its
 * output budget). The closed-pair arm backreferences the opening tag so a
 * `<think>` is only ever closed by `</think>` — that keeps behaviour on
 * `<think>` input byte-identical to before, with `<thinking>` purely additive;
 * a MISMATCHED pair still falls through to the open-ended arm exactly as it
 * did pre-change. Order matters: closed pairs first, then any surviving
 * unclosed opener to end-of-string.
 */
export function stripReasoningBlocks(raw: string): string {
  return raw
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking)>[\s\S]*$/i, '')
    .trim();
}

export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const direct = parseLlmJsonInner<T>(raw, opts);
  if (direct !== null) return direct;
  // A fallback LADDER, not a pre-filter: the raw text is parsed first, so every
  // existing call site behaves byte-for-byte as before and a payload that
  // legitimately contains "<think>"/"<thinking>" is unaffected. The retry runs only
  // after the raw parse has already failed, and text with no reasoning block
  // strips to itself — so the added cost on the success path is zero.
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) return parseLlmJsonInner<T>(stripped, opts);
  return null;
}

function parseLlmJsonInner<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = parseJsonCandidate<T>(fenceMatch[1].trim(), opts);
    if (fenced !== null) return fenced;
    // The extract stops at the FIRST closing ```, which may sit inside a JSON
    // string (a quoted code block) and cut the payload short. Retry, only
    // after the extract failed, so every payload that parsed before still
    // parses the same way (#6069): from the opening fence on when it starts a
    // line (a real fence, so a brace in prose or a reasoning draft before it
    // cannot win), else on the whole text (the ``` sat inside a JSON string).
    const at = fenceMatch.index ?? 0;
    const startsLine = raw.slice(raw.lastIndexOf('\n', at - 1) + 1, at).trim() === '';
    return parseJsonCandidate<T>((startsLine ? raw.slice(at) : raw).trim(), opts);
  }
  return parseJsonCandidate<T>(raw.trim(), opts);
}

function parseJsonCandidate<T>(cleaned: string, opts: { array?: boolean }): T | null {
  try {
    const direct = JSON.parse(cleaned);
    if (opts.array && Array.isArray(direct)) return direct as T;
    if (!opts.array && direct !== null && typeof direct === 'object') return direct as T;
  } catch {
    // fall through
  }
  const pattern = opts.array ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = cleaned.match(pattern);
  if (match) {
    try {
      const second = JSON.parse(match[0]);
      if (opts.array && Array.isArray(second)) return second as T;
      if (!opts.array && second !== null && typeof second === 'object') return second as T;
    } catch {
      // fall through
    }
  }
  return null;
}

/** Why `parseLlmJson` returned null, for a bounded diagnostic line. */
export interface LlmJsonFailure {
  /** The text holds a ``` fence. */
  fenced: boolean;
  /** JSON.parse's message for the most complete candidate. */
  error: string;
  /** Index in `raw` where that candidate stops being valid JSON (its end when truncated); null when there is no candidate. */
  offset: number | null;
}

/**
 * Explain a `parseLlmJson` miss. The candidate is the span from the first
 * opening bracket to the last closing one (the whole text when there is
 * none), the widest span the parse ladder tries. The offset comes from
 * jsonErrorOffset because Bun's JSON.parse messages carry no position.
 */
export function explainLlmJsonFailure(raw: string, opts: { array?: boolean } = {}): LlmJsonFailure {
  const fenced = raw.includes('```');
  if (!raw.trim()) return { fenced, error: 'empty response', offset: null };
  const [open, close] = opts.array ? ['[', ']'] : ['{', '}'];
  const first = raw.indexOf(open);
  const start = first >= 0 ? first : raw.search(/\S/);
  const last = raw.lastIndexOf(close);
  const candidate = raw.slice(start, last > start ? last + 1 : raw.length);
  let error = 'valid JSON of the wrong shape';
  try {
    JSON.parse(candidate);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const at = jsonErrorOffset(candidate);
  return { fenced, error, offset: at === null || at < 0 ? null : start + at };
}

/**
 * Index of the first character where `s` stops being one valid JSON value:
 * `s.length` when it ends early (truncated), -1 when it is valid, null when
 * the scan itself fails (nesting deep enough to exhaust the stack).
 */
export function jsonErrorOffset(s: string): number | null {
  let i = 0;
  const skipWs = (): void => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const str = (): boolean => {
    i++; // opening quote
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { i++; return true; }
      if (ch < ' ') return false;
      if (ch === '\\') {
        const esc = s[i + 1];
        if (esc !== undefined && '"\\/bfnrt'.includes(esc)) { i += 2; continue; }
        if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { i += 6; continue; }
        if (esc === undefined) i++;
        return false;
      }
      i++;
    }
    return false;
  };
  const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const members = (closer: string, member: () => boolean): boolean => {
    i++; // opening bracket
    skipWs();
    if (s[i] === closer) { i++; return true; }
    while (true) {
      if (!member()) return false;
      skipWs();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === closer) { i++; return true; }
      return false;
    }
  };
  const value = (): boolean => {
    skipWs();
    const c = s[i];
    if (c === '{') {
      return members('}', () => {
        skipWs();
        if (s[i] !== '"' || !str()) return false;
        skipWs();
        if (s[i] !== ':') return false;
        i++;
        return value();
      });
    }
    if (c === '[') return members(']', value);
    if (c === '"') return str();
    for (const lit of ['true', 'false', 'null']) {
      if (s.startsWith(lit, i)) { i += lit.length; return true; }
    }
    num.lastIndex = i;
    const m = num.exec(s);
    if (m) { i += m[0].length; return true; }
    return false;
  };
  try {
    if (!value()) return Math.min(i, s.length);
  } catch {
    return null; // RangeError from runaway nesting; the caller reports no offset
  }
  skipWs();
  return i < s.length ? i : -1;
}

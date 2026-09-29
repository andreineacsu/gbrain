/**
 * Recurrence guard for the GBRAIN_HOME path class (#5549).
 *
 * GBRAIN_HOME names a PARENT directory: gbrain appends `.gbrain` to it, and
 * `gbrainPath(...)` in src/core/config.ts resolves every state path that way.
 * A site that builds `join(homedir(), '.gbrain', ...)` (or the
 * `process.env.HOME` spelling) ignores GBRAIN_HOME, so one install ends up
 * with its state split across two homes: the configured one and the OS one.
 *
 * `findOsHomeGbrainPaths` parses a file with the TypeScript compiler, so
 * comments are skipped and multi-line calls are read whole, and flags three
 * shapes that put a `.gbrain` segment directly under an OS-home source:
 *   - a `join`/`resolve` call whose first argument is an OS-home source and
 *     whose later argument is `'.gbrain'` or starts with `'.gbrain/'`;
 *   - a template literal where `${<OS-home source>}` is followed by `/.gbrain`;
 *   - a `+` concatenation of an OS-home source and a `'/.gbrain...'` string.
 * An OS-home source is `homedir()`, `os.homedir()`, `process.env.HOME`,
 * `process.env['HOME']`, `Bun.env.HOME`, a `home()` helper, or a local named
 * `home`/`homeDir`/`userHome`. A value copied into some other local name
 * escapes the match; the naming convention is what the guard relies on.
 *
 * The source sweep fails on any flagged expression under src/ that is not in
 * ALLOWLIST. Entries are keyed on file + the flagged expression's text with
 * whitespace collapsed, not line numbers, so unrelated edits leave them
 * valid; an entry that no longer matches its expected number of expressions
 * fails too, so the list cannot go stale.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

const OS_HOME_SOURCE =
  /\b(?:os\.)?homedir\(\)|\bprocess\.env(?:\.HOME\b|\[['"]HOME['"]\])|\bBun\.env\.HOME\b|\b(?:home|homeDir|userHome)\b/;
/** A path-segment argument: `.gbrain` alone or `.gbrain/<more>`. */
const GBRAIN_SEGMENT = /^\.gbrain(?:\/|$)/;
/** Template or concatenated text continuing an OS-home value with `/.gbrain`. */
const GBRAIN_SUFFIX = /^\/\.gbrain(?:[/'"\s<]|$)/;
const PATH_BUILDERS = new Set(['join', 'resolve']);

const FIX_HINT =
  'resolve gbrain-home state through gbrainPath() from src/core/config.ts (honors GBRAIN_HOME), or add an allowlist entry with a reason';

const CANONICAL_FALLBACK =
  'configDir() itself: the canonical fallback when GBRAIN_HOME is unset';
const LEGACY_REDACTION_FALLBACK =
  'deliberate legacy fallback so redaction patterns are never lost (fail closed)';
const LEGACY_FALLBACK_READ =
  'reads the legacy $HOME/.gbrain copy only to surface it next to the gbrainPath() location';
const MOUNTS_REGISTRY =
  'mounts registry is documented per-user at ~/.gbrain/mounts.json (docs/architecture/brains-and-sources.md); whether a GBRAIN_HOME brain should see it is an open design question';
const SERVICE_UNIT_WRITES =
  'written by a generated launchd/systemd/cron unit or script under $HOME/.gbrain; moving it means regenerating installed units';
const SUPERVISOR_PIDFILE =
  'runtime supervisor pidfile keyed by brain id (#1849); the writer and every reader share DEFAULT_PID_FILE, and moving it would hide a running supervisor across an upgrade';
const ALREADY_HONORS_GBRAIN_HOME =
  '`home` here is GBRAIN_HOME ?? HOME, so the path already honors GBRAIN_HOME';

interface AllowEntry {
  file: string;
  expr: string;
  reason: string;
  /** Flagged expressions in `file` with this exact text; defaults to 1. */
  count?: number;
}

const ALLOWLIST: AllowEntry[] = [
  { file: 'src/core/config.ts', expr: "join(homedir(), '.gbrain')", reason: CANONICAL_FALLBACK },
  {
    file: 'src/core/skillpack/harvest-lint.ts',
    expr: "join(homedir(), '.gbrain', PRIVATE_PATTERNS_FILENAME)",
    reason: LEGACY_REDACTION_FALLBACK,
  },
  { file: 'src/core/brain-registry.ts', expr: "join(homedir(), '.gbrain', 'mounts.json')", reason: MOUNTS_REGISTRY },
  { file: 'src/core/mounts-cache.ts', expr: "join(homedir(), '.gbrain', 'mounts-cache')", reason: MOUNTS_REGISTRY },
  { file: 'src/commands/mounts.ts', expr: "join(homedir(), '.gbrain')", reason: MOUNTS_REGISTRY },
  {
    file: 'src/core/brain-repo-durability.ts',
    expr: "join(process.env.HOME || '', '.gbrain', 'brain-pull.log')",
    reason: `${SERVICE_UNIT_WRITES}; the reader must match the installed unit`,
  },
  {
    file: 'src/core/brain-repo-durability.ts',
    expr: '${esc(home)}/.gbrain/brain-pull.log</string>',
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/core/brain-repo-durability.ts',
    expr: '${esc(home)}/.gbrain/brain-pull.err</string>',
    reason: SERVICE_UNIT_WRITES,
  },
  { file: 'src/commands/autopilot.ts', expr: "join(process.env.HOME || '', '.gbrain')", reason: SERVICE_UNIT_WRITES },
  {
    file: 'src/commands/autopilot.ts',
    expr: "join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh')",
    reason: SERVICE_UNIT_WRITES,
  },
  { file: 'src/commands/autopilot.ts', expr: "join(home, '.gbrain', 'crontab.tmp')", reason: SERVICE_UNIT_WRITES, count: 2 },
  { file: 'src/commands/autopilot.ts', expr: "join(home, '.gbrain')", reason: SERVICE_UNIT_WRITES, count: 2 },
  {
    file: 'src/commands/autopilot.ts',
    expr: "join(process.env.HOME || '', '.gbrain', 'autopilot.log')",
    reason: `${SERVICE_UNIT_WRITES}; showStatus reads the legacy log as a fallback`,
  },
  {
    file: 'src/commands/autopilot.ts',
    expr: '${escapeXml(home)}/.gbrain/autopilot.log</string>',
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/commands/autopilot.ts',
    expr: '${escapeXml(home)}/.gbrain/autopilot.err</string>',
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/commands/autopilot.ts',
    expr: `\${home.replace(/'/g, "'\\\\''")}/.gbrain/autopilot.log' 2>&1`,
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/core/minions/supervisor.ts',
    expr: '${home}/.gbrain/supervisor-',
    reason: SUPERVISOR_PIDFILE,
  },
  {
    file: 'src/commands/doctor/checks/routing-federation.ts',
    expr: '${home}/.gbrain/autopilot.lock',
    reason: LEGACY_FALLBACK_READ,
  },
  {
    file: 'src/commands/doctor/checks/verbs-reflex.ts',
    expr: "join(process.env.HOME || homedir(), '.gbrain', 'integrations', 'retrieval-reflex', 'heartbeat.jsonl')",
    reason: LEGACY_FALLBACK_READ,
  },
  {
    file: 'src/core/skillopt/held-out.ts',
    expr: "path.join(home, '.gbrain', 'skillopt-captures')",
    reason: ALREADY_HONORS_GBRAIN_HOME,
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')').trim();
}

function stringText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isPathBuilder(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return PATH_BUILDERS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && PATH_BUILDERS.has(callee.name.text);
}

/**
 * Every expression in `source` that puts a `.gbrain` segment directly under
 * an OS-home source, as normalized text. A template hit is reported as the
 * interpolation plus the rest of its literal line.
 */
function findOsHomeGbrainPaths(source: string): string[] {
  const sf = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const isOsHome = (node: ts.Node) => OS_HOME_SOURCE.test(node.getText(sf));
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isPathBuilder(node.expression)) {
      const [first, ...rest] = node.arguments;
      const segment = rest.some(arg => GBRAIN_SEGMENT.test(stringText(arg) ?? ''));
      if (first && segment && isOsHome(first)) hits.push(normalize(node.getText(sf)));
    } else if (ts.isTemplateSpan(node)) {
      const literal = node.literal.text;
      if (GBRAIN_SUFFIX.test(literal) && isOsHome(node.expression)) {
        hits.push(normalize(`\${${node.expression.getText(sf)}}${literal.split('\n')[0]}`));
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (GBRAIN_SUFFIX.test(stringText(node.right) ?? '') && isOsHome(node.left)) {
        hits.push(normalize(node.getText(sf)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Counts of `<repo-relative path>:<flagged expression>` across src/. */
function scanOsHomeGbrainPaths(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('.gbrain')) continue;
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const expr of findOsHomeGbrainPaths(text)) {
      const key = `${rel}:${expr}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  return hits;
}

describe('gbrain-home state paths honor GBRAIN_HOME', () => {
  const hits = scanOsHomeGbrainPaths();
  const allowed = new Map(ALLOWLIST.map(e => [`${e.file}:${e.expr}`, e.count ?? 1]));

  test('every OS-home .gbrain path in src/ is allowlisted', () => {
    const violations: string[] = [];
    for (const [key, n] of hits) {
      const expected = allowed.get(key);
      if (expected === undefined) {
        violations.push(`${key}\n  -> ${FIX_HINT}`);
      } else if (n > expected) {
        violations.push(`${key} (${n} expressions, allowlisted ${expected})\n  -> ${FIX_HINT}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('every allowlist entry still matches its expressions (no stale entries)', () => {
    const stale: string[] = [];
    for (const [key, expected] of allowed) {
      const n = hits.get(key) ?? 0;
      if (n < expected) {
        stale.push(`${key} (found ${n} expressions, allowlisted ${expected}): remove or update the stale allowlist entry`);
      }
    }
    expect(stale).toEqual([]);
  });

  test('the matcher flags each OS-home shape and leaves GBRAIN_HOME-aware paths alone', () => {
    const cases: Array<{ name: string; snippet: string; flagged: boolean }> = [
      { name: 'homedir() join', snippet: "const p = join(homedir(), '.gbrain', 'x.json');", flagged: true },
      { name: 'os.homedir() join', snippet: "const p = path.join(os.homedir(), '.gbrain');", flagged: true },
      { name: 'process.env.HOME join', snippet: "const p = join(process.env.HOME || '', '.gbrain', 'a');", flagged: true },
      { name: "process.env['HOME'] join", snippet: "const p = join(process.env['HOME']!, '.gbrain');", flagged: true },
      { name: 'Bun.env.HOME join', snippet: "const p = join(Bun.env.HOME ?? '', '.gbrain');", flagged: true },
      { name: 'compound .gbrain/ segment', snippet: "const p = join(homedir(), '.gbrain/audit');", flagged: true },
      { name: 'local home variable', snippet: "mkdirSync(join(home, '.gbrain'), { recursive: true });", flagged: true },
      {
        name: 'home() helper',
        snippet: "function home(): string { return process.env.HOME || ''; }\nfunction gbrainDir(): string { return join(home(), '.gbrain'); }",
        flagged: true,
      },
      {
        name: 'multi-line join',
        snippet: "const DEFAULT_PRIVATE_PATTERNS_PATH = join(\n  homedir(),\n  '.gbrain',\n  'harvest-private-patterns.txt',\n);",
        flagged: true,
      },
      { name: 'template with home', snippet: 'const pid = `${home}/.gbrain/supervisor-${id}.pid`;', flagged: true },
      {
        name: 'template with wrapped home',
        snippet: 'const plist = `<string>${escapeXml(home)}/.gbrain/autopilot.log</string>`;',
        flagged: true,
      },
      { name: 'string concatenation', snippet: "const p = homedir() + '/.gbrain/x';", flagged: true },
      { name: 'gbrainPath', snippet: "const p = gbrainPath('x');", flagged: false },
      { name: 'join onto a non-home root', snippet: "const home = join(root, '.gbrain');", flagged: false },
      {
        name: 'shell text that honors GBRAIN_HOME',
        snippet: 'const script = `_log="\\${GBRAIN_HOME:-$HOME}/.gbrain/brain-push.log"`;',
        flagged: false,
      },
      { name: '.gbrain- prefixed temp dir', snippet: "dir = mkdtempSync(join(homedir(), '.gbrain-hop-'));", flagged: false },
      { name: 'comment only', snippet: "// return join(homedir(), '.gbrain');\nconst x = 1;", flagged: false },
    ];
    const wrong = cases
      .filter(c => (findOsHomeGbrainPaths(c.snippet).length > 0) !== c.flagged)
      .map(c => `${c.name}: expected ${c.flagged ? 'flagged' : 'not flagged'}`);
    expect(wrong).toEqual([]);
  });
});

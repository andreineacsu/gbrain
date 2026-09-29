/**
 * Recurrence guard for the GBRAIN_HOME path class (#5549).
 *
 * GBRAIN_HOME names a PARENT directory: gbrain appends `.gbrain` to it, and
 * `gbrainPath(...)` in src/core/config.ts resolves every state path that way.
 * A site that builds `join(homedir(), '.gbrain', ...)` (or the
 * `process.env.HOME` spelling) ignores GBRAIN_HOME, so one install ends up
 * with its state split across two homes: the configured one and the OS one.
 *
 * The source sweep finds every non-comment line under src/ that joins
 * `'.gbrain'` onto the OS home (`homedir()`, `process.env.HOME`, or a local
 * `home` variable) and fails on any line not in ALLOWLIST. Entries are keyed
 * on file + trimmed line text, not line numbers, so unrelated edits leave
 * them valid; an entry that no longer matches its expected number of lines
 * fails too, so the list cannot go stale.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

const GBRAIN_SEGMENT = /['"]\.gbrain['"]/;
const OS_HOME_SOURCES = [
  /\bhomedir\(\)/,
  /\bprocess\.env(\.HOME\b|\[['"]HOME['"]\])/,
  /\bjoin\(\s*home\s*,\s*['"]\.gbrain['"]/,
];

const FIX_HINT =
  'resolve gbrain-home state through gbrainPath() from src/core/config.ts (honors GBRAIN_HOME), or add an allowlist entry with a reason';

const CANONICAL_FALLBACK =
  'configDir() itself: the canonical fallback when GBRAIN_HOME is unset';
const LEGACY_REDACTION_FALLBACK =
  'deliberate legacy fallback so redaction patterns are never lost (fail closed)';
const MOUNTS_REGISTRY =
  'mounts registry is documented per-user at ~/.gbrain/mounts.json (docs/architecture/brains-and-sources.md); whether a GBRAIN_HOME brain should see it is an open design question';
const SERVICE_UNIT_WRITES =
  'written by a generated launchd/systemd/cron unit or script under $HOME/.gbrain; moving it means regenerating installed units';
const ALREADY_HONORS_GBRAIN_HOME =
  '`home` here is GBRAIN_HOME ?? HOME, so the path already honors GBRAIN_HOME';

interface AllowEntry {
  file: string;
  line: string;
  reason: string;
  /** Lines in `file` with this exact trimmed text; defaults to 1. */
  count?: number;
}

const ALLOWLIST: AllowEntry[] = [
  { file: 'src/core/config.ts', line: "return join(homedir(), '.gbrain');", reason: CANONICAL_FALLBACK },
  {
    file: 'src/core/skillpack/harvest-lint.ts',
    line: "legacyPath: string = join(homedir(), '.gbrain', PRIVATE_PATTERNS_FILENAME),",
    reason: LEGACY_REDACTION_FALLBACK,
  },
  { file: 'src/core/brain-registry.ts', line: "return join(homedir(), '.gbrain', 'mounts.json');", reason: MOUNTS_REGISTRY },
  { file: 'src/core/mounts-cache.ts', line: "return join(homedir(), '.gbrain', 'mounts-cache');", reason: MOUNTS_REGISTRY },
  {
    file: 'src/commands/mounts.ts',
    line: "function getMountsDir(): string { return join(homedir(), '.gbrain'); }",
    reason: MOUNTS_REGISTRY,
  },
  {
    file: 'src/core/brain-repo-durability.ts',
    line: "const log = join(process.env.HOME || '', '.gbrain', 'brain-pull.log');",
    reason: `${SERVICE_UNIT_WRITES}; the reader must match the installed unit`,
  },
  {
    file: 'src/commands/autopilot.ts',
    line: "const logDir = join(process.env.HOME || '', '.gbrain');",
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/commands/autopilot.ts',
    line: "return join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh');",
    reason: SERVICE_UNIT_WRITES,
  },
  {
    file: 'src/commands/autopilot.ts',
    line: "const tmpFile = join(home, '.gbrain', 'crontab.tmp');",
    reason: SERVICE_UNIT_WRITES,
    count: 2,
  },
  {
    file: 'src/commands/autopilot.ts',
    line: "mkdirSync(join(home, '.gbrain'), { recursive: true });",
    reason: SERVICE_UNIT_WRITES,
    count: 2,
  },
  {
    file: 'src/commands/autopilot.ts',
    line: "for (const logPath of [join(home, 'autopilot.log'), join(process.env.HOME || '', '.gbrain', 'autopilot.log')]) {",
    reason: `${SERVICE_UNIT_WRITES}; showStatus reads the legacy log as a fallback`,
  },
  {
    file: 'src/core/skillopt/held-out.ts',
    line: "return path.join(home, '.gbrain', 'skillopt-captures');",
    reason: ALREADY_HONORS_GBRAIN_HOME,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isCommentOnly(trimmed: string): boolean {
  return trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//');
}

/** Counts of `<repo-relative path>:<trimmed line>` for every OS-home `.gbrain` line in src/. */
function scanOsHomeGbrainLines(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      if (isCommentOnly(trimmed) || !GBRAIN_SEGMENT.test(trimmed)) continue;
      if (!OS_HOME_SOURCES.some(re => re.test(trimmed))) continue;
      const key = `${rel}:${trimmed}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  return hits;
}

describe('gbrain-home state paths honor GBRAIN_HOME', () => {
  const hits = scanOsHomeGbrainLines();
  const allowed = new Map(ALLOWLIST.map(e => [`${e.file}:${e.line}`, e.count ?? 1]));

  test('every OS-home .gbrain path in src/ is allowlisted', () => {
    const violations: string[] = [];
    for (const [key, n] of hits) {
      const expected = allowed.get(key);
      if (expected === undefined) {
        violations.push(`${key}\n  -> ${FIX_HINT}`);
      } else if (n > expected) {
        violations.push(`${key} (${n} lines, allowlisted ${expected})\n  -> ${FIX_HINT}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('every allowlist entry still matches its lines (no stale entries)', () => {
    const stale: string[] = [];
    for (const [key, expected] of allowed) {
      const n = hits.get(key) ?? 0;
      if (n < expected) {
        stale.push(`${key} (found ${n} lines, allowlisted ${expected}): remove or update the stale allowlist entry`);
      }
    }
    expect(stale).toEqual([]);
  });
});

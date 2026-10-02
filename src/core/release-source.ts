/**
 * Release-source readers: the files on master that describe the latest
 * release (VERSION, CHANGELOG.md), read from raw.githubusercontent.com.
 * Shared by `gbrain check-update` and `gbrain self-upgrade`;
 * `src/commands/check-update.ts` re-exports the readers it always exported.
 * No DB; every reader returns a failure value instead of throwing.
 */

import { VERSION } from '../version.ts';
import { isValidVersionString, parseSemver, semverGt, semverLte } from './semver.ts';

/** Master on raw.githubusercontent.com, the release train's one trusted host
 * for VERSION and CHANGELOG.md. */
const RAW_MASTER_BASE = 'https://raw.githubusercontent.com/garrytan/gbrain/master';

/** GET one file from RAW_MASTER_BASE with a 5s timeout. A network error
 * throws, so each caller keeps its own failure policy. */
function fetchRawMaster(path: string): Promise<Response> {
  return fetch(`${RAW_MASTER_BASE}/${path}`, {
    headers: { 'User-Agent': `gbrain/${VERSION}` },
    signal: AbortSignal.timeout(5_000),
  });
}

/** Where the latest version is resolved from. The release train's source of
 * truth is the `VERSION` file on master — same trusted host `fetchChangelog`
 * already uses. GitHub releases are published from it per VERSION bump
 * (`.github/workflows/release.yml`, #3521) and carry the binary assets, but
 * this check deliberately does NOT read `releases/latest`: it was a permanent
 * 404 before releases existed (#3520) and can still lag master. An npm
 * fallback was rejected: the `gbrain` package on npm is an unrelated GPU
 * library (#505), so it would produce false upgrade prompts pointing at a
 * stranger's package. */
const VERSION_SOURCE_PATH = 'VERSION';
const RELEASE_NOTES_URL = 'https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md';

/** Extract a version from the raw VERSION file body: first line, optional `v`
 * prefix, optional `-suffix` channel tag (`0.31.1.1-fixwave` compares as its
 * numeric base — fail-safe: a suffix-only bump never prompts). Body is bounded
 * before parsing so a malformed/huge response can't blow up the check. */
export function parseVersionFileBody(body: string): string | null {
  const firstLine = body.slice(0, 256).trim().split('\n')[0].trim();
  const m = firstLine.match(/^v?(\d+\.\d+\.\d+(?:\.\d+)?)(?:[-+][0-9A-Za-z.-]+)?$/);
  return m && isValidVersionString(m[1]) ? m[1] : null;
}

export type LatestReleaseResult =
  | { ok: true; tag: string; published_at: string; url: string }
  | { ok: false; reason: 'network_error' | 'no_releases' };

/**
 * Resolve the latest published gbrain version (from VERSION on master — see
 * VERSION_SOURCE_PATH). Exported (v0.42) so the self-upgrade refresh path and
 * tests can reuse it. 5s timeout — this runs on the detached refresh, never the
 * hot path. Failures are discriminated: `network_error` (offline/timeout) vs
 * `no_releases` (endpoint answered but no usable version).
 */
export async function fetchLatestRelease(): Promise<LatestReleaseResult> {
  let res: Response;
  try {
    res = await fetchRawMaster(VERSION_SOURCE_PATH);
  } catch {
    return { ok: false, reason: 'network_error' };
  }
  try {
    if (!res.ok) return { ok: false, reason: 'no_releases' };
    const tag = parseVersionFileBody(await res.text());
    if (!tag) return { ok: false, reason: 'no_releases' };
    return { ok: true, tag, published_at: '', url: RELEASE_NOTES_URL };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

export async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  try {
    const res = await fetchRawMaster('CHANGELOG.md');
    if (!res.ok) return '';
    const text = await res.text();
    return extractChangelogBetween(text, currentVersion, latestVersion);
  } catch {
    return '';
  }
}

export function extractChangelogBetween(changelog: string, from: string, to: string): string {
  const lines = changelog.split('\n');
  const entries: string[] = [];
  let capturing = false;
  const fromParsed = parseSemver(from);
  if (!fromParsed) return '';

  for (const line of lines) {
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+(?:\.\d+)?)\]/);
    if (versionMatch) {
      const verParsed = parseSemver(versionMatch[1]);
      if (!verParsed) {
        if (capturing) entries.push(line);
        continue;
      }
      if (!capturing) {
        // Start capturing at any version newer than current
        if (semverGt(verParsed, fromParsed)) {
          capturing = true;
          entries.push(line);
        }
      } else {
        // Stop capturing when we hit the current version or older
        if (semverLte(verParsed, fromParsed)) {
          break;
        }
        entries.push(line);
      }
    } else if (capturing) {
      entries.push(line);
    }
  }

  return entries.join('\n').trim();
}

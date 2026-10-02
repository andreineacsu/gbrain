import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';
import {
  isMinorOrMajorBump,
  isNewerVersion,
  isValidVersionString,
  parseSemver,
} from '../core/semver.ts';
import { readUpdateCache, writeUpdateCache, type UpdateMarker } from '../core/self-upgrade.ts';
import { fetchChangelog, fetchLatestRelease } from '../core/release-source.ts';

/** Best-effort cache write — a read-only ~/.gbrain must never make the check throw. */
function safeWriteCache(marker: UpdateMarker): void {
  try {
    writeUpdateCache(marker);
  } catch {
    /* fail-open: no cache this run, next invocation re-checks */
  }
}

// Back-compat re-exports: these used to live here; moved to ../core/semver.ts
// so the self-upgrade decision module can depend on them without an import
// cycle. Existing importers (`test/check-update.test.ts`, etc.) keep working.
export { parseSemver, isMinorOrMajorBump, isNewerVersion };

interface CheckUpdateResult {
  current_version: string;
  current_source: 'package-json';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  published_at: string;
  error?: string;
}

function upgradeCommandForMethod(method: string): string {
  switch (method) {
    case 'bun': return 'bun update gbrain';
    case 'clawhub': return 'clawhub update gbrain';
    case 'binary': return 'gbrain self-upgrade';
    default: return 'gbrain upgrade';
  }
}

// Release-source readers live in ../core/release-source.ts (shared with the
// autopilot self-upgrade channel); re-exported for existing importers.
export {
  extractChangelogBetween,
  fetchChangelog,
  fetchLatestRelease,
  parseVersionFileBody,
  type LatestReleaseResult,
} from '../core/release-source.ts';

/**
 * A failed check must NEVER write `up_to_date` — that was #486: the fetch
 * failed permanently (dead releases API) and every user was told "you're
 * current" forever. Instead, re-write the last-known-good marker (bumping its
 * mtime so the cache TTL still throttles retries and a network blip can't
 * erase a pending upgrade_available notice). No prior marker → write nothing;
 * the next invocation retries.
 */
function preserveCacheOnFailedCheck(): void {
  try {
    const prior = readUpdateCache();
    if (prior) safeWriteCache(prior.marker);
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch the latest version and write the self-upgrade cache (the marker line
 * read by the CLI startup hook). On fetch failure the last-known-good marker is
 * preserved (see preserveCacheOnFailedCheck) — never a fabricated `up_to_date`.
 * This is the function the detached single-flight refresh (`gbrain
 * check-update --refresh-cache`) invokes.
 */
export async function refreshUpdateCache(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release.ok) {
    preserveCacheOnFailedCheck();
    return;
  }
  const latestVersion = release.tag.replace(/^v/, '');
  if (!isValidVersionString(latestVersion) || !isNewerVersion(VERSION, latestVersion)) {
    safeWriteCache({ kind: 'up_to_date', current: VERSION });
    return;
  }
  safeWriteCache({ kind: 'upgrade_available', current: VERSION, latest: latestVersion });
}

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json] [--refresh-cache]\n\nCheck for new GBrain versions.\n\nReports any strictly newer release, including patch and micro updates.\nFails silently on network errors.\n\n--refresh-cache  Fetch + update the self-upgrade cache, print nothing (used by\n                 the CLI startup hook\'s detached refresh).');
    return;
  }

  // Detached refresh path: warm the cache for the next invocation, emit nothing.
  // Single-flight via the refresh lock so many simultaneous stale-cache
  // invocations don't stampede GitHub. If another refresh holds the lock, exit.
  if (args.includes('--refresh-cache')) {
    const { tryAcquireRefreshLock, releaseRefreshLock } = await import('../core/self-upgrade.ts');
    const lock = tryAcquireRefreshLock();
    if (!lock) return; // another refresh is in flight
    try {
      await refreshUpdateCache();
    } finally {
      releaseRefreshLock(lock);
    }
    return;
  }

  const json = args.includes('--json');
  const method = detectInstallMethod();
  const upgradeCmd = upgradeCommandForMethod(method);

  const release = await fetchLatestRelease();

  if (!release.ok) {
    preserveCacheOnFailedCheck();
    if (json) {
      console.log(JSON.stringify({
        current_version: VERSION,
        current_source: 'package-json',
        latest_version: '',
        update_available: false,
        upgrade_command: upgradeCmd,
        release_url: '',
        changelog_diff: '',
        published_at: '',
        error: release.reason,
      }, null, 2));
    } else if (release.reason === 'network_error') {
      console.log(`GBrain ${VERSION} — could not check for updates (network unavailable).`);
    } else {
      console.log(`GBrain ${VERSION} — could not determine the latest published version.`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isValidVersionString(latestVersion) && isNewerVersion(VERSION, latestVersion);

  // Warm the self-upgrade cache so the next `gbrain <cmd>` startup hook can emit
  // the marker without a network call.
  safeWriteCache(
    updateAvailable
      ? { kind: 'upgrade_available', current: VERSION, latest: latestVersion }
      : { kind: 'up_to_date', current: VERSION },
  );

  let changelogDiff = '';
  if (updateAvailable) {
    changelogDiff = await fetchChangelog(VERSION, latestVersion);
  }

  const result: CheckUpdateResult = {
    current_version: VERSION,
    current_source: 'package-json',
    latest_version: latestVersion,
    update_available: updateAvailable,
    upgrade_command: upgradeCmd,
    release_url: release.url,
    changelog_diff: changelogDiff,
    published_at: release.published_at,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (updateAvailable) {
    console.log(`GBrain update available: ${VERSION} → ${latestVersion}`);
    console.log(`Run: ${upgradeCmd}`);
    console.log(`Release: ${release.url}`);
  } else {
    console.log(`GBrain ${VERSION} is up to date.`);
  }
}

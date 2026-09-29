import { resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { resolveSourceId } from './source-resolver.ts';
import { ALL_SOURCES } from './source-id.ts';

/** The restore request does not identify exactly one source and its repo. */
export class RestoreTargetError extends Error {}

/**
 * The source and repo `gbrain export --restore-only` restores. `gbrain
 * storage status` resolves its restore hint with the same rule, so the files
 * it lists as missing are the ones the hint restores.
 *
 * `source` is an explicit --source already passed through resolveSourceId;
 * `repo` is an explicit --repo. A repo without a source selects the one
 * active source registered at that exact path, else the only active source.
 * Neither selects the flagless resolver chain's source and its local_path
 * (the legacy sync.repo_path answers for `default` only).
 */
export async function resolveRestoreTarget(
  engine: BrainEngine,
  source: string | undefined,
  repo: string | undefined,
): Promise<{ source: string; repo: string }> {
  if (source === ALL_SOURCES) throw new RestoreTargetError('--restore-only requires one source; pass --source <id>.');
  if (!source && repo) {
    const matches = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path=$1 LIMIT 2', [resolve(repo)]);
    if (matches.length === 1) source = matches[0].id;
    else {
      const owners = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id LIMIT 2');
      if (!matches.length && owners.length === 1) source = owners[0].id;
      else throw new RestoreTargetError('The restore repo does not identify exactly one source. Pass --source <id> and --repo <path> for that source.');
    }
  }
  source ??= await resolveSourceId(engine, undefined);
  if (source === ALL_SOURCES) throw new RestoreTargetError('--restore-only requires one source; pass --source <id>.');
  if (!repo) {
    const [owner] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [source]);
    repo = owner?.local_path ?? (source === 'default' ? await engine.getConfig('sync.repo_path') : undefined) ?? undefined;
  }
  if (!repo) throw new RestoreTargetError('--restore-only requires --repo <path> or a configured default source with a local_path.');
  return { source, repo };
}

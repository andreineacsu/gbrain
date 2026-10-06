/**
 * gbrain pages — page-level operator commands. v0.26.5+.
 *
 * The first subcommand: `pages purge-deleted [--older-than HOURS] [--dry-run]`.
 * Manual escape hatch alongside the autopilot purge phase. Hard-deletes pages
 * whose `deleted_at` is older than the cutoff; cascades to content_chunks,
 * page_links, chunk_relations via existing FKs.
 */
import type { BrainEngine } from '../core/engine.ts';
import { purgeDeletedPagesCoordinated } from '../core/persistence/purge-deleted.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const SOFT_DELETE_TTL_HOURS_DEFAULT = 72;

const PURGE_DELETED_USAGE = `Usage: gbrain pages purge-deleted [--older-than HOURS|Nh|Nd] [--dry-run] [--json]

Hard-delete pages soft-deleted more than --older-than ago (default ${SOFT_DELETE_TTL_HOURS_DEFAULT}h) in every
source; there is no --source. A managed brain leaves archived sources to
\`gbrain sources purge\`. Cascades to chunks, links and edges. There is no undo:
run with --dry-run first to list what would be purged.`;

/** Stops before the engine is touched: a purge must never run past an argument it would ignore. */
function refusePurge(message: string): never {
  console.error(`${message} Nothing was purged. Run \`gbrain pages purge-deleted --help\` for usage.`);
  process.exit(2);
}

function parseOlderThanHours(raw: string | undefined): number {
  if (raw === undefined) refusePurge('--older-than needs a value: hours (e.g. 72 or 72h) or days (e.g. 3d).');
  // Accept bare numbers (hours) or `<N>h` / `<N>d`. Reject anything ambiguous.
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)d$/);
  if (dayMatch) return Math.max(0, parseInt(dayMatch[1], 10) * 24);
  const hourMatch = trimmed.match(/^(\d+)h?$/);
  if (hourMatch) return Math.max(0, parseInt(hourMatch[1], 10));
  refusePurge(`Invalid --older-than value: "${raw}". Expected hours (e.g. 72 or 72h) or days (e.g. 3d).`);
}

function parsePurgeDeletedArgs(args: string[]): { olderThanHours: number; dryRun: boolean; json: boolean } {
  let olderThanHours: number | undefined;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--older-than') {
      if (olderThanHours !== undefined) refusePurge('--older-than was given more than once; pass it once.');
      olderThanHours = parseOlderThanHours(args[++i]);
    } else if (arg.startsWith('--older-than=')) {
      refusePurge(`Pass --older-than and its value as two arguments ("--older-than ${arg.slice('--older-than='.length)}"), not "${arg}".`);
    } else refusePurge(`Unknown argument for pages purge-deleted: "${arg}".`);
  }
  return { olderThanHours: olderThanHours ?? SOFT_DELETE_TTL_HOURS_DEFAULT, dryRun, json };
}

async function runPurgeDeleted(engine: BrainEngine, args: string[]): Promise<void> {
  // #6114: help and argument errors answer before the engine. The CLI's
  // engine-free help route reaches this with a null engine.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(PURGE_DELETED_USAGE);
    return;
  }
  const { olderThanHours, dryRun, json } = parsePurgeDeletedArgs(args);

  if (dryRun) {
    // Same engine method, same WHERE predicate, same DB now() clock as the
    // real purge — only the verb differs (SELECT, stays read-only). The old
    // listPages enumeration capped at 10000 rows (live pages included), so
    // brains past the cap under-reported the purge set.
    const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
    if (json) {
      console.log(JSON.stringify({ dry_run: true, older_than_hours: olderThanHours, count: preview.count, slugs: preview.slugs }, null, 2));
      return;
    }
    console.log(`(dry-run) Would purge ${preview.count} page(s) soft-deleted more than ${olderThanHours}h ago.`);
    for (const p of preview.pages ?? []) console.log(`  ${p.slug}  deleted_at=${p.deleted_at.toISOString()}`);
    return;
  }

  const result = await purgeDeletedPagesCoordinated(engine, olderThanHours);
  if (json) {
    console.log(JSON.stringify({ older_than_hours: olderThanHours, count: result.count, slugs: result.slugs,
      ...(result.blocked.length ? { blocked: result.blocked } : {}) }, null, 2));
    if (result.error) setCliExitVerdict(1);
    return;
  }
  for (const b of result.blocked) console.error(`Not purged: ${b.source_id}/${b.slug}: ${b.reason}`);
  if (result.error) setCliExitVerdict(1);
  if (result.count === 0) {
    console.log(`No pages to purge (older than ${olderThanHours}h).`);
  } else {
    console.log(`Purged ${result.count} page(s) (older than ${olderThanHours}h):`);
    for (const slug of result.slugs) console.log(`  ${slug}`);
  }
}

function printHelp(): void {
  console.log(`gbrain pages — page-level operator commands (v0.26.5)

Subcommands:
  purge-deleted [--older-than HOURS|Nh|Nd] [--dry-run] [--json]
                                    Hard-delete soft-deleted pages older than the cutoff
                                    (default ${SOFT_DELETE_TTL_HOURS_DEFAULT}h). Cascades to chunks/links/edges.
                                    Mirror of the autopilot purge phase.

Notes:
  Soft-delete a page via the MCP \`delete_page\` op (also removes its markdown file
  from the source working tree). Restore via \`restore_page\` (re-creates the file).
  This command is the manual operator escape hatch — the autopilot cycle's
  purge phase already calls the same library function on every run.
`);
}

export async function runPages(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'purge-deleted': return runPurgeDeleted(engine, rest);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { isDurabilityHardened } from '../brain-repo-durability.ts';
import { OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';

/** Most paths one batch publishes; the rest wait for the next pass. */
export const GIT_BATCH_PATHS = 100;
/** Whole-index listings grow with the worktree, not with the batch. */
const LISTING_BUFFER = 64 * 1024 * 1024;
const COMMIT_MESSAGE = 'gbrain: persist canonical memory update';

type Git = (args: string[], maxBuffer?: number) => Promise<{ stdout: string; stderr: string; code: number }>;
/** A settled path, or the refusal that belongs to it alone. */
export type GitPathResult = { outcome: Record<string, unknown> } | { error: unknown };

function git(root: string, hooks: string, args: string[], signal?: AbortSignal, maxBuffer = 1024 * 1024): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-C', root, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', timeout: 20_000, maxBuffer, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '0' },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) reject(new OperationError('git_unavailable', 'Git execution did not finish within its bounded attempt.'));
      else resolve({ stdout, stderr, code: error?.code as number ?? 0 });
    });
  });
}

/** Legacy hooks never run: Git sees an empty private hooks directory, which also holds pathspec files. */
async function withGit<T>(root: string, signal: AbortSignal | undefined, run: (git: Git, scratch: string) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  try { return await run((args, maxBuffer) => git(root, hooks, args, signal, maxBuffer), hooks); }
  finally { rmSync(hooks, { recursive: true, force: true }); }
}

/** Exit code and Git's first stderr line, for a fallback log. */
const exitCause = ({ code, stderr }: { code: number; stderr: string }) =>
  [`exit ${code}`, stderr.trim().split('\n')[0]].filter(Boolean).join(': ');
const notHardened = () => ({ git: 'skipped', reason: 'durability_not_enabled', push: 'skipped' });
const nativeRelative = (root: string, relativePath: string) =>
  relative(root, nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe')).split(sep).join('/');

/** One path with the absent-target and indexed-deletion checks. An outcome without `push` still needs a push. */
async function commitPath(root: string, relativePath: string, git: Git): Promise<Record<string, unknown>> {
  const path = nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe');
  relativePath = relative(root, path).split(sep).join('/');
  const tracked = await git(['ls-files', '-z', '--error-unmatch', '--', relativePath]);
  if (tracked.code !== 0 && tracked.code !== 1) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
  const changed = await git(['status', '--porcelain', '--untracked-files=all', '--', relativePath]);
  if (changed.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
  let commit = 'unchanged';
  if (changed.stdout.trim()) {
    if (tracked.code === 0 || existsSync(path)) {
      const add = await git(['add', '-A', '--', relativePath]);
      if (add.code !== 0) throw new OperationError('git_unavailable', 'Cannot stage the canonical Git target.');
    }
    const diff = await git(['diff', '--cached', '--quiet', '--', relativePath]);
    if (diff.code === 1) {
      // --only keeps unrelated staged paths out of this commit. After a lost
      // database acknowledgment the same HEAD/file state is an exact no-op.
      const result = await git(['commit', '--only', '-m', COMMIT_MESSAGE, '--', relativePath]);
      if (result.code !== 0) throw new OperationError('git_unavailable', 'Cannot commit the canonical Git target.');
      commit = 'committed';
    } else if (diff.code !== 0) throw new OperationError('git_unavailable', 'Cannot compare the canonical Git target.');
  } else if (tracked.code !== 0) {
    if (existsSync(path)) throw new OperationError('git_target_unsafe', 'Git cannot identify the existing canonical file by its native spelling.',
      'Reconcile the index and worktree spelling before retrying publication.');
    let parent = dirname(path);
    while (!existsSync(parent)) {
      if (parent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
      parent = dirname(parent);
    }
    const scope = relative(root, parent).split(sep).join('/') || '.';
    const deleted = await git(['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope]);
    const staged = await git(['diff', '--cached', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope]);
    if (deleted.code !== 0 || staged.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect canonical Git deletions.');
    for (const entry of new Set(`${deleted.stdout}${staged.stdout}`.split('\0').filter(Boolean))) {
      if (existsSync(join(root, entry))) continue;
      let missingParent = dirname(nativeFileTarget(root, join(root, entry), 'git_target_unsafe'));
      while (!existsSync(missingParent)) {
        if (missingParent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
        missingParent = dirname(missingParent);
      }
      if (missingParent === parent) throw new OperationError('git_target_unsafe', 'The absent target cannot be distinguished from an indexed deletion.',
        'Reconcile the recorded deletion path with the Git index before retrying publication.');
    }
    return { git: 'skipped', reason: 'target_absent', push: 'skipped' };
  }
  return { git: commit };
}

/**
 * Commits every present changed path in one `commit --only` and settles
 * present tracked unchanged paths. Absent targets, paths Git does not list
 * under their native spelling, and the whole set after a failed stage or a
 * failed whole-tree listing are left unsettled for the single-path checks.
 * Path lists reach Git through pathspec files, never argv.
 */
async function commitPresent(root: string, paths: string[], git: Git, scratch: string, settled: Map<string, GitPathResult>): Promise<void> {
  const fallback = (command: string, cause: string) =>
    console.warn(`[persistence] Git batch \`${command}\` failed (${cause}); ${paths.filter(path => !settled.has(path)).length} paths take the single-path route.`);
  // An old Git, the bounded attempt or the output cap can fail a whole-tree
  // listing; the path-scoped single-path commands still run then.
  const listing = async (args: string[]) => {
    try {
      const result = await git(args, LISTING_BUFFER);
      if (result.code === 0) return result.stdout;
      fallback(args.join(' '), exitCause(result));
    } catch (error) {
      if (!(error instanceof OperationError && error.code === 'git_unavailable')) throw error;
      fallback(args.join(' '), error.message);
    }
    return undefined;
  };
  // `ls-files` names paths from `root`; `status` and `diff` name them from
  // the Git toplevel, which `root` may sit below. The first failed listing
  // ends the batch route, so a slow worktree pays one bounded attempt.
  const prefix = (await listing(['rev-parse', '--show-prefix']))?.replace(/\n$/, '');
  if (prefix === undefined) return;
  const tracked = await listing(['ls-files', '-z']);
  if (tracked === undefined) return;
  const status = await listing(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']);
  if (status === undefined) return;
  const indexed = new Set(tracked.split('\0'));
  // Without rename detection every porcelain -z entry is `XY <path>`.
  const changed = new Set(status.split('\0').filter(Boolean).map(entry => entry.slice(3)));
  const staging: string[] = [];
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue;
    if (changed.has(prefix + path)) staging.push(path);
    else if (indexed.has(path)) settled.set(path, { outcome: { git: 'unchanged' } });
  }
  if (!staging.length) return;
  const list = join(scratch, 'pathspec');
  const pathspec = (selected: string[]) => { writeFileSync(list, selected.join('\0')); return [`--pathspec-from-file=${list}`, '--pathspec-file-nul']; };
  // One path Git refuses to stage must not fail the others: each retries alone.
  const add = await git(['add', '-A', ...pathspec(staging)]);
  if (add.code !== 0) { fallback('add -A --pathspec-from-file', exitCause(add)); return; }
  const staged = await listing(['diff', '--cached', '--name-only', '--no-renames', '-z']);
  if (staged === undefined) return;
  const differs = new Set(staged.split('\0'));
  const committing = staging.filter(path => differs.has(prefix + path));
  if (committing.length) {
    // --only keeps unrelated staged paths out of this commit.
    const result = await git(['commit', '--only', '-m', COMMIT_MESSAGE, ...pathspec(committing)]);
    if (result.code !== 0) throw new OperationError('git_unavailable', 'Cannot commit the canonical Git targets.');
  }
  for (const path of staging) settled.set(path, { outcome: { git: differs.has(prefix + path) ? 'committed' : 'unchanged' } });
}

/** Pushes HEAD to its tracking remote. A plain push is idempotent and cannot import remote canonical content. */
async function pushHead(git: Git): Promise<Record<string, unknown>> {
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code !== 0) return { push: 'skipped', reason: 'no_tracking_remote' };
  const remote = await git(['config', '--get', `branch.${branch.stdout.trim()}.remote`]);
  const merge = await git(['config', '--get', `branch.${branch.stdout.trim()}.merge`]);
  if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') {
    return { push: 'skipped', reason: 'no_tracking_remote' };
  }
  const push = await git(['push', '--', remote.stdout.trim(), `HEAD:${merge.stdout.trim()}`]);
  if (push.code !== 0) throw new OperationError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.');
  return { push: 'committed' };
}

/** Caller owns the native worktree lock. Never run pull, rebase, or legacy hooks. */
export async function publishGitEffect(root: string, relativePath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!isDurabilityHardened(root)) return notHardened();
  return withGit(root, signal, async git => {
    const outcome = await commitPath(root, relativePath, git);
    return outcome.push ? outcome : { ...outcome, ...await pushHead(git) };
  });
}

/**
 * Caller owns the native worktree lock. Commits a batch of paths, results
 * aligned with `relativePaths`; an outcome without `push` still needs
 * `pushGitEffects`. `hardened` is the caller's durability probe of `root`,
 * when it took one.
 */
export async function commitGitEffects(root: string, relativePaths: string[], signal?: AbortSignal,
  hardened?: boolean): Promise<GitPathResult[]> {
  if (relativePaths.length > GIT_BATCH_PATHS) throw new RangeError(`A Git batch holds at most ${GIT_BATCH_PATHS} paths.`);
  if (!(hardened ?? isDurabilityHardened(root))) return relativePaths.map(() => ({ outcome: notHardened() }));
  return withGit(root, signal, async (git, scratch) => {
    const settled = new Map<string, GitPathResult>();
    const refused: GitPathResult[] = [];
    const targets = relativePaths.map((relativePath, index) => {
      try { return nativeRelative(root, relativePath); }
      catch (error) { refused[index] = { error }; return undefined; }
    });
    const paths = [...new Set(targets.filter((path): path is string => path !== undefined))];
    if (paths.length > 1) await commitPresent(root, paths, git, scratch, settled);
    for (const path of paths) {
      if (settled.has(path)) continue;
      try { settled.set(path, { outcome: await commitPath(root, path, git) }); }
      catch (error) { settled.set(path, { error }); }
    }
    return targets.map((path, index) => refused[index] ?? settled.get(path!)!);
  });
}

/**
 * Pushes the worktree's HEAD. The caller holds the push lock: a batch pushes
 * after releasing the worktree lock, a walk page inside it.
 */
export async function pushGitEffects(root: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withGit(root, signal, pushHead);
}

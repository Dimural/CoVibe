/**
 * Git operation wrappers.
 *
 * Typed, testable wrappers around the VS Code Git extension API for common
 * repository operations: commit, push, pull, branch query, and dirty-file
 * enumeration.
 *
 * Pure logic lives in `_*Pure` functions (exported for testing via dependency
 * injection). The public functions (`gitCommit`, `gitPush`, etc.) wire in the
 * real VS Code API via a lazy import.
 */

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

/** Discriminated union of every failure that a Git operation can produce. */
export type GitOperationError =
  | { kind: 'no-repo'; message: string }
  | { kind: 'git-ext-unavailable'; message: string }
  | { kind: 'commit-failed'; message: string }
  | { kind: 'push-failed'; message: string }
  | { kind: 'pull-failed'; message: string };

// ---------------------------------------------------------------------------
// Internal structural types for the VS Code Git extension API subset we use.
// These are *not* re-exported — callers should rely on the public function
// signatures only.
// ---------------------------------------------------------------------------

interface GitChange {
  uri: { fsPath: string };
}

interface GitRepo {
  state: {
    HEAD?: { name?: string; commit?: string } | undefined;
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
  };
  commit(message: string, opts?: { all?: boolean }): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
}

interface GitAPI {
  repositories: GitRepo[];
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/** Resolves the first available repository from the VS Code Git extension API. */
async function resolveRepo(): Promise<GitRepo | GitOperationError> {
  const vscode = await import('vscode');
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitApi = gitExt?.exports?.getAPI(1);

  if (gitApi === undefined) {
    return { kind: 'git-ext-unavailable', message: 'VS Code Git extension is not available.' };
  }

  const repo = gitApi.repositories[0];
  if (repo === undefined) {
    return { kind: 'no-repo', message: 'No Git repository found in the current workspace.' };
  }

  return repo;
}

// ---------------------------------------------------------------------------
// Pure logic — exported for testing (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Returns the current branch name, or a {@link GitOperationError} when the
 * repo or HEAD is unavailable.
 *
 * Exported with `_` prefix to signal "testing only".
 */
export function _currentBranchPure(repo: GitRepo | undefined): Promise<string | GitOperationError> {
  if (repo === undefined)
    return Promise.resolve({
      kind: 'no-repo',
      message: 'No Git repository found in the current workspace.',
    });

  const name = repo.state.HEAD?.name ?? 'HEAD';
  return Promise.resolve(name);
}

/**
 * Returns an array of unique file paths that have uncommitted changes
 * (working-tree or index), or a {@link GitOperationError}.
 *
 * Exported with `_` prefix to signal "testing only".
 */
export function _dirtyFilesPure(repo: GitRepo | undefined): Promise<string[] | GitOperationError> {
  if (repo === undefined)
    return Promise.resolve({
      kind: 'no-repo',
      message: 'No Git repository found in the current workspace.',
    });

  const paths = new Set<string>();
  for (const change of repo.state.workingTreeChanges) {
    paths.add(change.uri.fsPath);
  }
  for (const change of repo.state.indexChanges) {
    paths.add(change.uri.fsPath);
  }

  return Promise.resolve([...paths]);
}

/**
 * Commits staged/all changes with `message`. Optionally accepts `files` for
 * future selective staging (currently ignored beyond signalling `all: false`).
 *
 * Exported with `_` prefix to signal "testing only".
 */
export async function _gitCommitPure(
  repo: GitRepo | undefined,
  message: string,
  files?: string[],
): Promise<void | GitOperationError> {
  if (repo === undefined)
    return { kind: 'no-repo', message: 'No Git repository found in the current workspace.' };

  try {
    const opts = files !== undefined && files.length > 0 ? { all: false } : undefined;
    await repo.commit(message, opts);
  } catch (err) {
    return { kind: 'commit-failed', message: errorMessage(err) };
  }
}

/**
 * Pushes the current branch to the upstream remote.
 *
 * Exported with `_` prefix to signal "testing only".
 */
export async function _gitPushPure(repo: GitRepo | undefined): Promise<void | GitOperationError> {
  if (repo === undefined)
    return { kind: 'no-repo', message: 'No Git repository found in the current workspace.' };

  try {
    await repo.push();
  } catch (err) {
    return { kind: 'push-failed', message: errorMessage(err) };
  }
}

/**
 * Pulls changes from the upstream remote into the current branch.
 *
 * Exported with `_` prefix to signal "testing only".
 */
export async function _gitPullPure(repo: GitRepo | undefined): Promise<void | GitOperationError> {
  if (repo === undefined)
    return { kind: 'no-repo', message: 'No Git repository found in the current workspace.' };

  try {
    await repo.pull();
  } catch (err) {
    return { kind: 'pull-failed', message: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Public VS Code-wired entry points
// ---------------------------------------------------------------------------

/**
 * Returns the name of the current Git branch, or a {@link GitOperationError}
 * describing why the branch could not be determined.
 */
export async function currentBranch(): Promise<string | GitOperationError> {
  const repoOrErr = await resolveRepo();
  if ('kind' in repoOrErr) return repoOrErr;
  return _currentBranchPure(repoOrErr);
}

/**
 * Returns the list of file paths that have uncommitted changes (working-tree
 * or staged), deduplicated. Returns a {@link GitOperationError} on failure.
 */
export async function dirtyFiles(): Promise<string[] | GitOperationError> {
  const repoOrErr = await resolveRepo();
  if ('kind' in repoOrErr) return repoOrErr;
  return _dirtyFilesPure(repoOrErr);
}

/**
 * Commits changes with the given `message`. Optionally accepts `files` (a
 * list of paths to include). Returns `void` on success or a
 * {@link GitOperationError} on failure.
 */
export async function gitCommit(
  message: string,
  files?: string[],
): Promise<void | GitOperationError> {
  const repoOrErr = await resolveRepo();
  if ('kind' in repoOrErr) return repoOrErr;
  return _gitCommitPure(repoOrErr, message, files);
}

/**
 * Pushes the current branch to its upstream remote. Returns `void` on success
 * or a {@link GitOperationError} on failure.
 */
export async function gitPush(): Promise<void | GitOperationError> {
  const repoOrErr = await resolveRepo();
  if ('kind' in repoOrErr) return repoOrErr;
  return _gitPushPure(repoOrErr);
}

/**
 * Pulls from the upstream remote into the current branch. Returns `void` on
 * success or a {@link GitOperationError} on failure.
 */
export async function gitPull(): Promise<void | GitOperationError> {
  const repoOrErr = await resolveRepo();
  if ('kind' in repoOrErr) return repoOrErr;
  return _gitPullPure(repoOrErr);
}

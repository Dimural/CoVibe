/**
 * Git context probe.
 *
 * Reads repository state from VS Code's built-in Git extension API.
 * The pure logic lives in `_probeRepoContext` (exported for testing);
 * `getRepoContext` and `watchBranchChanges` wire in the real vscode API.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepoContext {
  remoteUrl: string; // e.g. "https://github.com/owner/repo"
  branch: string; // current branch name
  isDirty: boolean; // any uncommitted changes
  headSha: string; // current HEAD SHA
}

export interface GitContextError {
  kind: 'no-repo' | 'no-remote' | 'git-ext-unavailable';
  message: string;
}

// ---------------------------------------------------------------------------
// Minimal structural types for the VS Code Git extension API subset we use.
// The Git extension does not ship its own @types package; we define our own.
// ---------------------------------------------------------------------------

interface Remote {
  name: string;
  fetchUrl?: string | undefined;
}

interface HeadRef {
  name?: string | undefined;
  commit?: string | undefined;
}

interface VsCodeDisposable {
  dispose(): void;
}

interface RepoState {
  remotes: Remote[];
  HEAD?: HeadRef | undefined;
  workingTreeChanges: unknown[];
  indexChanges: unknown[];
  onDidChange: (listener: () => void) => VsCodeDisposable;
}

interface Repository {
  state: RepoState;
}

interface GitAPI {
  repositories: Repository[];
  getRepository: (uri: unknown) => Repository | null;
  onDidChangeState?: ((listener: () => void) => VsCodeDisposable) | undefined;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

// ---------------------------------------------------------------------------
// Pure logic (exported for testing via dependency injection)
// ---------------------------------------------------------------------------

/**
 * Core probe logic. Accepts `gitApi` and `activeUri` as parameters so that
 * tests can pass mock objects without needing the VS Code extension host.
 *
 * Exported with a leading `_` to signal "exported for testing only".
 *
 * Edge cases:
 * - Detached HEAD: `branch` is `'HEAD'` (when `state.HEAD.name` is undefined).
 * - No commits: `headSha` is `''` (when `state.HEAD.commit` is undefined).
 * - Multiple repos: picks the repo that owns the active editor's document URI,
 *   falls back to `repositories[0]` if no match or no active editor.
 */
export function _probeRepoContext(
  gitApi: GitAPI | undefined,
  activeUri: unknown,
): Promise<RepoContext | GitContextError> {
  if (gitApi === undefined) {
    return Promise.resolve({
      kind: 'git-ext-unavailable' as const,
      message: 'VS Code Git extension is not available.',
    });
  }

  const { repositories } = gitApi;

  if (repositories.length === 0) {
    return Promise.resolve({
      kind: 'no-repo' as const,
      message: 'No Git repository found in the current workspace.',
    });
  }

  // Pick the active repo; fall back to the first one.
  const activeRepo =
    activeUri !== null ? (gitApi.getRepository(activeUri) ?? repositories[0]) : repositories[0];

  // repositories.length > 0 is already verified, so repositories[0] is defined.
  // The ?? satisfies noUncheckedIndexedAccess; the length guard ensures we
  // never actually reach undefined here.
  const repo = activeRepo ?? repositories[0];

  if (repo === undefined) {
    return Promise.resolve({
      kind: 'no-repo' as const,
      message: 'No Git repository found in the current workspace.',
    });
  }

  const { state } = repo;

  // Prefer 'origin'; fall back to the first available remote.
  const originRemote = state.remotes.find((r) => r.name === 'origin');
  const firstRemote = state.remotes[0];
  const remoteUrl = originRemote?.fetchUrl ?? firstRemote?.fetchUrl;

  if (remoteUrl === undefined) {
    return Promise.resolve({
      kind: 'no-remote' as const,
      message: 'No remote URL found for this repository.',
    });
  }

  const branch = state.HEAD?.name ?? 'HEAD';
  const isDirty = state.workingTreeChanges.length > 0 || state.indexChanges.length > 0;
  const headSha = state.HEAD?.commit ?? '';

  return Promise.resolve({ remoteUrl, branch, isDirty, headSha });
}

// ---------------------------------------------------------------------------
// Public entry points (vscode-dependent — lazy import so tests can load this
// module without an extension host)
// ---------------------------------------------------------------------------

/**
 * Returns the current repository context, or a `GitContextError` describing
 * why the context could not be determined.
 */
export async function getRepoContext(): Promise<RepoContext | GitContextError> {
  const vscode = await import('vscode');

  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitApi = gitExt?.exports?.getAPI(1);

  const activeUri = vscode.window.activeTextEditor?.document.uri ?? null;

  return _probeRepoContext(gitApi, activeUri);
}

/**
 * Watches for branch changes on the active repository and calls `callback`
 * with the new branch name whenever it changes.
 *
 * Returns a disposable that cleans up all subscriptions.
 */
export async function watchBranchChanges(
  callback: (branch: string) => void,
): Promise<VsCodeDisposable> {
  const vscode = await import('vscode');

  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitApi = gitExt?.exports?.getAPI(1);

  if (gitApi === undefined) {
    // No git API — return a no-op disposable.
    return { dispose(): void {} };
  }

  const disposables: VsCodeDisposable[] = [];
  let lastBranch: string | undefined;

  const notify = (): void => {
    const activeUri = vscode.window.activeTextEditor?.document.uri ?? null;
    const repo =
      activeUri !== null
        ? (gitApi.getRepository(activeUri) ?? gitApi.repositories[0])
        : gitApi.repositories[0];

    if (repo === undefined) return;

    const current = repo.state.HEAD?.name;
    if (current !== undefined && current !== lastBranch) {
      lastBranch = current;
      callback(current);
    }
  };

  // Subscribe to global git state changes.
  if (gitApi.onDidChangeState !== undefined) {
    disposables.push(gitApi.onDidChangeState(notify));
  }

  // Subscribe to the active repo's state changes.
  const activeUri = vscode.window.activeTextEditor?.document.uri ?? null;
  const repo =
    activeUri !== null
      ? (gitApi.getRepository(activeUri) ?? gitApi.repositories[0])
      : gitApi.repositories[0];

  if (repo !== undefined) {
    disposables.push(repo.state.onDidChange(notify));
  }

  return vscode.Disposable.from(...disposables);
}

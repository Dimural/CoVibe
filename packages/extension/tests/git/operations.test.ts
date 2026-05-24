/**
 * Tests for the pure Git operation wrappers.
 *
 * All tests use dependency-injected fake repo objects so no VS Code extension
 * host or real git repository is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  _currentBranchPure,
  _dirtyFilesPure,
  _gitCommitPure,
  _gitPushPure,
  _gitPullPure,
  type GitOperationError,
} from '../../src/git/operations.js';

// ---------------------------------------------------------------------------
// Minimal mock types mirroring the structural interfaces in operations.ts
// ---------------------------------------------------------------------------

interface MockChange {
  uri: { fsPath: string };
}

interface MockRepo {
  state: {
    HEAD?: { name?: string; commit?: string } | undefined;
    workingTreeChanges: MockChange[];
    indexChanges: MockChange[];
  };
  commit: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
}

function makeRepo(overrides: Partial<MockRepo['state']> = {}): MockRepo {
  const commit = vi.fn().mockResolvedValue(undefined);
  const push = vi.fn().mockResolvedValue(undefined);
  const pull = vi.fn().mockResolvedValue(undefined);
  return {
    state: {
      HEAD: { name: 'main', commit: 'abc1234' },
      workingTreeChanges: [],
      indexChanges: [],
      ...overrides,
    },
    commit,
    push,
    pull,
  };
}

// ---------------------------------------------------------------------------
// currentBranch
// ---------------------------------------------------------------------------

describe('_currentBranchPure', () => {
  it('returns branch name from repo.state.HEAD.name', async () => {
    const repo = makeRepo({ HEAD: { name: 'feature/awesome', commit: 'deadbeef' } });
    const result = await _currentBranchPure(repo);
    expect(result).toBe('feature/awesome');
  });

  it('returns no-repo error when repo is undefined', async () => {
    const result = await _currentBranchPure(undefined);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });

  it('returns no-repo error when HEAD is undefined', async () => {
    const repo = makeRepo({ HEAD: undefined });
    const result = await _currentBranchPure(repo);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });

  it('returns no-repo error when HEAD.name is undefined', async () => {
    const repo = makeRepo({ HEAD: { name: undefined, commit: 'abc' } });
    const result = await _currentBranchPure(repo);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

// ---------------------------------------------------------------------------
// dirtyFiles
// ---------------------------------------------------------------------------

describe('_dirtyFilesPure', () => {
  it('returns empty array when no changes', async () => {
    const repo = makeRepo({ workingTreeChanges: [], indexChanges: [] });
    const result = await _dirtyFilesPure(repo);
    expect(result).toEqual([]);
  });

  it('returns paths from workingTreeChanges', async () => {
    const repo = makeRepo({
      workingTreeChanges: [{ uri: { fsPath: '/a/foo.ts' } }, { uri: { fsPath: '/a/bar.ts' } }],
      indexChanges: [],
    });
    const result = await _dirtyFilesPure(repo);
    expect(result).toEqual(['/a/foo.ts', '/a/bar.ts']);
  });

  it('returns paths from indexChanges', async () => {
    const repo = makeRepo({
      workingTreeChanges: [],
      indexChanges: [{ uri: { fsPath: '/a/staged.ts' } }],
    });
    const result = await _dirtyFilesPure(repo);
    expect(result).toEqual(['/a/staged.ts']);
  });

  it('deduplicates paths that appear in both workingTreeChanges and indexChanges', async () => {
    const repo = makeRepo({
      workingTreeChanges: [{ uri: { fsPath: '/a/both.ts' } }, { uri: { fsPath: '/a/only-wt.ts' } }],
      indexChanges: [{ uri: { fsPath: '/a/both.ts' } }, { uri: { fsPath: '/a/only-ix.ts' } }],
    });
    const result = await _dirtyFilesPure(repo);
    expect(result).toHaveLength(3);
    expect(result).toContain('/a/both.ts');
    expect(result).toContain('/a/only-wt.ts');
    expect(result).toContain('/a/only-ix.ts');
  });

  it('returns no-repo error when repo is undefined', async () => {
    const result = await _dirtyFilesPure(undefined);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

// ---------------------------------------------------------------------------
// gitCommit
// ---------------------------------------------------------------------------

describe('_gitCommitPure', () => {
  it('calls repo.commit with the message and resolves void on success', async () => {
    const repo = makeRepo();
    const result = await _gitCommitPure(repo, 'feat: add something');
    expect(repo.commit).toHaveBeenCalledWith('feat: add something', undefined);
    expect(result).toBeUndefined();
  });

  it('passes opts when files are provided', async () => {
    const repo = makeRepo();
    const result = await _gitCommitPure(repo, 'feat: add something', ['/a/foo.ts']);
    expect(repo.commit).toHaveBeenCalledWith('feat: add something', { all: false });
    expect(result).toBeUndefined();
  });

  it('returns commit-failed error when repo.commit rejects', async () => {
    const repo = makeRepo();
    repo.commit.mockRejectedValue(new Error('conflict'));
    const result = await _gitCommitPure(repo, 'feat: broken');
    expect((result as GitOperationError).kind).toBe('commit-failed');
    expect((result as Extract<GitOperationError, { kind: 'commit-failed' }>).message).toBe(
      'conflict',
    );
  });

  it('returns no-repo error when repo is undefined', async () => {
    const result = await _gitCommitPure(undefined, 'oops');
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

// ---------------------------------------------------------------------------
// gitPush
// ---------------------------------------------------------------------------

describe('_gitPushPure', () => {
  it('calls repo.push() and resolves void on success', async () => {
    const repo = makeRepo();
    const result = await _gitPushPure(repo);
    expect(repo.push).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('returns push-failed error when repo.push rejects', async () => {
    const repo = makeRepo();
    repo.push.mockRejectedValue(new Error('network error'));
    const result = await _gitPushPure(repo);
    expect((result as GitOperationError).kind).toBe('push-failed');
    expect((result as Extract<GitOperationError, { kind: 'push-failed' }>).message).toBe(
      'network error',
    );
  });

  it('returns no-repo error when repo is undefined', async () => {
    const result = await _gitPushPure(undefined);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

// ---------------------------------------------------------------------------
// gitPull
// ---------------------------------------------------------------------------

describe('_gitPullPure', () => {
  it('calls repo.pull() and resolves void on success', async () => {
    const repo = makeRepo();
    const result = await _gitPullPure(repo);
    expect(repo.pull).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('returns pull-failed error when repo.pull rejects', async () => {
    const repo = makeRepo();
    repo.pull.mockRejectedValue(new Error('merge conflict'));
    const result = await _gitPullPure(repo);
    expect((result as GitOperationError).kind).toBe('pull-failed');
    expect((result as Extract<GitOperationError, { kind: 'pull-failed' }>).message).toBe(
      'merge conflict',
    );
  });

  it('returns no-repo error when repo is undefined', async () => {
    const result = await _gitPullPure(undefined);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

// ---------------------------------------------------------------------------
// git-ext-unavailable path
// ---------------------------------------------------------------------------

describe('git-ext-unavailable', () => {
  it('_currentBranchPure returns no-repo (not git-ext-unavailable) for undefined repo', async () => {
    // The public functions return git-ext-unavailable when the extension API
    // itself is missing. The pure functions only receive the repo object; they
    // return no-repo when the repo is undefined.
    const result = await _currentBranchPure(undefined);
    expect((result as GitOperationError).kind).toBe('no-repo');
  });
});

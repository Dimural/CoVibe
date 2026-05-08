/**
 * Tests for _probeRepoContext — the pure, dependency-injected core of
 * getRepoContext(). Passes mock GitAPI objects so no VS Code extension host
 * is needed.
 */
import { describe, it, expect } from 'vitest';
import {
  _probeRepoContext,
  type RepoContext,
  type GitContextError,
} from '../../src/git/context.js';

// ---------------------------------------------------------------------------
// Mock types (mirror the structural interface defined in context.ts)
// ---------------------------------------------------------------------------

interface MockRemote {
  name: string;
  fetchUrl?: string | undefined;
}

interface MockRepo {
  state: {
    remotes: MockRemote[];
    HEAD?: { name?: string | undefined; commit?: string | undefined } | undefined;
    workingTreeChanges: unknown[];
    indexChanges: unknown[];
    onDidChange: (listener: () => void) => { dispose(): void };
  };
}

interface MockGitApi {
  repositories: MockRepo[];
  getRepository: (uri: unknown) => MockRepo | null;
}

// ---------------------------------------------------------------------------
// Helper to build a minimal mock repo
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<MockRepo['state']> = {}): MockRepo {
  return {
    state: {
      remotes: [],
      HEAD: { name: 'main', commit: 'abc1234' },
      workingTreeChanges: [],
      indexChanges: [],
      onDidChange: () => ({ dispose(): void {} }),
      ...overrides,
    },
  };
}

function makeApi(repos: MockRepo[], getRepo?: (uri: unknown) => MockRepo | null): MockGitApi {
  return {
    repositories: repos,
    getRepository: getRepo ?? (() => repos[0] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_probeRepoContext', () => {
  it('returns git-ext-unavailable when gitApi is undefined', async () => {
    const result = await _probeRepoContext(undefined, null);
    expect((result as GitContextError).kind).toBe('git-ext-unavailable');
  });

  it('returns no-repo when repositories array is empty', async () => {
    const api = makeApi([]);
    const result = await _probeRepoContext(api, null);
    expect((result as GitContextError).kind).toBe('no-repo');
  });

  it('returns no-remote when the repo has no remotes', async () => {
    const repo = makeRepo({ remotes: [] });
    const api = makeApi([repo]);
    const result = await _probeRepoContext(api, null);
    expect((result as GitContextError).kind).toBe('no-remote');
  });

  it('returns correct RepoContext on the happy path', async () => {
    const repo = makeRepo({
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/owner/repo' }],
      HEAD: { name: 'main', commit: 'deadbeef' },
      workingTreeChanges: [{}, {}], // two changes → isDirty = true
      indexChanges: [],
    });
    const api = makeApi([repo]);
    const result = await _probeRepoContext(api, null);
    const ctx = result as RepoContext;
    expect(ctx.remoteUrl).toBe('https://github.com/owner/repo');
    expect(ctx.branch).toBe('main');
    expect(ctx.isDirty).toBe(true);
    expect(ctx.headSha).toBe('deadbeef');
  });

  it('prefers origin over other remotes', async () => {
    const repo = makeRepo({
      remotes: [
        { name: 'upstream', fetchUrl: 'https://github.com/upstream/repo' },
        { name: 'origin', fetchUrl: 'https://github.com/owner/repo' },
      ],
    });
    const api = makeApi([repo]);
    const result = await _probeRepoContext(api, null);
    const ctx = result as RepoContext;
    expect(ctx.remoteUrl).toBe('https://github.com/owner/repo');
  });

  it('falls back to repositories[0] when activeUri is null', async () => {
    const repo = makeRepo({
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/fallback/repo' }],
      HEAD: { name: 'develop', commit: 'cafebabe' },
    });
    // getRepository always returns null to force the fallback path.
    const api = makeApi([repo], () => null);
    const result = await _probeRepoContext(api, null);
    const ctx = result as RepoContext;
    expect(ctx.remoteUrl).toBe('https://github.com/fallback/repo');
    expect(ctx.branch).toBe('develop');
  });
});

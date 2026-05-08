/**
 * Integration tests for _probeRepoContext using real git repositories.
 *
 * We cannot use the real VS Code Git extension in Vitest (no extension host),
 * so instead we use `simple-git` to create a real git repository fixture and
 * then construct a mock gitApi that mirrors what the real VS Code Git extension
 * would return for that repo. This validates our structural type assumptions.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { describe, it, expect, afterEach } from 'vitest';
import simpleGit from 'simple-git';
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

function makeApi(repos: MockRepo[]): MockGitApi {
  return {
    repositories: repos,
    getRepository: () => repos[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Test state — temp dirs created by each test and cleaned up in afterEach
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_probeRepoContext (integration — real git repo fixtures)', () => {
  it('real-repo-with-remote: returns correct RepoContext for a repo with an origin remote', async () => {
    // Create a real git repo with a remote and an initial commit.
    const repoDir = await makeTempDir();
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test User');
    await git.addRemote('origin', 'https://github.com/test-owner/test-repo.git');

    // Create an initial commit so HEAD is defined.
    const readmePath = path.join(repoDir, 'README.md');
    await fs.writeFile(readmePath, '# Test\n');
    await git.add('.');
    await git.commit('Initial commit');

    // Read the actual HEAD SHA from the real repo.
    const log = await git.log({ maxCount: 1 });
    const realSha = log.latest?.hash ?? '';
    expect(realSha).not.toBe('');

    // Read the actual branch name (git init may default to 'main' or 'master').
    const branch = (await git.branchLocal()).current;

    // Construct a mock gitApi that simulates what VS Code's Git extension would
    // return for this repo state.
    const mockRepo: MockRepo = {
      state: {
        remotes: [{ name: 'origin', fetchUrl: 'https://github.com/test-owner/test-repo.git' }],
        HEAD: { name: branch, commit: realSha },
        workingTreeChanges: [],
        indexChanges: [],
        onDidChange: () => ({ dispose(): void {} }),
      },
    };
    const api = makeApi([mockRepo]);

    const result = await _probeRepoContext(api, null);
    const ctx = result as RepoContext;

    expect(ctx.remoteUrl).toBe('https://github.com/test-owner/test-repo.git');
    expect(ctx.branch).toBe(branch);
    expect(ctx.isDirty).toBe(false);
    expect(ctx.headSha).toBe(realSha);
  });

  it('no-commits: HEAD is undefined when repo has no commits yet', async () => {
    // Create a real git repo but do NOT make any commits.
    const repoDir = await makeTempDir();
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test User');
    await git.addRemote('origin', 'https://github.com/test-owner/empty-repo.git');

    // In a repo with no commits, VS Code's Git extension returns HEAD with
    // undefined commit (no SHA yet). Simulate that here.
    const mockRepo: MockRepo = {
      state: {
        remotes: [{ name: 'origin', fetchUrl: 'https://github.com/test-owner/empty-repo.git' }],
        HEAD: { name: undefined, commit: undefined }, // no commits → no SHA, no branch name
        workingTreeChanges: [],
        indexChanges: [],
        onDidChange: () => ({ dispose(): void {} }),
      },
    };
    const api = makeApi([mockRepo]);

    const result = await _probeRepoContext(api, null);
    const ctx = result as RepoContext;

    expect(ctx.remoteUrl).toBe('https://github.com/test-owner/empty-repo.git');
    // Detached / no-commits → falls back to 'HEAD'
    expect(ctx.branch).toBe('HEAD');
    // No commits → SHA is empty string
    expect(ctx.headSha).toBe('');
    expect(ctx.isDirty).toBe(false);
  });

  it('no-commits returns GitContextError when gitApi has no repos', async () => {
    // Sanity-check: even with a real temp dir, an empty repositories array
    // still returns no-repo.
    await makeTempDir();
    const api = makeApi([]);
    const result = await _probeRepoContext(api, null);
    expect((result as GitContextError).kind).toBe('no-repo');
  });
});

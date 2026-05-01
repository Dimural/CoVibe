import { describe, it, expect } from 'vitest';
import {
  canonicalRepoIdentity,
  deriveSessionId,
  generateInviteToken,
  formatInviteLink,
  parseInviteLink,
  InviteError,
} from '../src/session.js';

// ---------------------------------------------------------------------------
// Helper — extracts an InviteError from a throwing function, fails otherwise.
// ---------------------------------------------------------------------------

function captureInviteError(fn: () => unknown): InviteError {
  try {
    fn();
    throw new Error('Expected InviteError but no error was thrown');
  } catch (err) {
    if (err instanceof InviteError) return err;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// canonicalRepoIdentity
// ---------------------------------------------------------------------------

describe('canonicalRepoIdentity', () => {
  it('normalises https without .git suffix', () => {
    expect(canonicalRepoIdentity('https://github.com/foo/bar')).toBe('github.com/foo/bar');
  });

  it('normalises https with .git suffix', () => {
    expect(canonicalRepoIdentity('https://github.com/foo/bar.git')).toBe('github.com/foo/bar');
  });

  it('lowercases host and path', () => {
    expect(canonicalRepoIdentity('https://github.com/Foo/Bar.git')).toBe('github.com/foo/bar');
  });

  it('normalises SCP-style SSH URL to same form as https', () => {
    const scp = canonicalRepoIdentity('git@github.com:foo/bar.git');
    const https = canonicalRepoIdentity('https://github.com/foo/bar.git');
    expect(scp).toBe(https);
  });

  it('normalises ssh:// scheme', () => {
    expect(canonicalRepoIdentity('ssh://git@github.com/foo/bar.git')).toBe('github.com/foo/bar');
  });

  it('strips port from ssh:// URL', () => {
    expect(canonicalRepoIdentity('ssh://git@github.com:22/foo/bar')).toBe('github.com/foo/bar');
  });

  it('strips basic auth credentials from https URL', () => {
    expect(canonicalRepoIdentity('https://user:token@github.com/foo/bar.git')).toBe(
      'github.com/foo/bar',
    );
  });

  it('strips trailing slash', () => {
    expect(canonicalRepoIdentity('https://github.com/foo/bar/')).toBe('github.com/foo/bar');
  });

  it('preserves GitLab subgroup paths', () => {
    expect(canonicalRepoIdentity('git@gitlab.com:group/sub/repo.git')).toBe(
      'gitlab.com/group/sub/repo',
    );
  });

  it('throws InviteError on empty string', () => {
    expect(() => canonicalRepoIdentity('')).toThrow(InviteError);
    expect(captureInviteError(() => canonicalRepoIdentity('')).code).toBe('invalid-remote');
  });

  it('throws InviteError on whitespace-only string', () => {
    expect(() => canonicalRepoIdentity('   ')).toThrow(InviteError);
    expect(captureInviteError(() => canonicalRepoIdentity('   ')).code).toBe('invalid-remote');
  });

  it('throws InviteError on no-host input', () => {
    expect(() => canonicalRepoIdentity('foo')).toThrow(InviteError);
    expect(captureInviteError(() => canonicalRepoIdentity('foo')).code).toBe('invalid-remote');
  });

  it('throws InviteError on path-only input', () => {
    expect(() => canonicalRepoIdentity('/just/a/path')).toThrow(InviteError);
    expect(captureInviteError(() => canonicalRepoIdentity('/just/a/path')).code).toBe(
      'invalid-remote',
    );
  });

  it('throws InviteError on input longer than 2000 chars', () => {
    const long = 'https://github.com/foo/' + 'a'.repeat(1990);
    expect(() => canonicalRepoIdentity(long)).toThrow(InviteError);
    expect(captureInviteError(() => canonicalRepoIdentity(long)).code).toBe('invalid-remote');
  });

  it('does not leak credentials in error messages', () => {
    // A URL with credentials but no path — throws 'invalid-remote' for missing path.
    const err = captureInviteError(() => canonicalRepoIdentity('https://user:secret@github.com/'));
    expect(err.message).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// deriveSessionId
// ---------------------------------------------------------------------------

describe('deriveSessionId', () => {
  const base = {
    remoteUrl: 'https://github.com/foo/bar.git',
    branch: 'main',
    token: 'sometoken',
  };

  it('is deterministic across calls', () => {
    const id1 = deriveSessionId(base);
    const id2 = deriveSessionId(base);
    expect(id1).toBe(id2);
  });

  it('returns 22-character string', () => {
    expect(deriveSessionId(base)).toHaveLength(22);
  });

  it('result is in base64url charset', () => {
    const id = deriveSessionId(base);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('different branch produces different ID', () => {
    const id1 = deriveSessionId({ ...base, branch: 'main' });
    const id2 = deriveSessionId({ ...base, branch: 'develop' });
    expect(id1).not.toBe(id2);
  });

  it('different token produces different ID', () => {
    const id1 = deriveSessionId({ ...base, token: 'tokenA' });
    const id2 = deriveSessionId({ ...base, token: 'tokenB' });
    expect(id1).not.toBe(id2);
  });

  it('HTTPS and SSH remote URLs produce the same ID', () => {
    const httpsId = deriveSessionId({ ...base, remoteUrl: 'https://github.com/foo/bar.git' });
    const sshId = deriveSessionId({ ...base, remoteUrl: 'git@github.com:foo/bar.git' });
    expect(httpsId).toBe(sshId);
  });

  it('throws invalid-branch on empty branch', () => {
    expect(() => deriveSessionId({ ...base, branch: '' })).toThrow(InviteError);
    expect(captureInviteError(() => deriveSessionId({ ...base, branch: '' })).code).toBe(
      'invalid-branch',
    );
  });

  it('throws invalid-branch on whitespace-only branch', () => {
    expect(() => deriveSessionId({ ...base, branch: '   ' })).toThrow(InviteError);
    expect(captureInviteError(() => deriveSessionId({ ...base, branch: '   ' })).code).toBe(
      'invalid-branch',
    );
  });

  it('throws invalid-token on empty token', () => {
    expect(() => deriveSessionId({ ...base, token: '' })).toThrow(InviteError);
    expect(captureInviteError(() => deriveSessionId({ ...base, token: '' })).code).toBe(
      'invalid-token',
    );
  });

  it('does not collide when separator chars appear in branch or token', () => {
    const remote = 'https://github.com/foo/bar.git';
    const a = deriveSessionId({ remoteUrl: remote, branch: 'a|b', token: 'c' });
    const b = deriveSessionId({ remoteUrl: remote, branch: 'a', token: 'b|c' });
    expect(a).not.toBe(b);
  });

  it('rejects branch longer than 1024 chars', () => {
    const err = captureInviteError(() =>
      deriveSessionId({
        remoteUrl: 'https://github.com/foo/bar.git',
        branch: 'a'.repeat(1025),
        token: 'validtoken',
      }),
    );
    expect(err.code).toBe('invalid-branch');
  });

  it('rejects token longer than 1024 chars', () => {
    const err = captureInviteError(() =>
      deriveSessionId({
        remoteUrl: 'https://github.com/foo/bar.git',
        branch: 'main',
        token: 'a'.repeat(1025),
      }),
    );
    expect(err.code).toBe('invalid-token');
  });

  it('rejects branches with leading/trailing whitespace', () => {
    const err = captureInviteError(() =>
      deriveSessionId({
        remoteUrl: 'https://github.com/foo/bar.git',
        branch: ' main',
        token: 'validtoken',
      }),
    );
    expect(err.code).toBe('invalid-branch');
  });
});

// ---------------------------------------------------------------------------
// generateInviteToken
// ---------------------------------------------------------------------------

describe('generateInviteToken', () => {
  it('returns a 43-character string', () => {
    expect(generateInviteToken()).toHaveLength(43);
  });

  it('result is in base64url charset (no padding)', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('100 calls produce 100 distinct values (entropy check)', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateInviteToken()));
    expect(tokens.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatInviteLink / parseInviteLink round-trip
// ---------------------------------------------------------------------------

describe('formatInviteLink / parseInviteLink', () => {
  const sessionId = 'AAABBBCCCDDDEEEFFFGGG0';
  const token = 'a'.repeat(43);
  const branch = 'main';

  it('round-trips basic inputs', () => {
    const url = formatInviteLink({ sessionId, token, branch });
    const parsed = parseInviteLink(url);
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.token).toBe(token);
    expect(parsed.branch).toBe(branch);
  });

  it('branch with slash round-trips correctly', () => {
    const slashBranch = 'feat/foo';
    const url = formatInviteLink({ sessionId, token, branch: slashBranch });
    expect(url).toContain('feat%2Ffoo');
    const parsed = parseInviteLink(url);
    expect(parsed.branch).toBe(slashBranch);
  });

  it('branch with unicode/special chars round-trips correctly', () => {
    const unicodeBranch = 'feat/✨-thing';
    const url = formatInviteLink({ sessionId, token, branch: unicodeBranch });
    const parsed = parseInviteLink(url);
    expect(parsed.branch).toBe(unicodeBranch);
  });

  it('produces covibes:// scheme URL with join host', () => {
    const url = formatInviteLink({ sessionId, token, branch });
    expect(url.startsWith('covibes://join?')).toBe(true);
  });

  it('throws invalid-input when sessionId is empty', () => {
    expect(() => formatInviteLink({ sessionId: '', token, branch })).toThrow(InviteError);
    expect(captureInviteError(() => formatInviteLink({ sessionId: '', token, branch })).code).toBe(
      'invalid-input',
    );
  });

  it('throws invalid-input when token is empty', () => {
    expect(() => formatInviteLink({ sessionId, token: '', branch })).toThrow(InviteError);
  });

  it('throws invalid-input when branch is empty', () => {
    expect(() => formatInviteLink({ sessionId, token, branch: '' })).toThrow(InviteError);
  });

  it('throws invalid-input when sessionId contains invalid chars', () => {
    const err = captureInviteError(() =>
      formatInviteLink({ sessionId: 'abc!def', token: 'validtoken123', branch: 'main' }),
    );
    expect(err.code).toBe('invalid-input');
  });

  it('throws invalid-input when token contains invalid chars', () => {
    const err = captureInviteError(() =>
      formatInviteLink({ sessionId: 'validsession123', token: 'abc!def', branch: 'main' }),
    );
    expect(err.code).toBe('invalid-input');
  });

  it("round-trips a branch containing '%'", () => {
    const sessionId = deriveSessionId({
      remoteUrl: 'https://github.com/foo/bar.git',
      branch: 'main',
      token: generateInviteToken(),
    });
    const token = generateInviteToken();
    const branch = '100%done';
    const url = formatInviteLink({ sessionId, token, branch });
    const parsed = parseInviteLink(url);
    expect(parsed.branch).toBe(branch);
  });
});

describe('parseInviteLink', () => {
  const sessionId = 'AAABBBCCCDDDEEEFFFGGG0';
  const token = 'a'.repeat(43);
  const branch = 'main';

  it('rejects https:// scheme with invalid-scheme', () => {
    const url = 'https://example.com/?s=abc&t=abc&b=main';
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-scheme');
  });

  it('rejects wrong host (not "join")', () => {
    const url = `covibes://other?s=${sessionId}&t=${token}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
  });

  it('rejects missing s param', () => {
    const url = `covibes://join?t=${token}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects missing t param', () => {
    const url = `covibes://join?s=${sessionId}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects missing b param', () => {
    const url = `covibes://join?s=${sessionId}&t=${token}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects empty s param', () => {
    const url = `covibes://join?s=&t=${token}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects empty t param', () => {
    const url = `covibes://join?s=${sessionId}&t=&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects empty b param', () => {
    const url = `covibes://join?s=${sessionId}&t=${token}&b=`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });

  it('rejects s containing invalid char "!"', () => {
    const url = `covibes://join?s=abc!def&t=${token}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-session-id');
  });

  it('rejects t containing invalid char "!"', () => {
    const url = `covibes://join?s=${sessionId}&t=abc!def&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-token');
  });

  it('rejects query param exceeding 1024 chars', () => {
    const longToken = 'a'.repeat(1025);
    const url = `covibes://join?s=${sessionId}&t=${longToken}&b=${branch}`;
    expect(() => parseInviteLink(url)).toThrow(InviteError);
    expect(captureInviteError(() => parseInviteLink(url)).code).toBe('invalid-input');
  });
});

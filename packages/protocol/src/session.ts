/**
 * Session ID derivation, invite token generation, and invite link utilities.
 *
 * Security note: the invite token is the unguessable secret. The session ID
 * is a *public* routing key derived from it — it is safe to share, but must
 * be collision-resistant. SHA-256 of the canonical repo identity + branch +
 * token gives us ≥ 132 bits of entropy in the first 22 base64url chars (22
 * chars × 6 bits/char = 132 bits), which is ample for this use case.
 */

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Discriminating codes for {@link InviteError}. */
export type InviteErrorCode =
  | 'invalid-remote'
  | 'invalid-branch'
  | 'invalid-token'
  | 'invalid-session-id'
  | 'invalid-scheme'
  | 'invalid-input';

/**
 * Thrown when invite-link or session-ID operations fail validation.
 * Inspect `code` to distinguish failure modes without string-matching messages.
 */
export class InviteError extends Error {
  constructor(
    public readonly code: InviteErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

// ---------------------------------------------------------------------------
// SCP regex — used for `user@host:path` style git remotes
// ---------------------------------------------------------------------------

/** Matches SCP-style SSH URLs: `[user@]host:path`. Must NOT start with a scheme. */
const SCP_RE = /^(?:[a-zA-Z0-9_-]+@)?([a-zA-Z0-9.-]+):(.+)$/;

// ---------------------------------------------------------------------------
// canonicalRepoIdentity
// ---------------------------------------------------------------------------

/**
 * Normalises a git remote URL to a canonical `host/owner/repo` string used
 * as a stable, collision-resistant repo identifier.
 *
 * Supported forms:
 * - `https://github.com/foo/bar.git`
 * - `https://user:token@github.com/foo/bar.git` (credentials stripped)
 * - `git@github.com:foo/bar.git` (SCP-style SSH)
 * - `ssh://git@github.com:22/foo/bar.git` (port stripped)
 *
 * Result is lowercased. `.git` suffix and trailing slashes are stripped.
 *
 * **Trade-off on case-folding the path:** most git hosts (GitHub, GitLab,
 * Bitbucket) treat repository paths as case-insensitive. We lowercase to
 * produce a stable key regardless of capitalisation in the remote config. If
 * a host is genuinely case-sensitive for paths, two differently-cased remotes
 * that point to the same repo will still share the same canonical form —
 * which is the correct behaviour for this routing key.
 *
 * @throws {@link InviteError} with code `'invalid-remote'` on empty input,
 *   no-host input, or input longer than 2 000 chars.
 */
export function canonicalRepoIdentity(remoteUrl: string): string {
  if (!remoteUrl || remoteUrl.trim().length === 0) {
    throw new InviteError('invalid-remote', 'remoteUrl must not be empty');
  }
  if (remoteUrl.length > 2000) {
    throw new InviteError('invalid-remote', 'remoteUrl exceeds maximum length of 2 000 chars');
  }

  const trimmed = remoteUrl.trim();
  const redact = (u: string): string => u.replace(/:\/\/[^@/]+@/, '://[redacted]@');
  let host: string;
  let rawPath: string;

  // Try standard URL parsing first (handles https:// and ssh://).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch (err) {
      throw new InviteError('invalid-remote', `Unable to parse remoteUrl: ${redact(trimmed)}`, err);
    }
    host = parsed.hostname; // already strips port and credentials
    rawPath = parsed.pathname;
  } else {
    // SCP-style: user@host:path
    const match = SCP_RE.exec(trimmed);
    if (!match) {
      throw new InviteError(
        'invalid-remote',
        `remoteUrl has no discernible host or scheme: ${redact(trimmed)}`,
      );
    }
    host = match[1] as string;
    rawPath = match[2] as string;
  }

  if (!host) {
    throw new InviteError('invalid-remote', `No host found in remoteUrl: ${redact(trimmed)}`);
  }

  // Normalise path: strip leading slash, trailing slash, trailing .git.
  const path = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');

  if (!path) {
    throw new InviteError(
      'invalid-remote',
      `No repository path found in remoteUrl: ${redact(trimmed)}`,
    );
  }

  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// deriveSessionId
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic, collision-resistant session ID from a git remote
 * URL, branch, and an invite token.
 *
 * Algorithm:
 * 1. Canonicalise the remote URL via {@link canonicalRepoIdentity}.
 * 2. Compute SHA-256 of a length-prefixed encoding of each field:
 *    `"${canonical.length}:${canonical}|${branch.length}:${branch}|${token.length}:${token}"`.
 *    Length-prefixing guarantees unique encoding — two distinct inputs can never
 *    produce the same string regardless of whether field values contain `|` or
 *    `:` characters.
 * 3. Encode the digest as base64url (unpadded) and take the first 22 chars.
 *
 * **Why 22 chars?** A full SHA-256 base64url digest is 43 chars. The first 22
 * chars encode ≈ 132 bits (22 × 6 bits), which is well above the 128-bit
 * threshold recommended for routing keys.
 *
 * The returned session ID is a **public routing key** — it is safe to share,
 * log, or include in URLs. The security of the session depends entirely on the
 * unguessability of `token`.
 *
 * The result is stable across processes and platforms.
 *
 * @throws {@link InviteError} `'invalid-branch'` if `branch` is empty,
 *   has leading/trailing whitespace, or exceeds 1 024 chars.
 * @throws {@link InviteError} `'invalid-token'` if `token` is empty or
 *   exceeds 1 024 chars.
 * @throws {@link InviteError} `'invalid-remote'` via
 *   {@link canonicalRepoIdentity}.
 */
export function deriveSessionId({
  remoteUrl,
  branch,
  token,
}: {
  remoteUrl: string;
  branch: string;
  token: string;
}): string {
  if (branch.length === 0 || branch !== branch.trim()) {
    throw new InviteError(
      'invalid-branch',
      'branch must not be empty or have surrounding whitespace',
    );
  }
  if (!token) {
    throw new InviteError('invalid-token', 'token must not be empty');
  }
  if (branch.length > 1024) {
    throw new InviteError('invalid-branch', 'branch exceeds maximum length of 1024 chars');
  }
  if (token.length > 1024) {
    throw new InviteError('invalid-token', 'token exceeds maximum length of 1024 chars');
  }

  const canonical = canonicalRepoIdentity(remoteUrl);
  const input = `${canonical.length}:${canonical}|${branch.length}:${branch}|${token.length}:${token}`;
  const digest = createHash('sha256').update(input, 'utf8').digest();
  return Buffer.from(digest).toString('base64url').slice(0, 22);
}

// ---------------------------------------------------------------------------
// generateInviteToken
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random invite token.
 *
 * Uses 32 bytes from `crypto.randomBytes` (256 bits of entropy), then
 * base64url-encodes without padding via Node's built-in `'base64url'` codec.
 * The resulting string is always exactly 43 characters.
 *
 * Never uses `Math.random` or `crypto.randomUUID`.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Invite link format/parse helpers
// ---------------------------------------------------------------------------

/** Pattern that valid base64url strings must match (no padding characters). */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Serialises a session ID, invite token, and branch into a `covibes://` deep
 * link that can be shared with collaborators.
 *
 * Format: `covibes://join?s=<sessionId>&t=<token>&b=<encodeURIComponent(branch)>`
 *
 * The branch is percent-encoded so that slashes and other special characters
 * in git ref names survive URL round-trips. Session ID and token must be valid
 * base64url strings.
 *
 * @throws {@link InviteError} `'invalid-input'` if any argument is empty or if
 *   `sessionId` / `token` contain characters outside the base64url alphabet.
 */
export function formatInviteLink({
  sessionId,
  token,
  branch,
}: {
  sessionId: string;
  token: string;
  branch: string;
}): string {
  if (!sessionId) {
    throw new InviteError('invalid-input', 'sessionId must not be empty');
  }
  if (!token) {
    throw new InviteError('invalid-input', 'token must not be empty');
  }
  if (!branch) {
    throw new InviteError('invalid-input', 'branch must not be empty');
  }
  if (!BASE64URL_RE.test(sessionId)) {
    throw new InviteError('invalid-input', 'sessionId contains invalid characters');
  }
  if (!BASE64URL_RE.test(token)) {
    throw new InviteError('invalid-input', 'token contains invalid characters');
  }

  return `covibes://join?s=${sessionId}&t=${token}&b=${encodeURIComponent(branch)}`;
}

/**
 * Parses a `covibes://` invite link into its component parts.
 *
 * Validates:
 * - Scheme must be `covibes:`.
 * - Host must be `join`.
 * - All three query params (`s`, `t`, `b`) must be present, non-empty, and
 *   ≤ 1 024 chars each.
 * - `s` (sessionId) and `t` (token) must match the base64url alphabet
 *   `^[A-Za-z0-9_-]+$`.
 *
 * @throws {@link InviteError} `'invalid-scheme'` if the URL scheme is not
 *   `covibes:`.
 * @throws {@link InviteError} `'invalid-input'` for any structural violation
 *   (wrong host, missing/empty params, param too long).
 * @throws {@link InviteError} `'invalid-session-id'` if `s` fails the
 *   base64url check.
 * @throws {@link InviteError} `'invalid-token'` if `t` fails the base64url
 *   check.
 */
export function parseInviteLink(url: string): {
  sessionId: string;
  token: string;
  branch: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new InviteError('invalid-scheme', `Unable to parse invite link: ${url}`, err);
  }

  if (parsed.protocol !== 'covibes:') {
    throw new InviteError('invalid-scheme', `Expected covibes:// scheme, got: ${parsed.protocol}`);
  }

  // For covibes://join?..., the URL constructor puts "join" in the hostname.
  if (parsed.hostname !== 'join') {
    throw new InviteError('invalid-input', `Expected host "join", got: ${parsed.hostname}`);
  }

  const params = parsed.searchParams;

  const rawS = params.get('s');
  const rawT = params.get('t');
  const rawB = params.get('b');

  if (rawS === null) {
    throw new InviteError('invalid-input', 'Missing query param "s" (sessionId)');
  }
  if (rawT === null) {
    throw new InviteError('invalid-input', 'Missing query param "t" (token)');
  }
  if (rawB === null) {
    throw new InviteError('invalid-input', 'Missing query param "b" (branch)');
  }

  // Length sanity bounds before decoding.
  if (rawS.length > 1024) {
    throw new InviteError('invalid-input', 'Query param "s" exceeds 1 024 chars');
  }
  if (rawT.length > 1024) {
    throw new InviteError('invalid-input', 'Query param "t" exceeds 1 024 chars');
  }
  if (rawB.length > 1024) {
    throw new InviteError('invalid-input', 'Query param "b" exceeds 1 024 chars');
  }

  const sessionId = rawS;
  const token = rawT;
  const branch = rawB;

  if (!sessionId) {
    throw new InviteError('invalid-input', 'Query param "s" (sessionId) must not be empty');
  }
  if (!token) {
    throw new InviteError('invalid-input', 'Query param "t" (token) must not be empty');
  }
  if (!branch) {
    throw new InviteError('invalid-input', 'Query param "b" (branch) must not be empty');
  }

  if (!BASE64URL_RE.test(sessionId)) {
    throw new InviteError('invalid-session-id', 'sessionId contains invalid characters');
  }
  if (!BASE64URL_RE.test(token)) {
    throw new InviteError('invalid-token', 'token contains invalid characters');
  }

  return { sessionId, token, branch };
}

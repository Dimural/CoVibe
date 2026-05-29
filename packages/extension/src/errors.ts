/** Relay WebSocket connection failed or refused. */
export class RelayUnreachableError extends Error {
  override readonly name = 'RelayUnreachableError';
  constructor(public readonly relayUrl: string) {
    super(`Cannot reach CoVibes relay at ${relayUrl}`);
  }
}

/** Server sent a protocol version that doesn't match the client. */
export class ProtocolMismatchError extends Error {
  override readonly name = 'ProtocolMismatchError';
  constructor(
    public readonly localVersion: number,
    public readonly remoteVersion: number,
  ) {
    super(`Protocol version mismatch: client=${localVersion}, server=${remoteVersion}`);
  }
}

/** Server rejected the connection as unauthorized (close code 4401). */
export class AuthFailedError extends Error {
  override readonly name = 'AuthFailedError';
  constructor() {
    super('Authentication failed — invite link may be expired or invalid');
  }
}

/** Session is at capacity (close code 4429). */
export class SessionFullError extends Error {
  override readonly name = 'SessionFullError';
  constructor() {
    super('Session is full — CoVibes sessions support a maximum of 4 participants');
  }
}

/** User tried to join a session on a different branch. */
export class BranchMismatchError extends Error {
  override readonly name = 'BranchMismatchError';
  constructor(public readonly requiredBranch: string) {
    super(`Switch to branch "${requiredBranch}" to join this session`);
  }
}

/** Git repo has no remote configured. */
export class GitNoRemoteError extends Error {
  override readonly name = 'GitNoRemoteError';
  constructor() {
    super('No git remote found — CoVibes requires a remote to derive the session ID');
  }
}

/** Invite link could not be parsed. */
export class InvalidInviteLinkError extends Error {
  override readonly name = 'InvalidInviteLinkError';
  constructor(input: string) {
    super(`Invalid CoVibes invite link: "${input.slice(0, 80)}"`);
  }
}

/**
 * Maps any thrown value to a concise, actionable user-facing message suitable
 * for display in a VS Code notification.
 */
export function userMessage(err: unknown): string {
  if (err instanceof RelayUnreachableError) {
    return `CoVibes: Cannot reach the relay server (${err.relayUrl}). Check your internet connection or the relay URL in settings.`;
  }
  if (err instanceof ProtocolMismatchError) {
    return `CoVibes: Version mismatch with the relay (client v${err.localVersion}, server v${err.remoteVersion}). Please update the CoVibes extension.`;
  }
  if (err instanceof AuthFailedError) {
    return `CoVibes: Authentication failed. The invite link may be expired — ask the session host to share a new one.`;
  }
  if (err instanceof SessionFullError) {
    return `CoVibes: This session already has 4 participants (the maximum). Ask the host to start a new session.`;
  }
  if (err instanceof BranchMismatchError) {
    return `CoVibes: Switch to branch "${err.requiredBranch}" to join this session.`;
  }
  if (err instanceof GitNoRemoteError) {
    return `CoVibes: No git remote found. Push your repo to a remote (e.g. GitHub) before starting a session.`;
  }
  if (err instanceof InvalidInviteLinkError) {
    return `CoVibes: Invalid invite link. Make sure you copied the full link starting with covibes://join?...`;
  }
  if (err instanceof Error) {
    return `CoVibes: ${err.message}`;
  }
  return `CoVibes: An unexpected error occurred.`;
}

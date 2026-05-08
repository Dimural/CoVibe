/**
 * SessionManager — orchestrates connect/join/leave lifecycle.
 *
 * Design notes:
 * - `vscode` is imported lazily inside methods so this module can be loaded in
 *   tests without a VS Code extension host.
 * - `createClient` is injected for testability (tests pass in FakeRelayClient).
 * - The state machine lives in `./state.ts`; this module just drives transitions.
 */

import {
  generateInviteToken,
  deriveSessionId,
  formatInviteLink,
  parseInviteLink,
  InviteError,
} from '@covibes/protocol';

import type { RelayClientOptions } from '../relay/client.js';
import type { ParticipantIdentity } from '../identity.js';
import type { CoVibesConfig } from '../config.js';
import type { RepoContext } from '../git/context.js';

import {
  IDLE_STATE,
  toConnecting,
  toActive,
  toReconnecting,
  toFailed,
  toIdle,
  type SessionState,
  type ParticipantView,
} from './state.js';

// ---------------------------------------------------------------------------
// Minimal structural interface for RelayClient
// (avoids importing the concrete class, keeping tests independent)
// ---------------------------------------------------------------------------

export interface IRelayClient {
  on(event: string, handler: (...args: unknown[]) => void): this;
  off(event: string, handler: (...args: unknown[]) => void): this;
  once(event: string, handler: (...args: unknown[]) => void): this;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(type: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Typed error for branch mismatches
// ---------------------------------------------------------------------------

/**
 * Thrown by `join()` when the invite link targets a branch different from the
 * one currently checked out. The caller should prompt the user to switch
 * branches and retry.
 */
export class BranchMismatchError extends Error {
  constructor(public readonly requiredBranch: string) {
    super(`Switch to branch '${requiredBranch}' to join this session`);
    this.name = 'BranchMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Close codes copied from relay/client.ts — terminal means do NOT reconnect
// ---------------------------------------------------------------------------

const TERMINAL_CLOSE_CODES = new Set([
  4400, // InvalidParams
  4401, // Unauthorized
  4403, // Forbidden
  4426, // ProtocolMismatch
  4429, // SessionFull
]);

// ---------------------------------------------------------------------------
// AnyDecodedMessage shape — we only need enough to narrow on `type`
// ---------------------------------------------------------------------------

interface SessionStateMessage {
  type: 'session.state';
  payload: {
    sessionId: string;
    branch: string;
    you: string;
    participants: Array<{
      id: string;
      displayName: string;
      color: string;
      currentFile: string | null;
    }>;
  };
}

interface AnyMessage {
  type: string;
  payload: unknown;
}

function isSessionStateMessage(msg: AnyMessage): msg is SessionStateMessage {
  return msg.type === 'session.state';
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private state: SessionState = IDLE_STATE;
  private client: IRelayClient | null = null;

  constructor(
    private readonly identity: ParticipantIdentity,
    private readonly config: CoVibesConfig,
    private readonly createClient: (opts: RelayClientOptions) => IRelayClient,
    private readonly onStateChange: (state: SessionState) => void,
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Starts a new session as host.
   *
   * 1. Generates an invite token and derives the session ID.
   * 2. Copies the invite link to the clipboard.
   * 3. Transitions to Connecting and connects the relay client.
   * 4. Resolves once session.join has been sent; Active transition happens
   *    asynchronously when session.state arrives.
   */
  async start(repoContext: RepoContext): Promise<void> {
    if (this.state.kind !== 'Idle') {
      throw new Error('Session already started');
    }

    const token = generateInviteToken();
    const sessionId = deriveSessionId({
      remoteUrl: repoContext.remoteUrl,
      branch: repoContext.branch,
      token,
    });
    const inviteLink = formatInviteLink({ sessionId, token, branch: repoContext.branch });

    // Copy invite link to clipboard (lazy import — safe to call from tests
    // because tests mock vscode via vitest alias).
    const vscode = await import('vscode');
    await vscode.env.clipboard.writeText(inviteLink);

    await this.connectSession({ sessionId, token, inviteLink, repoContext });
  }

  /**
   * Joins an existing session via an invite link.
   *
   * Throws `BranchMismatchError` if the invite link targets a different branch.
   */
  async join(inviteLink: string, repoContext: RepoContext): Promise<void> {
    if (this.state.kind !== 'Idle') {
      throw new Error('Session already started');
    }

    let parsed: { sessionId: string; token: string; branch: string };
    try {
      parsed = parseInviteLink(inviteLink);
    } catch (err) {
      if (err instanceof InviteError) {
        throw new Error(`Invalid invite link: ${err.message}`);
      }
      throw new Error('Invalid invite link');
    }

    if (parsed.branch !== repoContext.branch) {
      throw new BranchMismatchError(parsed.branch);
    }

    await this.connectSession({
      sessionId: parsed.sessionId,
      token: parsed.token,
      inviteLink,
      repoContext,
    });
  }

  /**
   * Leaves the current session gracefully.
   *
   * No-op if the session is Idle, Connecting, or Failed.
   */
  async leave(): Promise<void> {
    if (this.state.kind !== 'Active' && this.state.kind !== 'Reconnecting') {
      return;
    }

    const client = this.client;
    if (client !== null) {
      await client.disconnect();
      this.client = null;
    }

    this.setState(toIdle());
  }

  /**
   * Starts watching for branch changes. On branch change while Active or
   * Reconnecting, shows an informational message and ends the session.
   *
   * NOTE: VS Code does not allow cancelling a git branch switch — we detect it
   * after it has already happened. We cannot prevent the switch; we can only
   * react by ending the session and notifying the user.
   *
   * @param disposables Array to push the watcher disposable into.
   */
  watchBranch(disposables: { dispose(): void }[]): void {
    // Lazily import vscode so this can be called in tests (mock is in place).
    void (async () => {
      const vscode = await import('vscode');
      const { watchBranchChanges } = await import('../git/context.js');

      const watcher = await watchBranchChanges(() => {
        if (this.state.kind === 'Active' || this.state.kind === 'Reconnecting') {
          void vscode.window.showInformationMessage(
            'CoVibes: Branch switched — your session has ended.',
          );
          void this.leave();
        }
      });

      disposables.push(watcher);
    })();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private setState(next: SessionState): void {
    this.state = next;
    this.onStateChange(next);
  }

  /**
   * Core connect logic shared by `start()` and `join()`.
   */
  private async connectSession(opts: {
    sessionId: string;
    token: string;
    inviteLink: string;
    repoContext: RepoContext;
  }): Promise<void> {
    const { sessionId, token, inviteLink, repoContext } = opts;

    // Transition to Connecting
    this.setState(toConnecting(sessionId, inviteLink));

    // Build the client
    const clientOpts: RelayClientOptions = {
      sessionId,
      participantId: this.identity.id,
      displayName: this.identity.displayName,
      token,
      relayUrl: this.config.relayUrl,
      branch: repoContext.branch,
      color: this.identity.color,
    };

    const client = this.createClient(clientOpts);
    this.client = client;

    // --- Event listeners -------------------------------------------------------

    // session.state → Active
    const onMessage = (msg: unknown): void => {
      const anyMsg = msg as AnyMessage;
      if (!isSessionStateMessage(anyMsg)) return;

      const current = this.state;
      if (current.kind !== 'Connecting' && current.kind !== 'Reconnecting') return;

      const participants: ParticipantView[] = anyMsg.payload.participants.map((p) => {
        const view: ParticipantView = {
          id: p.id,
          displayName: p.displayName,
          color: p.color,
        };
        // exactOptionalPropertyTypes: only set currentFile when it's a string
        if (typeof p.currentFile === 'string') {
          view.currentFile = p.currentFile;
        }
        return view;
      });

      this.setState(toActive(current, participants));
    };

    // reconnecting event → Reconnecting
    const onReconnecting = (attempt: unknown): void => {
      const current = this.state;
      if (current.kind === 'Active') {
        this.setState(toReconnecting(current, typeof attempt === 'number' ? attempt : 0));
      } else if (current.kind === 'Reconnecting') {
        // Update attempt counter
        this.setState({
          ...current,
          attempt: typeof attempt === 'number' ? attempt : current.attempt,
        });
      }
    };

    // close event → Failed or no-op (if disconnecting intentionally)
    const onClose = (code: unknown): void => {
      const closeCode = typeof code === 'number' ? code : 1006;

      if (TERMINAL_CLOSE_CODES.has(closeCode)) {
        this.setState(toFailed(`Connection closed with terminal code ${closeCode}`));
      } else {
        // Non-terminal close means the relay gave up reconnecting (max attempts
        // exceeded) or we got an unexpected close after all retries failed.
        const current = this.state;
        if (current.kind !== 'Idle') {
          this.setState(toFailed(`Connection lost (code ${closeCode})`));
        }
      }
    };

    client.on('message', onMessage);
    client.on('reconnecting', onReconnecting);
    client.on('close', onClose);

    // Connect — if this rejects, transition to Failed
    try {
      await client.connect();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setState(toFailed(reason));
      // Remove listeners to avoid memory leaks
      client.off('message', onMessage);
      client.off('reconnecting', onReconnecting);
      client.off('close', onClose);
      this.client = null;
    }
  }
}

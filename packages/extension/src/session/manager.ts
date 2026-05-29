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
} from '@covibes/protocol';

import type { RelayClientOptions } from '../relay/client.js';
import type { ParticipantIdentity } from '../identity.js';
import type { CoVibesConfig } from '../config.js';
import type { RepoContext } from '../git/context.js';

import { BranchMismatchError, InvalidInviteLinkError } from '../errors.js';
export { BranchMismatchError } from '../errors.js';

import {
  IDLE_STATE,
  toConnecting,
  toActive,
  toReconnectingUpdate,
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
// Close codes copied from relay/client.ts — terminal means do NOT reconnect
// ---------------------------------------------------------------------------

const TERMINAL_CLOSE_CODES = new Set([
  4400, // 4400 InvalidParams is also terminal — query params won't change on reconnect
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

  /**
   * Stored when a branch-switch ends a session so the user can be prompted to
   * rejoin if they switch back within the grace period.
   */
  private pendingRejoin: { branch: string; inviteLink: string } | null = null;

  /**
   * Handle for the grace-period timer started after a branch-switch leave.
   * Tracked here so stale timers can be cancelled before starting a new one,
   * and so leave() can cancel it on a manual/voluntary leave.
   */
  private gracePeriodTimer: ReturnType<typeof setTimeout> | null = null;

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
   * Branch mismatch throws `BranchMismatchError`. The caller is responsible for
   * prompting the user, performing the branch switch, and retrying with the
   * corrected `repoContext`.
   *
   * NOTE: Branch-checkout UI (i.e. "Switch to {branch}?") is intentionally
   * deferred to the extension command handler — this method only validates and
   * throws so the handler can decide what to do.
   */
  async join(inviteLink: string, repoContext: RepoContext): Promise<void> {
    if (this.state.kind !== 'Idle') {
      throw new Error('Session already started');
    }

    let parsed: { sessionId: string; token: string; branch: string };
    try {
      parsed = parseInviteLink(inviteLink);
    } catch {
      throw new InvalidInviteLinkError(inviteLink);
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
   *
   * @param reason - Why the session is being left. Defaults to `'user'` for
   *   voluntary leaves. Pass `'branch-switch'` when the user switched branches.
   */
  async leave(reason: 'user' | 'branch-switch' | 'shutdown' = 'user'): Promise<void> {
    // Cancel any pending grace-period timer so a stale callback cannot clear
    // a subsequent session's pendingRejoin data.
    if (this.gracePeriodTimer !== null) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
      this.pendingRejoin = null;
    }

    if (this.state.kind !== 'Active' && this.state.kind !== 'Reconnecting') {
      return;
    }

    // Transition to Idle BEFORE disconnecting so that the close event fired
    // synchronously by disconnect() sees state === Idle and no-ops via the
    // guard in onClose.
    const client = this.client;
    this.client = null;
    this.setState(toIdle());

    if (client !== null) {
      client.send('session.leave', { reason });
      await client.disconnect();
      this.removeListeners(client);
    }
  }

  /**
   * Starts watching for branch changes. On branch change while Active or
   * Reconnecting, shows an informational message, ends the session with reason
   * `'branch-switch'`, and records a pending rejoin offer.
   *
   * If the user later switches back to the session branch within the grace
   * period (`config.gracePeriodSeconds`), they are prompted to rejoin.
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

      const watcher = await watchBranchChanges((newBranch: string) => {
        // NOTE: Branch switches that arrive while the session is in the
        // Connecting state are intentionally ignored here. The session has not
        // yet received server confirmation (session.state), so there is no
        // meaningful in-progress collaboration to protect. Once connected the
        // normal Active/Reconnecting path below handles future switches.
        if (this.state.kind === 'Active' || this.state.kind === 'Reconnecting') {
          // Capture session info before leaving so we can offer to rejoin later.
          const sessionInviteLink = this.state.inviteLink;

          // Recover the session's branch from the invite link.
          let sessionBranchName: string | null = null;
          try {
            sessionBranchName = parseInviteLink(sessionInviteLink).branch;
          } catch {
            // If parsing fails, skip the rejoin offer.
          }

          void vscode.window.showInformationMessage(
            'CoVibes: Branch switched — your session has ended.',
          );
          void this.leave('branch-switch');

          // Offer rejoin only when we switched away from the session branch.
          if (sessionBranchName !== null && sessionBranchName !== newBranch) {
            this.pendingRejoin = { branch: sessionBranchName, inviteLink: sessionInviteLink };

            // Cancel any previous grace-period timer before starting a new
            // one. Without this, a stale timer from an earlier branch-switch
            // could fire and null out the pendingRejoin that belongs to the
            // most-recent switch (the "double-switch" timer-leak bug).
            if (this.gracePeriodTimer !== null) {
              clearTimeout(this.gracePeriodTimer);
            }
            this.gracePeriodTimer = setTimeout(() => {
              this.gracePeriodTimer = null;
              this.pendingRejoin = null;
            }, this.config.gracePeriodSeconds * 1000);
            // Avoid blocking Node.js exit in tests
            this.gracePeriodTimer.unref();
          }
        } else if (
          this.pendingRejoin !== null &&
          newBranch === this.pendingRejoin.branch &&
          this.state.kind === 'Idle'
        ) {
          // User switched back to the session branch — offer to rejoin.
          const { inviteLink } = this.pendingRejoin;
          this.pendingRejoin = null;

          void (async () => {
            const answer = await vscode.window.showInformationMessage(
              'Rejoin CoVibes session on this branch?',
              'Yes',
              'No',
            );
            if (answer === 'Yes') {
              try {
                const { getRepoContext } = await import('../git/context.js');
                const ctx = await getRepoContext();
                // getRepoContext returns RepoContext | GitContextError
                if ('branch' in ctx) {
                  await this.join(inviteLink, ctx);
                }
                // If error, silently skip — user can rejoin manually.
              } catch {
                // Rejoin failed silently.
              }
            }
          })();
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

    // Transition to Connecting — guard above ensures this.state.kind === 'Idle'
    this.setState(
      toConnecting(this.state as SessionState & { kind: 'Idle' }, sessionId, inviteLink),
    );

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

    /** Remove all three listeners from a client instance. */
    const removeListeners = (c: IRelayClient): void => {
      c.off('message', onMessage);
      c.off('reconnecting', onReconnecting);
      c.off('close', onClose);
    };

    // Expose removeListeners on the instance so leave() can call it.
    this.removeListeners = removeListeners;

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
      const attemptNum = typeof attempt === 'number' ? attempt : 0;
      if (current.kind === 'Active' || current.kind === 'Reconnecting') {
        this.setState(toReconnectingUpdate(current, attemptNum));
      }
    };

    // close event → Failed or no-op (if disconnecting intentionally)
    const onClose = (code: unknown): void => {
      const closeCode = typeof code === 'number' ? code : 1006;

      if (TERMINAL_CLOSE_CODES.has(closeCode)) {
        removeListeners(client);
        this.setState(toFailed(`Connection closed with terminal code ${closeCode}`));
      } else {
        // Non-terminal close means the relay gave up reconnecting (max attempts
        // exceeded) or we got an unexpected close after all retries failed.
        const current = this.state;
        if (current.kind !== 'Idle') {
          removeListeners(client);
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
      removeListeners(client);
      this.client = null;
    }
  }

  /**
   * Remove event listeners from the current client.
   * Replaced each time connectSession() is called; no-op by default.
   */
  private removeListeners: (client: IRelayClient) => void = () => {
    /* no-op until connectSession initialises the real remover */
  };
}

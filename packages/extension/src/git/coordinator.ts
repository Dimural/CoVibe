/**
 * GitCoordinator — orchestrates coordinated git operations across session
 * participants.
 *
 * Broadcast → countdown → commit (or abort on peer cancel / local cancel).
 * All side-effecting dependencies are injected for testability.
 */

import type { GitOperationError } from './operations.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A peer participant visible to the coordinator. */
export interface Peer {
  id: string;
  displayName: string;
}

/** Clock abstraction, mirroring {@link HeuristicClock} in agent/heuristic.ts. */
export interface CoordinatorClock {
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
}

/** Countdown handle returned by {@link GitCoordinatorOptions.showCommitCountdown}. */
export interface CommitCountdownHandle {
  /** Programmatically dismiss the countdown (e.g., when the operation is aborted). */
  cancel: () => void;
  /**
   * Resolves with `'expired'` when the countdown elapses normally, or
   * `'cancelled'` when the user clicks the Cancel button in the notification.
   */
  promise: Promise<'expired' | 'cancelled'>;
}

/** Dependency-injection surface for {@link GitCoordinator}. */
export interface GitCoordinatorOptions {
  /** The local participant's ID (used to distinguish self from peers). */
  localParticipantId: string;
  /** Send a typed message to all peers via the relay. */
  send: (type: string, payload: unknown) => void;
  /** Perform the actual git commit. */
  doCommit: (message: string) => Promise<void | GitOperationError>;
  /** Perform the actual git push. */
  doPush: () => Promise<void | GitOperationError>;
  /** Show a VS Code information message. */
  showInfo: (msg: string) => void;
  /** Show a VS Code warning message. */
  showWarning: (msg: string) => void;
  /** Show a VS Code error message. */
  showError: (msg: string) => void;
  /**
   * Show a progress notification with a cancel button.
   *
   * @param message - The notification text.
   * @param totalMs - Total milliseconds before the countdown expires.
   */
  showCommitCountdown: (message: string, totalMs: number) => CommitCountdownHandle;
  /** Clock abstraction for testability. */
  clock: CoordinatorClock;
  /** Participants currently in the session (not including self). */
  getPeers: () => Peer[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface PendingCommit {
  message: string;
  /**
   * Resolves the internal abort promise, causing coordinateCommit to abort.
   * `cancelledBy` is the display name of the peer who triggered the abort
   * (undefined if the local user cancelled via the countdown UI).
   */
  abort: (cancelledBy: string | undefined) => void;
}

// ---------------------------------------------------------------------------
// GitCoordinator
// ---------------------------------------------------------------------------

/** Duration of the commit countdown in milliseconds. */
const COMMIT_COUNTDOWN_MS = 10_000;

/**
 * Orchestrates coordinated commit (and, later, push/pull) operations across
 * all session participants.
 *
 * Inject all side-effecting dependencies via {@link GitCoordinatorOptions} so
 * the class can be unit-tested without a VS Code extension host.
 */
export class GitCoordinator {
  private readonly opts: GitCoordinatorOptions;
  private pendingCommit: PendingCommit | null = null;

  constructor(options: GitCoordinatorOptions) {
    this.opts = options;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initiates a coordinated commit:
   *
   * 1. Broadcasts `git.operation { kind: 'commit', message }` to all peers.
   * 2. Shows a local countdown notification.
   * 3. Waits for countdown expiry, peer cancellation, or local cancellation.
   * 4. On expiry: runs `doCommit` and reports success/failure.
   * 5. On any cancellation: aborts silently or with a warning.
   *
   * @param message - The commit message.
   */
  async coordinateCommit(message: string): Promise<void> {
    if (this.pendingCommit !== null) {
      this.opts.showError('A commit is already in progress.');
      return;
    }

    // 1. Broadcast intent to peers
    this.opts.send('git.operation', { kind: 'commit', message });

    // 2. Start local countdown
    const notificationMsg = `You will commit in 10s: '${message}'`;
    const handle = this.opts.showCommitCountdown(notificationMsg, COMMIT_COUNTDOWN_MS);

    // Internal abort promise — resolved by onAck (peer cancel) or local UI cancel
    let abortResolve!: (cancelledBy: string | undefined) => void;
    const abortPromise = new Promise<string | undefined>((resolve) => {
      abortResolve = resolve;
    });

    this.pendingCommit = {
      message,
      abort: abortResolve,
    };

    // 3. Race: countdown (expired or user-cancelled) vs. peer abort
    type Race =
      | { source: 'countdown'; result: 'expired' | 'cancelled' }
      | { source: 'abort'; cancelledBy: string | undefined };
    const outcome = await Promise.race<Race>([
      handle.promise.then((result) => ({ source: 'countdown' as const, result })),
      abortPromise.then((cancelledBy) => ({ source: 'abort' as const, cancelledBy })),
    ]);

    // Dismiss the countdown UI if still shown (no-op if already closed)
    handle.cancel();
    this.pendingCommit = null;

    // Determine whether to proceed
    if (outcome.source === 'countdown' && outcome.result === 'cancelled') {
      // Local user cancelled via countdown UI — silent abort
      return;
    }

    if (outcome.source === 'abort') {
      // Peer cancelled
      const { cancelledBy } = outcome;
      if (cancelledBy !== undefined) {
        this.opts.showWarning(`Commit cancelled by ${cancelledBy}.`);
      }
      return;
    }

    // 4. Countdown expired — proceed with commit
    const err = await this.opts.doCommit(message);
    if (err !== undefined) {
      this.opts.showError(`Commit failed: ${err.message}`);
    } else {
      this.opts.showInfo(`Committed: ${message}`);
    }
  }

  /**
   * Handles an incoming `git.ack` message from a peer.
   *
   * When `ack.kind === 'commit'` and `ack.cancelled === true`, the in-flight
   * commit (if any) is aborted and the peer's display name is shown in a
   * warning toast.
   *
   * @param ack - The decoded ack payload plus the sender's participantId.
   */
  onAck(ack: { kind: string; cancelled?: boolean; participantId: string }): void {
    if (ack.kind !== 'commit' || ack.cancelled !== true) return;
    if (this.pendingCommit === null) return;

    // Find the peer's display name
    const peer = this.opts.getPeers().find((p) => p.id === ack.participantId);
    const displayName = peer?.displayName ?? ack.participantId;

    this.pendingCommit.abort(displayName);
  }

  /**
   * Handles an incoming `git.operation` message from a peer.
   *
   * For `kind === 'commit'`: shows a countdown notification with a Cancel
   * button. If the local user clicks Cancel, sends a `git.ack` with
   * `cancelled: true` back to the originator.
   *
   * @param op - The decoded operation payload plus sender metadata.
   */
  onPeerOperation(op: {
    kind: string;
    message?: string;
    participantId: string;
    displayName?: string;
  }): void {
    if (op.kind !== 'commit') return;

    const displayName = op.displayName ?? op.participantId;
    const message = op.message ?? '(no message)';
    const notificationMsg = `${displayName} will commit in 10s: '${message}' [Cancel]`;

    const handle = this.opts.showCommitCountdown(notificationMsg, COMMIT_COUNTDOWN_MS);

    // If the local user cancels, send a git.ack back to the originator
    void handle.promise.then((result) => {
      if (result === 'cancelled') {
        this.opts.send('git.ack', { kind: 'commit', cancelled: true });
      }
    });
  }
}

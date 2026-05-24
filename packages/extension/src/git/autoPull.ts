/**
 * AutoPullCoordinator — detects when the remote HEAD has moved and coordinates
 * a pull across all session participants.
 *
 * Design:
 * - One participant (the one with the **lowest** `participantId` string) detects
 *   the remote update and broadcasts `git.operation { kind: 'pull-staged' }`.
 * - Others suppress broadcasting even if they detect the same update (they will
 *   receive the broadcast from the lowest-ID peer).
 * - Each participant then decides independently: dirty → prompt; clean → pull
 *   silently and toast.
 *
 * All side-effecting dependencies are injected for testability.
 */

import type { GitOperationError } from './operations.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependency-injection surface for {@link AutoPullCoordinator}. */
export interface AutoPullOptions {
  /** The local participant's ID used for tie-breaking. */
  localParticipantId: string;
  /** Send a message to all peers via the relay. */
  send: (type: string, payload: unknown) => void;
  /** Get all current participant IDs (including self). */
  getAllParticipantIds: () => string[];
  /** Whether the local workspace has uncommitted changes. */
  isDirty: () => boolean;
  /** Perform git pull; returns `undefined` on success or a {@link GitOperationError}. */
  doPull: () => Promise<void | GitOperationError>;
  /** Show a VS Code information toast. */
  showInfo: (msg: string) => void;
  /** Show a VS Code warning toast. */
  showWarning: (msg: string) => void;
  /**
   * Show a confirmation prompt:
   * "Pull will fast-forward and may conflict… Continue?"
   * Resolves `true` if the user confirms.
   */
  showDirtyPullConfirm: () => Promise<boolean>;
  /**
   * Subscribe to remote HEAD changes.
   * Returns a dispose function that unsubscribes.
   */
  watchRemoteHead: (callback: () => void) => () => void;
  /** Get the current remote HEAD SHA (e.g. from `git ls-remote`). */
  getRemoteHeadSha: () => Promise<string | undefined>;
  /** Get the current local HEAD SHA. */
  getLocalHeadSha: () => string | undefined;
}

// ---------------------------------------------------------------------------
// AutoPullCoordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates automatic pulls when the remote HEAD advances.
 *
 * Usage:
 * ```ts
 * const coordinator = new AutoPullCoordinator(options).start();
 * // …
 * coordinator.dispose();
 * ```
 */
export class AutoPullCoordinator {
  private readonly _opts: AutoPullOptions;
  private _disposeWatch: (() => void) | undefined;

  constructor(opts: AutoPullOptions) {
    this._opts = opts;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Subscribes to remote HEAD changes and returns `this` for chaining.
   */
  start(): this {
    this._disposeWatch = this._opts.watchRemoteHead(() => {
      void this._onRemoteChange();
    });
    return this;
  }

  /**
   * Unsubscribes from the remote HEAD watch.
   */
  dispose(): void {
    this._disposeWatch?.();
  }

  // ── Public peer message handler ───────────────────────────────────────────

  /**
   * Called when any `git.operation` message arrives from a peer.
   * Triggers a local pull when `op.kind === 'pull-staged'`.
   */
  async onPeerOperation(op: { kind: string; participantId?: string }): Promise<void> {
    if (op.kind !== 'pull-staged') return;
    await this._triggerLocalPull();
  }

  // ── Test escape hatch ─────────────────────────────────────────────────────

  /**
   * Exposed for unit tests only — allows tests to invoke `_onRemoteChange`
   * without going through the `watchRemoteHead` subscription mechanism.
   *
   * @internal
   */
  async testOnRemoteChange(): Promise<void> {
    await this._onRemoteChange();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Called whenever the remote HEAD watcher fires. */
  private async _onRemoteChange(): Promise<void> {
    const { getRemoteHeadSha, getLocalHeadSha, getAllParticipantIds, localParticipantId, send } =
      this._opts;

    const remoteHead = await getRemoteHeadSha();

    // Can't determine remote SHA → bail out.
    if (remoteHead === undefined) return;

    const localHead = getLocalHeadSha();

    // Already up to date → nothing to do.
    if (remoteHead === localHead) return;

    // Only the participant with the lowest ID broadcasts to avoid duplicates.
    const ids = getAllParticipantIds();
    const lowestId = [...ids].sort()[0];
    const isLowestId = lowestId === localParticipantId;

    if (!isLowestId) {
      // Will receive the broadcast from the lowest-ID peer.
      return;
    }

    // Broadcast to peers so they perform their local pull.
    send('git.operation', { kind: 'pull-staged' });

    // Also pull locally.
    await this._triggerLocalPull();
  }

  /** Performs the actual local pull, prompting when the workspace is dirty. */
  private async _triggerLocalPull(): Promise<void> {
    const { isDirty, showDirtyPullConfirm, doPull, showInfo, showWarning } = this._opts;

    if (isDirty()) {
      const confirmed = await showDirtyPullConfirm();
      if (!confirmed) return;
    }

    const result = await doPull();

    if (result === undefined) {
      showInfo('Pulled latest changes.');
      return;
    }

    // result is a GitOperationError
    if (result.kind === 'pull-failed') {
      showWarning(`Pull failed: ${result.message}. Use git tools to resolve.`);
    }
  }
}

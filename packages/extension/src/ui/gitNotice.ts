/**
 * gitNotice — VS Code notification helpers for coordinated git operations.
 *
 * This module is intentionally thin: it wraps `vscode.window.withProgress` to
 * produce the {@link CommitCountdownHandle} shape expected by
 * {@link GitCoordinatorOptions.showCommitCountdown}. All logic lives in
 * {@link GitCoordinator} and is tested via injected fakes; this file is only
 * exercised in integration.
 */

import type { CommitCountdownHandle } from '../git/coordinator.js';

/**
 * Creates a VS Code progress notification with a Cancel button that counts
 * down for `totalMs` milliseconds.
 *
 * - Resolves with `'expired'` when the countdown elapses naturally.
 * - Resolves with `'cancelled'` when the user clicks the Cancel button.
 * - Calling the returned `cancel()` function dismisses the notification
 *   programmatically (used by {@link GitCoordinator} to clean up when a peer
 *   aborts the operation).
 *
 * @param message - Text shown in the notification.
 * @param totalMs - Duration of the countdown in milliseconds.
 */
export function makeCommitCountdown(message: string, totalMs: number): CommitCountdownHandle {
  let resolveOuter!: (result: 'expired' | 'cancelled') => void;
  const outerPromise = new Promise<'expired' | 'cancelled'>((resolve) => {
    resolveOuter = resolve;
  });

  // We need a way to signal withProgress to finish. withProgress finishes when
  // the callback promise resolves. We create a "done" promise that we control
  // externally so that cancel() can properly dismiss the notification.
  let signalDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    signalDone = resolve;
  });

  // Lazy import so the module can be loaded in tests without a host
  void (async () => {
    const vscode = await import('vscode');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: true,
      },
      async (_progress, token) => {
        // User clicks the VS Code cancel button
        token.onCancellationRequested(() => {
          resolveOuter('cancelled');
          signalDone();
        });

        // Wait until externally dismissed or user cancels
        await donePromise;
      },
    );
  })();

  // Start the expiry timer
  const timer = setTimeout(() => {
    resolveOuter('expired');
    signalDone();
  }, totalMs);

  return {
    promise: outerPromise,
    cancel: () => {
      clearTimeout(timer);
      resolveOuter('cancelled');
      signalDone(); // properly dismisses the withProgress notification
    },
  };
}

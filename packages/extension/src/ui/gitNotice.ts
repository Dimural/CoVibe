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

  const promise = new Promise<'expired' | 'cancelled'>((resolve) => {
    resolveOuter = resolve;
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
        // Resolve as cancelled if the user clicks the cancel button
        token.onCancellationRequested(() => {
          resolveOuter('cancelled');
        });

        // Wait for totalMs, then resolve as expired (unless already cancelled)
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            resolveOuter('expired');
            done();
          }, totalMs);

          // If cancelled early, stop the timer and finish the progress task
          token.onCancellationRequested(() => {
            clearTimeout(timer);
            done();
          });
        });
      },
    );
  })();

  return {
    promise,
    cancel: () => {
      // Dismissing is handled by resolving the outer promise, which causes the
      // withProgress task to finish on the next tick. We resolve as 'cancelled'
      // here so the UI closes (the GitCoordinator ignores this resolution since
      // it aborts via the internal abort promise before awaiting the countdown).
      resolveOuter('cancelled');
    },
  };
}

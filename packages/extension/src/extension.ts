import * as vscode from 'vscode';
import { CoVibesStatusBar } from './ui/statusBar.js';
import { SessionPanel } from './ui/sessionPanel.js';
import { getOrCreateIdentity } from './identity.js';
import { getConfig } from './config.js';
import { SessionManager, BranchMismatchError } from './session/manager.js';
import { RelayClient } from './relay/client.js';
import { getRepoContext } from './git/context.js';
import type { SessionState } from './session/state.js';
import type { RelayClientOptions } from './relay/client.js';

let managerRef: SessionManager | null = null;

export function activate(context: vscode.ExtensionContext): void {
  let currentState: SessionState = { kind: 'Idle' };

  const statusBar = new CoVibesStatusBar();
  const sessionPanel = new SessionPanel(context.extensionUri);

  // Wire state change callback
  function onStateChange(state: SessionState): void {
    currentState = state;
    statusBar.update(state);
    sessionPanel.update(state);
  }

  // Bootstrap identity + config + manager asynchronously.
  // Commands are registered synchronously but delegate to the initialized
  // manager, which will be available by the time the user first invokes them.
  void (async () => {
    let identity: Awaited<ReturnType<typeof getOrCreateIdentity>>;
    try {
      identity = await getOrCreateIdentity(context);
    } catch (err) {
      void vscode.window.showErrorMessage(
        'CoVibes: Failed to load identity — ' + (err instanceof Error ? err.message : String(err)),
      );
      // Fallback identity
      const { randomUUID } = await import('node:crypto');
      const { deriveColor } = await import('./identity.js');
      const id = randomUUID();
      identity = { id, displayName: `User-${id.slice(0, 6)}`, color: deriveColor(id) };
    }

    const config = getConfig();

    const manager = new SessionManager(
      identity,
      config,
      (opts: RelayClientOptions) => new RelayClient(opts),
      onStateChange,
    );

    managerRef = manager;

    // Watch for branch changes — adds disposable to context.subscriptions
    manager.watchBranch(context.subscriptions);

    // Register a plain disposable so manager.leave() is called on deactivate
    context.subscriptions.push({
      dispose(): void {
        void manager.leave();
      },
    });
  })();

  context.subscriptions.push(
    statusBar,
    sessionPanel,
    vscode.commands.registerCommand('covibes.focusSessionPanel', () => {
      sessionPanel.show(currentState);
    }),
    vscode.commands.registerCommand('covibes.startSession', () => {
      void (async () => {
        const manager = managerRef;
        if (manager === null) {
          void vscode.window.showErrorMessage(
            'CoVibes: Extension not ready yet, please try again.',
          );
          return;
        }

        const repoCtx = await getRepoContext();
        if ('kind' in repoCtx) {
          void vscode.window.showErrorMessage(repoCtx.message);
          return;
        }

        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'CoVibes: Connecting...' },
            async () => {
              await manager.start(repoCtx);
            },
          );
          void vscode.window.showInformationMessage(
            'CoVibes: Session started! Invite link copied to clipboard.',
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            'CoVibes: Failed to start session — ' +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      })();
    }),
    vscode.commands.registerCommand('covibes.joinSession', () => {
      void (async () => {
        const manager = managerRef;
        if (manager === null) {
          void vscode.window.showErrorMessage(
            'CoVibes: Extension not ready yet, please try again.',
          );
          return;
        }

        const link = await vscode.window.showInputBox({
          prompt: 'Paste your CoVibes invite link',
          placeHolder: 'covibes://join?...',
        });

        if (link === undefined || link.trim() === '') {
          return;
        }

        const repoCtx = await getRepoContext();
        if ('kind' in repoCtx) {
          void vscode.window.showErrorMessage(repoCtx.message);
          return;
        }

        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'CoVibes: Connecting...' },
            async () => {
              await manager.join(link, repoCtx);
            },
          );
          void vscode.window.showInformationMessage('CoVibes: Joined session.');
        } catch (err) {
          if (err instanceof BranchMismatchError) {
            void vscode.window.showWarningMessage(
              `CoVibes: Switch to branch ${err.requiredBranch} to join this session.`,
              'OK',
            );
            return;
          }
          void vscode.window.showErrorMessage(
            'CoVibes: Failed to join session — ' +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      })();
    }),
    vscode.commands.registerCommand('covibes.leaveSession', () => {
      void (async () => {
        const manager = managerRef;
        if (manager !== null) {
          await manager.leave();
        }
        void vscode.window.showInformationMessage('CoVibes: Left the session.');
      })();
    }),
  );
}

export function deactivate(): void {
  if (managerRef !== null) {
    void managerRef.leave();
  }
}

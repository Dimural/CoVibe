import * as vscode from 'vscode';
import { CoVibesStatusBar } from './ui/statusBar.js';
import { SessionPanel } from './ui/sessionPanel.js';
import { getOrCreateIdentity } from './identity.js';
import { getConfig } from './config.js';
import { SessionManager } from './session/manager.js';
import { userMessage } from './errors.js';
import { RelayClient } from './relay/client.js';
import { getRepoContext } from './git/context.js';
import type { SessionState } from './session/state.js';
import type { RelayClientOptions } from './relay/client.js';
import { AgentCoordinator } from './agent/coordinator.js';
import { AgentDecorationManager } from './ui/agentDecorations.js';
import type { AgentDecorationHandle, DecorationRange } from './ui/agentDecorations.js';
import { ExplorerBadgeProvider } from './ui/explorerBadges.js';
import { ConflictView } from './conflict/view.js';

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

    // --- Phase 5: Agent Activity Layer ---

    const agentDecorationMgr = new AgentDecorationManager({
      decorationTypeFactory: {
        createTextEditorDecorationType: (opts) =>
          vscode.window.createTextEditorDecorationType(opts),
      },
      getActiveEditorForPath: (path) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        const editorPath = editor.document.uri.fsPath;
        if (!editorPath.endsWith(path.replace(/\//g, vscode.Uri.file('/').fsPath[0] ?? '/'))) {
          return undefined;
        }
        // Wrap vscode.TextEditor to satisfy AgentDecoratedEditor's narrower interface
        return {
          document: editor.document,
          setDecorations: (type: AgentDecorationHandle, ranges: readonly DecorationRange[]) => {
            editor.setDecorations(
              type as vscode.TextEditorDecorationType,
              ranges as unknown as vscode.Range[],
            );
          },
        };
      },
    });

    const explorerBadges = new ExplorerBadgeProvider();
    context.subscriptions.push(explorerBadges.register());

    const conflictViews = new Map<string, ConflictView>();

    // coordinatorRef holds the AgentCoordinator once constructed. Using a ref
    // object lets openConflictView capture it via closure without a temporal
    // dead zone (the callback only runs after coordinator is assigned).
    const coordinatorRef: { current: AgentCoordinator | undefined } = { current: undefined };

    const coordinator = new AgentCoordinator({
      localParticipantId: identity.id,
      heuristicConfig: {
        minEditsPerSecond: config.agentMinEditsPerSecond,
        minInsertionChars: config.agentMinInsertionChars,
        minAffectedLines: config.agentMinAffectedLines,
        burstEndQuietMs: 2000,
      },
      getTerminals: () =>
        vscode.window.terminals.map((t) => ({
          name: t.name,
          processRunning: (t as unknown as { processId?: unknown }).processId !== undefined,
        })),
      terminalPatterns: config.agentTerminalPatterns,
      send: () => {
        // relay send will be wired in Phase 6 when relay client is accessible
      },
      getDocumentText: (path) => {
        const editor = vscode.window.visibleTextEditors.find((e) =>
          e.document.uri.fsPath.endsWith(path),
        );
        return editor?.document.getText();
      },
      applyWorkspaceEdit: async (path, text) => {
        const uri = vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, path)
          : undefined;
        if (!uri) return;
        const edit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(uri, fullRange, text);
        await vscode.workspace.applyEdit(edit);
      },
      getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      showWarningMessage: (msg) => void vscode.window.showWarningMessage(msg),
      showInformationMessage: (msg) => void vscode.window.showInformationMessage(msg),
      onAgentStatusChange: (statuses) => {
        sessionPanel.updateAgentStatus(statuses);
        agentDecorationMgr.clearAll();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        explorerBadges.clearAll(workspaceRoot);
        for (const [participantId, status] of Object.entries(statuses)) {
          if (!status.agentActive) continue;
          const path = coordinatorRef.current?.getActiveIntentPath(participantId);
          if (path) explorerBadges.setActive(path, participantId, workspaceRoot);
        }
      },
      openConflictView: (conflictId, path, leftText, rightText, baseText, peers) => {
        const view = new ConflictView({
          extensionUri: context.extensionUri,
          localParticipantId: identity.id,
          onTextChange: () => {},
          onConfirm: (resolvedText) => {
            void (async () => {
              await coordinatorRef.current?.applyResolvedText(path, resolvedText);
              view.close();
              conflictViews.delete(conflictId);
              void vscode.window.showInformationMessage('CoVibes: Conflict resolved.');
            })();
          },
          onCancel: () => {
            view.close();
            conflictViews.delete(conflictId);
            void vscode.window.showInformationMessage(
              'CoVibes: Conflict resolution cancelled. Use git merge tools to resolve manually.',
            );
          },
        });
        conflictViews.set(conflictId, view);
        view.open(
          {
            conflictId,
            peers,
            leftText,
            rightText,
            baseText,
            resolutionText: `<<<<<<< YOURS\n${leftText}\n=======\n${rightText}\n>>>>>>> THEIRS\n`,
            confirmed: new Set(),
            cancelled: false,
          },
          path,
        );
      },
      clock: {
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    coordinatorRef.current = coordinator;

    if (config.agentDetectionEnabled) {
      coordinator.start();
    }

    context.subscriptions.push({
      dispose: () => {
        coordinator.dispose();
        agentDecorationMgr.clearAll();
        explorerBadges.dispose();
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
          void vscode.window.showErrorMessage(userMessage(err));
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
          void vscode.window.showErrorMessage(userMessage(err));
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

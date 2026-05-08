import * as vscode from 'vscode';
import { CoVibesStatusBar } from './ui/statusBar.js';
import { SessionPanel } from './ui/sessionPanel.js';
import type { SessionState } from './session/state.js';

export function activate(context: vscode.ExtensionContext): void {
  let currentState: SessionState = { kind: 'Idle' };

  const statusBar = new CoVibesStatusBar();
  const sessionPanel = new SessionPanel(context.extensionUri);

  context.subscriptions.push(
    statusBar,
    sessionPanel,
    vscode.commands.registerCommand('covibes.focusSessionPanel', () => {
      sessionPanel.show(currentState);
    }),
    vscode.commands.registerCommand('covibes.startSession', () => {
      void vscode.window.showInformationMessage('CoVibes: Start Session — coming soon');
    }),
    vscode.commands.registerCommand('covibes.joinSession', () => {
      void vscode.window.showInformationMessage('CoVibes: Join Session — coming soon');
    }),
    vscode.commands.registerCommand('covibes.leaveSession', () => {
      void vscode.window.showInformationMessage('CoVibes: Leave Session — coming soon');
    }),
  );

  // Wire state change callback — used by SessionManager in Task 3.7
  function onStateChange(state: SessionState): void {
    currentState = state;
    statusBar.update(state);
    sessionPanel.update(state);
  }

  // Suppress unused variable warning until SessionManager is wired in Task 3.7
  void onStateChange;
}

export function deactivate(): void {}

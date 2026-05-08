import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(circle-slash) CoVibes';
  statusBar.tooltip = 'CoVibes: Not in a session';
  statusBar.show();

  context.subscriptions.push(
    statusBar,
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
}

export function deactivate(): void {}

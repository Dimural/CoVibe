import * as vscode from 'vscode';
import type { SessionState } from '../session/state.js';

export class CoVibesStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'covibes.focusSessionPanel';
    this.update({ kind: 'Idle' });
    this.item.show();
  }

  update(state: SessionState): void {
    switch (state.kind) {
      case 'Idle':
        this.item.text = '$(circle-slash) CoVibes';
        this.item.tooltip = 'CoVibes: Not in a session. Click to start or join.';
        this.item.backgroundColor = undefined;
        break;
      case 'Connecting':
        this.item.text = '$(sync~spin) CoVibes';
        this.item.tooltip = 'CoVibes: Connecting...';
        this.item.backgroundColor = undefined;
        break;
      case 'Active': {
        const count = state.participants.length;
        this.item.text = `$(broadcast) CoVibes: ${count}`;
        this.item.tooltip = `CoVibes: ${count} participant${count === 1 ? '' : 's'} in session`;
        this.item.backgroundColor = undefined;
        break;
      }
      case 'Reconnecting':
        this.item.text = '$(sync~spin) CoVibes';
        this.item.tooltip = `CoVibes: Reconnecting (attempt ${state.attempt})...`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'Failed':
        this.item.text = '$(error) CoVibes';
        this.item.tooltip = `CoVibes: Error — ${state.reason}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

import * as vscode from 'vscode';
import type { ResolutionState } from './resolutionState.js';

export interface ConflictViewOptions {
  extensionUri: vscode.Uri;
  localParticipantId: string;
  onTextChange(text: string): void;
  onConfirm(text: string): void;
  onCancel(): void;
}

export class ConflictView {
  private panel: vscode.WebviewPanel | undefined;
  private readonly options: ConflictViewOptions;

  constructor(options: ConflictViewOptions) {
    this.options = options;
  }

  open(state: ResolutionState, path: string): void {
    if (this.panel) {
      this.panel.reveal();
      this.sendInit(state, path);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'covibes.conflictResolution',
      `CoVibes Conflict: ${path.split('/').pop() ?? path}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'media')],
      },
    );

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    panel.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
      if (msg.type === 'textChange') this.options.onTextChange(msg.text ?? '');
      else if (msg.type === 'confirm') this.options.onConfirm(msg.text ?? '');
      else if (msg.type === 'cancel') this.options.onCancel();
    });

    this.panel = panel;
    panel.webview.html = this.buildHtml(panel.webview);
    this.sendInit(state, path);
  }

  updateState(state: ResolutionState): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      type: 'stateUpdate',
      state: this.serializeState(state, ''),
    });
  }

  close(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private sendInit(state: ResolutionState, path: string): void {
    void this.panel?.webview.postMessage({
      type: 'init',
      state: { ...this.serializeState(state, path), path },
    });
  }

  private serializeState(state: ResolutionState, path: string) {
    return {
      path,
      leftText: state.leftText,
      rightText: state.rightText,
      resolutionText: state.resolutionText,
      peers: state.peers,
      confirmedPeers: [...state.confirmed],
      confirmedByMe: state.confirmed.has(this.options.localParticipantId),
      cancelled: state.cancelled,
    };
  }

  private buildHtml(webview: vscode.Webview): string {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, 'media', 'conflict.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, 'media', 'conflict.js'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CoVibes — Conflict Resolution</title>
  <link rel="stylesheet" href="${stylesUri.toString()}">
</head>
<body>
  <div id="header">
    <span id="conflict-file"></span>
    <span id="conflict-subtitle">Review both versions and resolve in the center panel</span>
  </div>
  <div id="panels">
    <div class="panel" id="left-panel">
      <div class="panel-header">YOUR VERSION</div>
      <pre class="panel-content" id="left-content"></pre>
    </div>
    <div class="panel center-panel" id="center-panel">
      <div class="panel-header">RESOLUTION <span id="resolved-badge" class="resolved-badge hidden">✓ resolved</span></div>
      <textarea id="center-content" spellcheck="false"></textarea>
    </div>
    <div class="panel" id="right-panel">
      <div class="panel-header">THEIR VERSION</div>
      <pre class="panel-content" id="right-content"></pre>
    </div>
  </div>
  <div id="toolbar">
    <div id="toolbar-actions">
      <button id="take-mine" class="btn">← Take Mine</button>
      <button id="take-theirs" class="btn">Take Theirs →</button>
    </div>
    <div id="toolbar-confirm">
      <div id="confirm-status"></div>
      <button id="confirm-btn" class="btn btn-primary" disabled>✓ Confirm Resolution</button>
      <button id="cancel-btn" class="btn btn-danger">✗ Cancel</button>
    </div>
  </div>
  <script src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

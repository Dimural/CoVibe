import * as vscode from 'vscode';
import type { SessionState, ParticipantView } from '../session/state.js';

// ---------------------------------------------------------------------------
// Pure helpers (no vscode dependency — testable in isolation)
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the inner HTML for the participants `<ul>`.
 * Pure function — no vscode dependency, fully testable.
 */
export function buildParticipantListHtml(participants: ParticipantView[]): string {
  if (participants.length === 0) {
    return '';
  }
  return participants
    .map((p) => {
      const fileSpan = p.currentFile
        ? `<span class="participant-file">${escapeHtml(p.currentFile)}</span>`
        : '';
      return (
        `<li class="participant" data-participant-id="${escapeHtml(p.id)}">` +
        `<span class="color-dot" style="background-color: ${escapeHtml(p.color)}"></span>` +
        `<span class="participant-name">${escapeHtml(p.displayName)}</span>` +
        fileSpan +
        `</li>`
      );
    })
    .join('');
}

// ---------------------------------------------------------------------------
// SessionPanel
// ---------------------------------------------------------------------------

export class SessionPanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /** Show or reveal the panel. */
  show(state: SessionState): void {
    if (this.panel) {
      this.panel.reveal();
      this.postState(state);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'covibes.sessionPanel',
      'CoVibes Session',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel = panel;
    panel.webview.html = this.getHtmlForWebview(panel.webview, state);
  }

  /** Update participant list without revealing if hidden. */
  update(state: SessionState): void {
    if (!this.panel) return;
    this.postState(state);
  }

  updateAgentStatus(
    agentStatuses: Record<string, { agentActive: boolean; agentSourced: boolean }>,
  ): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'agentUpdate', agents: agentStatuses });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private postState(state: SessionState): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'stateUpdate', state });
  }

  private getHtmlForWebview(webview: vscode.Webview, state: SessionState): string {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sessionPanel.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'sessionPanel.js'),
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    // Derive initial content from state
    let statusText = 'Not connected';
    let participantsHtml = '';
    switch (state.kind) {
      case 'Idle':
        statusText = 'Not connected';
        break;
      case 'Connecting':
        statusText = 'Connecting...';
        break;
      case 'Active':
        statusText = `Session active — ${state.participants.length} participant(s)`;
        participantsHtml = buildParticipantListHtml(state.participants);
        break;
      case 'Reconnecting':
        statusText = `Reconnecting (attempt ${state.attempt})...`;
        participantsHtml = buildParticipantListHtml(state.participants);
        break;
      case 'Failed':
        statusText = `Error: ${escapeHtml(state.reason)}`;
        break;
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- CSP: no remote resources. unsafe-inline for inline status icon colors only. -->
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CoVibes Session</title>
  <link rel="stylesheet" href="${stylesUri.toString()}">
</head>
<body>
  <div id="app">
    <div id="status-section">
      <p id="status-text">${statusText}</p>
    </div>
    <div id="participants-section">
      <h2>Participants</h2>
      <ul id="participants-list">${participantsHtml}</ul>
    </div>
  </div>
  <script src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

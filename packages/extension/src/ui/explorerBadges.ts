import * as vscode from 'vscode';

export class ExplorerBadgeProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** path → participant display name */
  private readonly active = new Map<string, string>();
  private registration: vscode.Disposable | undefined;

  register(): vscode.Disposable {
    this.registration = vscode.window.registerFileDecorationProvider(this);
    return this.registration;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const fsPath = uri.fsPath;
    for (const [activePath, name] of this.active) {
      if (fsPath.endsWith(activePath.replace(/\//g, vscode.Uri.file('/').fsPath[0] ?? '/'))) {
        return {
          badge: '⚡',
          tooltip: `${name}'s agent is editing this file`,
          color: new vscode.ThemeColor('editorWarning.foreground'),
          propagate: false,
        };
      }
    }
    return undefined;
  }

  setActive(path: string, displayName: string, workspaceRoot: string): void {
    this.active.set(path, displayName);
    const uri = vscode.Uri.file(`${workspaceRoot}/${path}`);
    this._onDidChangeFileDecorations.fire([uri]);
  }

  clearPath(path: string, workspaceRoot: string): void {
    if (!this.active.has(path)) return;
    this.active.delete(path);
    const uri = vscode.Uri.file(`${workspaceRoot}/${path}`);
    this._onDidChangeFileDecorations.fire([uri]);
  }

  clearAll(workspaceRoot: string): void {
    const paths = [...this.active.keys()];
    this.active.clear();
    const uris = paths.map((p) => vscode.Uri.file(`${workspaceRoot}/${p}`));
    if (uris.length > 0) this._onDidChangeFileDecorations.fire(uris);
  }

  dispose(): void {
    this.registration?.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}

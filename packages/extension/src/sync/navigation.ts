// ---------------------------------------------------------------------------
// Structural interfaces — no runtime vscode import needed for testability
// ---------------------------------------------------------------------------

export interface NavUri {
  readonly scheme: string;
  readonly fsPath: string;
}

export interface NavEditor {
  readonly document: { readonly uri: NavUri };
}

export interface Disposable {
  dispose(): void;
}

export interface NavFileOptions {
  /** Subscribe to VS Code active editor changes. Returns a disposable. */
  onDidChangeActiveTextEditor(handler: (editor: NavEditor | undefined) => void): Disposable;
  /** Convert a VS Code Uri to a workspace-relative path. Returns undefined if outside workspace. */
  uriToPath(uri: NavUri): string | undefined;
  /** Send nav.file to peers. */
  sendNavFile(path: string): void;
  /** Called when a remote participant changes their active file. */
  onRemoteNavFile(participantId: string, path: string): void;
}

// ---------------------------------------------------------------------------
// NavigationSync
// ---------------------------------------------------------------------------

export class NavigationSync {
  private readonly options: NavFileOptions;
  private readonly knownFiles = new Map<string, string>();
  private subscription: Disposable | undefined;

  constructor(options: NavFileOptions) {
    this.options = options;
  }

  /** Call when this class should start tracking editor changes. */
  start(): void {
    if (this.subscription !== undefined) return;
    this.subscription = this.options.onDidChangeActiveTextEditor((editor) => {
      this.handleEditorChange(editor);
    });
  }

  /** Call when a remote nav.file message arrives. */
  handleRemoteNavFile(participantId: string, path: string): void {
    this.knownFiles.set(participantId, path);
    this.options.onRemoteNavFile(participantId, path);
  }

  /** Call when a participant leaves — clears their last known file. */
  onParticipantLeft(participantId: string): void {
    this.knownFiles.delete(participantId);
  }

  /** Returns the last known file path for a participant (undefined if not seen yet). */
  getLastKnownFile(participantId: string): string | undefined {
    return this.knownFiles.get(participantId);
  }

  /** Clean up subscriptions. */
  dispose(): void {
    if (this.subscription !== undefined) {
      this.subscription.dispose();
      this.subscription = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleEditorChange(editor: NavEditor | undefined): void {
    if (editor === undefined) return;
    if (editor.document.uri.scheme !== 'file') return;

    const path = this.options.uriToPath(editor.document.uri);
    if (path === undefined) return;

    this.options.sendNavFile(path);
  }
}

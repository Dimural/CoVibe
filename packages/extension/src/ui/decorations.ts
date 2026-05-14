import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Structural interfaces
// ---------------------------------------------------------------------------

export interface DecorationTypeFactory {
  createTextEditorDecorationType(options: DecorationRenderOptions): DecorationHandle;
}

export interface DecorationHandle {
  dispose(): void;
}

export interface DecorationRenderOptions {
  borderWidth?: string;
  borderStyle?: string;
  borderColor?: string;
  after?: {
    contentText?: string;
    color?: string;
    fontSize?: string;
    margin?: string;
  };
  rangeBehavior?: number;
}

export interface DecoratedEditor {
  readonly document: { readonly uri: vscode.Uri };
  setDecorations(decorationType: DecorationHandle, ranges: readonly DecorationRange[]): void;
}

export interface DecorationRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

// ---------------------------------------------------------------------------
// DecorationManager
// ---------------------------------------------------------------------------

export interface DecorationManagerOptions {
  getActiveEditorForPath(path: string): DecoratedEditor | undefined;
  decorationTypeFactory: DecorationTypeFactory;
}

interface ParticipantDecoration {
  handle: DecorationHandle;
  // Tracks the last editor the decoration was applied to, so clear() and
  // clearAll() can call setDecorations(handle, []) before disposing and avoid
  // leaving a visual artifact until the next VS Code render cycle.
  editor: DecoratedEditor;
}

export class DecorationManager {
  private readonly options: DecorationManagerOptions;
  private readonly decorations = new Map<string, ParticipantDecoration>();

  constructor(options: DecorationManagerOptions) {
    this.options = options;
  }

  render(
    participantId: string,
    color: string,
    displayName: string,
    path: string,
    _anchorPos: { line: number; character: number },
    headPos: { line: number; character: number },
  ): void {
    let decoration = this.decorations.get(participantId);
    if (decoration === undefined) {
      // In CoVibes, colors and display names are assigned at session join and are
      // immutable for the duration of the session, so the first call always wins.
      // Subsequent render() calls reuse the cached handle; color/displayName are
      // intentionally not re-checked after initial creation.
      const handle = this.options.decorationTypeFactory.createTextEditorDecorationType({
        borderWidth: '2px 0 0',
        borderStyle: 'solid',
        borderColor: color,
        after: {
          contentText: ` ${displayName}`,
          color,
          fontSize: '11px',
          margin: '0 0 0 2px',
        },
        rangeBehavior: 1,
      });

      const editor = this.options.getActiveEditorForPath(path);
      if (editor === undefined) {
        // No active editor yet; the handle is still tracked so clear() can
        // dispose it later, but we cannot render decorations right now.
        // editor is stored as a sentinel that does nothing on setDecorations.
        const noop: DecoratedEditor = {
          document: { uri: undefined as unknown as vscode.Uri },
          setDecorations: () => {},
        };
        decoration = { handle, editor: noop };
        this.decorations.set(participantId, decoration);
        return;
      }

      decoration = { handle, editor };
      this.decorations.set(participantId, decoration);
    } else {
      // Update the stored editor reference on every render so clear() always
      // has a valid reference for the setDecorations(handle, []) call.
      const editor = this.options.getActiveEditorForPath(path);
      if (editor !== undefined) {
        decoration.editor = editor;
      }
    }

    decoration.editor.setDecorations(decoration.handle, [{ start: headPos, end: headPos }]);
  }

  clear(participantId: string): void {
    const decoration = this.decorations.get(participantId);
    if (decoration === undefined) return;
    // Clear visual artifacts before disposing; VS Code requires an explicit
    // empty-range call or the cursor ghost lingers until the next render cycle.
    decoration.editor.setDecorations(decoration.handle, []);
    decoration.handle.dispose();
    this.decorations.delete(participantId);
  }

  clearAll(): void {
    for (const decoration of this.decorations.values()) {
      decoration.editor.setDecorations(decoration.handle, []);
      decoration.handle.dispose();
    }
    this.decorations.clear();
  }

  has(participantId: string): boolean {
    return this.decorations.has(participantId);
  }
}

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
      decoration = { handle };
      this.decorations.set(participantId, decoration);
    }

    const editor = this.options.getActiveEditorForPath(path);
    if (editor === undefined) return;

    editor.setDecorations(decoration.handle, [{ start: headPos, end: headPos }]);
  }

  clear(participantId: string): void {
    const decoration = this.decorations.get(participantId);
    if (decoration === undefined) return;
    decoration.handle.dispose();
    this.decorations.delete(participantId);
  }

  clearAll(): void {
    for (const decoration of this.decorations.values()) {
      decoration.handle.dispose();
    }
    this.decorations.clear();
  }

  has(participantId: string): boolean {
    return this.decorations.has(participantId);
  }
}

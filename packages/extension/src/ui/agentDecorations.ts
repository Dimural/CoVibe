export interface DecorationRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface AgentDecorationHandle {
  dispose(): void;
}

export interface AgentDecorationTypeFactory {
  createTextEditorDecorationType(options: {
    borderWidth?: string;
    borderStyle?: string;
    borderColor?: string;
    isWholeLine?: boolean;
    overviewRulerColor?: string;
    overviewRulerLane?: number;
    rangeBehavior?: number;
  }): AgentDecorationHandle;
}

export interface AgentDecoratedEditor {
  readonly document: { readonly uri: { readonly fsPath: string; readonly scheme: string } };
  setDecorations(type: AgentDecorationHandle, ranges: readonly DecorationRange[]): void;
}

export interface AgentDecorationManagerOptions {
  decorationTypeFactory: AgentDecorationTypeFactory;
  getActiveEditorForPath(path: string): AgentDecoratedEditor | undefined;
}

interface Entry {
  handle: AgentDecorationHandle;
  editor: AgentDecoratedEditor;
}

const NOOP_EDITOR: AgentDecoratedEditor = {
  document: { uri: { fsPath: '', scheme: '' } },
  setDecorations: () => {},
};

export class AgentDecorationManager {
  private readonly options: AgentDecorationManagerOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(options: AgentDecorationManagerOptions) {
    this.options = options;
  }

  showAgentActive(
    participantId: string,
    color: string,
    _displayName: string,
    path: string,
    ranges: readonly DecorationRange[],
  ): void {
    let entry = this.entries.get(participantId);
    if (entry === undefined) {
      const handle = this.options.decorationTypeFactory.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: color + '99',
        isWholeLine: true,
        overviewRulerColor: color,
        overviewRulerLane: 1,
        rangeBehavior: 1,
      });
      const editor = this.options.getActiveEditorForPath(path) ?? NOOP_EDITOR;
      entry = { handle, editor };
      this.entries.set(participantId, entry);
    } else {
      const editor = this.options.getActiveEditorForPath(path);
      if (editor !== undefined) entry.editor = editor;
    }
    entry.editor.setDecorations(entry.handle, ranges);
  }

  clearParticipant(participantId: string): void {
    const entry = this.entries.get(participantId);
    if (entry === undefined) return;
    entry.editor.setDecorations(entry.handle, []);
    entry.handle.dispose();
    this.entries.delete(participantId);
  }

  clearAll(): void {
    for (const entry of this.entries.values()) {
      entry.editor.setDecorations(entry.handle, []);
      entry.handle.dispose();
    }
    this.entries.clear();
  }
}

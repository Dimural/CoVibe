// packages/extension/tests/ui/agentDecorations.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  AgentDecorationManager,
  type AgentDecorationTypeFactory,
  type AgentDecoratedEditor,
  type AgentDecorationHandle,
  type DecorationRange,
} from '../../src/ui/agentDecorations.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type CreatedEntry = {
  handle: AgentDecorationHandle;
  disposeSpy: ReturnType<typeof vi.fn>;
};

function makeFactory() {
  const created: CreatedEntry[] = [];
  const factory: AgentDecorationTypeFactory = {
    createTextEditorDecorationType(): AgentDecorationHandle {
      const disposeSpy = vi.fn();
      const handle: AgentDecorationHandle = { dispose: disposeSpy };
      created.push({ handle, disposeSpy });
      return handle;
    },
  };
  return { factory, created };
}

function makeEditor(
  path: string,
): AgentDecoratedEditor & { setDecorations: ReturnType<typeof vi.fn> } {
  return {
    document: { uri: { fsPath: path, scheme: 'file' } },
    setDecorations: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentDecorationManager', () => {
  it('applies gutter decoration when agent intent arrives', () => {
    const { factory, created } = makeFactory();
    const editor = makeEditor('/workspace/src/foo.ts');
    const mgr = new AgentDecorationManager({
      decorationTypeFactory: factory,
      getActiveEditorForPath: () => editor,
    });

    mgr.showAgentActive('participant-1', '#ff6b6b', 'Alice', 'src/foo.ts', [
      { start: { line: 5, character: 0 }, end: { line: 10, character: 0 } },
    ]);

    expect(created).toHaveLength(1);
    expect(editor.setDecorations).toHaveBeenCalledOnce();
  });

  it('clears decorations when agent change arrives', () => {
    const { factory } = makeFactory();
    const editor = makeEditor('/workspace/src/foo.ts');
    const mgr = new AgentDecorationManager({
      decorationTypeFactory: factory,
      getActiveEditorForPath: () => editor,
    });

    mgr.showAgentActive('participant-1', '#ff6b6b', 'Alice', 'src/foo.ts', []);
    mgr.clearParticipant('participant-1');

    const calls = editor.setDecorations.mock.calls as [AgentDecorationHandle, DecorationRange[]][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toEqual([]);
  });

  it('reuses the same decoration type across renders for same participant', () => {
    const { factory, created } = makeFactory();
    const editor = makeEditor('/workspace/src/foo.ts');
    const mgr = new AgentDecorationManager({
      decorationTypeFactory: factory,
      getActiveEditorForPath: () => editor,
    });

    mgr.showAgentActive('p1', '#ff6b6b', 'Alice', 'src/foo.ts', []);
    mgr.showAgentActive('p1', '#ff6b6b', 'Alice', 'src/foo.ts', []);

    expect(created).toHaveLength(1);
  });

  it('clearAll disposes all handles', () => {
    const { factory, created } = makeFactory();
    const editor = makeEditor('/workspace/src/foo.ts');
    const mgr = new AgentDecorationManager({
      decorationTypeFactory: factory,
      getActiveEditorForPath: () => editor,
    });

    mgr.showAgentActive('p1', '#ff6b6b', 'Alice', 'src/foo.ts', []);
    mgr.showAgentActive('p2', '#4ecdc4', 'Bob', 'src/foo.ts', []);
    mgr.clearAll();

    expect(created).toHaveLength(2);
    for (const entry of created) {
      expect(entry.disposeSpy).toHaveBeenCalledOnce();
    }
  });
});

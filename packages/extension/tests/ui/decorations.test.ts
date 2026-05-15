import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import {
  DecorationManager,
  type DecorationManagerOptions,
  type DecorationHandle,
  type DecorationRenderOptions,
  type DecoratedEditor,
} from '../../src/ui/decorations.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type CreatedDecoration = {
  options: DecorationRenderOptions;
  handle: DecorationHandle;
  disposeSpy: ReturnType<typeof vi.fn>;
};

function makeFactory() {
  const created: CreatedDecoration[] = [];
  const decorationTypeFactory = {
    createTextEditorDecorationType(options: DecorationRenderOptions): DecorationHandle {
      const disposeSpy = vi.fn();
      const handle: DecorationHandle = { dispose: disposeSpy };
      created.push({ options, handle, disposeSpy });
      return handle;
    },
  };
  return { decorationTypeFactory, created };
}

function makeEditor(
  uri: ReturnType<typeof Uri.file>,
): DecoratedEditor & { setDecorations: ReturnType<typeof vi.fn> } {
  return {
    document: { uri },
    setDecorations: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecorationManager — render', () => {
  it('creates a decoration type on first call and calls setDecorations', () => {
    const { decorationTypeFactory, created } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 3 },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.options.borderColor).toBe('#ff0000');
    expect(created[0]?.options.after?.contentText).toBe(' Alice');
    expect(editor.setDecorations).toHaveBeenCalledOnce();
  });

  it('reuses the same decoration type on subsequent renders for the same participant', () => {
    const { decorationTypeFactory, created } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 3 },
    );
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 1 },
      { line: 0, character: 4 },
    );

    expect(created).toHaveLength(1);
    expect(editor.setDecorations).toHaveBeenCalledTimes(2);
  });

  it('calls setDecorations on the correct editor for the given path', () => {
    const { decorationTypeFactory } = makeFactory();
    const editorA = makeEditor(Uri.file('/ws/a.ts'));
    const editorB = makeEditor(Uri.file('/ws/b.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: (path) => {
        if (path === 'a.ts') return editorA;
        if (path === 'b.ts') return editorB;
        return undefined;
      },
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'b.ts',
      { line: 0, character: 0 },
      { line: 0, character: 1 },
    );

    expect(editorA.setDecorations).not.toHaveBeenCalled();
    expect(editorB.setDecorations).toHaveBeenCalledOnce();
  });

  it('places the decoration range at headPos (zero-width)', () => {
    const { decorationTypeFactory } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    const headPos = { line: 3, character: 7 };
    dm.render('alice', '#ff0000', 'Alice', 'file.ts', { line: 0, character: 0 }, headPos);

    type RangeArg = {
      start: { line: number; character: number };
      end: { line: number; character: number };
    }[];
    const [, ranges] = editor.setDecorations.mock.calls[0] as [unknown, RangeArg];
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toEqual(headPos);
    expect(ranges[0]?.end).toEqual(headPos);
  });

  it('does not throw when no editor is found for the path', () => {
    const { decorationTypeFactory, created } = makeFactory();
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => undefined,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    expect(() =>
      dm.render(
        'alice',
        '#ff0000',
        'Alice',
        'missing.ts',
        { line: 0, character: 0 },
        { line: 0, character: 0 },
      ),
    ).not.toThrow();
    expect(created).toHaveLength(1);
  });
});

describe('DecorationManager — clear', () => {
  it('disposes the decoration type for the participant', () => {
    const { decorationTypeFactory, created } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 1 },
    );
    expect(dm.has('alice')).toBe(true);

    const handle = created[0]?.handle;
    const setDecorationsCallsBefore = editor.setDecorations.mock.calls.length;

    dm.clear('alice');
    expect(dm.has('alice')).toBe(false);
    expect(created[0]?.disposeSpy).toHaveBeenCalledOnce();

    // setDecorations(handle, []) must be called before dispose to clear visual artifacts
    const setDecorationsCallsAfter = editor.setDecorations.mock.calls.length;
    expect(setDecorationsCallsAfter).toBe(setDecorationsCallsBefore + 1);
    const lastCall = editor.setDecorations.mock.calls[setDecorationsCallsAfter - 1] as [
      unknown,
      unknown[],
    ];
    expect(lastCall[0]).toBe(handle);
    expect(lastCall[1]).toEqual([]);

    // Verify setDecorations([], ...) happened before dispose
    const disposeOrder = created[0]?.disposeSpy.mock.invocationCallOrder[0] ?? 0;
    const setDecorationsOrder =
      editor.setDecorations.mock.invocationCallOrder[setDecorationsCallsAfter - 1] ?? 0;
    expect(setDecorationsOrder).toBeLessThan(disposeOrder);
  });

  it('is a no-op for an unknown participant', () => {
    const { decorationTypeFactory } = makeFactory();
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => undefined,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    expect(() => dm.clear('nobody')).not.toThrow();
  });
});

describe('DecorationManager — clearAll', () => {
  it('disposes all decoration types', () => {
    const { decorationTypeFactory, created } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 1 },
    );
    dm.render(
      'bob',
      '#00ff00',
      'Bob',
      'file.ts',
      { line: 1, character: 0 },
      { line: 1, character: 2 },
    );

    const setDecorationsCallsBefore = editor.setDecorations.mock.calls.length;

    dm.clearAll();
    expect(dm.has('alice')).toBe(false);
    expect(dm.has('bob')).toBe(false);
    for (const entry of created) {
      expect(entry.disposeSpy).toHaveBeenCalledOnce();
    }

    // setDecorations(handle, []) must be called for each participant before dispose
    const clearCalls = editor.setDecorations.mock.calls.slice(setDecorationsCallsBefore) as [
      DecorationHandle,
      unknown[],
    ][];
    expect(clearCalls).toHaveLength(2);
    for (const [handle, ranges] of clearCalls) {
      const matchedEntry = created.find((e) => e.handle === handle);
      expect(matchedEntry).toBeDefined();
      expect(ranges).toEqual([]);
      // Verify setDecorations([]) was called before the corresponding dispose
      const disposeOrder = matchedEntry!.disposeSpy.mock.invocationCallOrder[0] ?? 0;
      const clearOrder =
        editor.setDecorations.mock.invocationCallOrder[
          editor.setDecorations.mock.calls.indexOf(
            editor.setDecorations.mock.calls.find(
              (c) => c[0] === handle && (c[1] as unknown[]).length === 0,
            )!,
          )
        ] ?? 0;
      expect(clearOrder).toBeLessThan(disposeOrder);
    }
  });
});

describe('DecorationManager — has()', () => {
  it('returns false before render and true after render', () => {
    const { decorationTypeFactory } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    expect(dm.has('alice')).toBe(false);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 1 },
    );
    expect(dm.has('alice')).toBe(true);
  });

  it('returns false after clear()', () => {
    const { decorationTypeFactory } = makeFactory();
    const editor = makeEditor(Uri.file('/ws/file.ts'));
    const opts: DecorationManagerOptions = {
      getActiveEditorForPath: () => editor,
      decorationTypeFactory,
    };

    const dm = new DecorationManager(opts);
    dm.render(
      'alice',
      '#ff0000',
      'Alice',
      'file.ts',
      { line: 0, character: 0 },
      { line: 0, character: 1 },
    );
    dm.clear('alice');
    expect(dm.has('alice')).toBe(false);
  });
});

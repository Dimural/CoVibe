import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import { type TextOp } from '@covibes/protocol/ot';
import {
  CursorSync,
  type CursorSyncOptions,
  type SelectionChangeEvent,
} from '../../src/sync/cursors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDoc(uri: ReturnType<typeof Uri.file>, text: string) {
  return {
    uri,
    getText: () => text,
    offsetAt(pos: { line: number; character: number }): number {
      return pos.character;
    },
    positionAt(offset: number) {
      return { line: 0, character: offset };
    },
  };
}

type TimerFn = () => void;

interface TimerHandle {
  id: number;
  fn: TimerFn;
  ms: number;
}

function makeTimerHarness() {
  let nextId = 1;
  const pending = new Map<number, TimerHandle>();

  const scheduleTimer = vi.fn((fn: TimerFn, ms: number): unknown => {
    const id = nextId++;
    pending.set(id, { id, fn, ms });
    return id;
  });

  const cancelTimer = vi.fn((handle: unknown): void => {
    pending.delete(handle as number);
  });

  const flushAll = (): void => {
    const timers = [...pending.values()];
    pending.clear();
    for (const t of timers) t.fn();
  };

  const pendingCount = (): number => pending.size;

  return { scheduleTimer, cancelTimer, flushAll, pendingCount };
}

function makeSelectionEvent(
  uri: ReturnType<typeof Uri.file>,
  text: string,
  anchorChar: number,
  activeChar: number,
): SelectionChangeEvent {
  const doc = makeDoc(uri, text);
  const sel = {
    anchor: { line: 0, character: anchorChar },
    active: { line: 0, character: activeChar },
  };
  return {
    textEditor: { document: doc, selections: [sel] },
    selections: [sel],
  };
}

function noopSource(): { dispose(): void } {
  return { dispose: () => {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CursorSync — start() sends cursor.update on selection change', () => {
  it('sends correct codepoint offsets for ASCII text after timer fires', () => {
    const timers = makeTimerHarness();
    const sendCursorUpdate = vi.fn();

    let capturedListener: ((e: SelectionChangeEvent) => void) | undefined;
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: (listener) => {
        capturedListener = listener;
        return { dispose: () => undefined };
      },
      uriToPath: (uri) => (uri.scheme === 'file' ? 'hello.ts' : undefined),
      sendCursorUpdate,
      applyDecoration: vi.fn(),
      clearDecoration: vi.fn(),
      throttleMs: 50,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.start();

    const evt = makeSelectionEvent(Uri.file('/ws/hello.ts'), 'hello world', 2, 5);
    capturedListener!(evt);

    expect(sendCursorUpdate).not.toHaveBeenCalled();
    timers.flushAll();
    expect(sendCursorUpdate).toHaveBeenCalledOnce();
    expect(sendCursorUpdate).toHaveBeenCalledWith('hello.ts', 2, 5);
  });
});

describe('CursorSync — throttling', () => {
  it('two rapid changes produce exactly one sendCursorUpdate when the timer fires', () => {
    const timers = makeTimerHarness();
    const sendCursorUpdate = vi.fn();

    let capturedListener: ((e: SelectionChangeEvent) => void) | undefined;
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: (listener) => {
        capturedListener = listener;
        return { dispose: () => undefined };
      },
      uriToPath: () => 'file.ts',
      sendCursorUpdate,
      applyDecoration: vi.fn(),
      clearDecoration: vi.fn(),
      throttleMs: 50,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.start();

    const evt1 = makeSelectionEvent(Uri.file('/ws/file.ts'), 'hello', 1, 1);
    const evt2 = makeSelectionEvent(Uri.file('/ws/file.ts'), 'hello', 2, 2);

    capturedListener!(evt1);
    expect(timers.pendingCount()).toBe(1);
    expect(timers.cancelTimer).not.toHaveBeenCalled();

    capturedListener!(evt2);
    expect(timers.cancelTimer).toHaveBeenCalledOnce();
    expect(timers.pendingCount()).toBe(1);

    timers.flushAll();
    expect(sendCursorUpdate).toHaveBeenCalledOnce();
    expect(sendCursorUpdate).toHaveBeenCalledWith('file.ts', 2, 2);
  });
});

describe('CursorSync — emoji offset conversion', () => {
  it('converts emoji document positions to codepoint offsets correctly', () => {
    // "a😀b" — UTF-16 length 4; codepoints: a=0, 😀=1, b=2
    const text = 'a\u{1F600}b';
    const timers = makeTimerHarness();
    const sendCursorUpdate = vi.fn();

    let capturedListener: ((e: SelectionChangeEvent) => void) | undefined;
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: (listener) => {
        capturedListener = listener;
        return { dispose: () => undefined };
      },
      uriToPath: () => 'emoji.ts',
      sendCursorUpdate,
      applyDecoration: vi.fn(),
      clearDecoration: vi.fn(),
      throttleMs: 50,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.start();

    // anchor at UTF-16 offset 0 (cp 0), active at UTF-16 offset 3 (cp 2 = "b")
    const doc = {
      uri: Uri.file('/ws/emoji.ts'),
      getText: () => text,
      offsetAt(pos: { line: number; character: number }): number {
        return pos.character;
      },
      positionAt(offset: number) {
        return { line: 0, character: offset };
      },
    };
    const sel = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 3 } };
    const evt: SelectionChangeEvent = {
      textEditor: { document: doc, selections: [sel] },
      selections: [sel],
    };

    capturedListener!(evt);
    timers.flushAll();

    expect(sendCursorUpdate).toHaveBeenCalledWith('emoji.ts', 0, 2);
  });
});

describe('CursorSync — onRemoteCursor', () => {
  it('stores position and calls applyDecoration', () => {
    const timers = makeTimerHarness();
    const applyDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration,
      clearDecoration: vi.fn(),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.onRemoteCursor('alice', { path: 'src/foo.ts', anchor: 5, head: 10 });

    expect(applyDecoration).toHaveBeenCalledOnce();
    expect(applyDecoration).toHaveBeenCalledWith('alice', 'src/foo.ts', 5, 10);
  });
});

describe('CursorSync — onRemoteCursor clears old decoration when path changes', () => {
  it('calls clearDecoration for old file and applyDecoration for new file when participant switches files', () => {
    const timers = makeTimerHarness();
    const applyDecoration = vi.fn();
    const clearDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration,
      clearDecoration,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);

    // First update: participant on file A
    sync.onRemoteCursor('alice', { path: 'src/a.ts', anchor: 0, head: 5 });
    expect(clearDecoration).not.toHaveBeenCalled();
    expect(applyDecoration).toHaveBeenCalledOnce();
    expect(applyDecoration).toHaveBeenCalledWith('alice', 'src/a.ts', 0, 5);

    applyDecoration.mockClear();

    // Second update: participant moves to file B
    sync.onRemoteCursor('alice', { path: 'src/b.ts', anchor: 1, head: 3 });
    expect(clearDecoration).toHaveBeenCalledOnce();
    expect(clearDecoration).toHaveBeenCalledWith('alice');
    expect(applyDecoration).toHaveBeenCalledOnce();
    expect(applyDecoration).toHaveBeenCalledWith('alice', 'src/b.ts', 1, 3);
  });

  it('does not call clearDecoration when path is unchanged', () => {
    const timers = makeTimerHarness();
    const clearDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration: vi.fn(),
      clearDecoration,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);

    sync.onRemoteCursor('alice', { path: 'src/a.ts', anchor: 0, head: 5 });
    sync.onRemoteCursor('alice', { path: 'src/a.ts', anchor: 2, head: 7 });

    expect(clearDecoration).not.toHaveBeenCalled();
  });
});

describe('CursorSync — onOtOp transforms cursor positions', () => {
  it('shifts cursors right after an insert at the beginning', () => {
    const timers = makeTimerHarness();
    const applyDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration,
      clearDecoration: vi.fn(),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.onRemoteCursor('alice', { path: 'hello.ts', anchor: 2, head: 2 });
    applyDecoration.mockClear();

    // Insert "abc" at position 0; "hello" (5 chars) follows: op = ["abc", 5]
    const op: TextOp = ['abc', 5];
    sync.onOtOp('hello.ts', op);

    // Position 2 shifts to 5 (2 + 3 inserted chars).
    expect(applyDecoration).toHaveBeenCalledOnce();
    expect(applyDecoration).toHaveBeenCalledWith('alice', 'hello.ts', 5, 5);
  });

  it('does not process cursors for a different path', () => {
    const timers = makeTimerHarness();
    const applyDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration,
      clearDecoration: vi.fn(),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.onRemoteCursor('bob', { path: 'other.ts', anchor: 1, head: 1 });
    applyDecoration.mockClear();

    const op: TextOp = ['abc', 5];
    sync.onOtOp('hello.ts', op);

    expect(applyDecoration).not.toHaveBeenCalled();
  });
});

describe('CursorSync — onParticipantLeft', () => {
  it('clears decoration, removes from state, and subsequent onOtOp ignores participant', () => {
    const timers = makeTimerHarness();
    const applyDecoration = vi.fn();
    const clearDecoration = vi.fn();
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: noopSource,
      uriToPath: () => undefined,
      sendCursorUpdate: vi.fn(),
      applyDecoration,
      clearDecoration,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.onRemoteCursor('alice', { path: 'file.ts', anchor: 3, head: 3 });
    applyDecoration.mockClear();

    sync.onParticipantLeft('alice');
    expect(clearDecoration).toHaveBeenCalledWith('alice');

    const op: TextOp = ['X', 5];
    sync.onOtOp('file.ts', op);
    expect(applyDecoration).not.toHaveBeenCalled();
  });
});

describe('CursorSync — dispose', () => {
  it('cancels pending timer and clears all decorations', () => {
    const timers = makeTimerHarness();
    const sendCursorUpdate = vi.fn();
    const clearDecoration = vi.fn();

    let capturedListener: ((e: SelectionChangeEvent) => void) | undefined;
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: (listener) => {
        capturedListener = listener;
        return { dispose: () => undefined };
      },
      uriToPath: () => 'file.ts',
      sendCursorUpdate,
      applyDecoration: vi.fn(),
      clearDecoration,
      throttleMs: 50,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.start();
    sync.onRemoteCursor('bob', { path: 'file.ts', anchor: 0, head: 0 });

    const evt = makeSelectionEvent(Uri.file('/ws/file.ts'), 'hello', 0, 1);
    capturedListener!(evt);
    expect(timers.pendingCount()).toBe(1);

    sync.dispose();

    expect(timers.cancelTimer).toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(0);
    expect(clearDecoration).toHaveBeenCalledWith('bob');

    timers.flushAll();
    expect(sendCursorUpdate).not.toHaveBeenCalled();
  });
});

describe('CursorSync — skips non-file URIs', () => {
  it('does not send update for non-file scheme', () => {
    const timers = makeTimerHarness();
    const sendCursorUpdate = vi.fn();

    let capturedListener: ((e: SelectionChangeEvent) => void) | undefined;
    const opts: CursorSyncOptions = {
      onDidChangeTextEditorSelection: (listener) => {
        capturedListener = listener;
        return { dispose: () => undefined };
      },
      uriToPath: () => 'output.ts',
      sendCursorUpdate,
      applyDecoration: vi.fn(),
      clearDecoration: vi.fn(),
      throttleMs: 50,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    };

    const sync = new CursorSync(opts);
    sync.start();

    const nonFileUri = {
      ...Uri.file('/ws/out.ts'),
      scheme: 'output',
    } as ReturnType<typeof Uri.file>;
    const doc = makeDoc(nonFileUri, 'hello');
    const sel = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 1 } };
    const evt: SelectionChangeEvent = {
      textEditor: { document: doc, selections: [sel] },
      selections: [sel],
    };

    capturedListener!(evt);
    timers.flushAll();
    expect(sendCursorUpdate).not.toHaveBeenCalled();
  });
});

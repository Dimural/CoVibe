/**
 * Tests for applyRemoteOp — converts an OT op (codepoint offsets) into a VS
 * Code WorkspaceEdit (UTF-16 offsets) and applies it, while preventing
 * EditCapture from echoing the change back.
 *
 * All dependencies are injected as plain-object fakes — no real extension host
 * or VS Code runtime required.
 */

import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import type { TextOp } from '@covibes/protocol/ot';
import { SyncedDocument } from '../../src/sync/document.js';
import {
  applyRemoteOp,
  type ApplyDocument,
  type ApplyRemoteDeps,
  type DocPosition,
  type EditBuilder,
} from '../../src/sync/applyRemote.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a fake ApplyDocument that correctly maps UTF-16 offsets to positions. */
function makeDoc(text: string, uriStr: string) {
  const uri = Uri.file(uriStr);
  return {
    doc: {
      uri,
      getText: () => text,
      positionAt: (offset: number): DocPosition => {
        const before = text.slice(0, offset);
        const line = (before.match(/\n/g) ?? []).length;
        const lastNl = before.lastIndexOf('\n');
        const character = lastNl === -1 ? offset : offset - lastNl - 1;
        return { line, character };
      },
    } satisfies ApplyDocument,
    uri,
  };
}

/** Captured replace call arguments. */
interface ReplaceCall {
  newText: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** Build a fake EditBuilder that records replace calls. */
function makeEditBuilder(): { builder: EditBuilder; calls: ReplaceCall[] } {
  const calls: ReplaceCall[] = [];
  const builder: EditBuilder = {
    replace(_uri, range, newText) {
      calls.push({
        newText,
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
      });
    },
  };
  return { builder, calls };
}

/**
 * Build a minimal set of deps for a successful apply.
 * Override individual properties in tests that need different behaviour.
 */
function makeDeps(
  applyDoc: ApplyDocument | undefined,
  editBuilder: EditBuilder,
  applyResult = true,
): {
  deps: ApplyRemoteDeps;
  markApplyingRemoteMock: ReturnType<typeof vi.fn>;
  onResyncNeededMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
  applyEditMock: ReturnType<typeof vi.fn>;
} {
  const markApplyingRemoteMock = vi.fn();
  const onResyncNeededMock = vi.fn();
  const warnMock = vi.fn();
  const applyEditMock = vi.fn().mockResolvedValue(applyResult);

  const deps: ApplyRemoteDeps = {
    getDocument: () => applyDoc,
    createEdit: () => editBuilder,
    applyEdit: applyEditMock,
    markApplyingRemote: markApplyingRemoteMock,
    onResyncNeeded: onResyncNeededMock,
    logger: {
      warn: warnMock,
      error: vi.fn(),
    },
  };

  return { deps, markApplyingRemoteMock, onResyncNeededMock, warnMock, applyEditMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyRemoteOp', () => {
  // -------------------------------------------------------------------------
  // 1. Pure insert at start
  // -------------------------------------------------------------------------
  it('pure insert at start: op = ["X"] emits replace at (0,0)→(0,0) with "X"', async () => {
    const { doc, uri } = makeDoc('', '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: '' });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    const op: TextOp = ['X'];
    await applyRemoteOp('/file.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 0,
      endLine: 0,
      endChar: 0,
      newText: 'X',
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pure insert at end
  // -------------------------------------------------------------------------
  it('pure insert at end: op = [5, "X"] on "hello" emits replace at (0,5)→(0,5)', async () => {
    const text = 'hello';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    const op: TextOp = [5, 'X'];
    await applyRemoteOp('/file.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 5,
      endLine: 0,
      endChar: 5,
      newText: 'X',
    });
  });

  // -------------------------------------------------------------------------
  // 3. Pure delete
  // -------------------------------------------------------------------------
  it('pure delete: op = [{ d: 3 }] on "hello" emits replace at (0,0)→(0,3) with ""', async () => {
    const text = 'hello';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    const op: TextOp = [{ d: 3 }];
    await applyRemoteOp('/file.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 0,
      endLine: 0,
      endChar: 3,
      newText: '',
    });
  });

  // -------------------------------------------------------------------------
  // 4. Mixed: skip + delete + insert
  // -------------------------------------------------------------------------
  it('mixed op: skip 6, delete 5, insert "there" on "hello world"', async () => {
    const text = 'hello world';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    // skip 6 ("hello "), delete 5 ("world"), insert "there"
    const op: TextOp = [6, { d: 5 }, 'there'];
    await applyRemoteOp('/file.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(2);
    // delete "world" at (0,6)→(0,11)
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 6,
      endLine: 0,
      endChar: 11,
      newText: '',
    });
    // insert "there" at (0,11)→(0,11)
    expect(calls[1]).toMatchObject({
      startLine: 0,
      startChar: 11,
      endLine: 0,
      endChar: 11,
      newText: 'there',
    });
  });

  // -------------------------------------------------------------------------
  // 5. Emoji surrogate pair
  // -------------------------------------------------------------------------
  it('emoji: skip 😀 (1 codepoint = 2 UTF-16 units), delete "X" → range (0,2)→(0,3)', async () => {
    // 😀 is U+1F600, encoded as a surrogate pair: 2 UTF-16 code units
    const text = '😀X';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    // skip 1 codepoint (the emoji), delete 1 codepoint ('X')
    const op: TextOp = [1, { d: 1 }];
    await applyRemoteOp('/file.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(1);
    // delete 'X' — starts at UTF-16 offset 2 (after the 2-unit emoji), ends at 3
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 2,
      endLine: 0,
      endChar: 3,
      newText: '',
    });
  });

  // -------------------------------------------------------------------------
  // 6. Document not open
  // -------------------------------------------------------------------------
  it('returns early without throwing when the document is not open', async () => {
    const uri = Uri.file('/ws/closed.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: 'hello' });
    const { builder } = makeEditBuilder();
    const { deps, markApplyingRemoteMock, applyEditMock } = makeDeps(undefined, builder);

    await expect(applyRemoteOp('/closed.ts', syncedDoc, ['X'], deps)).resolves.toBeUndefined();
    expect(markApplyingRemoteMock).not.toHaveBeenCalled();
    expect(applyEditMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. applyEdit returns false → onResyncNeeded + logger.warn
  // -------------------------------------------------------------------------
  it('calls onResyncNeeded and logger.warn when applyEdit returns false', async () => {
    const text = 'hello';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDocWithUri = new SyncedDocument({ uri, baseText: text });
    syncedDocWithUri.setVersion(7);
    const { builder } = makeEditBuilder();
    const { deps, onResyncNeededMock, warnMock } = makeDeps(doc, builder, false);

    await applyRemoteOp('src/file.ts', syncedDocWithUri, [1, { d: 1 }], deps);

    expect(onResyncNeededMock).toHaveBeenCalledOnce();
    expect(onResyncNeededMock).toHaveBeenCalledWith('src/file.ts', 7);
    expect(warnMock).toHaveBeenCalledOnce();
    // Verify the warn context contains required fields (no document content)
    const warnArgs = warnMock.mock.calls[0] as [Record<string, unknown>, string];
    const ctx = warnArgs[0];
    expect(ctx).toHaveProperty('path', 'src/file.ts');
    expect(ctx).toHaveProperty('version', 7);
    expect(ctx).toHaveProperty('uri');
  });

  // -------------------------------------------------------------------------
  // 8. markApplyingRemote called BEFORE applyEdit
  // -------------------------------------------------------------------------
  it('calls markApplyingRemote before applyEdit', async () => {
    const text = 'hello';
    const { doc, uri } = makeDoc(text, '/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder } = makeEditBuilder();

    const callOrder: string[] = [];
    const deps: ApplyRemoteDeps = {
      getDocument: () => doc,
      createEdit: () => builder,
      markApplyingRemote: vi.fn(() => {
        callOrder.push('markApplyingRemote');
      }),
      applyEdit: () => {
        callOrder.push('applyEdit');
        return Promise.resolve(true);
      },
      onResyncNeeded: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
    };

    await applyRemoteOp('/file.ts', syncedDoc, ['X'], deps);

    expect(callOrder).toEqual(['markApplyingRemote', 'applyEdit']);
  });

  // -------------------------------------------------------------------------
  // 9. Multi-line document
  // -------------------------------------------------------------------------
  it('multi-line: correctly maps codepoint offsets to (line, character) positions', async () => {
    // "line1\nline2\nline3" — 18 codepoints
    // line1 = chars 0..4, \n at 5
    // line2 = chars 6..10, \n at 11
    // line3 = chars 12..16
    const text = 'line1\nline2\nline3';
    const { doc, uri } = makeDoc(text, '/ws/multi.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    const { builder, calls } = makeEditBuilder();
    const { deps } = makeDeps(doc, builder);

    // skip 6 (past "line1\n"), delete 5 ("line2"), insert "NEW"
    const op: TextOp = [6, { d: 5 }, 'NEW'];
    await applyRemoteOp('/multi.ts', syncedDoc, op, deps);

    expect(calls).toHaveLength(2);
    // delete "line2" — starts at line 1, char 0; ends at line 1, char 5
    expect(calls[0]).toMatchObject({
      startLine: 1,
      startChar: 0,
      endLine: 1,
      endChar: 5,
      newText: '',
    });
    // insert "NEW" at line 1, char 5 (cpPos stays at 11 after delete)
    expect(calls[1]).toMatchObject({
      startLine: 1,
      startChar: 5,
      endLine: 1,
      endChar: 5,
      newText: 'NEW',
    });
  });
});

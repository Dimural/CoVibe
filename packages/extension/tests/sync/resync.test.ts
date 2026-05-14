/**
 * Tests for applySnapshot — applies a full-document snapshot to the VS Code
 * editor, resetting the SyncedDocument state and replacing the full document text.
 */

import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import type { DocSnapshotPayload } from '@covibes/protocol';
import { SyncedDocument } from '../../src/sync/document.js';
import {
  applySnapshot,
  type ResyncDeps,
  type ResyncDocument,
  type ResyncEditBuilder,
} from '../../src/sync/resync.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface ReplaceCall {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  newText: string;
}

function makeEditBuilder(): { builder: ResyncEditBuilder; calls: ReplaceCall[] } {
  const calls: ReplaceCall[] = [];
  const builder: ResyncEditBuilder = {
    replace(_uri, range, newText) {
      calls.push({
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
        newText,
      });
    },
  };
  return { builder, calls };
}

/**
 * Build a fake ResyncDocument.
 * `lineCount` and `lineAt` are wired to produce realistic line/char data from `text`.
 */
function makeResyncDoc(text: string, uriStr: string): ResyncDocument {
  const uri = Uri.file(uriStr);
  const lines = text.split('\n');
  return {
    uri,
    getText: () => text,
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const line = (before.match(/\n/g) ?? []).length;
      const lastNl = before.lastIndexOf('\n');
      const character = lastNl === -1 ? offset : offset - lastNl - 1;
      return { line, character };
    },
    get lineCount() {
      return lines.length;
    },
    lineAt(line: number) {
      const lineText = lines[line] ?? '';
      return { range: { end: { line, character: lineText.length } } };
    },
  };
}

function makeDeps(
  resyncDoc: ResyncDocument | undefined,
  editBuilder: ResyncEditBuilder,
  applyResult = true,
): {
  deps: ResyncDeps;
  markApplyingRemoteMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
  applyEditMock: ReturnType<typeof vi.fn>;
} {
  const markApplyingRemoteMock = vi.fn();
  const warnMock = vi.fn();
  const applyEditMock = vi.fn().mockResolvedValue(applyResult);

  const deps: ResyncDeps = {
    getDocument: () => resyncDoc,
    createEdit: () => editBuilder,
    applyEdit: applyEditMock,
    markApplyingRemote: markApplyingRemoteMock,
    logger: { warn: warnMock },
  };

  return { deps, markApplyingRemoteMock, warnMock, applyEditMock };
}

function makePayload(path: string, serverVersion: number, text: string): DocSnapshotPayload {
  return { path, serverVersion, text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applySnapshot', () => {
  // -------------------------------------------------------------------------
  // 1. Stale snapshot — serverVersion < syncedDoc.version
  // -------------------------------------------------------------------------
  it('stale snapshot: returns without calling applyEdit, calls logger.warn', async () => {
    const uri = Uri.file('/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: 'old text' });
    syncedDoc.setVersion(10);

    const { builder } = makeEditBuilder();
    const resyncDoc = makeResyncDoc('old text', '/ws/file.ts');
    const { deps, warnMock, applyEditMock } = makeDeps(resyncDoc, builder);

    const payload = makePayload('file.ts', 5, 'new text');
    await applySnapshot(syncedDoc, payload, deps);

    expect(applyEditMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledOnce();
    const warnArgs = warnMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnArgs[0]).toHaveProperty('snapshotVersion', 5);
    expect(warnArgs[0]).toHaveProperty('currentVersion', 10);
    // syncedDoc state must not have changed
    expect(syncedDoc.version).toBe(10);
    expect(syncedDoc.baseText).toBe('old text');
  });

  // -------------------------------------------------------------------------
  // 2. Document not open — getDocument returns undefined
  // -------------------------------------------------------------------------
  it('document not open: returns early, no edit applied', async () => {
    const uri = Uri.file('/ws/closed.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: '' });

    const { builder } = makeEditBuilder();
    const { deps, applyEditMock, markApplyingRemoteMock } = makeDeps(undefined, builder);

    const payload = makePayload('closed.ts', 0, 'new text');
    await expect(applySnapshot(syncedDoc, payload, deps)).resolves.toBeUndefined();

    expect(applyEditMock).not.toHaveBeenCalled();
    expect(markApplyingRemoteMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Successful apply — full document replace
  // -------------------------------------------------------------------------
  it('successful apply: syncedDoc.reset called, markApplyingRemote before applyEdit, correct range', async () => {
    const originalText = 'hello\nworld';
    const newText = 'replaced content';
    const uri = Uri.file('/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: originalText });
    syncedDoc.setVersion(3);

    const resyncDoc = makeResyncDoc(originalText, '/ws/file.ts');
    const { builder, calls } = makeEditBuilder();

    const callOrder: string[] = [];
    const { deps } = makeDeps(resyncDoc, builder);
    const orderedDeps: ResyncDeps = {
      ...deps,
      markApplyingRemote: vi.fn(() => {
        callOrder.push('markApplyingRemote');
      }),
      applyEdit: vi.fn(() => {
        callOrder.push('applyEdit');
        return Promise.resolve(true);
      }),
    };

    const payload = makePayload('file.ts', 7, newText);
    await applySnapshot(syncedDoc, payload, orderedDeps);

    // syncedDoc.reset must have been called
    expect(syncedDoc.baseText).toBe(newText);
    expect(syncedDoc.version).toBe(7);

    // markApplyingRemote must be called before applyEdit
    expect(callOrder).toEqual(['markApplyingRemote', 'applyEdit']);

    // edit.replace must cover the full original document
    expect(calls).toHaveLength(1);
    // "hello\nworld" — 2 lines; last line "world" has 5 chars
    expect(calls[0]).toMatchObject({
      startLine: 0,
      startChar: 0,
      endLine: 1,
      endChar: 5,
      newText,
    });
  });

  // -------------------------------------------------------------------------
  // 4. applyEdit returns false → logger.warn is called
  // -------------------------------------------------------------------------
  it('applyEdit returns false: logger.warn is called', async () => {
    const text = 'some content';
    const uri = Uri.file('/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });

    const resyncDoc = makeResyncDoc(text, '/ws/file.ts');
    const { builder } = makeEditBuilder();
    const { deps, warnMock } = makeDeps(resyncDoc, builder, false);

    const payload = makePayload('file.ts', 1, 'new content');
    await applySnapshot(syncedDoc, payload, deps);

    expect(warnMock).toHaveBeenCalledOnce();
    const warnArgs = warnMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnArgs[0]).toHaveProperty('uri');
    expect(typeof warnArgs[1]).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 5. Equal version snapshot (serverVersion === syncedDoc.version) is accepted
  // -------------------------------------------------------------------------
  it('snapshot at current version (equal) is accepted — not treated as stale', async () => {
    const text = 'current';
    const uri = Uri.file('/ws/file.ts');
    const syncedDoc = new SyncedDocument({ uri, baseText: text });
    syncedDoc.setVersion(5);

    const resyncDoc = makeResyncDoc(text, '/ws/file.ts');
    const { builder } = makeEditBuilder();
    const { deps, applyEditMock, warnMock } = makeDeps(resyncDoc, builder);

    const payload = makePayload('file.ts', 5, 'updated');
    await applySnapshot(syncedDoc, payload, deps);

    expect(applyEditMock).toHaveBeenCalledOnce();
    expect(warnMock).not.toHaveBeenCalled();
    expect(syncedDoc.version).toBe(5);
    expect(syncedDoc.baseText).toBe('updated');
  });
});

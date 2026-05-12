/**
 * Tests for EditCapture — VS Code TextDocument change events -> OT ops.
 *
 * EditCapture is exercised through dependency injection rather than reaching
 * into `vscode.workspace` so tests can fire synthetic events without an
 * extension host. The hard correctness invariant (Step 3 of Task 4.2) is
 * always-on: every captured op must reproduce the post-edit document text
 * when applied to baseText. If a test ever yields an op that violates it,
 * `EditCapture` throws — so an absence of throws + matching invocations is
 * a stronger signal than just "callback fired".
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, TextDocumentChangeReason, Uri } from 'vscode';
import * as fc from 'fast-check';
import { applyOp, type TextOp } from '@covibes/protocol/ot';
import type { SyncedDocument } from '../../src/sync/document.js';
import { DocumentRepository } from '../../src/sync/repo.js';
import {
  EditCapture,
  EditCaptureInvariantError,
  type CapturedChangeEvent,
  type ChangeDocument,
} from '../../src/sync/editCapture.js';

/** Strongly-typed capture callback to avoid `any` from `vi.fn()`. */
type CaptureCallback = (doc: SyncedDocument, op: TextOp) => void;

// ---------------------------------------------------------------------------
// Test harness — fake VS Code TextDocument and event firing
// ---------------------------------------------------------------------------

interface ContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** Fake doc structurally compatible with EditCapture's ChangeDocument. */
function makeDoc(uri: ReturnType<typeof Uri.file>, text: string): ChangeDocument {
  let current = text;
  return {
    uri,
    getText: () => current,
    /** Test helper — not part of the production interface. */
    _set(t: string) {
      current = t;
    },
  } as ChangeDocument & { _set(t: string): void };
}

/**
 * Apply `changes` to `pre` in descending-position order (mirrors VS Code's
 * guarantee) to compute the post-edit text.
 */
function applyContentChanges(pre: string, changes: ContentChange[]): string {
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  let text = pre;
  for (const c of sorted) {
    text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
  }
  return text;
}

interface Harness {
  emitter: EventEmitter<CapturedChangeEvent>;
  repo: DocumentRepository;
  capture: EditCapture;
  onCapture: ReturnType<typeof vi.fn<CaptureCallback>>;
  workspaceRoot: ReturnType<typeof Uri.file>;
  fireEdit(
    doc: ChangeDocument & { _set(t: string): void },
    changes: ContentChange[],
    reason?: number,
  ): string;
}

function makeHarness(): Harness {
  const emitter = new EventEmitter<CapturedChangeEvent>();
  const repo = new DocumentRepository();
  const workspaceRoot = Uri.file('/ws');
  const onCapture = vi.fn<CaptureCallback>();
  const capture = new EditCapture({
    repository: repo,
    eventSource: emitter.event,
    onCapture,
    getWorkspaceFolderUri: (uri) => (uri.fsPath.startsWith('/ws') ? workspaceRoot : undefined),
  });
  capture.start();
  return {
    emitter,
    repo,
    capture,
    onCapture,
    workspaceRoot,
    fireEdit(doc, changes, reason) {
      const pre = doc.getText();
      const post = applyContentChanges(pre, changes);
      doc._set(post);
      const evt: CapturedChangeEvent = {
        document: doc,
        contentChanges: changes,
        ...(reason !== undefined ? { reason } : {}),
      };
      emitter.fire(evt);
      return post;
    },
  };
}

// ---------------------------------------------------------------------------
// Skip cases
// ---------------------------------------------------------------------------

describe('EditCapture — skip cases', () => {
  it('skips events with no content changes (metadata-only)', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello');
    h.repo.getOrCreate('a.ts', doc.uri, 'hello');
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, []);
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it('skips events whose URI scheme is not file (output panels, etc.)', () => {
    const h = makeHarness();
    // Build a non-file URI by hand — the mock Uri.file always sets scheme 'file'.
    const outputUri = { ...Uri.file('/ws/a.ts'), scheme: 'output' } as ReturnType<typeof Uri.file>;
    const doc = makeDoc(outputUri, 'hello');
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
    ]);
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it('skips documents outside the workspace root', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/other/a.ts'), 'hello');
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
    ]);
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it('skips documents not yet registered in the repository (engine owns opening)', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello');
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
    ]);
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it('after markApplyingRemote, the next change event is skipped, then resumes capturing', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello');
    const synced = h.repo.getOrCreate('a.ts', doc.uri, 'hello');
    h.capture.markApplyingRemote(doc);

    // First edit — produced by our own applyRemote, must be skipped.
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
    ]);
    expect(h.onCapture).not.toHaveBeenCalled();

    // Simulate Task 4.3's behaviour: the OT engine advances baseText after
    // applying a remote op. Without this, the next captured edit would fail
    // the invariant check (baseText is stale relative to the document).
    synced.setBaseText(doc.getText());

    // Marker is single-use. The next event is a fresh local edit.
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'Y' },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
  });

  it('captures local undo/redo (only remote-driven undo/redo is suppressed via marker)', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello');
    h.repo.getOrCreate('a.ts', doc.uri, 'hello');
    h.fireEdit(
      doc as ChangeDocument & { _set(t: string): void },
      [{ rangeOffset: 0, rangeLength: 5, text: '' }],
      TextDocumentChangeReason.Undo,
    );
    expect(h.onCapture).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Conversion — single contentChange
// ---------------------------------------------------------------------------

describe('EditCapture — single contentChange', () => {
  it('captures an ASCII insert as [skip, "text"]', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'helloworld');
    h.repo.getOrCreate('a.ts', doc.uri, 'helloworld');
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 5, rangeLength: 0, text: ' ' },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp('helloworld', op)).toBe(post);
    expect(op).toEqual([5, ' ']);
  });

  it('captures an ASCII delete as [skip, { d: n }]', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello world');
    h.repo.getOrCreate('a.ts', doc.uri, 'hello world');
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 5, rangeLength: 6, text: '' },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp('hello world', op)).toBe(post);
    expect(op).toEqual([5, { d: 6 }]);
  });

  it('captures a replace as a single op with delete + insert', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello world');
    h.repo.getOrCreate('a.ts', doc.uri, 'hello world');
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 6, rangeLength: 5, text: 'there' },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp('hello world', op)).toBe(post);
    expect(post).toBe('hello there');
  });

  it('converts emoji insert into codepoint counts (not UTF-16 counts)', () => {
    const h = makeHarness();
    const pre = 'ab';
    const doc = makeDoc(Uri.file('/ws/a.ts'), pre);
    h.repo.getOrCreate('a.ts', doc.uri, pre);
    // Insert a non-BMP emoji at utf16 offset 1 (between 'a' and 'b').
    const emoji = '\u{1F600}'; // utf16 length 2, codepoint length 1
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 1, rangeLength: 0, text: emoji },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp(pre, op)).toBe(post);
    // The skip should be 1 codepoint, not 1 utf16 unit (incidentally the same
    // here for the offset, but contrasted with the next test).
    expect(op).toEqual([1, emoji]);
  });

  it('deletes an emoji as 1 codepoint, not 2 utf16 units', () => {
    const h = makeHarness();
    const pre = 'a\u{1F600}b'; // utf16 length 4, codepoints 3
    const doc = makeDoc(Uri.file('/ws/a.ts'), pre);
    h.repo.getOrCreate('a.ts', doc.uri, pre);
    // Delete the emoji: VS Code reports rangeOffset=1, rangeLength=2 (utf16).
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 1, rangeLength: 2, text: '' },
    ]);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp(pre, op)).toBe(post);
    expect(op).toEqual([1, { d: 1 }]); // 1 codepoint deletion, NOT 2
  });
});

// ---------------------------------------------------------------------------
// Multi-change composition
// ---------------------------------------------------------------------------

describe('EditCapture — multiple contentChanges in one event', () => {
  it('composes multi-cursor non-overlapping edits into a single correct op', () => {
    const h = makeHarness();
    const pre = 'aaa bbb ccc';
    const doc = makeDoc(Uri.file('/ws/a.ts'), pre);
    h.repo.getOrCreate('a.ts', doc.uri, pre);
    // VS Code typically emits multi-cursor edits in descending order.
    const changes: ContentChange[] = [
      { rangeOffset: 8, rangeLength: 3, text: 'CCC' },
      { rangeOffset: 4, rangeLength: 3, text: 'BBB' },
      { rangeOffset: 0, rangeLength: 3, text: 'AAA' },
    ];
    const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, changes);
    expect(h.onCapture).toHaveBeenCalledTimes(1);
    const [, op] = h.onCapture.mock.calls[0]!;
    expect(applyOp(pre, op)).toBe(post);
    expect(post).toBe('AAA BBB CCC');
  });

  it('property: any set of disjoint changes composes into an op that reproduces post-edit text', () => {
    fc.assert(
      fc.property(
        fc.fullUnicodeString({ minLength: 1, maxLength: 40 }),
        fc.array(
          fc.record({
            posFrac: fc.float({ min: 0, max: 1, noNaN: true }),
            delFrac: fc.float({ min: 0, max: 1, noNaN: true }),
            insert: fc.fullUnicodeString({ maxLength: 6 }),
          }),
          { maxLength: 4 },
        ),
        (pre, raw) => {
          // Carve `pre` into segments and place one change per segment, then
          // drop any change whose [start, end) overlaps the next one (after
          // surrogate adjustment two adjacent changes can collapse into the
          // same offset — VS Code never emits that pattern in one event, so
          // we filter it out rather than complicating the SUT).
          const segments = raw.length === 0 ? [] : raw;
          if (segments.length === 0) return;
          const segLen = Math.floor(pre.length / segments.length);
          if (segLen === 0) return;
          const rawChanges: ContentChange[] = [];
          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i]!;
            const segStart = i * segLen;
            const segEnd = i === segments.length - 1 ? pre.length : (i + 1) * segLen;
            const within = segEnd - segStart;
            const posInSeg = Math.floor(seg.posFrac * within);
            let rangeOffset = segStart + posInSeg;
            const maxDel = segEnd - rangeOffset;
            let rangeLength = Math.floor(seg.delFrac * maxDel);
            // Avoid splitting a surrogate pair at the boundaries.
            if (rangeOffset > 0 && rangeOffset < pre.length) {
              const prev = pre.charCodeAt(rangeOffset - 1);
              if (prev >= 0xd800 && prev <= 0xdbff) rangeOffset += 1;
            }
            if (rangeOffset + rangeLength < pre.length && rangeOffset + rangeLength > 0) {
              const end = rangeOffset + rangeLength;
              const prev = pre.charCodeAt(end - 1);
              if (prev >= 0xd800 && prev <= 0xdbff) rangeLength += 1;
            }
            if (rangeOffset + rangeLength > pre.length) {
              rangeLength = pre.length - rangeOffset;
            }
            rawChanges.push({ rangeOffset, rangeLength, text: seg.insert });
          }
          // Drop overlaps & duplicates: keep changes whose start is strictly
          // greater than the previous change's end.
          rawChanges.sort((a, b) => a.rangeOffset - b.rangeOffset);
          const changes: ContentChange[] = [];
          let lastEnd = -1;
          for (const c of rawChanges) {
            if (c.rangeOffset > lastEnd) {
              changes.push(c);
              lastEnd = c.rangeOffset + c.rangeLength;
            }
          }
          if (changes.length === 0) return;
          // VS Code emits descending. We sort to mimic that.
          changes.sort((a, b) => b.rangeOffset - a.rangeOffset);

          const h = makeHarness();
          const doc = makeDoc(Uri.file('/ws/a.ts'), pre);
          h.repo.getOrCreate('a.ts', doc.uri, pre);
          const post = h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, changes);
          // If the changes were all no-ops (no text inserted, no deletion),
          // the captured op normalizes to empty and the callback is skipped.
          // Otherwise, the callback was invoked exactly once and applying the
          // captured op to baseText must reproduce post.
          if (h.onCapture.mock.calls.length === 0) {
            expect(post).toBe(pre);
          } else {
            expect(h.onCapture).toHaveBeenCalledTimes(1);
            const [, op] = h.onCapture.mock.calls[0]!;
            expect(applyOp(pre, op)).toBe(post);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant check
// ---------------------------------------------------------------------------

describe('EditCapture — invariant check', () => {
  it("throws EditCaptureInvariantError when the document's reported post-text disagrees with baseText+changes", () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hello');
    h.repo.getOrCreate('a.ts', doc.uri, 'hello');
    // Construct a malformed event: claim an insert of 'X' at offset 0, but
    // the document's getText() returns something inconsistent.
    (doc as ChangeDocument & { _set(t: string): void })._set('TOTALLY WRONG');
    const evt: CapturedChangeEvent = {
      document: doc,
      contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: 'X' }],
    };
    expect(() => h.emitter.fire(evt)).toThrow(EditCaptureInvariantError);
  });

  it('error message does not leak document content', () => {
    const h = makeHarness();
    const SECRET = 'super-secret-credentials-1234';
    const doc = makeDoc(Uri.file('/ws/a.ts'), SECRET);
    h.repo.getOrCreate('a.ts', doc.uri, SECRET);
    (doc as ChangeDocument & { _set(t: string): void })._set('wrong-' + SECRET);
    const evt: CapturedChangeEvent = {
      document: doc,
      contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: 'X' }],
    };
    try {
      h.emitter.fire(evt);
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET);
    }
  });
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('EditCapture — lifecycle', () => {
  it('start() returns a disposable that unsubscribes', () => {
    const h = makeHarness();
    const doc = makeDoc(Uri.file('/ws/a.ts'), 'hi');
    h.repo.getOrCreate('a.ts', doc.uri, 'hi');
    h.capture.dispose();
    h.fireEdit(doc as ChangeDocument & { _set(t: string): void }, [
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
    ]);
    expect(h.onCapture).not.toHaveBeenCalled();
  });
});

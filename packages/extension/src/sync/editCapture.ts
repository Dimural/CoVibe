/**
 * EditCapture — converts VS Code `TextDocument` change events into OT ops.
 *
 * Responsibility boundary (Task 4.2 only):
 *  1. Subscribe to a VS Code-style change-event source.
 *  2. Filter out events we do not care about (non-file URIs, outside-workspace
 *     paths, metadata-only events, our own remote-applied edits).
 *  3. Convert each event's content changes into a single OT op against the
 *     document's current `baseText`, performing UTF-16 -> codepoint
 *     conversion (the boundary where silent corruption usually happens).
 *  4. Verify, via a hard always-on invariant check, that applying the op to
 *     `baseText` reproduces the document's reported post-edit text. On
 *     mismatch we throw — that signals a conversion bug, not an edge case.
 *  5. Hand the captured op to the configured `onCapture` callback.
 *
 * What this module does NOT do:
 *  - Advance `SyncedDocument.baseText`. Task 4.3 (OT engine) owns that
 *    decision, because base-text mutation has to interlock with ack/transform
 *    flows we have not built yet.
 *  - Append to `pendingOps` directly. Same reason: leaving that to 4.3 lets
 *    the engine compose this captured op with whatever it needs to send.
 *  - Talk to the relay or any session machinery.
 *
 * Dependency injection:
 *  - `eventSource` is the VS Code event (e.g. `workspace.onDidChangeTextDocument`)
 *    passed in by the wiring code. This keeps `vscode.workspace` out of our
 *    import graph, lets tests fire synthetic events, and matches the pattern
 *    used by other modules (RelayClient, SessionManager).
 *  - `getWorkspaceFolderUri` wraps `workspace.getWorkspaceFolder` in production.
 *
 * Remote-edit marker:
 *  - Task 4.5 will apply remote ops via a `WorkspaceEdit`. Before doing so it
 *    calls `markApplyingRemote(doc)`; the very next change event for that
 *    document is then skipped (and the marker is consumed). This module
 *    exposes the marker mechanism so Task 4.5 can plug in without circular
 *    imports.
 *  - The marker is *single-event*. A subsequent user-driven undo/redo of the
 *    remote change is a fresh, locally-originated edit and is captured
 *    normally — the plan's "undo/redo from a remote application" guard means
 *    the apply event itself, not later user actions.
 */

import type * as vscode from 'vscode';
import { applyOp, normalizeOp, type TextOp, type TextOpComponent } from '@covibes/protocol/ot';

import type { SyncedDocument } from './document.js';
import type { DocumentRepository } from './repo.js';
import { toRelativePosixPath } from './repo.js';
import { utf16ToCodepoint } from './offsets.js';

// ---------------------------------------------------------------------------
// Structural types — keeps tests independent of @types/vscode
// ---------------------------------------------------------------------------

/** Minimal VS Code TextDocument surface used by EditCapture. */
export interface ChangeDocument {
  readonly uri: vscode.Uri;
  getText(): string;
}

/** Minimal content-change shape (subset of vscode.TextDocumentContentChangeEvent). */
export interface ChangeContent {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

/** Minimal event shape (subset of vscode.TextDocumentChangeEvent). */
export interface CapturedChangeEvent {
  readonly document: ChangeDocument;
  readonly contentChanges: readonly ChangeContent[];
  readonly reason?: number;
}

/** Subscribe-style event source matching vscode.Event<T>. */
export type EventSource<T> = (listener: (e: T) => void) => { dispose(): void };

/** Disposable shape matching vscode.Disposable. */
export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an op we built does not reproduce the document's post-edit text
 * when applied to `baseText`. This is a programming error — either our offset
 * conversion is wrong, the change set was incoherent, or `baseText` is stale.
 * Either way it must not be swallowed. The message intentionally omits file
 * content (only metadata and lengths) to match the relay's no-content policy.
 */
export class EditCaptureInvariantError extends Error {
  constructor(detail: {
    uri: string;
    baseLength: number;
    expectedLength: number;
    actualLength: number;
    firstDivergenceCodepoint: number;
  }) {
    super(
      `EditCapture invariant violated for ${detail.uri}: ` +
        `baseLength=${detail.baseLength}, ` +
        `expectedLength=${detail.expectedLength}, ` +
        `actualLength=${detail.actualLength}, ` +
        `firstDivergenceCodepoint=${detail.firstDivergenceCodepoint}`,
    );
    this.name = 'EditCaptureInvariantError';
  }
}

// ---------------------------------------------------------------------------
// EditCapture
// ---------------------------------------------------------------------------

export interface EditCaptureOptions {
  /** Index of currently-synced documents. */
  readonly repository: DocumentRepository;
  /**
   * VS Code event source. In production this is
   * `vscode.workspace.onDidChangeTextDocument`.
   */
  readonly eventSource: EventSource<CapturedChangeEvent>;
  /**
   * Callback invoked once per captured op. The OT engine (Task 4.3) is the
   * canonical owner of this callback; until then tests supply their own.
   */
  readonly onCapture: (doc: SyncedDocument, op: TextOp) => void;
  /**
   * Resolve a document URI to its workspace-folder URI. In production wraps
   * `vscode.workspace.getWorkspaceFolder(uri)?.uri`. Returning `undefined`
   * means the document is outside any workspace folder — we skip those.
   */
  readonly getWorkspaceFolderUri: (uri: vscode.Uri) => vscode.Uri | undefined;
}

export class EditCapture {
  private readonly repository: DocumentRepository;
  private readonly eventSource: EventSource<CapturedChangeEvent>;
  private readonly onCapture: (doc: SyncedDocument, op: TextOp) => void;
  private readonly getWorkspaceFolderUri: (uri: vscode.Uri) => vscode.Uri | undefined;
  /** Single-use marker: the next change event for a marked doc is skipped. */
  private readonly applyingRemote = new WeakSet<ChangeDocument>();
  private subscription: Disposable | undefined;

  constructor(options: EditCaptureOptions) {
    this.repository = options.repository;
    this.eventSource = options.eventSource;
    this.onCapture = options.onCapture;
    this.getWorkspaceFolderUri = options.getWorkspaceFolderUri;
  }

  /**
   * Subscribe to the event source. Idempotent: calling twice returns the
   * existing subscription (the second call is a no-op).
   *
   * The returned disposable is also stored internally so `dispose()` works
   * without the caller holding on to it.
   */
  start(): Disposable {
    if (this.subscription !== undefined) return this.subscription;
    this.subscription = this.eventSource((evt) => this.handle(evt));
    return this.subscription;
  }

  /** Unsubscribe from the event source. Safe to call multiple times. */
  dispose(): void {
    if (this.subscription !== undefined) {
      this.subscription.dispose();
      this.subscription = undefined;
    }
  }

  /**
   * Mark `doc` as being mutated by a remote-op application. The very next
   * change event for this document is consumed silently and the marker is
   * cleared. Task 4.5 calls this before invoking `applyEdit`.
   */
  markApplyingRemote(doc: ChangeDocument): void {
    this.applyingRemote.add(doc);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handle(evt: CapturedChangeEvent): void {
    const docUri = evt.document.uri;

    // (1) Filter non-file URIs (output panels, vscode-userdata, ...). We do
    // this before the marker check because a marker is only meaningful for
    // file-backed docs we could possibly own.
    if (docUri.scheme !== 'file') return;

    // (2) Resolve workspace root; skip if outside. Same rationale as (1) —
    // markers on docs outside the workspace are not ours to consume.
    const rootUri = this.getWorkspaceFolderUri(docUri);
    if (rootUri === undefined) return;

    // (3) If this event is the result of our own remote-apply, consume the
    // marker and skip without converting. Marker is single-use.
    //
    // This MUST run before the metadata-only short-circuit and before the
    // repository-registration check: a metadata-only event (e.g. dirty-state
    // change) arriving between `markApplyingRemote` and the actual apply
    // event would otherwise leave the marker uncon­sumed, causing it to
    // swallow the next legitimate user edit.
    if (this.applyingRemote.has(evt.document)) {
      this.applyingRemote.delete(evt.document);
      return;
    }

    // (4) Metadata-only events have no content changes.
    if (evt.contentChanges.length === 0) return;

    let relativePath: string;
    try {
      relativePath = toRelativePosixPath(rootUri, docUri);
    } catch {
      // toRelativePosixPath throws when the file is outside the root —
      // this is a documented skip case, not an error worth surfacing.
      return;
    }

    // (5) Skip docs the engine has not registered. Opening is the engine's
    // job (Task 4.3); we should not silently create entries here because we
    // would not know the right baseText.
    const synced = this.repository.get(relativePath);
    if (synced === undefined) return;

    const baseText = synced.baseText;
    const op = buildOpFromChanges(baseText, evt.contentChanges);
    const normalized = normalizeOp(op);

    // (6) Invariant: applying the op to baseText must equal the reported
    // post-edit text. If not, our conversion is wrong.
    const expected = evt.document.getText();
    const actual = applyOp(baseText, normalized);
    if (actual !== expected) {
      throw new EditCaptureInvariantError({
        uri: docUri.toString(),
        baseLength: baseText.length,
        expectedLength: expected.length,
        actualLength: actual.length,
        firstDivergenceCodepoint: firstDivergenceCodepoint(expected, actual),
      });
    }

    // Empty op (e.g. inserting and deleting the same text in one tick) —
    // nothing meaningful to forward.
    if (normalized.length === 0) return;

    this.onCapture(synced, normalized);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build a single OT op (in codepoint coordinates) from a set of VS Code
 * content changes that all apply to the pre-edit text `baseText`.
 *
 * Strategy:
 *  - Sort changes by ascending utf16 `rangeOffset`. VS Code's documented order
 *    is descending; we re-sort to walk the document left-to-right.
 *  - Walk linearly: emit (skip-to-range-start, delete, insert) for each
 *    change, then implicit-skip the remainder by not emitting a trailing
 *    skip (ot-text-unicode rejects trailing skips).
 *
 * Composing per-change ops with `composeOps` is the alternative; this linear
 * walk produces the same result without going through transform-by-position.
 * Correctness is enforced by the invariant check at the call site.
 */
function buildOpFromChanges(baseText: string, changes: readonly ChangeContent[]): TextOp {
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  const op: TextOpComponent[] = [];
  let cursorCp = 0;

  for (const c of sorted) {
    const startCp = utf16ToCodepoint(baseText, c.rangeOffset);
    const endCp = utf16ToCodepoint(baseText, c.rangeOffset + c.rangeLength);

    const skipFromCursor = startCp - cursorCp;
    if (skipFromCursor > 0) op.push(skipFromCursor);

    const delLen = endCp - startCp;
    if (delLen > 0) op.push({ d: delLen });

    if (c.text.length > 0) op.push(c.text);

    cursorCp = endCp;
  }

  // Do NOT append a trailing skip — ot-text-unicode rejects those, and the
  // remaining codepoints are implicitly skipped.
  return op;
}

/**
 * Return the codepoint index at which `a` and `b` first differ, or the
 * shorter codepoint length if one is a prefix of the other.
 *
 * Used only for error diagnostics. We deliberately do not return the diverging
 * characters themselves to avoid leaking document content into logs.
 */
function firstDivergenceCodepoint(a: string, b: string): number {
  // Iterate codepoints, not utf16 units, so emoji count as 1.
  let i = 0;
  const itA = a[Symbol.iterator]();
  const itB = b[Symbol.iterator]();
  for (;;) {
    const ra = itA.next();
    const rb = itB.next();
    if (ra.done && rb.done) return i;
    if (ra.done || rb.done) return i;
    if (ra.value !== rb.value) return i;
    i++;
  }
}

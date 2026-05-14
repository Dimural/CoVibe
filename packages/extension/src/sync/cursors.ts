import type * as vscode from 'vscode';
import { transformPosition, type TextOp } from '@covibes/protocol/ot';
import { utf16ToCodepoint } from './offsets.js';

// ---------------------------------------------------------------------------
// Structural interfaces
// ---------------------------------------------------------------------------

export interface DocPosition {
  readonly line: number;
  readonly character: number;
}

export interface DocSelection {
  readonly anchor: DocPosition;
  readonly active: DocPosition;
}

export interface CursorDocument {
  readonly uri: vscode.Uri;
  getText(): string;
  positionAt(offset: number): DocPosition;
  offsetAt(pos: DocPosition): number;
}

export interface CursorEditor {
  readonly document: CursorDocument;
  readonly selections: readonly DocSelection[];
}

export type EventSource<T> = (listener: (e: T) => void) => { dispose(): void };

export interface SelectionChangeEvent {
  readonly textEditor: CursorEditor;
  readonly selections: readonly DocSelection[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CursorSyncOptions {
  onDidChangeTextEditorSelection: EventSource<SelectionChangeEvent>;
  uriToPath(uri: vscode.Uri): string | undefined;
  sendCursorUpdate(path: string, anchor: number, head: number): void;
  applyDecoration(participantId: string, path: string, anchor: number, head: number): void;
  clearDecoration(participantId: string): void;
  throttleMs?: number;
  scheduleTimer(fn: () => void, ms: number): unknown;
  cancelTimer(handle: unknown): void;
}

// ---------------------------------------------------------------------------
// CursorSync
// ---------------------------------------------------------------------------

interface StoredCursor {
  path: string;
  anchor: number;
  head: number;
}

export class CursorSync {
  private readonly options: CursorSyncOptions;
  private readonly throttleMs: number;
  private readonly cursors = new Map<string, StoredCursor>();
  private subscription: { dispose(): void } | undefined;
  private pendingTimer: unknown = undefined;
  private pendingPayload: { path: string; anchor: number; head: number } | undefined;

  constructor(options: CursorSyncOptions) {
    this.options = options;
    this.throttleMs = options.throttleMs ?? 50;
  }

  start(): { dispose(): void } {
    if (this.subscription !== undefined) return this.subscription;
    this.subscription = this.options.onDidChangeTextEditorSelection((evt) =>
      this.handleSelectionChange(evt),
    );
    return this.subscription;
  }

  onRemoteCursor(
    participantId: string,
    payload: { path: string; anchor: number; head: number },
  ): void {
    const existing = this.cursors.get(participantId);
    if (existing !== undefined && existing.path !== payload.path) {
      this.options.clearDecoration(participantId);
    }
    this.cursors.set(participantId, { ...payload });
    this.options.applyDecoration(participantId, payload.path, payload.anchor, payload.head);
  }

  onOtOp(path: string, op: TextOp): void {
    for (const [participantId, cursor] of this.cursors) {
      if (cursor.path !== path) continue;
      const newAnchor = transformPosition(cursor.anchor, op);
      const newHead = transformPosition(cursor.head, op);
      cursor.anchor = newAnchor;
      cursor.head = newHead;
      this.options.applyDecoration(participantId, path, newAnchor, newHead);
    }
  }

  onParticipantLeft(participantId: string): void {
    this.options.clearDecoration(participantId);
    this.cursors.delete(participantId);
  }

  dispose(): void {
    if (this.pendingTimer !== undefined) {
      this.options.cancelTimer(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.subscription !== undefined) {
      this.subscription.dispose();
      this.subscription = undefined;
    }
    for (const participantId of this.cursors.keys()) {
      this.options.clearDecoration(participantId);
    }
    this.cursors.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleSelectionChange(evt: SelectionChangeEvent): void {
    const doc = evt.textEditor.document;
    if (doc.uri.scheme !== 'file') return;

    const path = this.options.uriToPath(doc.uri);
    if (path === undefined) return;

    const sel = evt.selections[0];
    if (sel === undefined) return;

    const text = doc.getText();
    const anchorUtf16 = doc.offsetAt(sel.anchor);
    const headUtf16 = doc.offsetAt(sel.active);
    const anchorCp = utf16ToCodepoint(text, anchorUtf16);
    const headCp = utf16ToCodepoint(text, headUtf16);

    this.pendingPayload = { path, anchor: anchorCp, head: headCp };

    if (this.pendingTimer !== undefined) {
      this.options.cancelTimer(this.pendingTimer);
    }

    this.pendingTimer = this.options.scheduleTimer(() => {
      this.pendingTimer = undefined;
      if (this.pendingPayload !== undefined) {
        const { path: p, anchor, head } = this.pendingPayload;
        this.pendingPayload = undefined;
        this.options.sendCursorUpdate(p, anchor, head);
      }
    }, this.throttleMs);
  }
}

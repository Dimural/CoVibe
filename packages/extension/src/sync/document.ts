import type * as vscode from 'vscode';
import type { TextOp } from '@covibes/protocol/ot';

/** Construction options for {@link SyncedDocument}. */
export interface SyncedDocumentOptions {
  /** The VS Code URI of the underlying file. */
  readonly uri: vscode.Uri;
  /** The initial base-text snapshot the document was opened against. */
  readonly baseText: string;
}

/**
 * Pure data model for one open file participating in real-time sync.
 *
 * Responsibilities are intentionally narrow:
 * - hold the current `baseText` snapshot the OT engine reasons against,
 * - expose monotonically increasing integer `version` (engine-managed),
 * - buffer `pendingOps` (locally-applied, awaiting server ack) and
 *   `ackedOps` (server-confirmed history).
 *
 * Non-responsibilities (handled by later Phase-4 tasks):
 * - applying ops to a text snapshot (Task 4.2/4.3),
 * - enforcing version monotonicity (Task 4.3 — the OT engine owns the
 *   invariants and may legitimately rewind on a full resync, Task 4.7),
 * - subscribing to VS Code editor events,
 * - networking.
 *
 * Op buffers are exposed via getters that return defensive copies so callers
 * cannot accidentally mutate internal state. Mutation goes through the
 * explicit `append*` / `clear*` methods.
 */
export class SyncedDocument {
  /** The VS Code URI this document tracks. Immutable for the document's lifetime. */
  readonly uri: vscode.Uri;

  private _baseText: string;
  private _version = 0;
  private readonly _pendingOps: TextOp[] = [];
  private readonly _ackedOps: TextOp[] = [];

  constructor(options: SyncedDocumentOptions) {
    this.uri = options.uri;
    this._baseText = options.baseText;
  }

  /** Current base-text snapshot. */
  get baseText(): string {
    return this._baseText;
  }

  /**
   * Replace the base-text snapshot.
   *
   * Used by full-document resync (Task 4.7). Not validated here.
   */
  setBaseText(text: string): void {
    this._baseText = text;
  }

  /** Current document version (engine-managed). Starts at 0. */
  get version(): number {
    return this._version;
  }

  /**
   * Set the document version.
   *
   * Monotonicity is the OT engine's responsibility — see class TSDoc.
   */
  setVersion(v: number): void {
    this._version = v;
  }

  /** Snapshot of pending (unacked) ops. Mutating the returned array is safe. */
  get pendingOps(): TextOp[] {
    return [...this._pendingOps];
  }

  /** Append an op to the pending buffer. */
  appendPending(op: TextOp): void {
    this._pendingOps.push(op);
  }

  /** Empty the pending buffer. Called by the engine after an ack settles them. */
  clearPending(): void {
    this._pendingOps.length = 0;
  }

  /** Snapshot of acked op history. Mutating the returned array is safe. */
  get ackedOps(): TextOp[] {
    return [...this._ackedOps];
  }

  /**
   * Append an op to the acked buffer.
   *
   * No `clear` counterpart: acked history is append-only in Phase 4. Bounding
   * the history (e.g. to a ring buffer) is a later concern when memory becomes
   * a constraint, not now.
   */
  appendAcked(op: TextOp): void {
    this._ackedOps.push(op);
  }
}

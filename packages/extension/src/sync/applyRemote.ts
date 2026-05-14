/**
 * applyRemote — applies an OT op (codepoint offsets) as a VS Code WorkspaceEdit.
 *
 * Responsibility boundary (Task 4.5):
 *  1. Convert codepoint-based TextOp components to UTF-16 offsets using
 *     `codepointToUtf16`, then map to line/character positions via the
 *     document's `positionAt`.
 *  2. Build a WorkspaceEdit (via injectable `createEdit`) with `replace` calls.
 *  3. Mark the document as having a remote op applied (`markApplyingRemote`)
 *     BEFORE calling `applyEdit`, so EditCapture ignores the resulting event.
 *  4. On apply failure, log a structured warning and request a full resync.
 *
 * All dependencies are injectable — no direct vscode API calls in core logic.
 * The structural interfaces below match the VS Code types structurally so that
 * tests can provide plain-object fakes without a real extension host.
 */

import type * as vscode from 'vscode';
import type { TextOp, TextOpComponent } from '@covibes/protocol/ot';

import type { SyncedDocument } from './document.js';
import { codepointToUtf16 } from './offsets.js';

// ---------------------------------------------------------------------------
// Structural interfaces — no vscode import needed for these
// ---------------------------------------------------------------------------

/** Minimal position (line + character) matching vscode.Position. */
export interface DocPosition {
  readonly line: number;
  readonly character: number;
}

/** Minimal range matching vscode.Range. */
export interface DocRange {
  readonly start: DocPosition;
  readonly end: DocPosition;
}

/** Minimal WorkspaceEdit: only the replace operation we need. */
export interface EditBuilder {
  replace(uri: vscode.Uri, range: DocRange, newText: string): void;
}

/** Minimal open TextDocument surface we need. */
export interface ApplyDocument {
  readonly uri: vscode.Uri;
  getText(): string;
  /** Converts a UTF-16 code-unit offset to a {line, character} position. */
  positionAt(offset: number): DocPosition;
}

/** Injectable dependencies for applyRemoteOp. */
export interface ApplyRemoteDeps {
  /**
   * Get the currently-open VS Code document for the given URI.
   * Returns undefined if the document is not open (closed/hidden).
   */
  getDocument(uri: vscode.Uri): ApplyDocument | undefined;
  /** Factory: create a fresh WorkspaceEdit. Returns the injectable EditBuilder. */
  createEdit(): EditBuilder;
  /** Apply the edit. Resolves true on success, false on failure. */
  applyEdit(edit: EditBuilder): Promise<boolean>;
  /**
   * Mark the document as having a remote op applied.
   * Prevents EditCapture from capturing the resulting change event as a local edit.
   */
  markApplyingRemote(doc: ApplyDocument): void;
  /** Called when applyEdit returns false — the document needs a full snapshot resync. */
  onResyncNeeded(path: string, version: number): void;
  /** For structured logging of failures. Log without document content (paths + metadata only). */
  logger: {
    warn(context: Record<string, unknown>, msg: string): void;
    error(context: Record<string, unknown>, msg: string): void;
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Apply a remote OT op to the open VS Code document identified by `syncedDoc`.
 *
 * Converts codepoint offsets in `op` to UTF-16 offsets, builds a
 * WorkspaceEdit, marks the document so EditCapture skips the resulting event,
 * and applies the edit. On failure, logs a warning and requests a resync.
 *
 * Returns early (no-op) if the document is not currently open in the editor.
 */
export async function applyRemoteOp(
  path: string,
  syncedDoc: SyncedDocument,
  op: TextOp,
  deps: ApplyRemoteDeps,
): Promise<void> {
  // Step 1: Get the open document — bail out if it's not open.
  const applyDoc = deps.getDocument(syncedDoc.uri);
  if (applyDoc === undefined) {
    return;
  }

  // Step 2: Get the current document text (may include user edits on top of base).
  const text = applyDoc.getText();

  // Step 3: Build the WorkspaceEdit by walking the op.
  const edit = deps.createEdit();
  const uri = applyDoc.uri;

  let cpPos = 0;

  for (const component of op) {
    // noUncheckedIndexedAccess: component is TextOpComponent (number | string | { d: number })
    // The for-of loop gives us each element, so no index access here.
    // We still need to handle the union type carefully.
    const comp: TextOpComponent = component;

    if (typeof comp === 'number') {
      // Retain/skip: advance codepoint position without emitting any edit.
      cpPos += comp;
    } else if (typeof comp === 'string') {
      // Insert: emit a zero-width replace (insert) at the current position.
      const utf16 = codepointToUtf16(text, cpPos);
      const pos = applyDoc.positionAt(utf16);
      edit.replace(uri, { start: pos, end: pos }, comp);
      // cpPos unchanged — insert does not consume source text.
    } else {
      // Delete: emit a replace over [cpPos, cpPos + d) with empty string.
      // The ot-text-unicode type declares d as `number | string`, but in
      // practice the OT layer always produces numeric delete counts. We
      // coerce defensively so strict arithmetic works under noUncheckedIndexedAccess.
      const n = Number(comp.d);
      const startUtf16 = codepointToUtf16(text, cpPos);
      const endUtf16 = codepointToUtf16(text, cpPos + n);
      const startPos = applyDoc.positionAt(startUtf16);
      const endPos = applyDoc.positionAt(endUtf16);
      edit.replace(uri, { start: startPos, end: endPos }, '');
      cpPos += n;
    }
  }

  // Step 4: Mark before applying so EditCapture ignores the resulting change event.
  deps.markApplyingRemote(applyDoc);

  // Step 5: Apply the edit.
  const ok = await deps.applyEdit(edit);

  // Step 6: Handle failure.
  if (!ok) {
    deps.logger.warn(
      {
        path,
        version: syncedDoc.version,
        uri: syncedDoc.uri.toString(),
      },
      'applyRemoteOp: WorkspaceEdit apply failed — requesting resync',
    );
    deps.onResyncNeeded(path, syncedDoc.version);
  }
}

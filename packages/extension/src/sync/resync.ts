import type * as vscode from 'vscode';
import type { DocSnapshotPayload } from '@covibes/protocol';
import type { SyncedDocument } from './document.js';

export interface ResyncDocument {
  readonly uri: vscode.Uri;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  readonly lineCount: number;
  lineAt(line: number): { readonly range: { readonly end: { line: number; character: number } } };
}

export interface ResyncEditBuilder {
  replace(
    uri: vscode.Uri,
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    },
    newText: string,
  ): void;
}

export interface ResyncDeps {
  getDocument(uri: vscode.Uri): ResyncDocument | undefined;
  createEdit(): ResyncEditBuilder;
  applyEdit(edit: ResyncEditBuilder): Promise<boolean>;
  markApplyingRemote(doc: ResyncDocument): void;
  logger: {
    warn(context: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Apply a full-document snapshot to the VS Code editor.
 * Resets SyncedDocument state and replaces the full document text.
 * Skips if the snapshot is stale (serverVersion < syncedDoc.version).
 */
export async function applySnapshot(
  syncedDoc: SyncedDocument,
  payload: DocSnapshotPayload,
  deps: ResyncDeps,
): Promise<void> {
  // Skip stale snapshots
  if (payload.serverVersion < syncedDoc.version) {
    deps.logger.warn(
      {
        uri: syncedDoc.uri.toString(),
        snapshotVersion: payload.serverVersion,
        currentVersion: syncedDoc.version,
      },
      'applySnapshot: stale snapshot — ignoring',
    );
    return;
  }

  const applyDoc = deps.getDocument(syncedDoc.uri);
  if (applyDoc === undefined) return;

  // Build a full-document replace WorkspaceEdit
  const edit = deps.createEdit();
  // VS Code guarantees lineCount >= 1 for any open document.
  const lastLine = applyDoc.lineCount - 1;
  const lastChar = applyDoc.lineAt(lastLine).range.end.character;
  edit.replace(
    applyDoc.uri,
    { start: { line: 0, character: 0 }, end: { line: lastLine, character: lastChar } },
    payload.text,
  );

  deps.markApplyingRemote(applyDoc);
  const ok = await deps.applyEdit(edit);
  if (!ok) {
    deps.logger.warn({ uri: syncedDoc.uri.toString() }, 'applySnapshot: WorkspaceEdit failed');
    return;
  }
  // Only update in-memory state after the editor text is successfully replaced.
  syncedDoc.reset(payload.text, payload.serverVersion);
}

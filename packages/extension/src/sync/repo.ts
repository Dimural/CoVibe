import * as path from 'node:path';
import type * as vscode from 'vscode';
import { SyncedDocument } from './document.js';

/**
 * Compute the POSIX-style path of `fileUri` relative to `workspaceRoot`.
 *
 * Behaviour:
 * - Separators are normalised to `/` regardless of host OS, because the
 *   relative path is the wire-serialised document key and must be portable.
 * - Case is **preserved**. We never lowercase, even on case-insensitive
 *   filesystems (macOS default, Windows). git is case-sensitive: treating
 *   `Foo.ts` and `foo.ts` as the same key would conflate two different
 *   tracked files and corrupt sync state.
 * - Throws if `fileUri` resolves outside `workspaceRoot` (a `..` would be
 *   needed to reach it). Returns `'.'` when the two URIs refer to the same
 *   path.
 *
 * Implementation note: we operate on `fsPath` (the host-native form) and
 * normalise both sides to POSIX separators before computing the relative
 * path with `path.posix.relative`. This keeps Windows backslash inputs
 * working under tests run on macOS/Linux.
 */
export function toRelativePosixPath(workspaceRoot: vscode.Uri, fileUri: vscode.Uri): string {
  const rootPosix = toPosix(workspaceRoot.fsPath);
  const filePosix = toPosix(fileUri.fsPath);
  const rel = path.posix.relative(rootPosix, filePosix);

  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
    throw new Error(
      `File URI is outside workspace root: ${fileUri.fsPath} not under ${workspaceRoot.fsPath}`,
    );
  }
  return rel;
}

/** Replace backslashes with forward slashes; leave everything else intact. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Indexes {@link SyncedDocument} instances by their relative POSIX path
 * (relative to the workspace root + branch — branch scoping is provided
 * externally by whoever constructs the repository).
 *
 * Case-sensitive keys (see {@link toRelativePosixPath} for rationale).
 *
 * Lifecycle is owner-managed: callers must invoke `dispose`/`disposeAll`
 * when documents are closed. The class does not subscribe to VS Code
 * events; that wiring lives in later tasks (4.2+).
 */
export class DocumentRepository {
  private readonly byPath = new Map<string, SyncedDocument>();

  /** Number of documents currently tracked. */
  get size(): number {
    return this.byPath.size;
  }

  /** Return the document at `relativePath`, or `undefined` if absent. */
  get(relativePath: string): SyncedDocument | undefined {
    return this.byPath.get(relativePath);
  }

  /**
   * Return the existing document for `relativePath` if one is tracked,
   * otherwise create a new {@link SyncedDocument} with the given `uri` and
   * `baseText` and register it. Idempotent: a second call with the same
   * key returns the original instance and ignores the supplied `uri` /
   * `baseText` (overwriting them would silently discard pending ops).
   */
  getOrCreate(relativePath: string, uri: vscode.Uri, baseText: string): SyncedDocument {
    const existing = this.byPath.get(relativePath);
    if (existing !== undefined) return existing;

    const doc = new SyncedDocument({ uri, baseText });
    this.byPath.set(relativePath, doc);
    return doc;
  }

  /** Remove the document at `relativePath` from the index. No-op if absent. */
  dispose(relativePath: string): void {
    this.byPath.delete(relativePath);
  }

  /** Remove every document from the index. */
  disposeAll(): void {
    this.byPath.clear();
  }
}

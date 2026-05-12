/**
 * Tests for SyncedDocument — pure data model for an open synced file.
 */
import { describe, it, expect } from 'vitest';
import { Uri } from 'vscode';
import type { TextOp } from '@covibes/protocol/ot';
import { SyncedDocument } from '../../src/sync/document.js';

describe('SyncedDocument', () => {
  it('initializes with given uri/baseText, version 0, and empty op buffers', () => {
    const uri = Uri.file('/ws/src/foo.ts');
    const doc = new SyncedDocument({ uri, baseText: 'hello' });
    expect(doc.uri).toBe(uri);
    expect(doc.baseText).toBe('hello');
    expect(doc.version).toBe(0);
    expect(doc.pendingOps).toEqual([]);
    expect(doc.ackedOps).toEqual([]);
  });

  it('setVersion updates the version (engine-managed, no monotonicity check here)', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    doc.setVersion(5);
    expect(doc.version).toBe(5);
    // Task 4.1 explicitly does not enforce monotonicity — engine's job.
    doc.setVersion(3);
    expect(doc.version).toBe(3);
  });

  it('setBaseText replaces the base text snapshot (used by resync in Task 4.7)', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: 'one' });
    doc.setBaseText('two');
    expect(doc.baseText).toBe('two');
  });

  it('appendPending pushes ops onto the pending buffer', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    const op1: TextOp = [{ i: 'a' }];
    const op2: TextOp = [{ i: 'b' }];
    doc.appendPending(op1);
    doc.appendPending(op2);
    expect(doc.pendingOps).toEqual([op1, op2]);
  });

  it('clearPending empties the pending buffer', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    doc.appendPending([{ i: 'a' }]);
    doc.clearPending();
    expect(doc.pendingOps).toEqual([]);
  });

  it('appendAcked pushes ops onto the acked buffer', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    const op: TextOp = [{ i: 'x' }];
    doc.appendAcked(op);
    expect(doc.ackedOps).toEqual([op]);
  });

  it('pendingOps getter returns a defensive copy (mutating it must not affect state)', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    doc.appendPending([{ i: 'a' }]);
    const snapshot = doc.pendingOps;
    snapshot.push([{ i: 'EVIL' }]);
    expect(doc.pendingOps).toHaveLength(1);
  });

  it('ackedOps getter returns a defensive copy (mutating it must not affect state)', () => {
    const doc = new SyncedDocument({ uri: Uri.file('/ws/a'), baseText: '' });
    doc.appendAcked([{ i: 'a' }]);
    const snapshot = doc.ackedOps;
    snapshot.length = 0;
    expect(doc.ackedOps).toHaveLength(1);
  });
});

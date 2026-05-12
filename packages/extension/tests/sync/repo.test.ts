/**
 * Tests for the document repository and path normalization helper.
 */
import { describe, it, expect } from 'vitest';
import { Uri } from 'vscode';
import { DocumentRepository, toRelativePosixPath } from '../../src/sync/repo.js';

describe('toRelativePosixPath', () => {
  it('returns a POSIX-separated path relative to the workspace root (macOS)', () => {
    const root = Uri.file('/Users/alice/code/proj');
    const file = Uri.file('/Users/alice/code/proj/src/foo/bar.ts');
    expect(toRelativePosixPath(root, file)).toBe('src/foo/bar.ts');
  });

  it('preserves case (does not lowercase) — git is case-sensitive', () => {
    const root = Uri.file('/Users/alice/code/Proj');
    const file = Uri.file('/Users/alice/code/Proj/Src/Foo.TS');
    expect(toRelativePosixPath(root, file)).toBe('Src/Foo.TS');
  });

  it('converts Windows-style backslash separators to forward slashes', () => {
    const root = Uri.file('C:\\dev\\Proj');
    const file = Uri.file('C:\\dev\\Proj\\src\\foo\\bar.ts');
    expect(toRelativePosixPath(root, file)).toBe('src/foo/bar.ts');
  });

  it('throws when the file is outside the workspace root', () => {
    const root = Uri.file('/Users/alice/code/proj');
    const file = Uri.file('/Users/alice/other/file.ts');
    expect(() => toRelativePosixPath(root, file)).toThrow(/outside workspace root/i);
  });

  it('throws when the relative path would escape the root via ..', () => {
    const root = Uri.file('/Users/alice/code/proj');
    const file = Uri.file('/Users/alice/code/file.ts');
    expect(() => toRelativePosixPath(root, file)).toThrow(/outside workspace root/i);
  });

  it('returns "." when fileUri equals workspaceRoot', () => {
    const root = Uri.file('/Users/alice/code/proj');
    expect(toRelativePosixPath(root, root)).toBe('.');
  });

  it('normalizes ".." segments that resolve back inside the root', () => {
    const root = Uri.file('/Users/alice/code/proj');
    const file = Uri.file('/Users/alice/code/proj/src/../src/foo.ts');
    expect(toRelativePosixPath(root, file)).toBe('src/foo.ts');
  });

  it('handles deeply nested paths', () => {
    const root = Uri.file('/Users/alice/code/proj');
    const file = Uri.file('/Users/alice/code/proj/a/b/c/d/e/f/g/h.ts');
    expect(toRelativePosixPath(root, file)).toBe('a/b/c/d/e/f/g/h.ts');
  });
});

describe('DocumentRepository', () => {
  it('starts empty', () => {
    const repo = new DocumentRepository();
    expect(repo.size).toBe(0);
    expect(repo.get('src/foo.ts')).toBeUndefined();
  });

  it('getOrCreate creates a new document when key is absent', () => {
    const repo = new DocumentRepository();
    const doc = repo.getOrCreate('src/foo.ts', Uri.file('/ws/src/foo.ts'), 'hello');
    expect(doc.baseText).toBe('hello');
    expect(repo.size).toBe(1);
    expect(repo.get('src/foo.ts')).toBe(doc);
  });

  it('getOrCreate returns the same instance for the same key even when baseText differs', () => {
    const repo = new DocumentRepository();
    const uri = Uri.file('/ws/src/foo.ts');
    const first = repo.getOrCreate('src/foo.ts', uri, 'one');
    const second = repo.getOrCreate('src/foo.ts', uri, 'TWO');
    expect(second).toBe(first);
    expect(second.baseText).toBe('one');
    expect(repo.size).toBe(1);
  });

  it('treats keys case-sensitively (Foo.ts vs foo.ts are distinct)', () => {
    const repo = new DocumentRepository();
    const a = repo.getOrCreate('src/Foo.ts', Uri.file('/ws/src/Foo.ts'), 'A');
    const b = repo.getOrCreate('src/foo.ts', Uri.file('/ws/src/foo.ts'), 'B');
    expect(a).not.toBe(b);
    expect(repo.size).toBe(2);
  });

  it('dispose removes a single document', () => {
    const repo = new DocumentRepository();
    repo.getOrCreate('a', Uri.file('/ws/a'), '');
    repo.getOrCreate('b', Uri.file('/ws/b'), '');
    repo.dispose('a');
    expect(repo.get('a')).toBeUndefined();
    expect(repo.get('b')).toBeDefined();
    expect(repo.size).toBe(1);
  });

  it('dispose is a no-op on unknown keys', () => {
    const repo = new DocumentRepository();
    expect(() => repo.dispose('missing')).not.toThrow();
    expect(repo.size).toBe(0);
  });

  it('disposeAll empties the index', () => {
    const repo = new DocumentRepository();
    repo.getOrCreate('a', Uri.file('/ws/a'), '');
    repo.getOrCreate('b', Uri.file('/ws/b'), '');
    repo.disposeAll();
    expect(repo.size).toBe(0);
    expect(repo.get('a')).toBeUndefined();
  });
});

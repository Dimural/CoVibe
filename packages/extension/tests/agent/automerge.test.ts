import { describe, it, expect } from 'vitest';
import { computeMergeDecision } from '../../src/agent/automerge.js';

describe('computeMergeDecision', () => {
  it('returns no-op when both sides are identical to snapshot', () => {
    const result = computeMergeDecision('hello world', 'hello world', 'hello world');
    expect(result.kind).toBe('noop');
  });

  it('returns auto-merge when only one side changed', () => {
    const result = computeMergeDecision(
      'line1\nline2\nline3\n',
      'line1\nline2 modified\nline3\n',
      'line1\nline2\nline3\n',
    );
    expect(result.kind).toBe('merge');
    if (result.kind === 'merge') {
      expect(result.mergedText).toBe('line1\nline2 modified\nline3\n');
    }
  });

  it('returns auto-merge for disjoint line changes', () => {
    const snapshot = 'line1\nline2\nline3\nline4\n';
    const left = 'line1 modified\nline2\nline3\nline4\n';
    const right = 'line1\nline2\nline3\nline4 modified\n';
    const result = computeMergeDecision(snapshot, left, right);
    expect(result.kind).toBe('merge');
    if (result.kind === 'merge') {
      expect(result.mergedText).toBe('line1 modified\nline2\nline3\nline4 modified\n');
    }
  });

  it('returns conflict for overlapping line changes', () => {
    const snapshot = 'line1\nline2\nline3\n';
    const left = 'line1\nline2-A\nline3\n';
    const right = 'line1\nline2-B\nline3\n';
    const result = computeMergeDecision(snapshot, left, right);
    expect(result.kind).toBe('conflict');
  });

  it('returns noop when both sides made the same change', () => {
    const snapshot = 'line1\nline2\n';
    const left = 'line1\nline2 modified\n';
    const right = 'line1\nline2 modified\n';
    const result = computeMergeDecision(snapshot, left, right);
    expect(result.kind).toBe('noop');
  });
});

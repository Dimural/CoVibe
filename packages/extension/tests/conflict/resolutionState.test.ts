// packages/extension/tests/conflict/resolutionState.test.ts
import { describe, it, expect } from 'vitest';
import {
  createResolutionState,
  confirmParticipant,
  cancelResolution,
  updateResolutionText,
  isResolved,
  isBothConfirmed,
} from '../../src/conflict/resolutionState.js';

describe('ResolutionState', () => {
  it('creates initial state with conflict markers and no confirmations', () => {
    const state = createResolutionState('conflict-1', ['p1', 'p2'], 'left', 'right', 'base\n');
    expect(state.conflictId).toBe('conflict-1');
    expect(state.confirmed).toEqual(new Set());
    expect(state.cancelled).toBe(false);
    expect(state.resolutionText).toContain('<<<<<<<');
  });

  it('isResolved returns false when conflict markers remain', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    expect(isResolved(state)).toBe(false);
  });

  it('isResolved returns true when no conflict markers remain', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    const updated = updateResolutionText(state, 'clean text without markers');
    expect(isResolved(updated)).toBe(true);
  });

  it('confirmParticipant adds to confirmed set', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    const clean = updateResolutionText(state, 'resolved');
    const s2 = confirmParticipant(clean, 'p1');
    expect(s2.confirmed.has('p1')).toBe(true);
    expect(s2.confirmed.has('p2')).toBe(false);
  });

  it('isBothConfirmed returns true when all peers have confirmed', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    const clean = updateResolutionText(state, 'resolved');
    const s1 = confirmParticipant(clean, 'p1');
    const s2 = confirmParticipant(s1, 'p2');
    expect(isBothConfirmed(s2)).toBe(true);
  });

  it('isBothConfirmed returns false when only one confirmed', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    const clean = updateResolutionText(state, 'resolved');
    const s1 = confirmParticipant(clean, 'p1');
    expect(isBothConfirmed(s1)).toBe(false);
  });

  it('cancelResolution sets cancelled flag', () => {
    const state = createResolutionState('c1', ['p1', 'p2'], 'left', 'right', 'base\n');
    const cancelled = cancelResolution(state);
    expect(cancelled.cancelled).toBe(true);
  });
});

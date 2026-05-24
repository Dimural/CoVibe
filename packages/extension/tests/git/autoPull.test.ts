/**
 * Tests for AutoPullCoordinator (Task 6.4 — auto-pull on remote update).
 *
 * All dependencies are injected as fakes; no VS Code extension host required.
 */

import { describe, it, expect, vi } from 'vitest';
import { AutoPullCoordinator } from '../../src/git/autoPull.js';
import type { AutoPullOptions } from '../../src/git/autoPull.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<AutoPullOptions> = {}): AutoPullOptions {
  return {
    localParticipantId: 'b-participant',
    send: vi.fn(),
    getAllParticipantIds: vi.fn(() => ['a-participant', 'b-participant']),
    isDirty: vi.fn(() => false),
    doPull: vi.fn(() => Promise.resolve(undefined)),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
    showDirtyPullConfirm: vi.fn(() => Promise.resolve(true)),
    watchRemoteHead: vi.fn(() => vi.fn()),
    getRemoteHeadSha: vi.fn(() => Promise.resolve('remote-sha-abc')),
    getLocalHeadSha: vi.fn(() => 'local-sha-xyz'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AutoPullCoordinator', () => {
  // ── onRemoteChange ──────────────────────────────────────────────────────

  describe('onRemoteChange', () => {
    it('1. local is lowest ID → broadcasts git.operation { kind: pull-staged }', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant', 'b-participant']),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.send).toHaveBeenCalledWith('git.operation', { kind: 'pull-staged' });
    });

    it('2. local is NOT lowest ID → does NOT broadcast', async () => {
      // b-participant > a-participant, so b is not the lowest
      const opts = makeOptions({
        localParticipantId: 'b-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant', 'b-participant']),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.send).not.toHaveBeenCalled();
    });

    it('3. remote SHA === local SHA → no broadcast, no pull', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant']),
        getRemoteHeadSha: vi.fn(() => Promise.resolve('same-sha')),
        getLocalHeadSha: vi.fn(() => 'same-sha'),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.send).not.toHaveBeenCalled();
      expect(opts.doPull).not.toHaveBeenCalled();
    });

    it('4. remote SHA undefined → no-op', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant']),
        getRemoteHeadSha: vi.fn(() => Promise.resolve<string | undefined>(undefined)),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.send).not.toHaveBeenCalled();
      expect(opts.doPull).not.toHaveBeenCalled();
    });

    it('5. local is lowest, not dirty → calls doPull and shows info toast', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant', 'b-participant']),
        isDirty: vi.fn(() => false),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.doPull).toHaveBeenCalledOnce();
      expect(opts.showInfo).toHaveBeenCalledWith('Pulled latest changes.');
    });

    it('6. local is lowest, dirty, user confirms → calls doPull', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant']),
        isDirty: vi.fn(() => true),
        showDirtyPullConfirm: vi.fn(() => Promise.resolve(true)),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.showDirtyPullConfirm).toHaveBeenCalledOnce();
      expect(opts.doPull).toHaveBeenCalledOnce();
    });

    it('7. local is lowest, dirty, user declines → does NOT call doPull', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant']),
        isDirty: vi.fn(() => true),
        showDirtyPullConfirm: vi.fn(() => Promise.resolve(false)),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.showDirtyPullConfirm).toHaveBeenCalledOnce();
      expect(opts.doPull).not.toHaveBeenCalled();
    });
  });

  // ── onPeerOperation ─────────────────────────────────────────────────────

  describe('onPeerOperation', () => {
    it('8. kind=pull-staged, not dirty → calls doPull and shows info toast', async () => {
      const opts = makeOptions({ isDirty: vi.fn(() => false) });
      const coord = new AutoPullCoordinator(opts);
      await coord.onPeerOperation({ kind: 'pull-staged' });

      expect(opts.doPull).toHaveBeenCalledOnce();
      expect(opts.showInfo).toHaveBeenCalledWith('Pulled latest changes.');
    });

    it('9. kind=pull-staged, dirty, user confirms → calls doPull', async () => {
      const opts = makeOptions({
        isDirty: vi.fn(() => true),
        showDirtyPullConfirm: vi.fn(() => Promise.resolve(true)),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.onPeerOperation({ kind: 'pull-staged' });

      expect(opts.showDirtyPullConfirm).toHaveBeenCalledOnce();
      expect(opts.doPull).toHaveBeenCalledOnce();
    });

    it('10. kind=pull-staged, dirty, user declines → does NOT call doPull', async () => {
      const opts = makeOptions({
        isDirty: vi.fn(() => true),
        showDirtyPullConfirm: vi.fn(() => Promise.resolve(false)),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.onPeerOperation({ kind: 'pull-staged' });

      expect(opts.showDirtyPullConfirm).toHaveBeenCalledOnce();
      expect(opts.doPull).not.toHaveBeenCalled();
    });

    it('11. kind=push (unrelated) → does nothing', async () => {
      const opts = makeOptions();
      const coord = new AutoPullCoordinator(opts);
      await coord.onPeerOperation({ kind: 'push' });

      expect(opts.doPull).not.toHaveBeenCalled();
      expect(opts.showInfo).not.toHaveBeenCalled();
    });
  });

  // ── error path ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('12. doPull returns pull-failed error → shows warning', async () => {
      const opts = makeOptions({
        localParticipantId: 'a-participant',
        getAllParticipantIds: vi.fn(() => ['a-participant']),
        isDirty: vi.fn(() => false),
        doPull: vi.fn(() =>
          Promise.resolve({ kind: 'pull-failed' as const, message: 'merge conflict' }),
        ),
      });
      const coord = new AutoPullCoordinator(opts);
      await coord.testOnRemoteChange();

      expect(opts.showWarning).toHaveBeenCalledWith(
        'Pull failed: merge conflict. Use git tools to resolve.',
      );
      expect(opts.showInfo).not.toHaveBeenCalled();
    });
  });

  // ── lifecycle ────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('start() subscribes via watchRemoteHead and returns this', () => {
      const dispose = vi.fn();
      const opts = makeOptions({ watchRemoteHead: vi.fn(() => dispose) });
      const coord = new AutoPullCoordinator(opts);
      const result = coord.start();

      expect(opts.watchRemoteHead).toHaveBeenCalledOnce();
      expect(result).toBe(coord);
    });

    it('dispose() calls the unsubscribe function', () => {
      const dispose = vi.fn();
      const opts = makeOptions({ watchRemoteHead: vi.fn(() => dispose) });
      const coord = new AutoPullCoordinator(opts);
      coord.start();
      coord.dispose();

      expect(dispose).toHaveBeenCalledOnce();
    });
  });
});

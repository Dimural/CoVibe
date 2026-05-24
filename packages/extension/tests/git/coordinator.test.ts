/**
 * Tests for GitCoordinator — coordinated commit flow.
 *
 * All dependencies are injected as fakes. No VS Code extension host required.
 */
import { describe, it, expect, vi } from 'vitest';
import { GitCoordinator, type GitCoordinatorOptions } from '../../src/git/coordinator.js';
import type { GitOperationError } from '../../src/git/operations.js';

// ---------------------------------------------------------------------------
// Fake clock and countdown helpers
// ---------------------------------------------------------------------------

type CountdownResult = 'expired' | 'cancelled';

interface FakeCountdown {
  cancel: ReturnType<typeof vi.fn>;
  promise: Promise<CountdownResult>;
  resolve: (result: CountdownResult) => void;
}

function makeCountdown(): FakeCountdown {
  let res!: (r: CountdownResult) => void;
  const promise = new Promise<CountdownResult>((resolve) => {
    res = resolve;
  });
  return { cancel: vi.fn(), promise, resolve: res };
}

// ---------------------------------------------------------------------------
// Default options factory
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<GitCoordinatorOptions> = {}): GitCoordinatorOptions {
  return {
    localParticipantId: 'local-p1',
    send: vi.fn(),
    doCommit: vi.fn().mockResolvedValue(undefined),
    doPush: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
    showCommitCountdown: vi.fn().mockReturnValue(makeCountdown()),
    clock: {
      now: () => 0,
      schedule: vi.fn().mockReturnValue(0),
      cancel: vi.fn(),
    },
    getPeers: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitCoordinator', () => {
  // -------------------------------------------------------------------------
  // coordinateCommit
  // -------------------------------------------------------------------------

  describe('coordinateCommit', () => {
    it('broadcasts git.operation commit message to peers', async () => {
      const send = vi.fn();
      const countdown = makeCountdown();
      const options = makeOptions({
        send,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('add login');
      // countdown is still pending — resolve it to expire so commit proceeds
      countdown.resolve('expired');
      await commitPromise;

      expect(send).toHaveBeenCalledWith('git.operation', { kind: 'commit', message: 'add login' });
    });

    it('calls doCommit after countdown expires', async () => {
      const doCommit = vi.fn().mockResolvedValue(undefined);
      const countdown = makeCountdown();
      const options = makeOptions({
        doCommit,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('fix bug');
      countdown.resolve('expired');
      await commitPromise;

      expect(doCommit).toHaveBeenCalledWith('fix bug');
    });

    it('does NOT call doCommit when peer cancels via onAck', async () => {
      const doCommit = vi.fn().mockResolvedValue(undefined);
      const countdown = makeCountdown();
      const options = makeOptions({
        doCommit,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
        getPeers: vi.fn().mockReturnValue([{ id: 'peer-1', displayName: 'Alice' }]),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('fix bug');
      coordinator.onAck({ kind: 'commit', cancelled: true, participantId: 'peer-1' });
      await commitPromise;

      expect(doCommit).not.toHaveBeenCalled();
    });

    it('shows info toast on successful commit', async () => {
      const showInfo = vi.fn();
      const countdown = makeCountdown();
      const options = makeOptions({
        showInfo,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('add feature');
      countdown.resolve('expired');
      await commitPromise;

      expect(showInfo).toHaveBeenCalledWith('Committed: add feature');
    });

    it('shows error toast when doCommit returns a GitOperationError', async () => {
      const showError = vi.fn();
      const err: GitOperationError = { kind: 'commit-failed', message: 'nothing to commit' };
      const countdown = makeCountdown();
      const options = makeOptions({
        showError,
        doCommit: vi.fn().mockResolvedValue(err),
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('bad commit');
      countdown.resolve('expired');
      await commitPromise;

      expect(showError).toHaveBeenCalledWith('Commit failed: nothing to commit');
    });

    it('does NOT call doCommit when user cancels countdown locally', async () => {
      const doCommit = vi.fn().mockResolvedValue(undefined);
      const countdown = makeCountdown();
      const options = makeOptions({
        doCommit,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('add feature');
      countdown.resolve('cancelled');
      await commitPromise;

      expect(doCommit).not.toHaveBeenCalled();
    });

    it('shows warning with peer display name when peer cancels', async () => {
      const showWarning = vi.fn();
      const countdown = makeCountdown();
      const options = makeOptions({
        showWarning,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
        getPeers: vi.fn().mockReturnValue([{ id: 'peer-2', displayName: 'Bob' }]),
      });
      const coordinator = new GitCoordinator(options);

      const commitPromise = coordinator.coordinateCommit('some change');
      coordinator.onAck({ kind: 'commit', cancelled: true, participantId: 'peer-2' });
      await commitPromise;

      expect(showWarning).toHaveBeenCalledWith('Commit cancelled by Bob.');
    });

    it('guards against double-initiation when commit already in progress', async () => {
      const showError = vi.fn();
      const countdown = makeCountdown();
      const options = makeOptions({
        showError,
        showCommitCountdown: vi.fn().mockReturnValue(countdown),
      });
      const coordinator = new GitCoordinator(options);

      // Start first commit, don't resolve countdown yet
      const firstCommit = coordinator.coordinateCommit('first');
      // Attempt second commit while first is in progress
      await coordinator.coordinateCommit('second');

      expect(showError).toHaveBeenCalledWith(expect.stringContaining('already in progress'));

      // Clean up first
      countdown.resolve('cancelled');
      await firstCommit;
    });
  });

  // -------------------------------------------------------------------------
  // onPeerOperation
  // -------------------------------------------------------------------------

  describe('onPeerOperation', () => {
    it('shows notification when peer commit operation arrives', () => {
      const showCommitCountdown = vi.fn().mockReturnValue(makeCountdown());
      const coordinator = new GitCoordinator(makeOptions({ showCommitCountdown }));

      coordinator.onPeerOperation({
        kind: 'commit',
        message: 'add login validation',
        participantId: 'peer-1',
        displayName: 'Alice',
      });

      expect(showCommitCountdown).toHaveBeenCalledWith(
        expect.stringContaining('Alice'),
        expect.any(Number),
      );
      expect(showCommitCountdown).toHaveBeenCalledWith(
        expect.stringContaining('add login validation'),
        expect.any(Number),
      );
    });

    it('sends git.ack cancelled=true when peer-side cancel is triggered', async () => {
      const send = vi.fn();
      const peerCountdown = makeCountdown();
      const showCommitCountdown = vi.fn().mockReturnValue(peerCountdown);
      const coordinator = new GitCoordinator(makeOptions({ send, showCommitCountdown }));

      coordinator.onPeerOperation({
        kind: 'commit',
        message: 'add feature',
        participantId: 'peer-1',
        displayName: 'Alice',
      });

      // Peer-side user clicks Cancel
      peerCountdown.resolve('cancelled');
      // Wait a tick for promise microtasks
      await new Promise((r) => setTimeout(r, 0));

      expect(send).toHaveBeenCalledWith('git.ack', { kind: 'commit', cancelled: true });
    });
  });
});

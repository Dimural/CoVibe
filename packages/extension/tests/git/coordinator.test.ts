/**
 * Tests for GitCoordinator — coordinated commit and push flows.
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
    hasActiveAgentIntent: vi.fn().mockReturnValue(false),
    hasUnsyncedDocs: vi.fn().mockReturnValue(false),
    showPushConfirm: vi.fn().mockResolvedValue(true),
    showPeerPushRequest: vi.fn().mockResolvedValue('confirm' as const),
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
      expect(countdown.cancel).toHaveBeenCalledTimes(1);
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
      expect(countdown.cancel).toHaveBeenCalledTimes(1);
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
      // Drain microtask queue so the promise chain resolves
      await Promise.resolve();
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith('git.ack', { kind: 'commit', cancelled: true });
    });
  });

  // -------------------------------------------------------------------------
  // coordinatePush
  // -------------------------------------------------------------------------

  describe('coordinatePush', () => {
    it('no peers → immediately calls doPush without waiting for acks', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn();
      const options = makeOptions({
        doPush,
        send,
        getPeers: vi.fn().mockReturnValue([]),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(doPush).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith('git.operation', { kind: 'push' });
    });

    it('all peers ack with confirm → calls doPush', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn();
      const options = makeOptions({
        doPush,
        send,
        getPeers: vi.fn().mockReturnValue([
          { id: 'peer-1', displayName: 'Alice' },
          { id: 'peer-2', displayName: 'Bob' },
        ]),
      });
      const coordinator = new GitCoordinator(options);

      const pushPromise = coordinator.coordinatePush();
      coordinator.onAck({ kind: 'push', cancelled: false, participantId: 'peer-1' });
      coordinator.onAck({ kind: 'push', cancelled: false, participantId: 'peer-2' });
      await pushPromise;

      expect(doPush).toHaveBeenCalledTimes(1);
    });

    it('any peer acks with cancel → does NOT call doPush, shows warning with peer name', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const showWarning = vi.fn();
      const options = makeOptions({
        doPush,
        showWarning,
        getPeers: vi.fn().mockReturnValue([
          { id: 'peer-1', displayName: 'Alice' },
          { id: 'peer-2', displayName: 'Bob' },
        ]),
      });
      const coordinator = new GitCoordinator(options);

      const pushPromise = coordinator.coordinatePush();
      coordinator.onAck({ kind: 'push', cancelled: false, participantId: 'peer-1' });
      coordinator.onAck({ kind: 'push', cancelled: true, participantId: 'peer-2' });
      await pushPromise;

      expect(doPush).not.toHaveBeenCalled();
      expect(showWarning).toHaveBeenCalledWith('Push cancelled by Bob.');
    });

    it('pre-flight: hasActiveAgentIntent=true, user says no → returns without push or broadcast', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn();
      const options = makeOptions({
        doPush,
        send,
        hasActiveAgentIntent: vi.fn().mockReturnValue(true),
        showPushConfirm: vi.fn().mockResolvedValue(false),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(doPush).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('pre-flight: hasActiveAgentIntent=true, user says yes → broadcasts push, proceeds', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn();
      const options = makeOptions({
        doPush,
        send,
        hasActiveAgentIntent: vi.fn().mockReturnValue(true),
        showPushConfirm: vi.fn().mockResolvedValue(true),
        getPeers: vi.fn().mockReturnValue([]),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(send).toHaveBeenCalledWith('git.operation', { kind: 'push' });
      expect(doPush).toHaveBeenCalledTimes(1);
    });

    it('pre-flight: hasUnsyncedDocs=true, user says no → returns without push', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn();
      const options = makeOptions({
        doPush,
        send,
        hasUnsyncedDocs: vi.fn().mockReturnValue(true),
        showPushConfirm: vi.fn().mockResolvedValue(false),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(doPush).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('double-initiation guard → shows error', async () => {
      const showError = vi.fn();
      const options = makeOptions({
        showError,
        getPeers: vi.fn().mockReturnValue([{ id: 'peer-1', displayName: 'Alice' }]),
      });
      const coordinator = new GitCoordinator(options);

      // Start first push but don't resolve it yet
      const firstPush = coordinator.coordinatePush();
      // Attempt second push while first is in progress
      await coordinator.coordinatePush();

      expect(showError).toHaveBeenCalledWith(expect.stringContaining('already in progress'));

      // Clean up first
      coordinator.onAck({ kind: 'push', cancelled: false, participantId: 'peer-1' });
      await firstPush;
    });

    it('shows info toast on successful push', async () => {
      const showInfo = vi.fn();
      const options = makeOptions({
        showInfo,
        getPeers: vi.fn().mockReturnValue([]),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(showInfo).toHaveBeenCalledWith('Pushed successfully.');
    });

    it('shows error toast when doPush returns a GitOperationError', async () => {
      const showError = vi.fn();
      const err: GitOperationError = { kind: 'push-failed', message: 'remote rejected' };
      const options = makeOptions({
        showError,
        doPush: vi.fn().mockResolvedValue(err),
        getPeers: vi.fn().mockReturnValue([]),
      });
      const coordinator = new GitCoordinator(options);

      await coordinator.coordinatePush();

      expect(showError).toHaveBeenCalledWith('Push failed: remote rejected');
    });

    it('onPeerLeft: sole pending peer leaves → doPush is called (implicit confirm)', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const options = makeOptions({
        doPush,
        getPeers: vi.fn().mockReturnValue([{ id: 'peer-1', displayName: 'Alice' }]),
      });
      const coordinator = new GitCoordinator(options);

      const pushPromise = coordinator.coordinatePush();
      // Peer disconnects before acking
      coordinator.onPeerLeft('peer-1');
      await pushPromise;

      expect(doPush).toHaveBeenCalledTimes(1);
    });

    it('onPeerLeft: one of two peers leaves → doPush not yet called; remaining peer confirms → doPush called', async () => {
      const doPush = vi.fn().mockResolvedValue(undefined);
      const options = makeOptions({
        doPush,
        getPeers: vi.fn().mockReturnValue([
          { id: 'peer-1', displayName: 'Alice' },
          { id: 'peer-2', displayName: 'Bob' },
        ]),
      });
      const coordinator = new GitCoordinator(options);

      const pushPromise = coordinator.coordinatePush();

      // Alice disconnects — Bob still pending
      coordinator.onPeerLeft('peer-1');
      // doPush must NOT have been called yet (Bob hasn't responded)
      expect(doPush).not.toHaveBeenCalled();

      // Bob confirms
      coordinator.onAck({ kind: 'push', cancelled: false, participantId: 'peer-2' });
      await pushPromise;

      expect(doPush).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // onPeerOperation — push handling
  // -------------------------------------------------------------------------

  describe('onPeerOperation push handling', () => {
    it('kind=push, confirm → sends git.ack { cancelled: false }', async () => {
      const send = vi.fn();
      const options = makeOptions({
        send,
        showPeerPushRequest: vi.fn().mockResolvedValue('confirm' as const),
      });
      const coordinator = new GitCoordinator(options);

      coordinator.onPeerOperation({
        kind: 'push',
        participantId: 'peer-1',
        displayName: 'Alice',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith('git.ack', { kind: 'push', cancelled: false });
    });

    it('kind=push, cancel → sends git.ack { cancelled: true }', async () => {
      const send = vi.fn();
      const options = makeOptions({
        send,
        showPeerPushRequest: vi.fn().mockResolvedValue('cancel' as const),
      });
      const coordinator = new GitCoordinator(options);

      coordinator.onPeerOperation({
        kind: 'push',
        participantId: 'peer-1',
        displayName: 'Alice',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith('git.ack', { kind: 'push', cancelled: true });
    });

    it('kind=push, wait → sends nothing', async () => {
      const send = vi.fn();
      const options = makeOptions({
        send,
        showPeerPushRequest: vi.fn().mockResolvedValue('wait' as const),
      });
      const coordinator = new GitCoordinator(options);

      coordinator.onPeerOperation({
        kind: 'push',
        participantId: 'peer-1',
        displayName: 'Alice',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(send).not.toHaveBeenCalled();
    });
  });
});

/**
 * Tests for SessionManager.
 *
 * Uses a FakeRelayClient (in-memory, no WebSocket) for isolation.
 * The `vscode` module is aliased to the stub in tests/__mocks__/vscode.ts by
 * the vitest config, but SessionManager imports vscode lazily — we patch it
 * here via vi.mock() for the clipboard call in start().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionManager,
  BranchMismatchError,
  type IRelayClient,
} from '../../src/session/manager.js';
import { formatInviteLink, deriveSessionId, generateInviteToken } from '@covibes/protocol';
import type { ParticipantIdentity } from '../../src/identity.js';
import type { CoVibesConfig } from '../../src/config.js';
import type { RepoContext } from '../../src/git/context.js';
import type { SessionState } from '../../src/session/state.js';

// ---------------------------------------------------------------------------
// Mock git/context so watchBranchChanges is controllable in tests
// ---------------------------------------------------------------------------

/** Captured callbacks from watchBranchChanges — each call pushes one entry. */
const branchCallbacks: ((branch: string) => void)[] = [];

vi.mock('../../src/git/context.js', () => ({
  watchBranchChanges: vi.fn((cb: (branch: string) => void) => {
    branchCallbacks.push(cb);
    return Promise.resolve({ dispose: vi.fn() });
  }),
  getRepoContext: vi.fn().mockResolvedValue({
    remoteUrl: 'https://github.com/example/repo.git',
    branch: 'main',
    isDirty: false,
    headSha: 'abc123',
  }),
}));

// ---------------------------------------------------------------------------
// Mock vscode so clipboard.writeText doesn't crash in tests
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  env: {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  },
  window: {
    activeTextEditor: undefined,
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
  extensions: {
    getExtension: vi.fn().mockReturnValue(undefined),
  },
  Disposable: {
    from: (...disposables: { dispose(): void }[]) => ({
      dispose: () => disposables.forEach((d) => d.dispose()),
    }),
  },
}));

// ---------------------------------------------------------------------------
// FakeRelayClient
// ---------------------------------------------------------------------------

class FakeRelayClient implements IRelayClient {
  connected = false;
  sentMessages: { type: string; payload: unknown }[] = [];
  eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.eventHandlers.get(event) ?? [];
    const filtered = handlers.filter((h) => h !== handler);
    this.eventHandlers.set(event, filtered);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  /** Simulate the server (or internal client) emitting an event. */
  emit(event: string, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    // Simulate the close event that disconnect triggers
    this.emit('close', 1000, 'client disconnect');
    return Promise.resolve();
  }

  send(type: string, payload: unknown): void {
    this.sentMessages.push({ type, payload });
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const identity: ParticipantIdentity = {
  id: 'test-participant-id',
  displayName: 'Test User',
  color: '#e74c3c',
};

const config: CoVibesConfig = {
  relayUrl: 'wss://relay.example.com',
  followModeEnabled: true,
  agentDetectionEnabled: true,
  gracePeriodSeconds: 1800,
};

const repoCtx: RepoContext = {
  remoteUrl: 'https://github.com/example/repo.git',
  branch: 'main',
  isDirty: false,
  headSha: 'abc123',
};

/** Build a decoded session.state message shaped like AnyDecodedMessage. */
function makeSessionStateMessage(
  participants: {
    id: string;
    displayName: string;
    color: string;
    currentFile?: string;
  }[],
) {
  return {
    type: 'session.state' as const,
    payload: {
      sessionId: 'test-session-id',
      branch: 'main',
      you: identity.id,
      participants: participants.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        color: p.color,
        currentFile: p.currentFile ?? null,
        agentActiveOn: null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(fakeClient: FakeRelayClient): {
  manager: SessionManager;
  stateChanges: SessionState[];
} {
  const stateChanges: SessionState[] = [];

  const manager = new SessionManager(
    identity,
    config,
    // Ignore opts — always return the fake client
    (): IRelayClient => fakeClient,
    (state) => {
      stateChanges.push(state);
    },
  );

  return { manager, stateChanges };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let fakeClient: FakeRelayClient;

  beforeEach(() => {
    fakeClient = new FakeRelayClient();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. start() transitions to Connecting
  // -------------------------------------------------------------------------

  it('start() transitions to Connecting', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    await manager.start(repoCtx);

    const connectingState = stateChanges.find((s) => s.kind === 'Connecting');
    expect(connectingState).toBeDefined();
    expect(connectingState?.kind).toBe('Connecting');
  });

  // -------------------------------------------------------------------------
  // 2. session.state message transitions to Active
  // -------------------------------------------------------------------------

  it('session.state message transitions to Active', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    await manager.start(repoCtx);

    const participants = [
      { id: 'p1', displayName: 'Alice', color: '#ff0000' },
      { id: 'p2', displayName: 'Bob', color: '#00ff00', currentFile: 'src/index.ts' },
    ];

    fakeClient.emit('message', makeSessionStateMessage(participants));

    const activeState = stateChanges.find((s) => s.kind === 'Active');
    expect(activeState).toBeDefined();
    expect(activeState?.kind).toBe('Active');
    if (activeState?.kind === 'Active') {
      expect(activeState.participants).toHaveLength(2);
      expect(activeState.participants[0]?.displayName).toBe('Alice');
      expect(activeState.participants[1]?.currentFile).toBe('src/index.ts');
    }
  });

  // -------------------------------------------------------------------------
  // 3. join() with invalid link throws
  // -------------------------------------------------------------------------

  it('join() with invalid link throws', async () => {
    const { manager } = makeManager(fakeClient);

    await expect(manager.join('not-a-valid-link', repoCtx)).rejects.toThrow('Invalid invite link');
  });

  // -------------------------------------------------------------------------
  // 4. join() with branch mismatch throws BranchMismatchError
  // -------------------------------------------------------------------------

  it('join() with branch mismatch throws BranchMismatchError', async () => {
    const { manager } = makeManager(fakeClient);

    // Build an invite link for 'other-branch'
    const token = generateInviteToken();
    const sessionId = deriveSessionId({
      remoteUrl: repoCtx.remoteUrl,
      branch: 'other-branch',
      token,
    });
    const link = formatInviteLink({ sessionId, token, branch: 'other-branch' });

    // Join with repoCtx.branch === 'main' — mismatch
    const error = await manager.join(link, { ...repoCtx, branch: 'main' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BranchMismatchError);
    expect((error as BranchMismatchError).requiredBranch).toBe('other-branch');
  });

  // -------------------------------------------------------------------------
  // 5. leave() disconnects and transitions to Idle
  // -------------------------------------------------------------------------

  it('leave() disconnects and transitions to Idle', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    // Start and go Active
    await manager.start(repoCtx);
    fakeClient.emit(
      'message',
      makeSessionStateMessage([{ id: 'p1', displayName: 'Alice', color: '#ff0000' }]),
    );

    const beforeLeave = stateChanges[stateChanges.length - 1];
    expect(beforeLeave?.kind).toBe('Active');

    await manager.leave();

    const afterLeave = stateChanges[stateChanges.length - 1];
    expect(afterLeave?.kind).toBe('Idle');
    expect(fakeClient.connected).toBe(false);

    const leaveMsg = fakeClient.sentMessages.find((m) => m.type === 'session.leave');
    expect(leaveMsg).toBeDefined();
    expect(leaveMsg?.type).toBe('session.leave');

    // No spurious Failed transition should have been emitted (race condition fix)
    const failedState = stateChanges.find((s) => s.kind === 'Failed');
    expect(failedState).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. reconnecting event updates state to Reconnecting
  // -------------------------------------------------------------------------

  it('reconnecting event transitions Active to Reconnecting', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    await manager.start(repoCtx);

    // Go Active first
    fakeClient.emit(
      'message',
      makeSessionStateMessage([{ id: 'p1', displayName: 'Alice', color: '#ff0000' }]),
    );

    const activeState = stateChanges.find((s) => s.kind === 'Active');
    expect(activeState?.kind).toBe('Active');

    // Simulate reconnecting event: (attempt, delayMs)
    fakeClient.emit('reconnecting', 1, 2000);

    const reconnectingState = stateChanges.find((s) => s.kind === 'Reconnecting');
    expect(reconnectingState).toBeDefined();
    expect(reconnectingState?.kind).toBe('Reconnecting');
    if (reconnectingState?.kind === 'Reconnecting') {
      expect(reconnectingState.attempt).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 7. terminal close transitions to Failed
  // -------------------------------------------------------------------------

  it('terminal close code 4401 transitions to Failed', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    await manager.start(repoCtx);

    // Emit a terminal close (4401 = Unauthorized)
    fakeClient.emit('close', 4401, 'Unauthorized');

    const failedState = stateChanges.find((s) => s.kind === 'Failed');
    expect(failedState).toBeDefined();
    expect(failedState?.kind).toBe('Failed');
  });

  // -------------------------------------------------------------------------
  // 8. start() when not Idle throws
  // -------------------------------------------------------------------------

  it('start() when already started throws', async () => {
    const { manager } = makeManager(fakeClient);

    await manager.start(repoCtx);

    // Second start should throw
    await expect(manager.start(repoCtx)).rejects.toThrow('Session already started');
  });

  // -------------------------------------------------------------------------
  // 9. connect() failure transitions to Failed
  // -------------------------------------------------------------------------

  it('connect() failure transitions to Failed', async () => {
    // FakeRelayClient whose connect() rejects
    class RejectingFakeClient extends FakeRelayClient {
      override connect(): Promise<void> {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
    }
    const rejectingClient = new RejectingFakeClient();
    const { manager, stateChanges } = makeManager(rejectingClient);

    await expect(manager.start(repoCtx)).resolves.toBeUndefined();

    // State should be Failed after connect() rejection
    const failedState = stateChanges.find((s) => s.kind === 'Failed');
    expect(failedState).toBeDefined();
    expect(failedState?.kind).toBe('Failed');

    // Manager should be reusable after failure (back to some terminal state)
    // — the state machine allows start() again only from Idle, but Failed is
    // a terminal state here; just verify the transition happened.
    expect(stateChanges.at(-1)?.kind).toBe('Failed');
  });

  // -------------------------------------------------------------------------
  // 10. Reconnecting → Active re-transition
  // -------------------------------------------------------------------------

  it('Reconnecting state transitions back to Active on session.state message', async () => {
    const { manager, stateChanges } = makeManager(fakeClient);

    await manager.start(repoCtx);

    // Go Active first
    fakeClient.emit(
      'message',
      makeSessionStateMessage([{ id: 'p1', displayName: 'Alice', color: '#ff0000' }]),
    );
    expect(stateChanges.find((s) => s.kind === 'Active')).toBeDefined();

    // Simulate reconnecting
    fakeClient.emit('reconnecting', 1, 1000);
    expect(stateChanges.find((s) => s.kind === 'Reconnecting')).toBeDefined();

    // Server reconnects and sends session.state again
    fakeClient.emit(
      'message',
      makeSessionStateMessage([
        { id: 'p1', displayName: 'Alice', color: '#ff0000' },
        { id: 'p2', displayName: 'Bob', color: '#3498db' },
      ]),
    );

    const lastState = stateChanges.at(-1);
    expect(lastState?.kind).toBe('Active');
    if (lastState?.kind === 'Active') {
      expect(lastState.participants).toHaveLength(2);
    }
  });

  // -------------------------------------------------------------------------
  // 11–15. Branch-switch handling (Task 6.5)
  // -------------------------------------------------------------------------

  describe('watchBranch / branch-switch handling', () => {
    /** Helper: start a session and make it Active, then call watchBranch. */
    async function startActiveWithWatch(
      manager: SessionManager,
    ): Promise<{ branchCb: (branch: string) => void }> {
      await manager.start(repoCtx); // repoCtx.branch === 'main'
      fakeClient.emit(
        'message',
        makeSessionStateMessage([{ id: 'p1', displayName: 'Alice', color: '#ff0000' }]),
      );
      const disposables: { dispose(): void }[] = [];
      manager.watchBranch(disposables);
      // watchBranch is async internally — drain microtasks so the callback registers
      await new Promise((r) => setTimeout(r, 0));
      const cb = branchCallbacks[branchCallbacks.length - 1];
      if (cb === undefined) throw new Error('watchBranchChanges was not called');
      return { branchCb: cb };
    }

    beforeEach(() => {
      // Reset captured callbacks before each branch-switch sub-test
      branchCallbacks.length = 0;
    });

    // 11. Branch switch while Active → session.leave with reason 'branch-switch'
    it('sends session.leave with reason "branch-switch" when branch changes while Active', async () => {
      const { manager } = makeManager(fakeClient);
      const { branchCb } = await startActiveWithWatch(manager);

      // Simulate branch change (away from 'main')
      branchCb('feature/other');
      await new Promise((r) => setTimeout(r, 0));

      const leaveMsg = fakeClient.sentMessages.find((m) => m.type === 'session.leave');
      expect(leaveMsg).toBeDefined();
      expect((leaveMsg?.payload as { reason: string }).reason).toBe('branch-switch');
    });

    // 12. Branch switch while Active → manual leave() still sends 'user' reason
    it('leave() still sends reason "user" when called directly', async () => {
      const { manager } = makeManager(fakeClient);
      await manager.start(repoCtx);
      fakeClient.emit(
        'message',
        makeSessionStateMessage([{ id: 'p1', displayName: 'Alice', color: '#ff0000' }]),
      );

      await manager.leave();

      const leaveMsg = fakeClient.sentMessages.find((m) => m.type === 'session.leave');
      expect(leaveMsg).toBeDefined();
      expect((leaveMsg?.payload as { reason: string }).reason).toBe('user');
    });

    // 13. Switching back to session branch → shows rejoin prompt
    it('shows rejoin prompt when switching back to session branch', async () => {
      const vscode = await import('vscode');
      const showInfo = vi.mocked(vscode.window.showInformationMessage);
      // Simulate user clicking "Yes"
      showInfo.mockResolvedValueOnce('Yes' as unknown as undefined);

      const { manager } = makeManager(fakeClient);
      const { branchCb } = await startActiveWithWatch(manager);

      // Switch away
      branchCb('feature/other');
      await new Promise((r) => setTimeout(r, 0));

      // Switch back to 'main'
      branchCb('main');
      await new Promise((r) => setTimeout(r, 0));

      expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('Rejoin'), 'Yes', 'No');
    });

    // 14. Rejoin prompt "Yes" → calls join flow (relay client connects)
    it('rejoins session when user clicks Yes on the rejoin prompt', async () => {
      const vscode = await import('vscode');
      const showInfo = vi.mocked(vscode.window.showInformationMessage);
      showInfo.mockResolvedValueOnce(undefined); // branch-switch info message
      showInfo.mockResolvedValueOnce('Yes' as unknown as undefined); // rejoin prompt

      const { manager } = makeManager(fakeClient);
      const { branchCb } = await startActiveWithWatch(manager);

      branchCb('feature/other');
      await new Promise((r) => setTimeout(r, 0));

      // Must be Idle before rejoining
      branchCb('main');
      await new Promise((r) => setTimeout(r, 20));

      // A new connect should have been attempted — fakeClient.connect is called again
      // (FakeRelayClient.connect resolves immediately and sets connected = true)
      expect(fakeClient.connected).toBe(true);
    });

    // 15. Rejoin prompt "No" → no reconnect attempted
    it('does not rejoin when user clicks No on the rejoin prompt', async () => {
      const vscode = await import('vscode');
      const showInfo = vi.mocked(vscode.window.showInformationMessage);
      showInfo.mockResolvedValueOnce(undefined); // branch-switch info
      showInfo.mockResolvedValueOnce('No' as unknown as undefined); // rejoin → No

      const { manager } = makeManager(fakeClient);
      const { branchCb } = await startActiveWithWatch(manager);

      branchCb('feature/other');
      await new Promise((r) => setTimeout(r, 0));

      fakeClient.connected = false; // reset to detect new connect

      branchCb('main');
      await new Promise((r) => setTimeout(r, 20));

      // No new connection should have been made
      expect(fakeClient.connected).toBe(false);
    });

    // 16. Rejoin offer expires after grace period → return-to-branch no longer shows prompt
    it('does not show rejoin prompt after grace period has elapsed', async () => {
      const vscode = await import('vscode');
      const showInfo = vi.mocked(vscode.window.showInformationMessage);

      const { manager } = makeManager(fakeClient);
      // Start session and attach watcher BEFORE enabling fake timers so async
      // setup (setTimeout(r, 0)) in startActiveWithWatch can resolve normally.
      const { branchCb } = await startActiveWithWatch(manager);

      // Switch to fake timers now that all async setup is complete.
      vi.useFakeTimers();

      branchCb('feature/other');
      // Flush synchronous microtasks; fake timers don't affect Promise ticks.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past grace period (config.gracePeriodSeconds = 1800)
      vi.advanceTimersByTime(1800 * 1000 + 100);

      showInfo.mockClear();

      branchCb('main');
      await Promise.resolve();
      await Promise.resolve();

      // Should NOT show rejoin prompt
      const rejoinCall = showInfo.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('Rejoin'),
      );
      expect(rejoinCall).toBeUndefined();

      vi.useRealTimers();
    });
  });
});

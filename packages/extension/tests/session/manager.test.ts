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
});

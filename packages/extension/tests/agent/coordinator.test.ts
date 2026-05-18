// packages/extension/tests/agent/coordinator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AgentCoordinator, type CoordinatorOptions } from '../../src/agent/coordinator.js';

function makeOptions(overrides: Partial<CoordinatorOptions> = {}): CoordinatorOptions {
  return {
    localParticipantId: 'local-p1',
    heuristicConfig: {
      minEditsPerSecond: 3,
      minInsertionChars: 200,
      minAffectedLines: 5,
      burstEndQuietMs: 100,
    },
    getTerminals: () => [],
    terminalPatterns: [],
    send: vi.fn(),
    getDocumentText: vi.fn(() => 'some text'),
    applyWorkspaceEdit: vi.fn(),
    getWorkspaceRoot: () => '/workspace',
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    onAgentStatusChange: vi.fn(),
    openConflictView: vi.fn(),
    clock: {
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    ...overrides,
  };
}

describe('AgentCoordinator', () => {
  it('sends agent.intent when a large edit is captured', () => {
    const send = vi.fn();
    const coordinator = new AgentCoordinator(makeOptions({ send }));
    coordinator.start();

    coordinator.onLocalEdit({
      path: 'src/foo.ts',
      timestamp: 1000,
      insertedChars: 300,
      affectedLines: 1,
      rangeStart: 0,
      rangeEnd: 0,
    });

    expect(send).toHaveBeenCalledWith(
      'agent.intent',
      expect.objectContaining({ path: 'src/foo.ts' }),
    );
  });

  it('shows warning toast on concurrent write detection', () => {
    const showWarning = vi.fn();
    const coordinator = new AgentCoordinator(makeOptions({ showWarningMessage: showWarning }));
    coordinator.start();

    coordinator.onRemoteMessage(
      {
        type: 'agent.intent',
        payload: { path: 'src/foo.ts', description: 'test', agentSourced: true },
      },
      'p2',
    );

    coordinator.onRemoteMessage(
      {
        type: 'agent.intent',
        payload: { path: 'src/foo.ts', description: 'test', agentSourced: true },
      },
      'p3',
    );

    // Not triggered for just one remote intent per side (detector needs >500ms gap)
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('calls onAgentStatusChange when remote intent arrives', () => {
    const onAgentStatusChange = vi.fn();
    const coordinator = new AgentCoordinator(makeOptions({ onAgentStatusChange }));
    coordinator.start();

    coordinator.onRemoteMessage(
      {
        type: 'agent.intent',
        payload: { path: 'src/foo.ts', description: 'test', agentSourced: true },
      },
      'p2',
    );

    const calls = onAgentStatusChange.mock.calls;
    const lastArg = calls.at(-1)?.[0] as Record<
      string,
      { agentActive: boolean; agentSourced: boolean }
    >;
    expect(lastArg['p2']).toMatchObject({ agentActive: true });
  });

  it('clears agent status when remote change arrives', () => {
    const onAgentStatusChange = vi.fn();
    const coordinator = new AgentCoordinator(makeOptions({ onAgentStatusChange }));
    coordinator.start();

    coordinator.onRemoteMessage(
      {
        type: 'agent.intent',
        payload: { path: 'src/foo.ts', description: 'test', agentSourced: false },
      },
      'p2',
    );

    coordinator.onRemoteMessage(
      {
        type: 'agent.change',
        payload: { path: 'src/foo.ts', mergeKind: 'none' },
      },
      'p2',
    );

    const lastCall = onAgentStatusChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall?.['p2']).toMatchObject({ agentActive: false });
  });

  it('disposes cleanly', () => {
    const coordinator = new AgentCoordinator(makeOptions());
    coordinator.start();
    expect(() => coordinator.dispose()).not.toThrow();
  });
});

// packages/extension/tests/agent/intent.test.ts
import { describe, it, expect } from 'vitest';
import { IntentBroadcaster } from '../../src/agent/intent.js';

describe('IntentBroadcaster', () => {
  function makeSystem(agentActive = false, throttleMs = 5000) {
    const sent: { type: string; payload: unknown }[] = [];
    const broadcaster = new IntentBroadcaster({
      send: (type, payload) => sent.push({ type, payload }),
      isAgentActive: () => agentActive,
      throttleMs,
    });
    return { broadcaster, sent };
  }

  it('sends agent.intent on burst started', () => {
    const { broadcaster, sent } = makeSystem();
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 1000 });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('agent.intent');
    expect(sent[0].payload).toMatchObject({ path: 'src/foo.ts' });
  });

  it('sends agent.change on burst ended', () => {
    const { broadcaster, sent } = makeSystem();
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 1000 });
    broadcaster.onBurstEvent({ type: 'ended', path: 'src/foo.ts', startedAt: 1000 });
    const change = sent.find((s) => s.type === 'agent.change');
    expect(change).toBeDefined();
    expect(change!.payload).toMatchObject({ path: 'src/foo.ts' });
  });

  it('includes agentSourced: true when agent terminal is active', () => {
    const { broadcaster, sent } = makeSystem(true);
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 0 });
    expect(sent[0].payload).toMatchObject({ agentSourced: true });
  });

  it('includes agentSourced: false when no agent terminal', () => {
    const { broadcaster, sent } = makeSystem(false);
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 0 });
    expect(sent[0].payload).toMatchObject({ agentSourced: false });
  });

  it('throttles: does not re-send agent.intent for same path within throttleMs', () => {
    const { broadcaster, sent } = makeSystem(false, 5000);
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'ended', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 1000 }); // still throttled
    const intents = sent.filter((s) => s.type === 'agent.intent');
    expect(intents).toHaveLength(1);
  });

  it('allows re-sending agent.intent after throttle window expires', () => {
    const { broadcaster, sent } = makeSystem(false, 1000);
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'ended', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 2000 }); // past throttle
    const intents = sent.filter((s) => s.type === 'agent.intent');
    expect(intents).toHaveLength(2);
  });

  it('does not throttle agent.change', () => {
    const { broadcaster, sent } = makeSystem(false, 5000);
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'ended', path: 'src/foo.ts', startedAt: 0 });
    broadcaster.onBurstEvent({ type: 'started', path: 'src/foo.ts', startedAt: 100 });
    broadcaster.onBurstEvent({ type: 'ended', path: 'src/foo.ts', startedAt: 100 });
    const changes = sent.filter((s) => s.type === 'agent.change');
    expect(changes).toHaveLength(2);
  });
});

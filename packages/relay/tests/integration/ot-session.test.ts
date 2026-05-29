/**
 * Integration tests for the CoVibes relay — Task 7.1.
 *
 * Scenarios 7–10 extend the existing suite in scenarios.test.ts with four
 * additional test cases covering OT sequencing, agent intent routing,
 * coordinated git operation routing, and conflict routing.
 *
 * Each scenario spins up its own server instance and uses unique
 * sessionId/token pairs to prevent cross-test interference.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { connectClient, type RelayClient } from '../helpers/wsClient.js';
import type { AnyDecodedMessage } from '@covibes/protocol';
import { MemorySessionStore } from '../../src/sessionStore.memory.js';
import { SessionRegistryImpl } from '../../src/sessionRegistry.impl.js';
import { RelayServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';

interface Ctx {
  baseUrl: string;
  stop: () => Promise<void>;
}

const openClients: RelayClient[] = [];

function track(c: RelayClient): RelayClient {
  openClients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    await c.close().catch(() => {});
  }
});

async function setup(): Promise<Ctx> {
  const config = loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const logger = createLogger(config);
  const store = new MemorySessionStore();
  const registry = new SessionRegistryImpl({
    store,
    config: { maxParticipants: 4, sessionGraceMs: 30_000 },
  });
  const server = new RelayServer({ config, logger, registry });
  const port = await server.start();
  return {
    baseUrl: `ws://127.0.0.1:${port}/ws`,
    stop: async () => {
      await server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 7 — OT sequencing: concurrent doc.delta ops are sequenced and acked
// ---------------------------------------------------------------------------

describe('Scenario 7 — OT sequencing: concurrent doc.delta', () => {
  it('sequences concurrent ops from two clients and acks each', async () => {
    const ctx = await setup();
    try {
      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'ot-sess-1',
          token: 'tok-ot-1',
          branch: 'main',
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'ot-sess-1',
          token: 'tok-ot-1',
          branch: 'main',
          user: 'bob',
          color: '#0000ff',
        }),
      );

      await A.recv((m) => m.type === 'session.state');
      await B.recv((m) => m.type === 'session.state');

      // Both send doc.delta at baseVersion=0 (concurrent)
      A.sendEnvelope('doc.delta', { path: 'src/app.ts', baseVersion: 0, op: [3, 'hello'] });
      B.sendEnvelope('doc.delta', { path: 'src/app.ts', baseVersion: 0, op: [1, ' world'] });

      // Both should receive a doc.ack for their own op
      const ackA = await A.recv((m: AnyDecodedMessage) => m.type === 'doc.ack', 1000);
      const ackB = await B.recv((m: AnyDecodedMessage) => m.type === 'doc.ack', 1000);
      expect((ackA.payload as { serverVersion: number }).serverVersion).toBeGreaterThanOrEqual(1);
      expect((ackB.payload as { serverVersion: number }).serverVersion).toBeGreaterThanOrEqual(1);

      // Each client receives the other's transformed op
      await A.recv((m: AnyDecodedMessage) => m.type === 'doc.delta', 1000);
      await B.recv((m: AnyDecodedMessage) => m.type === 'doc.delta', 1000);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Agent intent routing
// ---------------------------------------------------------------------------

describe('Scenario 8 — agent intent routing', () => {
  it('agent.intent from A is forwarded to B but not echoed to A', async () => {
    const ctx = await setup();
    try {
      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'agent-sess-1',
          token: 'tok-ag-1',
          branch: 'main',
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'agent-sess-1',
          token: 'tok-ag-1',
          branch: 'main',
          user: 'bob',
          color: '#0000ff',
        }),
      );

      await A.recv((m) => m.type === 'session.state');
      await B.recv((m) => m.type === 'session.state');

      A.sendEnvelope('agent.intent', {
        path: 'src/auth.ts',
        description: 'agent is modifying this file',
      });

      const msg = await B.recv((m: AnyDecodedMessage) => m.type === 'agent.intent', 500);
      expect((msg.payload as { path: string }).path).toBe('src/auth.ts');

      // A must NOT receive its own intent echo
      await A.expectNoMessage(150);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Coordinated git.operation routing
// ---------------------------------------------------------------------------

describe('Scenario 9 — git.operation routing', () => {
  it('git.operation from A is forwarded to B; git.ack from B is forwarded to A', async () => {
    const ctx = await setup();
    try {
      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'git-sess-1',
          token: 'tok-git-1',
          branch: 'main',
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'git-sess-1',
          token: 'tok-git-1',
          branch: 'main',
          user: 'bob',
          color: '#0000ff',
        }),
      );

      await A.recv((m) => m.type === 'session.state');
      await B.recv((m) => m.type === 'session.state');

      // A initiates a commit using a fixed envelope id so B can echo it back
      const opId = '550e8400-e29b-41d4-a716-446655440000';
      A.sendEnvelope('git.operation', { kind: 'commit', message: 'add feature' }, { id: opId });

      const opMsg = await B.recv((m: AnyDecodedMessage) => m.type === 'git.operation', 500);
      expect((opMsg.payload as { kind: string }).kind).toBe('commit');

      // B acks using the envelope id as operationId
      B.sendEnvelope('git.ack', {
        operationId: opMsg.envelope.id,
        accepted: true,
      });

      const ackMsg = await A.recv((m: AnyDecodedMessage) => m.type === 'git.ack', 500);
      expect((ackMsg.payload as { accepted: boolean }).accepted).toBe(true);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — Conflict routing
//
// NOTE: `conflict.open` is server-originated; clients cannot send it. The
// routable type for conflict resolution is `conflict.resolve`. This scenario
// verifies that a `conflict.resolve` sent by B is forwarded to A (and not
// echoed back to B).
// ---------------------------------------------------------------------------

describe('Scenario 10 — conflict.resolve routing', () => {
  it('conflict.resolve from B is forwarded to A but not echoed to B', async () => {
    const ctx = await setup();
    try {
      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'conflict-sess-1',
          token: 'tok-cf-1',
          branch: 'main',
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'conflict-sess-1',
          token: 'tok-cf-1',
          branch: 'main',
          user: 'bob',
          color: '#0000ff',
        }),
      );

      await A.recv((m) => m.type === 'session.state');
      await B.recv((m) => m.type === 'session.state');

      const conflictId = '660e8400-e29b-41d4-a716-446655440000';

      // B resolves a conflict; the resolution is forwarded to A
      B.sendEnvelope('conflict.resolve', {
        conflictId,
        resolvedText: 'merged version',
        confirmedBy: [],
      });

      const resolveMsg = await A.recv((m: AnyDecodedMessage) => m.type === 'conflict.resolve', 500);
      expect((resolveMsg.payload as { conflictId: string }).conflictId).toBe(conflictId);

      // B must NOT receive its own resolution echo
      await B.expectNoMessage(150);
    } finally {
      await ctx.stop();
    }
  });
});

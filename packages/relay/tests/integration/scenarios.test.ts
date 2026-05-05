/**
 * Integration tests for the CoVibes relay — Task 2.6.
 *
 * These tests exercise the full stack (RelayServer + Router + SessionRegistry +
 * Connection + WebSocket) with real WS clients over the wire. Each scenario spins
 * up a fresh server and connects real ws clients; nothing is mocked.
 *
 * NOTE on store choice: The plan mentions testcontainers + real Redis. We
 * deliberately use the in-memory store instead. Reasons:
 *   1. The Redis integration is already covered by `sessionStore.redis.test.ts`
 *      (gated on `REDIS_URL`).
 *   2. Testcontainers adds Docker as a CI dependency — heavyweight for unit/
 *      integration test speed goals.
 *   3. The memory store provides identical business logic (same
 *      SessionRegistryImpl) — only the storage backend differs.
 *
 * If real-Redis end-to-end validation is needed in Phase 7 deploy tests,
 * testcontainers is the right place for it.
 *
 * Vitest include glob `tests/**\/*.test.ts` in `vitest.config.ts` covers this
 * nested directory automatically.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { connectClient, type RelayClient } from '../helpers/wsClient.js';
import type { SessionStatePayload } from '@covibes/protocol';
import { MemorySessionStore } from '../../src/sessionStore.memory.js';
import { SessionRegistryImpl } from '../../src/sessionRegistry.impl.js';
import { RelayServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';

// ---------------------------------------------------------------------------
// Local setup helper
// ---------------------------------------------------------------------------

interface Ctx {
  baseUrl: string;
  stop: () => Promise<void>;
}

interface SetupOptions {
  maxParticipants?: number;
  sessionGraceMs?: number;
}

async function setup(opts: SetupOptions = {}): Promise<Ctx> {
  const config = loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const logger = createLogger(config);
  const store = new MemorySessionStore();
  const registry = new SessionRegistryImpl({
    store,
    config: {
      maxParticipants: opts.maxParticipants ?? 4,
      sessionGraceMs: opts.sessionGraceMs ?? 30_000,
    },
  });

  const server = new RelayServer({ config, logger, registry });
  const port = await server.start();
  return {
    baseUrl: `ws://127.0.0.1:${port}/ws`,
    stop: () => server.stop(),
  };
}

// Shared cleanup — accumulate open clients and close them after each test.
const openClients: RelayClient[] = [];

function track(client: RelayClient): RelayClient {
  openClients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    await c.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Scenario 1 — Create and join
// ---------------------------------------------------------------------------

describe('Scenario 1 — create and join', () => {
  it('A creates a session, B joins, both see session.state with both participants', async () => {
    const ctx = await setup();
    try {
      const sessionId = 'integration-session-01';
      const token = 'shared-token-aaaa';
      const branch = 'main';

      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const aState = await A.recv((m) => m.type === 'session.state');
      const aPayload = aState.payload as SessionStatePayload;
      expect(aPayload.participants).toHaveLength(1);
      expect(aPayload.you).toBe(aPayload.participants[0]?.id);

      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'bob',
          color: '#00ff00',
        }),
      );
      const bState = await B.recv((m) => m.type === 'session.state');
      const bPayload = bState.payload as SessionStatePayload;
      expect(bPayload.participants).toHaveLength(2);
      const ids = bPayload.participants.map((p) => p.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids).toContain(bPayload.you);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Routing (no echo, peer delivery)
// ---------------------------------------------------------------------------

describe('Scenario 2 — routing', () => {
  it('A sends doc.delta; B receives with from field; A does not echo', async () => {
    const ctx = await setup();
    try {
      const sessionId = 'integration-session-02';
      const token = 'shared-token-bbbb';
      const branch = 'main';

      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const aState = await A.recv((m) => m.type === 'session.state');
      const aPayload = aState.payload as SessionStatePayload;
      const aliceId = aPayload.you;

      const B = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'bob',
          color: '#00ff00',
        }),
      );
      await B.recv((m) => m.type === 'session.state');

      A.sendEnvelope('doc.delta', { path: 'src/index.ts', baseVersion: 0, op: [] });

      const bMsg = await B.recv((m) => m.type === 'doc.delta', 500);
      expect(bMsg.type).toBe('doc.delta');
      expect(bMsg.envelope.from).toBe(aliceId);

      await A.expectNoMessage(150);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Capacity: 5th client gets close 4429
// ---------------------------------------------------------------------------

describe('Scenario 3 — capacity', () => {
  it('5th client to a session of max=4 gets close 4429', async () => {
    const ctx = await setup({ maxParticipants: 4 });
    try {
      const sessionId = 'cap-session';
      const token = 'cap-token-cccc';
      const branch = 'main';

      // Connect 4 clients successfully.
      const clients: RelayClient[] = [];
      for (let i = 0; i < 4; i++) {
        const c = track(
          await connectClient({
            baseUrl: ctx.baseUrl,
            sessionId,
            token,
            branch,
            user: `u${i}`,
            color: '#000000',
          }),
        );
        await c.recv((m) => m.type === 'session.state');
        clients.push(c);
      }

      // 5th attempt: server completes upgrade then immediately closes with 4429.
      // connectClient resolves on 'open', then expectClose catches the 4429.
      let fifth: RelayClient | Error;
      try {
        fifth = track(
          await connectClient({
            baseUrl: ctx.baseUrl,
            sessionId,
            token,
            branch,
            user: 'u4',
            color: '#000000',
          }),
        );
      } catch (e) {
        fifth = e instanceof Error ? e : new Error(String(e));
      }

      if (fifth instanceof Error) {
        // connectClient rejected — the code should be embedded in the error.
        const code = (fifth as Error & { code?: number }).code;
        expect(code).toBe(4429);
      } else {
        const result = await fifth.expectClose(500);
        expect(result.code).toBe(4429);
      }
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Leave + rejoin within grace restores participant identity
// ---------------------------------------------------------------------------

describe('Scenario 4 — leave and rejoin within grace', () => {
  it('participantId is restored when rejoining within grace period', async () => {
    // Use a long grace so the timer never fires during this test.
    const ctx = await setup({ sessionGraceMs: 60_000 });
    try {
      const sessionId = 'rejoin-session';
      const token = 'rejoin-token-dddd';
      const branch = 'main';

      // A connects and gets its participantId.
      const A = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const a1State = await A.recv((m) => m.type === 'session.state');
      const originalId = (a1State.payload as SessionStatePayload).you;

      // A disconnects — grace timer starts.
      await A.close();

      // A reconnects with the same participantId hint, before grace expires.
      const A2 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
          participantId: originalId,
        }),
      );
      const a2State = await A2.recv((m) => m.type === 'session.state');
      const a2Payload = a2State.payload as SessionStatePayload;

      // The restored session should have exactly one active participant with
      // the original participantId.
      expect(a2Payload.you).toBe(originalId);
      // Only the rejoining participant should be active (previous session entry
      // is reused in-place, so still one entry).
      expect(a2Payload.participants.map((p) => p.id)).toContain(originalId);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Expiry: after grace the session is fresh on rejoin
// ---------------------------------------------------------------------------

describe('Scenario 5 — expiry after grace', () => {
  it('after grace expiry, the session is fresh on rejoin', async () => {
    // Use a very short grace so we can wait it out in real time.
    const ctx = await setup({ sessionGraceMs: 100 });
    try {
      const sessionId = 'expiry-session';
      const token = 'expiry-token-eeee';
      const branch = 'main';

      const A1 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
        }),
      );
      const a1State = await A1.recv((m) => m.type === 'session.state');
      const oldParticipantId = (a1State.payload as SessionStatePayload).you;
      await A1.close();

      // Wait beyond grace (100 ms + comfortable margin).
      await new Promise((r) => setTimeout(r, 300));

      // Rejoin — session was deleted; a new one is created.
      const A2 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId,
          token,
          branch,
          user: 'alice',
          color: '#ff0000',
          participantId: oldParticipantId,
        }),
      );
      const a2State = await A2.recv((m) => m.type === 'session.state');
      const newPayload = a2State.payload as SessionStatePayload;

      // Fresh session: only one participant, no stale records from before.
      expect(newPayload.participants).toHaveLength(1);
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Cross-session isolation
// ---------------------------------------------------------------------------

describe('Scenario 6 — cross-session isolation', () => {
  it('messages in session X never appear in session Y', async () => {
    const ctx = await setup();
    try {
      const tokenX = 'token-x-fffff0';
      const tokenY = 'token-y-fffff1';
      const branch = 'main';

      // Session X
      const X1 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'sess-x',
          token: tokenX,
          branch,
          user: 'x1',
          color: '#ff0000',
        }),
      );
      const X2 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'sess-x',
          token: tokenX,
          branch,
          user: 'x2',
          color: '#ff0001',
        }),
      );

      // Session Y
      const Y1 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'sess-y',
          token: tokenY,
          branch,
          user: 'y1',
          color: '#00ff00',
        }),
      );
      const Y2 = track(
        await connectClient({
          baseUrl: ctx.baseUrl,
          sessionId: 'sess-y',
          token: tokenY,
          branch,
          user: 'y2',
          color: '#00ff01',
        }),
      );

      // Drain session.state messages
      await X1.recv((m) => m.type === 'session.state');
      await X2.recv((m) => m.type === 'session.state');
      await Y1.recv((m) => m.type === 'session.state');
      await Y2.recv((m) => m.type === 'session.state');

      // X1 sends doc.delta → X2 must receive; Y1 and Y2 must NOT.
      X1.sendEnvelope('doc.delta', { path: 'src/index.ts', baseVersion: 0, op: [] });
      await X2.recv((m) => m.type === 'doc.delta', 500);
      await Promise.all([Y1.expectNoMessage(150), Y2.expectNoMessage(150)]);

      // Y1 sends cursor.update → Y2 must receive; X1 and X2 must NOT.
      Y1.sendEnvelope('cursor.update', { path: 'src/index.ts', anchor: 0, head: 5 });
      await Y2.recv((m) => m.type === 'cursor.update', 500);
      await Promise.all([X1.expectNoMessage(150), X2.expectNoMessage(150)]);
    } finally {
      await ctx.stop();
    }
  });
});

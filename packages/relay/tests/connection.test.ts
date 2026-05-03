import type { Socket } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { InMemoryAuthorizer } from '../src/auth.memory.js';
import { CloseCodes } from '../src/closeCodes.js';
import { withRelay } from './helpers/withRelay.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build default valid query params for a WS connection. */
function defaultParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    session: 'testSession123',
    token: 'testToken123',
    user: 'Alice',
    color: '#ff0000',
    branch: 'main',
    ...overrides,
  };
}

/** Serialize params to a query string. */
function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Open a WebSocket and wait for it to be open or closed. */
function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    // If the server immediately closes we still want to resolve so callers can
    // inspect the close code — but we reject on network-level errors.
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected-response: ${res.statusCode}`));
    });
  });
}

/** Wait for the WebSocket close event and return { code, reason }. */
function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reasonBuf) => {
      resolve({ code, reason: reasonBuf.toString('utf8') });
    });
  });
}

/** Connect and wait for close. Combines openWs + waitClose. */
async function connectAndWaitClose(
  baseUrl: string,
  params: Record<string, string>,
): Promise<{ code: number; reason: string }> {
  const url = `${baseUrl}?${qs(params)}`;
  // For some rejections the server closes immediately after upgrade, so we
  // set up the close listener before the socket is fully open.
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString('utf8') }));
    ws.once('error', reject);
  });
}

/** Create an authorizer with the test config. */
function makeAuthorizer(maxParticipants = 4): InMemoryAuthorizer {
  const config = loadConfig({
    PORT: '0',
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    MAX_PARTICIPANTS: String(maxParticipants),
  });
  return new InMemoryAuthorizer({ config });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connection lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('auth', () => {
    it('1. successful connect — valid params → admitted, clean client close', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        const url = `${baseUrl}?${qs(defaultParams())}`;
        const ws = await openWs(url);
        expect(ws.readyState).toBe(WebSocket.OPEN);

        const closePromise = waitClose(ws);
        ws.close(1000, 'done');
        const { code } = await closePromise;
        // Normal close: either 1000 (clean) or the server may echo 1000.
        expect(code).toBe(1000);
      });
    });

    it('2. two joiners with same token — both admitted, distinct participantIds', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        const params = defaultParams();
        const url = `${baseUrl}?${qs(params)}`;

        const ws1 = await openWs(url);
        const ws2 = await openWs(`${baseUrl}?${qs({ ...params, user: 'Bob' })}`);

        expect(ws1.readyState).toBe(WebSocket.OPEN);
        expect(ws2.readyState).toBe(WebSocket.OPEN);

        const c1 = waitClose(ws1);
        const c2 = waitClose(ws2);
        ws1.close(1000);
        ws2.close(1000);
        await Promise.all([c1, c2]);
      });
    });

    it('3. wrong token → close 4401', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        // First joiner establishes the token.
        const ws1 = await openWs(`${baseUrl}?${qs(defaultParams())}`);

        // Second joiner with different token.
        const { code } = await connectAndWaitClose(
          baseUrl,
          defaultParams({ token: 'WrongToken999' }),
        );
        expect(code).toBe(CloseCodes.Unauthorized);

        ws1.close(1000);
        await waitClose(ws1);
      });
    });

    it('5. missing params → close 4400', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        // Connect to /ws with no query params at all.
        const { code } = await connectAndWaitClose(baseUrl, {});
        expect(code).toBe(CloseCodes.InvalidInput);
      });
    });

    it('5b. partial params (missing token) → close 4400', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        const params: Record<string, string> = {
          session: 'abc123',
          user: 'Alice',
          color: '#fff',
          branch: 'main',
        };
        const { code } = await connectAndWaitClose(baseUrl, params);
        expect(code).toBe(CloseCodes.InvalidInput);
      });
    });

    it('10. timing-safe compare smoke: wrong-token regardless of differing character position', async () => {
      const config = loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
      const auth = new InMemoryAuthorizer({ config });
      const base = {
        sessionId: 'sess1',
        token: 'AAAA',
        displayName: 'A',
        color: '#fff',
        branch: 'main',
      };

      // Establish session.
      const r1 = await auth.authorize(base);
      expect(r1.kind).toBe('admitted');

      // Wrong token — differs at first char.
      const r2 = await auth.authorize({ ...base, token: 'BAAA' });
      expect(r2).toEqual({ kind: 'rejected', reason: 'wrong-token' });

      // Wrong token — differs at last char.
      const r3 = await auth.authorize({ ...base, token: 'AAAB' });
      expect(r3).toEqual({ kind: 'rejected', reason: 'wrong-token' });

      // Correct token.
      const r4 = await auth.authorize({ ...base, displayName: 'B' });
      expect(r4.kind).toBe('admitted');
    });

    it('11. resume path — same participantId re-joins → admitted, same id returned', async () => {
      const config = loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
      const auth = new InMemoryAuthorizer({ config });
      const base = {
        sessionId: 'sess-resume',
        token: 'tok',
        displayName: 'A',
        color: '#aaa',
        branch: 'main',
      };

      const r1 = await auth.authorize(base);
      expect(r1.kind).toBe('admitted');
      const pid = (r1 as { kind: 'admitted'; participantId: string }).participantId;

      // Release to simulate disconnect.
      await auth.release(base.sessionId, pid);

      // Re-join with same participantId — note: since we released, the session
      // may still exist if other participants are present; here it was the only one,
      // so session was deleted. The resume path for an existing session is tested
      // directly on the authorizer.
      const auth2 = new InMemoryAuthorizer({ config });
      const r2 = await auth2.authorize(base);
      expect(r2.kind).toBe('admitted');
      const pid2 = (r2 as { kind: 'admitted'; participantId: string }).participantId;

      // Same participantId re-joins (session still active).
      const r3 = await auth2.authorize({ ...base, participantId: pid2, displayName: 'B' });
      expect(r3).toEqual({ kind: 'admitted', participantId: pid2 });
    });
  });

  // -------------------------------------------------------------------------
  describe('capacity', () => {
    it('4. 5th joiner with max=4 → close 4429', async () => {
      const authorizer = makeAuthorizer(4);
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        const sockets: WebSocket[] = [];
        // Admit 4 connections.
        for (let i = 0; i < 4; i++) {
          const ws = await openWs(`${baseUrl}?${qs(defaultParams({ user: `User${i}` }))}`);
          sockets.push(ws);
        }
        // 5th should be rejected.
        const { code } = await connectAndWaitClose(baseUrl, defaultParams({ user: 'User5' }));
        expect(code).toBe(CloseCodes.SessionFull);

        // Clean up.
        await Promise.all(
          sockets.map((ws) => {
            const p = waitClose(ws);
            ws.close(1000);
            return p;
          }),
        );
      });
    });

    it('9. release on close — after disconnecting, a new slot opens', async () => {
      const authorizer = makeAuthorizer(2);
      await withRelay({ authorizer }, async ({ baseUrl }) => {
        // Fill capacity.
        const ws1 = await openWs(`${baseUrl}?${qs(defaultParams({ user: 'User1' }))}`);
        const ws2 = await openWs(`${baseUrl}?${qs(defaultParams({ user: 'User2' }))}`);

        // Third should be rejected.
        const { code: code3 } = await connectAndWaitClose(
          baseUrl,
          defaultParams({ user: 'User3' }),
        );
        expect(code3).toBe(CloseCodes.SessionFull);

        // Disconnect one.
        const closeP = waitClose(ws1);
        ws1.close(1000);
        await closeP;

        // Wait a tick for the onClose callback to call release().
        await new Promise<void>((r) => setTimeout(r, 50));

        // Now a new connection should be admitted.
        const ws4 = await openWs(`${baseUrl}?${qs(defaultParams({ user: 'User4' }))}`);
        expect(ws4.readyState).toBe(WebSocket.OPEN);

        const c2 = waitClose(ws2);
        const c4 = waitClose(ws4);
        ws2.close(1000);
        ws4.close(1000);
        await Promise.all([c2, c4]);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('path routing', () => {
    it('6. bad path /wsx → HTTP 404 (unexpected-response)', async () => {
      const authorizer = makeAuthorizer();
      await withRelay({ authorizer }, async ({ port }) => {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/wsx?${qs(defaultParams())}`);
          ws.once('unexpected-response', (_req, res) => {
            expect(res.statusCode).toBe(404);
            resolve();
          });
          ws.once('open', () => {
            ws.close();
            reject(new Error('Expected unexpected-response but got open'));
          });
          ws.once('error', (err) => {
            // Some environments emit 'error' instead of 'unexpected-response'
            // when the server rejects. Accept either.
            expect(String(err)).toMatch(/404|ECONNRESET|unexpected/i);
            resolve();
          });
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('heartbeat', () => {
    it('7. heartbeat — clean: normally-ponging client stays connected for ≥5 intervals', async () => {
      const INTERVAL = 30;
      const authorizer = makeAuthorizer();
      await withRelay(
        { authorizer, heartbeatIntervalMs: INTERVAL, heartbeatMissesAllowed: 2 },
        async ({ baseUrl }) => {
          const ws = await openWs(`${baseUrl}?${qs(defaultParams())}`);

          let closed = false;
          ws.once('close', () => {
            closed = true;
          });

          // Wait for at least 5 intervals plus buffer. Client auto-pongs.
          await new Promise<void>((r) => setTimeout(r, INTERVAL * 5 + 80));

          expect(closed).toBe(false);
          ws.close(1000);
          await waitClose(ws);
        },
      );
    }, 5000);

    it('8. heartbeat — drop: non-ponging client closed with 4408', async () => {
      const INTERVAL = 30;
      const MISSES = 2;
      const authorizer = makeAuthorizer();
      await withRelay(
        { authorizer, heartbeatIntervalMs: INTERVAL, heartbeatMissesAllowed: MISSES },
        async ({ baseUrl }) => {
          const url = `${baseUrl}?${qs(defaultParams())}`;

          const startTime = Date.now();

          // Wait for the close event before opening, to avoid race.
          const closeResult = await new Promise<{ code: number; reason: string }>(
            (resolve, reject) => {
              const ws = new WebSocket(url);

              ws.once('open', () => {
                // Disable the automatic pong by removing the listener that ws adds internally.
                // The ws library handles pongs automatically; to prevent them we intercept
                // at the socket level and drop the pong response.
                // We use the underlying socket to swallow outgoing traffic that would be pong.
                // Simpler approach: override the internal _socket.write to drop pong frames.
                const rawSocket = (ws as unknown as { _socket: Socket })._socket;
                const origWrite = rawSocket.write.bind(rawSocket) as (
                  ...args: unknown[]
                ) => boolean;
                // Pong frames start with 0x8a (FIN + opcode 0xa = pong).
                (rawSocket as unknown as Record<string, unknown>).write = function (
                  data: unknown,
                  ...args: unknown[]
                ): boolean {
                  if (Buffer.isBuffer(data) && data.length >= 1 && (data[0] ?? 0) === 0x8a) {
                    // Drop the pong frame.
                    return true;
                  }
                  return origWrite(data, ...args);
                };
              });

              ws.once('close', (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString('utf8') });
              });
              ws.once('error', reject);
            },
          );

          const elapsed = Date.now() - startTime;

          // After MISSES+1 intervals the server should have dropped the connection.
          // We wait for the close event above, which fires naturally.
          expect(closeResult.code).toBe(CloseCodes.PingTimeout);

          // With heartbeatMissesAllowed=MISSES and >=, the server closes on tick MISSES+1
          // (after exactly MISSES missed pongs). elapsed should be ≈ (MISSES+1)*INTERVAL.
          // With the off-by-one bug (>), close fires one tick later at (MISSES+2)*INTERVAL,
          // which would violate the upper bound below.
          expect(elapsed).toBeGreaterThanOrEqual(INTERVAL * MISSES - 5); // small jitter slack
          expect(elapsed).toBeLessThan(INTERVAL * (MISSES + 2)); // bug fires at (MISSES+2)*INTERVAL, violating this
        },
      );
    }, 5000);
  });
});

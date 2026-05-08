/**
 * Tests for RelayClient.
 *
 * Uses an in-process WebSocketServer on localhost:0 (OS assigns port) to
 * simulate the relay server.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { type WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { encode, decode } from '@covibes/protocol';
import { RelayClient, type RelayClientOptions } from '../../src/relay/client.js';

// --------------------------------------------------------------------------
// Test server helper
// --------------------------------------------------------------------------

interface TestServer {
  wss: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}

/** Convert ws RawData to string safely, avoiding no-base-to-string lint errors. */
function rawToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return Buffer.concat(data).toString('utf-8');
}

function createTestServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Unexpected server address'));
        return;
      }
      const port = addr.port;

      const close = (): Promise<void> =>
        new Promise((res, rej) => {
          // Close all open sockets
          wss.clients.forEach((ws) => ws.terminate());
          wss.close((err) => {
            if (err != null) {
              rej(err);
              return;
            }
            httpServer.close((err2) => {
              if (err2 != null) rej(err2);
              else res();
            });
          });
        });

      resolve({ wss, port, close });
    });

    httpServer.on('error', reject);
  });
}

function makeClientOpts(
  port: number,
  overrides: Partial<RelayClientOptions> = {},
): RelayClientOptions {
  return {
    sessionId: 'test-session',
    participantId: 'test-participant',
    displayName: 'Test User',
    token: 'test-token',
    relayUrl: `ws://127.0.0.1:${port}`,
    branch: 'main',
    color: '#aabbcc',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

let server: TestServer | null = null;

afterEach(async () => {
  if (server !== null) {
    await server.close();
    server = null;
  }
});

describe('RelayClient', () => {
  it('connect: client connects and server receives session.join, client emits connected', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    const serverMessages: string[] = [];
    const serverConnected = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          serverMessages.push(rawToString(data));
          resolve();
        });
      });
    });

    const client = new RelayClient(makeClientOpts(port));
    const connectedEmitted = new Promise<void>((resolve) => {
      client.once('connected', () => resolve());
    });

    await client.connect();
    await connectedEmitted;
    await serverConnected;

    expect(serverMessages.length).toBeGreaterThan(0);
    const firstMsg = serverMessages[0];
    expect(firstMsg).toBeDefined();
    const decoded = decode(firstMsg!);
    expect(decoded.type).toBe('session.join');

    await client.disconnect();
  });

  it('message flow: server sends cursor.update, client emits message event with decoded payload', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    let serverSocket: WsWebSocket | null = null;
    wss.on('connection', (ws) => {
      serverSocket = ws;
    });

    const client = new RelayClient(makeClientOpts(port));
    await client.connect();

    // Wait for server socket to be assigned
    await vi.waitFor(() => {
      expect(serverSocket).not.toBeNull();
    });

    const messageReceived = new Promise<ReturnType<typeof decode>>((resolve) => {
      client.once('message', (msg) => resolve(msg));
    });

    // Server sends a cursor.update message
    const wireMsg = encode('cursor.update', {
      path: 'src/index.ts',
      anchor: 10,
      head: 20,
    });
    serverSocket!.send(wireMsg);

    const msg = await messageReceived;
    expect(msg.type).toBe('cursor.update');
    if (msg.type === 'cursor.update') {
      expect(msg.payload.path).toBe('src/index.ts');
      expect(msg.payload.anchor).toBe(10);
      expect(msg.payload.head).toBe(20);
    }

    await client.disconnect();
  });

  it('send: client sends session.leave, server receives and decodes it', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    const serverMessages: string[] = [];
    // First message is always session.join — we want the second
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        serverMessages.push(rawToString(data));
      });
    });

    const client = new RelayClient(makeClientOpts(port));
    await client.connect();

    // Send a session.leave (separate from the disconnect's leave)
    client.send('session.leave', { reason: 'user' });

    // Wait for server to receive it
    await vi.waitFor(() => {
      expect(serverMessages.length).toBeGreaterThanOrEqual(2);
    });

    // The second message should be our session.leave
    const leaveMsg = serverMessages[1];
    expect(leaveMsg).toBeDefined();
    const decoded = decode(leaveMsg!);
    expect(decoded.type).toBe('session.leave');
    if (decoded.type === 'session.leave') {
      expect(decoded.payload.reason).toBe('user');
    }

    await client.disconnect();
  });

  it('drop + reconnect: server closes with code 1006 (abnormal), client reconnects and sends session.join again', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    const sessionJoinCount = { value: 0 };
    const connections: WsWebSocket[] = [];

    wss.on('connection', (ws) => {
      connections.push(ws);
      ws.on('message', (data) => {
        const msg = rawToString(data);
        try {
          const decoded = decode(msg);
          if (decoded.type === 'session.join') {
            sessionJoinCount.value++;
          }
        } catch {
          // ignore
        }
      });
    });

    const client = new RelayClient(
      makeClientOpts(port, {
        reconnect: { initialDelayMs: 50, maxDelayMs: 500, jitterFactor: 0 },
      }),
    );

    const reconnectingEmitted = new Promise<void>((resolve) => {
      client.once('reconnecting', () => resolve());
    });

    await client.connect();

    // Initial session.join received
    await vi.waitFor(() => {
      expect(sessionJoinCount.value).toBe(1);
    });

    // Simulate abnormal closure from server side — code 1006 cannot be sent directly
    // but we can terminate the connection which triggers abnormal close on client
    expect(connections[0]).toBeDefined();
    connections[0]!.terminate();

    // Wait for reconnecting event
    await reconnectingEmitted;

    // Wait for second session.join
    await vi.waitFor(
      () => {
        expect(sessionJoinCount.value).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );

    await client.disconnect();
  });

  it('terminal close: server closes with code 4401, client does NOT reconnect and emits close', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    let serverSocket: WsWebSocket | null = null;
    wss.on('connection', (ws) => {
      serverSocket = ws;
    });

    const client = new RelayClient(
      makeClientOpts(port, {
        reconnect: { initialDelayMs: 50, maxDelayMs: 500, jitterFactor: 0 },
      }),
    );

    const reconnectingEvents: number[] = [];
    client.on('reconnecting', (attempt) => reconnectingEvents.push(attempt));

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once('close', (code, reason) => resolve({ code, reason }));
    });

    await client.connect();

    await vi.waitFor(() => {
      expect(serverSocket).not.toBeNull();
    });

    // Server closes with 4401 Unauthorized
    serverSocket!.close(4401, 'Unauthorized');

    const { code } = await closePromise;
    expect(code).toBe(4401);

    // Wait a bit to ensure no reconnect was scheduled
    await new Promise((res) => setTimeout(res, 200));
    expect(reconnectingEvents.length).toBe(0);
  });

  it('disconnect: client.disconnect() sends session.leave then connection closes gracefully', async () => {
    server = await createTestServer();
    const { wss, port } = server;

    const serverMessages: string[] = [];
    const serverClosePromise = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          serverMessages.push(rawToString(data));
        });
        ws.on('close', () => resolve());
      });
    });

    const client = new RelayClient(makeClientOpts(port));
    await client.connect();

    await client.disconnect();

    // Server should have received the close
    await serverClosePromise;

    // Should have received session.join + session.leave
    const types = serverMessages.map((raw) => {
      try {
        return decode(raw).type;
      } catch {
        return 'unknown';
      }
    });

    expect(types).toContain('session.join');
    expect(types).toContain('session.leave');
    expect(client.connected).toBe(false);
  });
});

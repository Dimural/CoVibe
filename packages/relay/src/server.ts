import * as http from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import type { SessionAuthorizer } from './auth.js';
import { Connection } from './connection.js';
import { CloseCodes } from './closeCodes.js';

export interface RelayServerDeps {
  config: Config;
  logger: Logger;
  /** Optional authorizer; defaults to rejecting all connections when omitted (not useful in production). */
  authorizer?: SessionAuthorizer;
  redis?: { ping: () => Promise<'PONG'> }; // structural; matches ioredis subset we need
  /** Milliseconds between server-issued ping frames. Defaults to 25000. */
  heartbeatIntervalMs?: number;
  /** Number of consecutive missed pongs before the connection is dropped. Defaults to 2. */
  heartbeatMissesAllowed?: number;
}

/**
 * Export an alias so external callers can type the options object without
 * importing the concrete class.
 */
export type RelayOptions = RelayServerDeps;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const REDIS_PING_TIMEOUT_MS = 2000;
const STOP_FORCE_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_MISSES_ALLOWED = 2;

/**
 * Zod schema that validates WebSocket upgrade query parameters.
 *
 * Charset rules:
 * - `session` and `token`: base64url characters only (A-Z a-z 0-9 - _ =).
 * - `user`: printable, ≤64 chars.
 * - `color`: CSS hex color (#rgb or #rrggbb).
 * - `branch`: ≤255 chars.
 * - `participantId`: optional UUID.
 */
const UpgradeQuerySchema = z.object({
  session: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9\-_=]+$/, 'sessionId must be base64url'),
  token: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9\-_=]+$/, 'token must be base64url'),
  user: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'color must be a hex color (#rgb or #rrggbb)'),
  branch: z.string().min(1).max(255),
  participantId: z.string().uuid().optional(),
});

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Creates a new {@link RelayServer} instance with the provided options.
 * Convenience factory for tests and `main.ts`.
 *
 * If `options.config` is omitted, defaults to port 0 / test env / fatal log level.
 * If `options.logger` is omitted, one is derived from the config.
 */
export function createRelay(options: Partial<RelayOptions>): RelayServer {
  const config = options.config ?? loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const logger = options.logger ?? createLogger(config);
  return new RelayServer({ ...options, config, logger });
}

export class RelayServer {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #redis: RelayServerDeps['redis'];
  readonly #authorizer: SessionAuthorizer | undefined;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMissesAllowed: number;
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #listening = false;
  #port = 0;

  constructor(deps: RelayServerDeps) {
    this.#config = deps.config;
    this.#logger = deps.logger;
    this.#redis = deps.redis;
    this.#authorizer = deps.authorizer;
    this.#heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatMissesAllowed = deps.heartbeatMissesAllowed ?? DEFAULT_HEARTBEAT_MISSES_ALLOWED;
  }

  get listening(): boolean {
    return this.#listening;
  }

  get port(): number {
    return this.#port;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.#handleRequest(req, res);
      });
      this.#server = server;

      // WebSocket server in noServer mode — we manage upgrades ourselves so we
      // can enforce path, validate query params, and run auth before admission.
      const wss = new WebSocketServer({ noServer: true });
      this.#wss = wss;

      server.on('upgrade', (req, socket, head) => {
        void this.#handleUpgrade(req, socket as Socket, head, wss);
      });

      server.listen(this.#config.port, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Unexpected server address format'));
          return;
        }
        this.#port = addr.port;
        this.#listening = true;
        resolve(addr.port);
      });

      server.once('error', reject);
    });
  }

  stop(): Promise<void> {
    if (!this.#server || !this.#listening) {
      return Promise.resolve();
    }

    this.#listening = false;
    const server = this.#server;
    const wss = this.#wss;
    this.#server = null;
    this.#wss = null;

    return new Promise((resolve, reject) => {
      const forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, STOP_FORCE_TIMEOUT_MS);

      // Close the WS server first (terminates all WS connections) then close
      // the underlying HTTP server.
      wss?.close(() => {
        // Force-terminate any remaining WS clients so HTTP server can close cleanly.
        for (const client of wss.clients) {
          client.terminate();
        }
        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      if (!wss) {
        server.close((err) => {
          clearTimeout(forceTimer);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  }

  async #handleUpgrade(
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
    wss: WebSocketServer,
  ): Promise<void> {
    // Only allow upgrades on exactly /ws.
    const rawUrl = req.url ?? '';
    const urlPath = rawUrl.split('?')[0];
    if (urlPath !== '/ws') {
      // Reject at HTTP level — the client receives a 404 before the WS handshake.
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Parse the query string.
    const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    const params = Object.fromEntries(new URLSearchParams(qs).entries());
    const parsed = UpgradeQuerySchema.safeParse(params);

    if (!parsed.success) {
      // Per WS spec, close codes are only valid AFTER a successful upgrade handshake.
      // Complete the upgrade then immediately close with 4400.
      this.#logger.debug({ path: urlPath, reason: 'invalid-input' }, 'upgrade rejected');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CloseCodes.InvalidInput, 'invalid-input');
        ws.terminate();
      });
      return;
    }

    const { session, token, user, color, branch, participantId } = parsed.data;

    if (!this.#authorizer) {
      // No authorizer configured — close with internal error.
      this.#logger.error({ reason: 'no-authorizer' }, 'upgrade rejected');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CloseCodes.InternalError, 'no-authorizer');
        ws.terminate();
      });
      return;
    }

    let authResult;
    try {
      authResult = await this.#authorizer.authorize({
        sessionId: session,
        token,
        ...(participantId !== undefined ? { participantId } : {}),
        displayName: user,
        color,
        branch,
      });
    } catch (err: unknown) {
      this.#logger.error({ err, reason: 'authorizer-threw' }, 'upgrade rejected');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CloseCodes.InternalError, 'internal-error');
        ws.terminate();
      });
      return;
    }

    if (authResult.kind === 'rejected') {
      const code =
        authResult.reason === 'session-full'
          ? CloseCodes.SessionFull
          : authResult.reason === 'wrong-token'
            ? CloseCodes.Unauthorized
            : CloseCodes.InvalidInput;

      this.#logger.warn({ sessionId: session, reason: authResult.reason }, 'upgrade rejected');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(code, authResult.reason);
        ws.terminate();
      });
      return;
    }

    // Admitted — complete upgrade and create Connection.
    // noServer mode: we use the ws callback directly. No listeners are attached
    // to wss, so wss.emit('connection', ws) would be a no-op.
    const { participantId: assignedParticipantId } = authResult;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connLogger = this.#logger.child({
        sessionId: session,
        participantId: assignedParticipantId,
      });

      const conn = new Connection({
        socket: ws,
        sessionId: session,
        participantId: assignedParticipantId,
        displayName: user,
        color,
        branch,
        logger: connLogger,
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        heartbeatMissesAllowed: this.#heartbeatMissesAllowed,
      });

      conn.onClose((closeCode, closeReason) => {
        connLogger.debug({ closeCode, closeReason }, 'releasing participant');
        void this.#authorizer!.release(session, assignedParticipantId);
      });

      conn.start();

      connLogger.info({ displayName: user, branch, color }, 'participant admitted');
    });
  }

  async #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      if (url === '/healthz' || url === '/readyz') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          writeJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
        if (url === '/healthz') {
          writeJson(res, 200, { status: 'ok' });
          return;
        }
        // /readyz: check Redis if provided
        await this.#handleReadyz(res);
        return;
      }

      writeJson(res, 404, { error: 'not-found' });
    } catch (err: unknown) {
      this.#logger.error({ err }, 'unhandled request error');
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal' });
      }
    }
  }

  async #handleReadyz(res: http.ServerResponse): Promise<void> {
    if (!this.#redis) {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    const pingWithTimeout = new Promise<'PONG'>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('redis ping timeout'));
      }, REDIS_PING_TIMEOUT_MS);

      this.#redis!.ping()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    try {
      await pingWithTimeout;
      writeJson(res, 200, { status: 'ok' });
    } catch (err: unknown) {
      this.#logger.warn({ err }, 'redis ping failed');
      writeJson(res, 503, { status: 'not-ready', reason: 'redis' });
    }
  }
}

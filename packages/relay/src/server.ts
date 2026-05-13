import * as http from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Metrics } from './metrics.js';
import type { SessionAuthorizer } from './auth.js';
import type { SessionRegistry, SessionView } from './sessionRegistry.js';
import { Connection } from './connection.js';
import { CloseCodes } from './closeCodes.js';
import { Router } from './router.js';
import { DocSequencer } from './doc/sequencer.js';

export interface RelayServerDeps {
  config: Config;
  logger: Logger;
  /** Optional authorizer; defaults to rejecting all connections when omitted (not useful in production). */
  authorizer?: SessionAuthorizer;
  /**
   * Optional session registry. When provided, the server will use `joinOrCreate`
   * (which returns a full `SessionView`) and wire up the router to send `session.state`
   * on admission. Takes precedence over `authorizer` when both are provided.
   */
  registry?: SessionRegistry;
  /** Optional pre-built Router instance. If omitted and `registry` is provided, one is created automatically. */
  router?: Router;
  redis?: { ping: () => Promise<'PONG'> }; // structural; matches ioredis subset we need
  /** Optional metrics instance. When provided, exposes /metrics and records counters. */
  metrics?: Metrics;
  /** Milliseconds between server-issued ping frames. Defaults to 25000. */
  heartbeatIntervalMs?: number;
  /** Number of consecutive missed pongs before the connection is dropped. Defaults to 2. */
  heartbeatMissesAllowed?: number;
  /** Backpressure threshold in bytes for the router. Defaults to 1 MiB. */
  bufferedAmountThreshold?: number;
  /** Max message size in bytes for the router. Defaults to 1 MiB. */
  maxMessageBytes?: number;
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

/**
 * Strip IPv6-mapped IPv4 prefix from a remote address string.
 *
 * Node.js reports IPv4-mapped IPv6 addresses as `::ffff:x.x.x.x` when the
 * server is listening on a dual-stack socket. This helper normalises them to
 * plain IPv4.
 *
 * NOTE: when the relay runs behind a reverse proxy, `req.socket.remoteAddress`
 * is the proxy address, not the end client. Trusting `X-Forwarded-For` is a
 * security decision deferred to Phase 7.
 */
function stripIpv6Prefix(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export class RelayServer {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #redis: RelayServerDeps['redis'];
  readonly #metrics: Metrics | undefined;
  readonly #authorizer: SessionAuthorizer | undefined;
  readonly #registry: SessionRegistry | undefined;
  readonly #router: Router;
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
    this.#metrics = deps.metrics;
    this.#registry = deps.registry;
    // When a registry is provided it also implements SessionAuthorizer (authorize/release).
    this.#authorizer = deps.registry ?? deps.authorizer;
    this.#heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatMissesAllowed = deps.heartbeatMissesAllowed ?? DEFAULT_HEARTBEAT_MISSES_ALLOWED;
    this.#router =
      deps.router ??
      new Router({
        logger: deps.logger,
        sequencer: new DocSequencer(),
        ...(deps.metrics !== undefined && { metrics: deps.metrics }),
        ...(deps.bufferedAmountThreshold !== undefined && {
          bufferedAmountThreshold: deps.bufferedAmountThreshold,
        }),
        ...(deps.maxMessageBytes !== undefined && { maxMessageBytes: deps.maxMessageBytes }),
      });
  }

  /** Expose the router for tests and metrics (Task 2.5). */
  get router(): Router {
    return this.#router;
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

      // Terminate all open WS clients first; only then close the WS server
      // so wss.close() fires its callback immediately (it waits for clients
      // to disconnect before calling back when using noServer mode).
      if (wss) {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          server.close((err) => {
            clearTimeout(forceTimer);
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } else {
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

    const authReq = {
      sessionId: session,
      token,
      ...(participantId !== undefined ? { participantId } : {}),
      displayName: user,
      color,
      branch,
    };

    // Use joinOrCreate (registry path) when available — it returns a full SessionView
    // needed for the session.state message. Fall back to authorize() for plain authorizers.
    let assignedParticipantId: string;
    let sessionView: SessionView | null = null;

    if (this.#registry) {
      let joinResult;
      try {
        joinResult = await this.#registry.joinOrCreate(authReq);
      } catch (err: unknown) {
        this.#logger.error({ err, reason: 'registry-threw' }, 'upgrade rejected');
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(CloseCodes.InternalError, 'internal-error');
          ws.terminate();
        });
        return;
      }

      if (joinResult.kind === 'rejected') {
        const code =
          joinResult.reason === 'session-full'
            ? CloseCodes.SessionFull
            : joinResult.reason === 'wrong-token'
              ? CloseCodes.Unauthorized
              : CloseCodes.InvalidInput;

        this.#logger.warn({ sessionId: session, reason: joinResult.reason }, 'upgrade rejected');
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(code, joinResult.reason);
          ws.terminate();
        });
        return;
      }

      assignedParticipantId = joinResult.participantId;
      sessionView = joinResult.view;
    } else {
      let authResult;
      try {
        authResult = await this.#authorizer.authorize(authReq);
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

      assignedParticipantId = authResult.participantId;
    }

    // Admitted — complete upgrade and create Connection.
    // noServer mode: we use the ws callback directly. No listeners are attached
    // to wss, so wss.emit('connection', ws) would be a no-op.
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
      this.#router.attach(conn);
      if (sessionView !== null) {
        this.#router.sendSessionState(conn, sessionView);
      }

      connLogger.info(
        { displayName: user, branch, color, remoteIp: stripIpv6Prefix(req.socket.remoteAddress) },
        'participant admitted',
      );
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

      if (url === '/metrics') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          writeJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
        if (!this.#metrics) {
          writeJson(res, 404, { error: 'not-found' });
          return;
        }
        const body = await this.#metrics.render();
        res.writeHead(200, {
          'Content-Type': Metrics.contentType(),
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
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

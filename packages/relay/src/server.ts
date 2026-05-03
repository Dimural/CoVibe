import * as http from 'node:http';
import type { Config } from './config.js';
import type { Logger } from './log.js';

export interface RelayServerDeps {
  config: Config;
  logger: Logger;
  redis?: { ping: () => Promise<'PONG'> }; // structural; matches ioredis subset we need
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const REDIS_PING_TIMEOUT_MS = 2000;
const STOP_FORCE_TIMEOUT_MS = 5000;

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export class RelayServer {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #redis?: RelayServerDeps['redis'];
  #server: http.Server | null = null;
  #listening = false;
  #port = 0;

  constructor(deps: RelayServerDeps) {
    this.#config = deps.config;
    this.#logger = deps.logger;
    this.#redis = deps.redis;
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

      // WebSocket upgrade is wired in Task 2.2

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
    this.#server = null;

    return new Promise((resolve, reject) => {
      const forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, STOP_FORCE_TIMEOUT_MS);

      server.close((err) => {
        clearTimeout(forceTimer);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
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

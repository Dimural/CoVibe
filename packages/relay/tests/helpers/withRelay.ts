import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { RelayServer } from '../../src/server.js';
import type { RelayOptions } from '../../src/server.js';

/**
 * Starts a {@link RelayServer}, runs `fn`, then stops the server.
 * Uses port `0` so the OS assigns a free port.
 */
export async function withRelay<T>(
  options: Partial<RelayOptions>,
  fn: (ctx: { server: RelayServer; port: number; baseUrl: string }) => Promise<T>,
): Promise<T> {
  const config = options.config ?? loadConfig({ PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  const logger = options.logger ?? createLogger(config);
  const server = new RelayServer({ ...options, config, logger });
  const port = await server.start();
  try {
    return await fn({ server, port, baseUrl: `ws://127.0.0.1:${port}/ws` });
  } finally {
    await server.stop();
  }
}

import { Redis as IORedis } from 'ioredis';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Metrics } from './metrics.js';
import { RelayServer } from './server.js';
import { initSentry } from './sentry.js';
import { MemorySessionStore } from './sessionStore.memory.js';
import { RedisSessionStore } from './sessionStore.redis.js';
import { SessionRegistryImpl } from './sessionRegistry.impl.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  await initSentry(config, logger);

  const metrics = new Metrics();

  const redis = config.redisUrl ? new IORedis(config.redisUrl, { lazyConnect: true }) : undefined;
  if (redis) await redis.connect();

  const store = redis ? new RedisSessionStore(redis) : new MemorySessionStore();
  const registry = new SessionRegistryImpl({ store, config, logger });

  const server = new RelayServer({
    config,
    logger,
    authorizer: registry,
    metrics,
    ...(redis !== undefined ? { redis } : {}),
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    await server.stop();
    if (redis) await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const port = await server.start();
  logger.info({ port, env: config.nodeEnv }, 'relay listening');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('relay fatal startup error', err);
  process.exit(1);
});

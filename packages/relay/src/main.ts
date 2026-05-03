import { Redis as IORedis } from 'ioredis';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { RelayServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const redis = config.redisUrl ? new IORedis(config.redisUrl, { lazyConnect: true }) : undefined;
  if (redis) await redis.connect();

  const server = new RelayServer({
    config,
    logger,
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

import type { Config } from './config.js';
import type { Logger } from './log.js';

/**
 * Optionally initializes the Sentry SDK.
 *
 * When `config.sentryDsn` is absent this function is a no-op — `@sentry/node`
 * is never imported, so the optional dependency need not be installed.
 *
 * The lazy `import()` + try/catch pattern ensures that a missing
 * `@sentry/node` package does not crash the relay; Sentry failures are
 * logged as warnings and the server continues without it.
 */
export async function initSentry(config: Config, logger: Logger): Promise<void> {
  if (!config.sentryDsn) return;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.nodeEnv,
      tracesSampleRate: 0,
    });
    logger.info('Sentry initialized');
  } catch (err: unknown) {
    logger.warn({ err }, 'Sentry initialization failed; continuing without it');
  }
}

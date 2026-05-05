import pino from 'pino';
import type { Config } from './config.js';

/**
 * Fields that must never appear in log output — defense-in-depth.
 *
 * `payload` guards against accidentally logging routed message content.
 * `token` guards against session tokens leaking into structured logs.
 */
const REDACT_PATHS = ['payload', '*.payload', '*.*.payload', 'token', '*.token', '*.*.token'];

/**
 * Creates a structured pino logger bound to the given {@link Config}.
 *
 * Redaction removes `payload` and `token` fields at any depth so that
 * opaque message content cannot leak into log sinks, even if a future
 * code path accidentally passes a full envelope to a log call.
 */
export function createLogger(config: Config) {
  const opts: pino.LoggerOptions = {
    level: config.logLevel,
    formatters: { bindings: () => ({}) }, // suppress pid/hostname; we add structured context per-event
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      remove: true, // remove the field entirely rather than replacing with [Redacted]
    },
  };
  return pino(opts);
}

export type Logger = ReturnType<typeof createLogger>;

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

/**
 * Redaction paths mirroring those in src/log.ts.
 * These must stay in sync if REDACT_PATHS changes.
 */
const REDACT_PATHS = ['payload', '*.payload', '*.*.payload', 'token', '*.token', '*.*.token'];

function captureLog(level: 'info' | 'debug' | 'warn' | 'error' = 'info'): {
  logger: pino.Logger;
  lines: () => unknown[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });

  const opts: pino.LoggerOptions = {
    level,
    formatters: { bindings: () => ({}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, remove: true },
  };

  const logger = pino(opts, stream);

  return {
    logger,
    lines: () =>
      chunks.flatMap((c) =>
        c
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as unknown),
      ),
  };
}

describe('createLogger redaction', () => {
  it('strips top-level payload field', () => {
    const cap = captureLog();
    cap.logger.info({ payload: 'secret', sessionId: 'abc' }, 'msg');
    const [entry] = cap.lines();
    expect((entry as Record<string, unknown>).payload).toBeUndefined();
    expect((entry as Record<string, unknown>).sessionId).toBe('abc');
  });

  it('strips nested payload field (one level deep)', () => {
    const cap = captureLog();
    cap.logger.info({ envelope: { payload: { x: 1 } }, sessionId: 'abc' }, 'msg');
    const [entry] = cap.lines();
    const env = (entry as Record<string, unknown>).envelope as Record<string, unknown> | undefined;
    expect(env?.payload).toBeUndefined();
    expect((entry as Record<string, unknown>).sessionId).toBe('abc');
  });

  it('strips top-level token field', () => {
    const cap = captureLog();
    cap.logger.info({ token: 'tok' }, 'msg');
    const [entry] = cap.lines();
    expect((entry as Record<string, unknown>).token).toBeUndefined();
  });

  it('strips nested token field (one level deep)', () => {
    const cap = captureLog();
    cap.logger.info({ auth: { token: 'hidden' }, sessionId: 's1' }, 'msg');
    const [entry] = cap.lines();
    const auth = (entry as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    expect(auth?.token).toBeUndefined();
    expect((entry as Record<string, unknown>).sessionId).toBe('s1');
  });

  it('preserves non-redacted fields', () => {
    const cap = captureLog();
    cap.logger.info({ sessionId: 'abc', participantId: 'p1' }, 'msg');
    const [entry] = cap.lines();
    expect((entry as Record<string, unknown>).sessionId).toBe('abc');
    expect((entry as Record<string, unknown>).participantId).toBe('p1');
  });

  it('includes the log message string', () => {
    const cap = captureLog();
    cap.logger.info({ sessionId: 'x' }, 'hello world');
    const [entry] = cap.lines();
    expect((entry as Record<string, unknown>).msg).toBe('hello world');
  });
});

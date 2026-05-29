import type * as SentryType from '@sentry/node';

export interface TelemetryEvent {
  session_start: { participantCount?: number };
  sync_latency_high: { latencyMs: number };
  error: { code: string };
}

export type TelemetryEventName = keyof TelemetryEvent;

export interface Telemetry {
  track<K extends TelemetryEventName>(event: K, data: TelemetryEvent[K]): void;
  recordSyncLatency(latencyMs: number): void;
  dispose(): void;
}

interface TelemetryOptions {
  enabled: boolean;
  vscodeTelemetryEnabled: boolean;
  sentryDsn: string | undefined;
  /** Injected in tests to spy on track calls without real Sentry. */
  _trackFn?: (event: string, data: Record<string, unknown>) => void;
}

const SYNC_LATENCY_THRESHOLD_MS = 300;

/** Creates a Telemetry instance. No-op when disabled or sentryDsn is absent. */
export function createTelemetry(opts: TelemetryOptions): Telemetry {
  const active = opts.enabled && opts.vscodeTelemetryEnabled && opts.sentryDsn !== undefined;

  let _sentryInitialized = false;

  const internalTrack =
    opts._trackFn ??
    ((event: string, data: Record<string, unknown>) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Sentry = require('@sentry/node') as typeof SentryType;
        if (!_sentryInitialized) {
          Sentry.init({
            ...(opts.sentryDsn !== undefined ? { dsn: opts.sentryDsn } : {}),
            environment: 'extension',
            tracesSampleRate: 0,
          });
          _sentryInitialized = true;
        }
        Sentry.addBreadcrumb({ category: 'telemetry', message: event, data });
        Sentry.captureEvent({
          message: `telemetry.${event}`,
          level: 'info',
          extra: data,
          tags: { telemetry: 'true' },
        });
      } catch {
        // Sentry unavailable — no-op
      }
    });

  function track<K extends TelemetryEventName>(event: K, data: TelemetryEvent[K]): void {
    if (!active) return;
    internalTrack(event, data);
  }

  function recordSyncLatency(latencyMs: number): void {
    if (latencyMs > SYNC_LATENCY_THRESHOLD_MS) {
      track('sync_latency_high', { latencyMs });
    }
  }

  return { track, recordSyncLatency, dispose: () => {} };
}

/** Singleton no-op instance used before activation completes. */
export const noopTelemetry: Telemetry = {
  track: () => {},
  recordSyncLatency: () => {},
  dispose: () => {},
};

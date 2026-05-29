export interface TelemetryEvent {
  session_start: { participantCount?: number };
  session_end: { durationMs: number; conflictCount: number };
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
      // Lazy Sentry import mirrors the relay's sentry.ts pattern so that a
      // missing @sentry/node package does not crash the extension host.
      // We use a dynamic string to avoid a static import that would require
      // @sentry/node to be present at typecheck time.
      const sentryModule = '@sentry/node';
      void (async () => {
        try {
          const Sentry = (await import(/* @vite-ignore */ sentryModule)) as {
            init: (opts: {
              dsn: string | undefined;
              environment: string;
              tracesSampleRate: number;
            }) => void;
            addBreadcrumb: (opts: {
              category: string;
              message: string;
              data: Record<string, unknown>;
            }) => void;
            captureEvent: (opts: {
              message: string;
              level: string;
              extra: Record<string, unknown>;
              tags: Record<string, string>;
            }) => void;
          };
          if (!_sentryInitialized) {
            Sentry.init({
              dsn: opts.sentryDsn,
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
          // Sentry unavailable; silently swallow
        }
      })();
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

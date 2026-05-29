import { describe, it, expect, vi } from 'vitest';

describe('Telemetry', () => {
  it('does not call track when telemetry is disabled', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: false,
      vscodeTelemetryEnabled: true,
      sentryDsn: 'https://fake@sentry.io/123',
      _trackFn: trackSpy,
    });
    tel.track('session_start', {});
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('does not call track when VS Code global telemetry is off', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: true,
      vscodeTelemetryEnabled: false,
      sentryDsn: 'https://fake@sentry.io/123',
      _trackFn: trackSpy,
    });
    tel.track('session_start', {});
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('calls track when both enabled flags are true', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: true,
      vscodeTelemetryEnabled: true,
      sentryDsn: 'https://fake@sentry.io/123',
      _trackFn: trackSpy,
    });
    tel.track('session_start', { participantCount: 2 });
    expect(trackSpy).toHaveBeenCalledOnce();
    expect(trackSpy).toHaveBeenCalledWith('session_start', { participantCount: 2 });
  });

  it('track is a no-op when sentryDsn is absent', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: true,
      vscodeTelemetryEnabled: true,
      sentryDsn: undefined,
      _trackFn: trackSpy,
    });
    tel.track('session_start', {});
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('recordSyncLatency does not track when under threshold', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: true,
      vscodeTelemetryEnabled: true,
      sentryDsn: 'https://fake@sentry.io/123',
      _trackFn: trackSpy,
    });
    tel.recordSyncLatency(100);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('recordSyncLatency tracks when over 300ms threshold', async () => {
    const trackSpy = vi.fn();
    const { createTelemetry } = await import('../src/telemetry.js');
    const tel = createTelemetry({
      enabled: true,
      vscodeTelemetryEnabled: true,
      sentryDsn: 'https://fake@sentry.io/123',
      _trackFn: trackSpy,
    });
    tel.recordSyncLatency(400);
    expect(trackSpy).toHaveBeenCalledWith('sync_latency_high', { latencyMs: 400 });
  });

  it('noopTelemetry.track is always silent', async () => {
    const { noopTelemetry } = await import('../src/telemetry.js');
    // Should not throw; returns void
    expect(() => noopTelemetry.track('session_start', {})).not.toThrow();
    expect(() => noopTelemetry.recordSyncLatency(500)).not.toThrow();
  });
});

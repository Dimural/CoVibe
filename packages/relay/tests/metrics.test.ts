import { describe, it, expect } from 'vitest';
import { Metrics } from '../src/metrics.js';

describe('Metrics', () => {
  it('exposes the expected counter/gauge names in render output', async () => {
    const m = new Metrics();
    const text = await m.render();
    expect(text).toMatch(/covibes_relay_connections_total/);
    expect(text).toMatch(/covibes_relay_sessions_active/);
    expect(text).toMatch(/covibes_relay_messages_routed_total/);
    expect(text).toMatch(/covibes_relay_bytes_routed_total/);
    expect(text).toMatch(/covibes_relay_dropped_for_backpressure_total/);
    expect(text).toMatch(/covibes_relay_dropped_for_oversize_total/);
    expect(text).toMatch(/covibes_relay_protocol_errors_total/);
  });

  it('counter increments are reflected in render()', async () => {
    const m = new Metrics();
    m.messages_routed_total.inc({ type: 'doc.delta' }, 3);
    const text = await m.render();
    // Expect a line like: covibes_relay_messages_routed_total{type="doc.delta"} 3
    expect(text).toMatch(/covibes_relay_messages_routed_total\{[^}]*type="doc\.delta"[^}]*\} 3/);
  });

  it('contentType is the Prometheus text exposition format', () => {
    expect(Metrics.contentType()).toMatch(/text\/plain/);
    expect(Metrics.contentType()).toMatch(/version=0\.0\.4/);
  });

  it('Counter and Gauge instances are usable without throwing', () => {
    const m = new Metrics();
    expect(() => m.connections_total.inc({ kind: 'admitted', reason: 'ok' })).not.toThrow();
    expect(() => m.sessions_active.inc()).not.toThrow();
    expect(() => m.sessions_active.dec()).not.toThrow();
  });

  it('connections_total increments are visible in render()', async () => {
    const m = new Metrics();
    m.connections_total.inc({ kind: 'rejected', reason: 'session-full' }, 2);
    const text = await m.render();
    expect(text).toMatch(
      /covibes_relay_connections_total\{[^}]*kind="rejected"[^}]*reason="session-full"[^}]*\} 2/,
    );
  });

  it('protocol_errors_total increments are visible in render()', async () => {
    const m = new Metrics();
    m.protocol_errors_total.inc({ code: 'malformed-json' }, 5);
    const text = await m.render();
    expect(text).toMatch(
      /covibes_relay_protocol_errors_total\{[^}]*code="malformed-json"[^}]*\} 5/,
    );
  });

  it('bytes_routed_total accumulates correctly', async () => {
    const m = new Metrics();
    m.bytes_routed_total.inc(100);
    m.bytes_routed_total.inc(200);
    const text = await m.render();
    expect(text).toMatch(/covibes_relay_bytes_routed_total\b.*\b300/);
  });
});

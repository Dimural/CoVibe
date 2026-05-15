import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Interface for the DocSequencer to record its processing duration.
 * Kept minimal so DocSequencer does not depend on the full Metrics class.
 */
export interface SequencerMetrics {
  recordProcessDuration(durationSeconds: number): void;
}

/**
 * Prometheus metrics for the CoVibes relay.
 *
 * All metrics are registered on an isolated {@link Registry} so that multiple
 * `Metrics` instances can coexist within the same process (e.g. in tests).
 *
 * Usage:
 * ```ts
 * const metrics = new Metrics();
 * metrics.connections_total.inc({ kind: 'admitted', reason: 'ok' });
 * const body = await metrics.render();
 * ```
 */
export class Metrics {
  /** Isolated Prometheus registry — avoids polluting the global default registry. */
  readonly registry: Registry;

  /** Total WebSocket upgrade attempts, labeled by outcome kind and reason. */
  readonly connections_total: Counter<'kind' | 'reason'>;

  /** Number of currently active sessions (≥1 active participant). */
  readonly sessions_active: Gauge<never>;

  /** Messages routed to peers, labeled by protocol message type. */
  readonly messages_routed_total: Counter<'type'>;

  /** Total bytes routed to peers (post-from-injection). */
  readonly bytes_routed_total: Counter<never>;

  /** Connections dropped due to send-buffer backpressure. */
  readonly dropped_for_backpressure_total: Counter<never>;

  /** Inbound messages rejected for exceeding maxMessageBytes. */
  readonly dropped_for_oversize_total: Counter<never>;

  /** Protocol errors observed, labeled by error code. */
  readonly protocol_errors_total: Counter<'code'>;

  /**
   * Server-side processing latency of {@link DocSequencer.process} calls.
   * Buckets cover 100µs to 100ms in roughly an order-of-magnitude spread.
   */
  readonly ot_sequencer_process_duration_seconds: Histogram<never>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: 'covibes_relay_' });

    this.connections_total = new Counter({
      name: 'covibes_relay_connections_total',
      help: 'Total WebSocket upgrade attempts, labeled by outcome.',
      labelNames: ['kind', 'reason'] as const,
      registers: [this.registry],
    });

    this.sessions_active = new Gauge({
      name: 'covibes_relay_sessions_active',
      help: 'Number of currently active sessions (≥1 active participant).',
      registers: [this.registry],
    });

    this.messages_routed_total = new Counter({
      name: 'covibes_relay_messages_routed_total',
      help: 'Messages routed to peers, labeled by type.',
      labelNames: ['type'] as const,
      registers: [this.registry],
    });

    this.bytes_routed_total = new Counter({
      name: 'covibes_relay_bytes_routed_total',
      help: 'Total bytes routed to peers (post-from-injection).',
      registers: [this.registry],
    });

    this.dropped_for_backpressure_total = new Counter({
      name: 'covibes_relay_dropped_for_backpressure_total',
      help: 'Connections dropped due to send-buffer backpressure.',
      registers: [this.registry],
    });

    this.dropped_for_oversize_total = new Counter({
      name: 'covibes_relay_dropped_for_oversize_total',
      help: 'Inbound messages rejected for exceeding maxMessageBytes.',
      registers: [this.registry],
    });

    this.protocol_errors_total = new Counter({
      name: 'covibes_relay_protocol_errors_total',
      help: 'Protocol errors observed, labeled by error code.',
      labelNames: ['code'] as const,
      registers: [this.registry],
    });

    this.ot_sequencer_process_duration_seconds = new Histogram({
      name: 'covibes_relay_ot_sequencer_process_duration_seconds',
      help: 'Wall-clock duration of DocSequencer.process() calls in seconds.',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
      registers: [this.registry],
    });
  }

  /** Returns a {@link SequencerMetrics} adapter backed by this instance. */
  asSequencerMetrics(): SequencerMetrics {
    return {
      recordProcessDuration: (durationSeconds: number) => {
        this.ot_sequencer_process_duration_seconds.observe(durationSeconds);
      },
    };
  }

  /** Render Prometheus exposition format. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content-Type header value for a Prometheus scrape response. */
  static contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
}

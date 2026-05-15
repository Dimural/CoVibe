/**
 * LatencyTracker — FIFO-based RTT measurement for OT round-trips.
 *
 * Usage:
 *   - Call `recordSend()` each time a local op is dispatched to the server.
 *   - Call `recordAck()` each time a `doc.ack` arrives.
 *
 * Since the protocol guarantees in-order delivery (TCP/WebSocket) and the OT
 * engine sends ops sequentially (only one in-flight at a time), the oldest
 * pending send time always corresponds to the arriving ack — FIFO ordering is
 * correct.
 *
 * Both methods accept an optional `nowMs` parameter so tests can inject a
 * deterministic clock without mocking `Date.now`.
 */
export class LatencyTracker {
  readonly #sendTimes: number[] = []; // FIFO queue of send timestamps
  readonly #rttHistory: number[] = []; // last `maxHistory` RTT measurements (oldest first)
  readonly maxHistory: number;

  constructor(maxHistory = 50) {
    this.maxHistory = maxHistory;
  }

  /**
   * Record that a local op was just sent to the server.
   * @param nowMs - Timestamp in milliseconds (defaults to `Date.now()`).
   */
  recordSend(nowMs = Date.now()): void {
    this.#sendTimes.push(nowMs);
  }

  /**
   * Record that a `doc.ack` arrived from the server.
   * Dequeues the oldest send time and computes RTT.
   *
   * @param nowMs - Timestamp in milliseconds (defaults to `Date.now()`).
   * @returns RTT in milliseconds, or `undefined` if there is no matching send
   *          (i.e. `recordSend` was never called or has been fully drained).
   */
  recordAck(nowMs = Date.now()): number | undefined {
    const sendTime = this.#sendTimes.shift();
    if (sendTime === undefined) return undefined;
    const rtt = nowMs - sendTime;
    this.#rttHistory.push(rtt);
    if (this.#rttHistory.length > this.maxHistory) {
      this.#rttHistory.shift();
    }
    return rtt;
  }

  /** Most recent RTT measurements, oldest first. */
  get history(): readonly number[] {
    return this.#rttHistory;
  }

  /**
   * Mean RTT over the recorded history.
   * Returns `undefined` when no data has been collected yet.
   */
  get averageRttMs(): number | undefined {
    if (this.#rttHistory.length === 0) return undefined;
    return this.#rttHistory.reduce((a, b) => a + b, 0) / this.#rttHistory.length;
  }
}

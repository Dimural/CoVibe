/**
 * Exponential backoff with jitter for relay reconnection.
 */

export interface ReconnectOptions {
  /** Initial delay in milliseconds. Default: 1000 */
  initialDelayMs: number;
  /** Maximum delay in milliseconds. Default: 30000 */
  maxDelayMs: number;
  /** Jitter factor (±fraction). Default: 0.3 (±30%) */
  jitterFactor: number;
  /** Maximum reconnect attempts. Undefined = unlimited. */
  maxAttempts?: number;
}

export const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.3,
};

/**
 * Computes the next reconnect delay for a given attempt number (0-indexed).
 *
 * Formula:
 *   baseDelay = clamp(initialDelayMs * 2^attempt, initialDelayMs, maxDelayMs)
 *   delay = baseDelay * (1 + jitterFactor * (Math.random() * 2 - 1))
 *   delay = clamp(delay, initialDelayMs, maxDelayMs)
 */
export function computeNextDelay(attempt: number, opts: ReconnectOptions): number {
  const { initialDelayMs, maxDelayMs, jitterFactor } = opts;

  const baseDelay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = jitterFactor * (Math.random() * 2 - 1);
  const delay = baseDelay * (1 + jitter);

  // Clamp to [initialDelayMs, maxDelayMs]
  return Math.max(initialDelayMs, Math.min(maxDelayMs, delay));
}

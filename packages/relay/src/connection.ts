import type { WebSocket } from 'ws';
import type { Logger } from './log.js';
import { CloseCodes } from './closeCodes.js';

/** Dependencies injected when constructing a {@link Connection}. */
export interface ConnectionDeps {
  /** The underlying `ws` WebSocket instance for this client. */
  socket: WebSocket;
  /** Relay session this connection belongs to. */
  sessionId: string;
  /** Unique identifier for this participant within the session. */
  participantId: string;
  /** Display name as provided by the client (already validated). */
  displayName: string;
  /** Hex color as provided by the client (already validated). */
  color: string;
  /** Git branch as provided by the client (already validated). */
  branch: string;
  /** Child logger pre-populated with sessionId/participantId context fields. */
  logger: Logger;
  /** How often (ms) to send a ping frame to the client. */
  heartbeatIntervalMs: number;
  /**
   * How many consecutive missed pongs are tolerated before the connection is
   * dropped with {@link CloseCodes.PingTimeout}.
   */
  heartbeatMissesAllowed: number;
}

type CloseCallback = (code: number, reason: string) => void;

/**
 * Encapsulates a single live WebSocket client connection.
 *
 * Responsibilities (Phase 2.2):
 * - Store participant identity (sessionId, participantId, display name, color, branch).
 * - Run a heartbeat loop: ping every `heartbeatIntervalMs`; drop after
 *   `heartbeatMissesAllowed` consecutive missed pongs with code
 *   {@link CloseCodes.PingTimeout}.
 * - Provide a clean {@link close} method (idempotent, code+reason).
 * - Fire {@link onClose} callbacks when the socket closes for any reason.
 *
 * Message routing (Task 2.4) and metrics (Task 2.5) are out of scope here.
 */
export class Connection {
  /** Relay session this connection belongs to. */
  readonly sessionId: string;
  /** Unique identifier for this participant within the session. */
  readonly participantId: string;
  /** Display name as provided by the client. */
  readonly displayName: string;
  /** Hex color as provided by the client. */
  readonly color: string;
  /** Git branch as provided by the client. */
  readonly branch: string;

  readonly #socket: WebSocket;
  readonly #logger: Logger;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMissesAllowed: number;
  readonly #closeCallbacks: CloseCallback[] = [];

  #started = false;
  #closed = false;
  #pendingPongs = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ConnectionDeps) {
    this.sessionId = deps.sessionId;
    this.participantId = deps.participantId;
    this.displayName = deps.displayName;
    this.color = deps.color;
    this.branch = deps.branch;

    this.#socket = deps.socket;
    this.#logger = deps.logger;
    this.#heartbeatIntervalMs = deps.heartbeatIntervalMs;
    this.#heartbeatMissesAllowed = deps.heartbeatMissesAllowed;
  }

  /**
   * Register a callback to be invoked when the connection closes for any reason.
   * The callback receives the WebSocket close code and reason string.
   * Safe to call before or after {@link start}.
   */
  onClose(cb: CloseCallback): void {
    this.#closeCallbacks.push(cb);
  }

  /**
   * Close the underlying socket with a numeric code and reason string.
   * Idempotent — subsequent calls are no-ops.
   */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#logger.debug({ code, reason }, 'connection closing');
    this.#socket.close(code, reason);
  }

  /**
   * Begin the heartbeat loop and wire up socket event listeners.
   * Must be called exactly once after the socket has been admitted.
   * Calling `start()` more than once is a no-op (guarded by a flag).
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;

    this.#socket.on('pong', this.#onPong);
    this.#socket.on('close', this.#onSocketClose);

    this.#heartbeatTimer = setInterval(this.#tick, this.#heartbeatIntervalMs);
  }

  // ----- private handlers (arrow functions to bind `this`) -----

  readonly #tick = (): void => {
    if (this.#pendingPongs >= this.#heartbeatMissesAllowed) {
      this.#logger.warn(
        { pendingPongs: this.#pendingPongs, allowed: this.#heartbeatMissesAllowed },
        'heartbeat timeout — dropping connection',
      );
      this.close(CloseCodes.PingTimeout, 'ping-timeout');
      return;
    }
    this.#pendingPongs += 1;
    try {
      this.#socket.ping();
    } catch (err: unknown) {
      // Socket may have closed between the interval firing and here.
      this.#logger.debug({ err }, 'ping failed (socket likely already closed)');
    }
  };

  readonly #onPong = (): void => {
    this.#pendingPongs = 0;
  };

  readonly #onSocketClose = (code: number, reasonBuf: Buffer): void => {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    // Remove our own listeners to prevent any double-firing.
    this.#socket.off('pong', this.#onPong);
    this.#socket.off('close', this.#onSocketClose);

    this.#closed = true;
    const reason = reasonBuf.toString('utf8');
    this.#logger.debug({ code, reason }, 'connection closed');

    for (const cb of this.#closeCallbacks) {
      try {
        cb(code, reason);
      } catch (err: unknown) {
        this.#logger.error({ err }, 'onClose callback threw');
      }
    }
  };
}

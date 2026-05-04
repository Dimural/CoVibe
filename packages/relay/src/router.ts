/**
 * Router — central message routing component for the CoVibes relay.
 *
 * Responsibilities:
 * - Receive raw text frames from each {@link Connection} via `attach`.
 * - Validate messages through the protocol codec.
 * - Forward client-originated messages to all OTHER participants in the same
 *   session (peer-to-peer relay). Never echoes to sender. Never crosses sessions.
 * - Inject the sender's `participantId` as the `from` field on forwarded envelopes.
 * - Generate server-originated messages: `session.state`, `error`, `conflict.open`.
 * - Enforce per-connection backpressure: close with 4413 when buffered bytes exceed
 *   the threshold.
 * - Maintain routing-relevant counters in {@link RouterStats}.
 */

import { ProtocolError, decode, encode } from '@covibes/protocol';
import type { AnyDecodedMessage, Envelope, MessageType, MessagePayload } from '@covibes/protocol';
import { CloseCodes } from './closeCodes.js';
import type { Connection } from './connection.js';
import type { Logger } from './log.js';
import type { SessionView } from './sessionRegistry.js';

/** Set of message types the Router will forward peer-to-peer. */
export const ROUTABLE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  'doc.delta',
  'cursor.update',
  'agent.intent',
  'agent.change',
  'nav.file',
  'git.operation',
  'git.ack',
  'conflict.resolve',
]);

/**
 * Types that are server-originated only — clients must not send these.
 * Receiving one from a client is a protocol error.
 */
const SERVER_ORIGINATED_TYPES = new Set<string>([
  'session.state',
  'conflict.open',
  'error',
  'session.join',
  'session.leave',
  'ping',
  'pong',
]);

const DEFAULT_BUFFERED_AMOUNT_THRESHOLD = 1_048_576; // 1 MiB
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576; // 1 MiB

/** Injectable dependencies for the {@link Router}. */
export interface RouterDeps {
  /** Child logger for routing events. */
  logger: Logger;
  /** Backpressure threshold in bytes; close connection if bufferedAmount exceeds. */
  bufferedAmountThreshold?: number; // default 1_048_576 (1 MiB)
  /** Max raw message size (bytes) the router will accept. Larger → close 4413. */
  maxMessageBytes?: number; // default 1_048_576
}

/** Point-in-time routing counters. All values monotonically increase. */
export interface RouterStats {
  readonly messagesReceived: number;
  readonly messagesRouted: number;
  readonly bytesRouted: number;
  readonly droppedForBackpressure: number;
  readonly droppedForOversize: number;
  readonly errors: { readonly byCode: Readonly<Record<string, number>> };
}

/** Internal per-session connection map. */
type SessionMap = Map<string, Connection>; // participantId → Connection

/**
 * Central message router for the CoVibes relay.
 *
 * Call {@link attach} immediately after creating and starting a {@link Connection}.
 * The router self-manages: when the connection closes it removes itself from the
 * internal registry automatically.
 */
export class Router {
  readonly #logger: Logger;
  readonly #bufferedAmountThreshold: number;
  readonly #maxMessageBytes: number;

  /**
   * Two-level map: sessionId → (participantId → Connection).
   * Guarantees O(participants in session) peer iteration — ≤4 in practice.
   */
  readonly #sessions: Map<string, SessionMap> = new Map();

  // --- counters ---
  #messagesReceived = 0;
  #messagesRouted = 0;
  #bytesRouted = 0;
  #droppedForBackpressure = 0;
  #droppedForOversize = 0;
  readonly #errorsByCode: Record<string, number> = {};

  constructor(deps: RouterDeps) {
    this.#logger = deps.logger;
    this.#bufferedAmountThreshold =
      deps.bufferedAmountThreshold ?? DEFAULT_BUFFERED_AMOUNT_THRESHOLD;
    this.#maxMessageBytes = deps.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  /**
   * Bind a connection to the router.
   *
   * The connection's incoming text frames will be processed by the router.
   * The connection's close event will trigger automatic removal from the registry.
   */
  attach(conn: Connection): void {
    // Add to internal two-level registry.
    let sessionMap = this.#sessions.get(conn.sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.#sessions.set(conn.sessionId, sessionMap);
    }
    sessionMap.set(conn.participantId, conn);

    // Subscribe to incoming messages.
    conn.onMessage((raw, byteLength) => {
      this.#handleMessage(conn, raw, byteLength);
    });

    // Remove from registry when the connection closes (for any reason).
    conn.onClose(() => {
      const map = this.#sessions.get(conn.sessionId);
      if (map) {
        map.delete(conn.participantId);
        if (map.size === 0) {
          this.#sessions.delete(conn.sessionId);
        }
      }
    });
  }

  /**
   * Send a typed server-originated message to a single participant in a session.
   * Used for `session.state` on admit, `error` on protocol failure, `conflict.open`.
   *
   * Returns `false` if the participant is not found or if the connection was dropped
   * due to backpressure or close.
   */
  sendToParticipant<T extends MessageType>(
    sessionId: string,
    participantId: string,
    type: T,
    payload: MessagePayload<T>,
  ): boolean {
    const conn = this.#sessions.get(sessionId)?.get(participantId);
    if (!conn) return false;

    let encoded: string;
    try {
      encoded = encode(type, payload);
    } catch (err: unknown) {
      this.#logger.error(
        { err, type, sessionId, participantId },
        'encode failed for sendToParticipant',
      );
      return false;
    }
    return conn.send(encoded);
  }

  /**
   * Broadcast a server-originated message to all participants in a session.
   * Used for `conflict.open` and similar Phase-5-mediated messages.
   *
   * Returns the count of successfully-queued sends.
   */
  broadcastToSession<T extends MessageType>(
    sessionId: string,
    type: T,
    payload: MessagePayload<T>,
  ): number {
    const sessionMap = this.#sessions.get(sessionId);
    if (!sessionMap) return 0;

    let encoded: string;
    try {
      encoded = encode(type, payload);
    } catch (err: unknown) {
      this.#logger.error({ err, type, sessionId }, 'encode failed for broadcastToSession');
      return 0;
    }

    let count = 0;
    for (const conn of sessionMap.values()) {
      if (conn.send(encoded)) count++;
    }
    return count;
  }

  /**
   * Send `session.state` to a freshly-admitted participant.
   * Called from the server's upgrade-success path immediately after {@link attach}.
   */
  sendSessionState(conn: Connection, view: SessionView): void {
    const participants = view.participants.map((p) => ({
      id: p.participantId,
      displayName: p.displayName,
      color: p.color,
      currentFile: null,
      agentActiveOn: null,
    }));

    // Ensure the branch is populated from the view.
    this.sendToParticipant(conn.sessionId, conn.participantId, 'session.state', {
      sessionId: view.sessionId,
      branch: view.branch,
      you: conn.participantId,
      participants,
    });
  }

  /** Current routing statistics snapshot. */
  get stats(): RouterStats {
    return {
      messagesReceived: this.#messagesReceived,
      messagesRouted: this.#messagesRouted,
      bytesRouted: this.#bytesRouted,
      droppedForBackpressure: this.#droppedForBackpressure,
      droppedForOversize: this.#droppedForOversize,
      errors: { byCode: { ...this.#errorsByCode } },
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  #handleMessage(senderConn: Connection, raw: string, byteLength: number): void {
    this.#messagesReceived++;

    // Step 1: size check.
    if (byteLength > this.#maxMessageBytes) {
      this.#droppedForOversize++;
      this.#logger.warn(
        { byteLength, max: this.#maxMessageBytes, participantId: senderConn.participantId },
        'message exceeds max size — closing',
      );
      senderConn.close(CloseCodes.MessageTooLarge, 'message-too-large');
      return;
    }

    // Step 2: decode and validate.
    let decoded: AnyDecodedMessage;
    try {
      decoded = decode(raw);
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        this.#incrementErrorCode(err.code);
        if (err.code === 'version-mismatch') {
          // Can't send error back — client can't parse our response. Close hard.
          senderConn.close(CloseCodes.ProtocolMismatch, 'version-mismatch');
        } else {
          // All other protocol errors: send error message but keep connection alive.
          this.#sendError(senderConn, err.code, err.message, true);
        }
      } else {
        this.#logger.error({ err }, 'unexpected non-ProtocolError from decode');
        this.#incrementErrorCode('internal');
      }
      return;
    }

    const { type } = decoded;

    // Step 3: type routing decision.
    if (ROUTABLE_TYPES.has(type)) {
      // Forward to peers.
      this.#forwardToPeers(senderConn, decoded.envelope);
      return;
    }

    // Unexpected client-sent type.
    if (SERVER_ORIGINATED_TYPES.has(type)) {
      this.#incrementErrorCode('unexpected-type');
      this.#sendError(
        senderConn,
        'unexpected-type',
        `Message type '${type}' is not valid from clients`,
        true,
      );
      return;
    }

    // Any other type that passed decode but is not routable and not server-originated
    // (shouldn't happen with current MessageMap, but be defensive).
    this.#incrementErrorCode('unexpected-type');
    this.#sendError(
      senderConn,
      'unexpected-type',
      `Message type '${type}' cannot be sent by clients`,
      true,
    );
  }

  #forwardToPeers(senderConn: Connection, envelope: Envelope): void {
    const sessionMap = this.#sessions.get(senderConn.sessionId);
    if (!sessionMap) return;

    // Re-serialize with `from` injected.
    // Overwrite (or set) from — never trust the client's value.
    const envelopeWithFrom = JSON.stringify({ ...envelope, from: senderConn.participantId });
    const byteLength = Buffer.byteLength(envelopeWithFrom, 'utf8');

    for (const [peerId, peerConn] of sessionMap) {
      if (peerId === senderConn.participantId) continue; // never echo

      // Backpressure check before forwarding.
      if (peerConn.bufferedAmount > this.#bufferedAmountThreshold) {
        this.#droppedForBackpressure++;
        this.#logger.warn(
          {
            peerParticipantId: peerId,
            bufferedAmount: peerConn.bufferedAmount,
            threshold: this.#bufferedAmountThreshold,
          },
          'peer backpressure threshold exceeded — closing peer',
        );
        peerConn.close(CloseCodes.SlowConsumer, 'backpressure');
        continue;
      }

      if (peerConn.send(envelopeWithFrom)) {
        this.#messagesRouted++;
        this.#bytesRouted += byteLength;
      }
    }
  }

  #sendError(conn: Connection, code: string, message: string, recoverable: boolean): void {
    try {
      const encoded = encode('error', {
        code: code.slice(0, 64),
        message: message.slice(0, 2000),
        recoverable,
      });
      conn.send(encoded);
    } catch (err: unknown) {
      this.#logger.error({ err, code }, 'failed to encode/send error message');
    }
  }

  #incrementErrorCode(code: string): void {
    this.#errorsByCode[code] = (this.#errorsByCode[code] ?? 0) + 1;
  }
}

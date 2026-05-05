/**
 * SessionStore — backend-agnostic persistence interface for session data.
 *
 * The registry composes a SessionStore. Two implementations are provided:
 * - {@link MemorySessionStore} (in-process Map, single-node only).
 * - {@link RedisSessionStore} (ioredis, multi-node safe via WATCH/MULTI).
 */

/** A participant's persisted state. */
export interface StoredParticipant {
  displayName: string;
  color: string;
  /** True once the participant has been admitted (active WebSocket connection). */
  active: boolean;
}

/** A session's full persisted state. */
export interface StoredSession {
  sessionId: string;
  branch: string;
  /** SHA-256 of the canonical token. Stored for verification across all joiners. */
  tokenHash: Buffer;
  /** Map from participantId → participant data. */
  participants: Map<string, StoredParticipant>;
  /** Number of currently-connected (active) participants (≤ participants.size during grace). */
  activeCount: number;
  /**
   * Wall-clock timestamp (ms since epoch) at which expiry timer was set.
   * Null if at least one participant is active.
   */
  expiryTimestamp: number | null;
}

/**
 * Backend-agnostic persistence for sessions.
 *
 * Implementations must guarantee that `update` is atomic and serialized
 * per `sessionId`. Concurrent `update` calls on the same session must not
 * interleave — each transform must see the result of all prior transforms.
 */
export interface SessionStore {
  /**
   * Read a session record. Returns null if the session does not exist.
   * The returned object must be treated as immutable by the caller.
   */
  read(sessionId: string): Promise<StoredSession | null>;

  /**
   * Atomically read-modify-write a session record.
   *
   * The `transform` callback receives the current record (or null for a new
   * session) and returns:
   * - `{ next: StoredSession, result: T }` — store `next`, return `result`.
   * - `{ next: null, result: T }` — delete the record, return `result`.
   *
   * The store guarantees that `transform` runs under a per-session lock
   * (promise queue for in-memory, WATCH/MULTI retry for Redis).
   */
  update<T>(
    sessionId: string,
    transform: (current: StoredSession | null) => { next: StoredSession | null; result: T },
  ): Promise<T>;

  /**
   * Delete a session record. Idempotent.
   */
  delete(sessionId: string): Promise<void>;
}

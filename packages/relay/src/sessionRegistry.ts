/**
 * SessionRegistry — the high-level abstraction the server consumes.
 *
 * Implements {@link SessionAuthorizer} (so `server.ts` can use it without
 * modification) and adds `get`/`listParticipants`/`joinOrCreate`/`leave`
 * for richer session management.
 *
 * The registry owns:
 * - Token verification (constant-time SHA-256 compare).
 * - Capacity enforcement.
 * - Grace timer scheduling / cancellation.
 * - Active-count bookkeeping.
 *
 * The storage backend is provided via {@link SessionStore}.
 */

import type { SessionAuthorizer, AuthorizeRequest } from './auth.js';

/** Public view of a participant, safe to return to the server layer. */
export interface ParticipantView {
  participantId: string;
  displayName: string;
  color: string;
  /** True once the participant has actively connected (admitted via authorize). */
  active: boolean;
}

/** Public view of a session, safe to return to the server layer. */
export interface SessionView {
  sessionId: string;
  branch: string;
  participants: readonly ParticipantView[];
  /**
   * Wall-clock timestamp (ms since epoch) at which the session expires if no
   * participant is connected. Null if at least one participant is active.
   */
  expiresAt: number | null;
}

/** Outcome of a `joinOrCreate` call. */
export type JoinOrCreateOutcome =
  | { kind: 'admitted'; participantId: string; view: SessionView }
  | { kind: 'rejected'; reason: 'session-full' | 'wrong-token' | 'invalid-input' };

/**
 * High-level session registry consumed by the relay server.
 *
 * Extends {@link SessionAuthorizer} so the existing `server.ts` upgrade
 * handler can use it without modification (`authorize` and `release` are both
 * present). `release` is an alias for `leave`.
 */
export interface SessionRegistry extends SessionAuthorizer {
  /**
   * Read-only snapshot of a session, or null if not found / expired.
   * Stale-tolerant: callers must not mutate the returned object.
   */
  get(sessionId: string): Promise<SessionView | null>;

  /** Ordered list of participants in a session, or empty array if not found. */
  listParticipants(sessionId: string): Promise<readonly ParticipantView[]>;

  /**
   * Join an existing session or create a new one. Returns a full `SessionView`
   * so the server can immediately build a `session.state` message.
   *
   * Equivalent to `authorize` but with richer return type.
   */
  joinOrCreate(req: AuthorizeRequest): Promise<JoinOrCreateOutcome>;

  /**
   * Mark a participant as having left. If this empties the session, start the
   * grace timer; a future `joinOrCreate` within grace cancels the timer.
   * Idempotent — calling `leave` on an already-inactive participant is a no-op.
   */
  leave(sessionId: string, participantId: string): Promise<void>;
}

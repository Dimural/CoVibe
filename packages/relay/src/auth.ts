/**
 * Auth interfaces for WebSocket upgrade admission.
 *
 * ## Auth model
 *
 * The relay does NOT verify a cryptographic signature. Instead it uses a
 * **shared bearer-secret per session**: the first participant to connect to a
 * given `sessionId` establishes the canonical token. All subsequent joiners
 * must present the same token (verified with a constant-time comparison).
 *
 * This is appropriate because:
 * - Neither the relay nor the client knows the other's signing key.
 * - Both sides derive `sessionId` from `(remoteUrl, branch, token)` using
 *   `deriveSessionId` from `@covibes/protocol`, so the token itself is the
 *   credential that created the session identity.
 * - Wrong token → `4401 Unauthorized`. Capacity exceeded → `4429 Session Full`.
 *
 * Phase 2.3 replaces the in-memory implementation with a Redis-backed one.
 */

/**
 * Authorizes WebSocket upgrade attempts. Implementations decide whether a
 * given (sessionId, token, participantId?) is allowed to join the session,
 * and either create the session (first joiner) or attach to an existing one.
 *
 * The Phase 2.2 stub accepts the first joiner of a session and stores the
 * token; subsequent joiners with the same token are accepted, others are
 * rejected with `wrong-token`. Capacity is enforced.
 *
 * Phase 2.3 replaces this with a Redis-backed implementation.
 */
export interface SessionAuthorizer {
  /**
   * Attempt to admit a participant to a session.
   * - If the session does not exist, create it and admit.
   * - If it exists with the same token and capacity remains, admit.
   * - Otherwise reject with a typed reason.
   */
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;

  /**
   * Notify the authorizer that a participant has disconnected.
   * Implementations use this to free a capacity slot.
   */
  release(sessionId: string, participantId: string): Promise<void>;
}

/** Input to an authorization attempt. */
export interface AuthorizeRequest {
  /** The session identifier derived by the client from (remoteUrl, branch, token). */
  sessionId: string;
  /** The bearer token that identifies the session — opaque to the relay. */
  token: string;
  /**
   * Provided by the client to resume an existing identity within grace;
   * undefined for new joiners.
   */
  participantId?: string;
  /** Display name from the client; opaque to the relay (length-bounded). */
  displayName: string;
  /** Hex color, also opaque/length-validated. */
  color: string;
  /** Branch the client is on. Stored as part of session metadata, not validated. */
  branch: string;
}

/** Result of an authorization attempt. */
export type AuthorizeResult =
  | { kind: 'admitted'; participantId: string }
  | { kind: 'rejected'; reason: AuthorizeRejection };

/** Typed rejection reasons. */
export type AuthorizeRejection = 'session-full' | 'wrong-token' | 'invalid-input';

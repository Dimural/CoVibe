/**
 * SessionRegistryImpl — concrete implementation of {@link SessionRegistry}.
 *
 * ## Architecture
 *
 * This class owns all business logic (token verification, capacity enforcement,
 * grace timers, active-count bookkeeping) and delegates raw storage to a
 * {@link SessionStore}.
 *
 * ## Multi-node caveat
 *
 * In a single relay process the in-process `setTimeout` reliably fires after
 * `sessionGraceMs` milliseconds and deletes the session from the store. In a
 * multi-node deployment this timer does NOT survive a process restart.
 *
 * Redis TTL (set via `pexpire` in `RedisSessionStore`) is the authoritative
 * source of truth: if the process holding the timer dies, the Redis key still
 * auto-expires at the correct wall-clock time. The in-process timer is therefore
 * an optimisation — when it fires it attempts `store.delete`, which is harmless
 * if the key is already gone.
 *
 * Conversely, if a different relay node called `leave` (setting the timer)
 * while this node's in-process timer is still pending from an earlier grace
 * period on a different session, there is no correctness issue: the timer
 * callback checks `activeCount === 0` before deleting, guarding against the
 * case where a new participant joined on another node and the Redis store now
 * shows the session as active.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { AuthorizeRequest, AuthorizeResult } from './auth.js';
import type {
  SessionRegistry,
  SessionView,
  ParticipantView,
  JoinOrCreateOutcome,
} from './sessionRegistry.js';
import type { SessionStore, StoredSession } from './sessionStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toView(session: StoredSession): SessionView {
  const participants: ParticipantView[] = Array.from(session.participants.entries()).map(
    ([participantId, p]) => ({
      participantId,
      displayName: p.displayName,
      color: p.color,
      active: p.active,
    }),
  );
  return {
    sessionId: session.sessionId,
    branch: session.branch,
    participants,
    expiresAt: session.expiryTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Injectable dependencies for testability. */
export interface SessionRegistryDeps {
  store: SessionStore;
  config: Pick<Config, 'maxParticipants' | 'sessionGraceMs'>;
  /** Optional clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional `setTimeout` override for tests (fake timers). */
  setTimeout?: typeof globalThis.setTimeout;
  /** Optional `clearTimeout` override for tests (fake timers). */
  clearTimeout?: typeof globalThis.clearTimeout;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Concrete {@link SessionRegistry} implementation backed by a {@link SessionStore}.
 *
 * Construct with `new SessionRegistryImpl({ store, config })`.
 */
export class SessionRegistryImpl implements SessionRegistry {
  readonly #store: SessionStore;
  readonly #maxParticipants: number;
  readonly #sessionGraceMs: number;
  readonly #now: () => number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #logger: Logger | undefined;

  /** In-process grace timers keyed by sessionId. */
  readonly #graceTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  constructor(deps: SessionRegistryDeps) {
    this.#store = deps.store;
    this.#maxParticipants = deps.config.maxParticipants;
    this.#sessionGraceMs = deps.config.sessionGraceMs;
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimeout = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimeout = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.#logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // SessionRegistry public API
  // -------------------------------------------------------------------------

  async get(sessionId: string): Promise<SessionView | null> {
    const record = await this.#store.read(sessionId);
    return record ? toView(record) : null;
  }

  async listParticipants(sessionId: string): Promise<readonly ParticipantView[]> {
    const record = await this.#store.read(sessionId);
    if (!record) return [];
    return Array.from(record.participants.entries()).map(([participantId, p]) => ({
      participantId,
      displayName: p.displayName,
      color: p.color,
      active: p.active,
    }));
  }

  async joinOrCreate(req: AuthorizeRequest): Promise<JoinOrCreateOutcome> {
    // Defense-in-depth: validate inputs before touching the store.
    if (!req.sessionId || !req.token || !req.displayName || !req.color || !req.branch) {
      return { kind: 'rejected', reason: 'invalid-input' };
    }

    const tokenHash = sha256(req.token);

    type TransformResult =
      | { kind: 'admitted'; participantId: string; session: StoredSession }
      | { kind: 'rejected'; reason: 'session-full' | 'wrong-token' | 'invalid-input' };

    const outcome = await this.#store.update<TransformResult>(req.sessionId, (current) => {
      if (current === null) {
        // First joiner: create the session.
        const participantId = req.participantId ?? randomUUID();
        const next: StoredSession = {
          sessionId: req.sessionId,
          branch: req.branch,
          tokenHash,
          participants: new Map([
            [participantId, { displayName: req.displayName, color: req.color, active: true }],
          ]),
          activeCount: 1,
          expiryTimestamp: null,
        };
        return { next, result: { kind: 'admitted', participantId, session: next } };
      }

      // --- Existing session ---

      // Token check — must happen before capacity check to avoid leaking info.
      if (!constantTimeEqual(current.tokenHash, tokenHash)) {
        return { next: current, result: { kind: 'rejected', reason: 'wrong-token' } };
      }

      // Resume path: known participantId re-joining (may be inactive during grace).
      if (req.participantId !== undefined && current.participants.has(req.participantId)) {
        const existing = current.participants.get(req.participantId)!;
        const wasActive = existing.active;
        existing.active = true;
        if (!wasActive) {
          current.activeCount += 1;
        }
        // Cancel grace timer if applicable.
        current.expiryTimestamp = null;

        // Update display name / color in case they changed.
        existing.displayName = req.displayName;
        existing.color = req.color;

        // Ensure expiryTimestamp is cleared.
        const next: StoredSession = { ...current, expiryTimestamp: null };
        return {
          next,
          result: { kind: 'admitted', participantId: req.participantId, session: next },
        };
      }

      // New participant — enforce capacity.
      if (current.activeCount >= this.#maxParticipants) {
        return { next: current, result: { kind: 'rejected', reason: 'session-full' } };
      }

      // Admit new participant.
      const participantId = req.participantId ?? randomUUID();
      current.participants.set(participantId, {
        displayName: req.displayName,
        color: req.color,
        active: true,
      });
      current.activeCount += 1;
      current.expiryTimestamp = null;

      const next: StoredSession = { ...current };
      return { next, result: { kind: 'admitted', participantId, session: next } };
    });

    if (outcome.kind === 'rejected') {
      return { kind: 'rejected', reason: outcome.reason };
    }

    // Cancel any pending grace timer for this session.
    this.#cancelGraceTimer(req.sessionId);

    return {
      kind: 'admitted',
      participantId: outcome.participantId,
      view: toView(outcome.session),
    };
  }

  async leave(sessionId: string, participantId: string): Promise<void> {
    const now = this.#now();

    const shouldStartGrace = await this.#store.update<boolean>(sessionId, (current) => {
      if (current === null) return { next: null, result: false };

      const participant = current.participants.get(participantId);
      if (!participant || !participant.active) {
        // Idempotent: already inactive or unknown.
        return { next: current, result: false };
      }

      participant.active = false;
      current.activeCount = Math.max(0, current.activeCount - 1);

      if (current.activeCount === 0) {
        current.expiryTimestamp = now + this.#sessionGraceMs;
        return { next: current, result: true };
      }

      return { next: current, result: false };
    });

    if (shouldStartGrace) {
      this.#scheduleGraceTimer(sessionId);
    }
  }

  /**
   * Implement `SessionAuthorizer.release` — delegates to `leave`.
   * Kept so existing `server.ts` code calling `authorizer.release(...)` works
   * without modification.
   */
  release(sessionId: string, participantId: string): Promise<void> {
    return this.leave(sessionId, participantId);
  }

  /**
   * Implement `SessionAuthorizer.authorize` — thin shim over `joinOrCreate`.
   * Maps {@link JoinOrCreateOutcome} to {@link AuthorizeResult}.
   */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const outcome = await this.joinOrCreate(req);
    if (outcome.kind === 'admitted') {
      return { kind: 'admitted', participantId: outcome.participantId };
    }
    return { kind: 'rejected', reason: outcome.reason };
  }

  // -------------------------------------------------------------------------
  // Grace timer management
  // -------------------------------------------------------------------------

  #scheduleGraceTimer(sessionId: string): void {
    // Cancel any existing timer first (safety; shouldn't happen in normal flow).
    this.#cancelGraceTimer(sessionId);

    const timer = this.#setTimeout(() => {
      this.#graceTimers.delete(sessionId);
      this.#expireSession(sessionId).catch((err: unknown) => {
        this.#logger?.error({ sessionId, err }, 'failed to expire session after grace');
      });
    }, this.#sessionGraceMs);

    this.#graceTimers.set(sessionId, timer);
  }

  #cancelGraceTimer(sessionId: string): void {
    const timer = this.#graceTimers.get(sessionId);
    if (timer !== undefined) {
      this.#clearTimeout(timer);
      this.#graceTimers.delete(sessionId);
    }
  }

  async #expireSession(sessionId: string): Promise<void> {
    const deleted = await this.#store.update<boolean>(sessionId, (current) => {
      if (current === null) {
        return { next: null, result: false };
      }
      if (current.activeCount > 0) {
        // Session was revived during the grace period — leave it alone.
        return { next: current, result: false };
      }
      return { next: null, result: true };
    });
    if (deleted) {
      this.#logger?.debug({ sessionId }, 'session expired after grace period');
    } else {
      this.#logger?.debug(
        { sessionId },
        'grace timer fired but session is active or already gone; skipping delete',
      );
    }
  }
}

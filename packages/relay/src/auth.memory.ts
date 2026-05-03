import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { AuthorizeRequest, AuthorizeResult, SessionAuthorizer } from './auth.js';

interface ParticipantRecord {
  displayName: string;
  color: string;
  branch: string;
}

interface SessionRecord {
  /** SHA-256 of the token — fixed 32-byte length suitable for `timingSafeEqual`. */
  tokenHash: Buffer;
  participants: Map<string, ParticipantRecord>;
}

/**
 * In-memory implementation of {@link SessionAuthorizer}.
 *
 * This is the Phase 2.2 stub. It stores session state in a `Map`, making it
 * single-process only. Phase 2.3 replaces/wraps this with a Redis-backed
 * implementation that works across multiple relay instances.
 *
 * Despite being a stub, this implementation is production-quality:
 * - Token comparison uses SHA-256 digests with `timingSafeEqual` to prevent
 *   timing-oracle attacks on the bearer secret.
 * - Capacity is strictly enforced.
 * - The resume path (same `participantId` re-joining) is idempotent.
 */
export class InMemoryAuthorizer implements SessionAuthorizer {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #maxParticipants: number;

  constructor(deps: { config: Pick<Config, 'maxParticipants'> }) {
    this.#maxParticipants = deps.config.maxParticipants;
  }

  authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    // Defense-in-depth: server.ts validates inputs with zod before calling us,
    // but we validate again here to protect against direct callers.
    if (!req.sessionId || !req.token || !req.displayName || !req.color || !req.branch) {
      return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    }

    const tokenHash = sha256(req.token);
    const existing = this.#sessions.get(req.sessionId);

    // Session IDs are public routing keys (see @covibes/protocol/session.ts).
    // Timing leakage on this branch does not compromise security since the
    // secret is the token, not the session ID.
    if (!existing) {
      // First joiner: establish the session and set the canonical token hash.
      const participantId = req.participantId ?? randomUUID();
      const record: SessionRecord = {
        tokenHash,
        participants: new Map([
          [participantId, { displayName: req.displayName, color: req.color, branch: req.branch }],
        ]),
      };
      this.#sessions.set(req.sessionId, record);
      return Promise.resolve({ kind: 'admitted', participantId });
    }

    // Token check — must happen before capacity check to avoid leaking capacity info
    // to a caller with the wrong token.
    if (!constantTimeEqual(existing.tokenHash, tokenHash)) {
      return Promise.resolve({ kind: 'rejected', reason: 'wrong-token' });
    }

    // Resume path: known participantId already in the session → admit idempotently.
    if (req.participantId !== undefined && existing.participants.has(req.participantId)) {
      return Promise.resolve({ kind: 'admitted', participantId: req.participantId });
    }

    if (existing.participants.size >= this.#maxParticipants) {
      return Promise.resolve({ kind: 'rejected', reason: 'session-full' });
    }

    const participantId = req.participantId ?? randomUUID();
    existing.participants.set(participantId, {
      displayName: req.displayName,
      color: req.color,
      branch: req.branch,
    });
    return Promise.resolve({ kind: 'admitted', participantId });
  }

  release(sessionId: string, participantId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return Promise.resolve();
    record.participants.delete(participantId);
    if (record.participants.size === 0) {
      this.#sessions.delete(sessionId);
    }
    return Promise.resolve();
  }
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * In-memory implementation of {@link SessionStore}.
 *
 * Uses a `Map<string, StoredSession>` for storage and a per-session promise
 * queue to serialize concurrent `update` calls. Single-process only; no
 * persistence across restarts.
 */

import type { SessionStore, StoredSession } from './sessionStore.js';

/** Clones a StoredSession so callers cannot mutate the stored record. */
function cloneSession(s: StoredSession): StoredSession {
  return {
    sessionId: s.sessionId,
    branch: s.branch,
    tokenHash: Buffer.from(s.tokenHash),
    participants: new Map(Array.from(s.participants.entries()).map(([k, v]) => [k, { ...v }])),
    activeCount: s.activeCount,
    expiryTimestamp: s.expiryTimestamp,
  };
}

/**
 * In-memory {@link SessionStore}.
 *
 * Thread-safety: Node.js is single-threaded, but async code can interleave.
 * The per-session mutex (a promise queue) ensures transforms on the same
 * sessionId are always serialized.
 */
export class MemorySessionStore implements SessionStore {
  readonly #data = new Map<string, StoredSession>();
  /** Per-session update queue. Each entry is the tail promise of the chain. */
  readonly #locks = new Map<string, Promise<unknown>>();

  read(sessionId: string): Promise<StoredSession | null> {
    const record = this.#data.get(sessionId);
    return Promise.resolve(record ? cloneSession(record) : null);
  }

  update<T>(
    sessionId: string,
    transform: (current: StoredSession | null) => { next: StoredSession | null; result: T },
  ): Promise<T> {
    // Chain this update behind any pending update for the same session.
    const prev = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.#runTransform(sessionId, transform));
    // Store the chain tail; clean up when done (either way).
    this.#locks.set(
      sessionId,
      next.then(
        () => {
          if (this.#locks.get(sessionId) === next) this.#locks.delete(sessionId);
        },
        () => {
          if (this.#locks.get(sessionId) === next) this.#locks.delete(sessionId);
        },
      ),
    );
    return next;
  }

  #runTransform<T>(
    sessionId: string,
    transform: (current: StoredSession | null) => { next: StoredSession | null; result: T },
  ): T {
    const current = this.#data.get(sessionId) ?? null;
    const { next, result } = transform(current ? cloneSession(current) : null);
    if (next === null) {
      this.#data.delete(sessionId);
    } else {
      // Store a clone so future reads/transforms start fresh.
      this.#data.set(sessionId, cloneSession(next));
    }
    return result;
  }

  delete(sessionId: string): Promise<void> {
    this.#data.delete(sessionId);
    return Promise.resolve();
  }
}

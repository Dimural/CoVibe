/**
 * Redis-backed implementation of {@link SessionStore}.
 *
 * ## Key schema
 * - `session:{id}:meta`  — JSON blob: `{ branch, tokenHash (base64), activeCount, expiryTimestamp }`.
 * - `session:{id}:participants` — Redis hash (HSET), field=participantId, value=JSON `{ displayName, color, active }`.
 *
 * ## Concurrency
 * `update` uses WATCH/MULTI (optimistic concurrency) with up to MAX_RETRIES
 * attempts before throwing. On each retry the full read-transform-write cycle
 * repeats.
 *
 * ## TTL / grace
 * When `expiryTimestamp` is set, `pexpire` is applied to both keys so Redis
 * auto-expires the session. When cleared (session becomes active again),
 * `persist` removes the TTL.
 *
 * ## Multi-node caveat
 * Redis TTL is the source of truth for expiry across nodes. The in-process
 * `setTimeout` held by `SessionRegistryImpl` is an optimization; if a node
 * dies its timer is lost, but the Redis TTL still expires the key correctly.
 */

import type { Redis } from 'ioredis';
import type { SessionStore, StoredParticipant, StoredSession } from './sessionStore.js';

const MAX_RETRIES = 10;

interface SerializedMeta {
  branch: string;
  tokenHash: string; // base64
  activeCount: number;
  expiryTimestamp: number | null;
}

function metaKey(sessionId: string): string {
  return `session:${sessionId}:meta`;
}

function participantsKey(sessionId: string): string {
  return `session:${sessionId}:participants`;
}

function serializeMeta(s: StoredSession): SerializedMeta {
  return {
    branch: s.branch,
    tokenHash: s.tokenHash.toString('base64'),
    activeCount: s.activeCount,
    expiryTimestamp: s.expiryTimestamp,
  };
}

function deserializeParticipants(raw: Record<string, string>): Map<string, StoredParticipant> {
  const map = new Map<string, StoredParticipant>();
  for (const [id, json] of Object.entries(raw)) {
    const parsed = JSON.parse(json) as StoredParticipant;
    map.set(id, parsed);
  }
  return map;
}

async function readBoth(
  redis: Redis,
  mKey: string,
  pKey: string,
  sessionId: string,
): Promise<StoredSession | null> {
  const [metaRaw, participantsRaw] = await Promise.all([redis.get(mKey), redis.hgetall(pKey)]);

  if (metaRaw === null) return null;

  const meta = JSON.parse(metaRaw) as SerializedMeta;
  const participants = participantsRaw
    ? deserializeParticipants(participantsRaw)
    : new Map<string, StoredParticipant>();

  return {
    sessionId,
    branch: meta.branch,
    tokenHash: Buffer.from(meta.tokenHash, 'base64'),
    participants,
    activeCount: meta.activeCount,
    expiryTimestamp: meta.expiryTimestamp,
  };
}

/**
 * Redis-backed {@link SessionStore}.
 *
 * Requires an `ioredis` Redis instance. The caller is responsible for
 * connection management (connect/quit).
 */
export class RedisSessionStore implements SessionStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async read(sessionId: string): Promise<StoredSession | null> {
    return readBoth(this.#redis, metaKey(sessionId), participantsKey(sessionId), sessionId);
  }

  async update<T>(
    sessionId: string,
    transform: (current: StoredSession | null) => { next: StoredSession | null; result: T },
  ): Promise<T> {
    const mKey = metaKey(sessionId);
    const pKey = participantsKey(sessionId);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Watch both keys for optimistic concurrency.
      await this.#redis.watch(mKey, pKey);

      const current = await readBoth(this.#redis, mKey, pKey, sessionId);
      const { next, result } = transform(current);

      const tx = this.#redis.multi();

      if (next === null) {
        tx.del(mKey, pKey);
      } else {
        tx.set(mKey, JSON.stringify(serializeMeta(next)));
        // Rebuild the participants hash atomically.
        tx.del(pKey);
        if (next.participants.size > 0) {
          const fields: string[] = [];
          for (const [id, p] of next.participants.entries()) {
            fields.push(id, JSON.stringify(p));
          }
          tx.hset(pKey, ...fields);
        }

        // Apply or remove TTL.
        if (next.expiryTimestamp !== null) {
          const ttlMs = next.expiryTimestamp - Date.now();
          if (ttlMs > 0) {
            tx.pexpire(mKey, ttlMs);
            tx.pexpire(pKey, ttlMs);
          } else {
            // Already expired — delete immediately.
            tx.del(mKey, pKey);
          }
        } else {
          // Active session — no TTL.
          tx.persist(mKey);
          tx.persist(pKey);
        }
      }

      const execResult = await tx.exec();
      if (execResult !== null) {
        // Transaction succeeded.
        return result;
      }
      // null → another client modified the watched keys; retry.
    }

    throw new Error(
      `RedisSessionStore: optimistic concurrency failed after ${MAX_RETRIES} retries for session "${sessionId}"`,
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.#redis.del(metaKey(sessionId), participantsKey(sessionId));
  }
}

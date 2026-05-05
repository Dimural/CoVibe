/**
 * Redis store tests.
 *
 * These tests require a real Redis instance or `ioredis-mock`.
 * They are skipped when the `REDIS_URL` environment variable is not set AND
 * `ioredis-mock` is not installed.
 *
 * To run against a real Redis:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @covibes/relay test
 *
 * Note: `redis-memory-server` / `ioredis-mock` are not added as hard
 * dependencies to keep CI fast. If you want to run these tests locally without
 * a real Redis, install `ioredis-mock` in the relay package and update this
 * file to use it unconditionally.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Redis } from 'ioredis';
import type { StoredSession } from '../src/sessionStore.js';
import type { RedisSessionStore } from '../src/sessionStore.redis.js';

// ---------------------------------------------------------------------------
// Dynamic import of ioredis (real or mock)
// ---------------------------------------------------------------------------

const REDIS_URL = process.env['REDIS_URL'];
const HAS_REDIS = Boolean(REDIS_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id = 'session-redis-1'): StoredSession {
  return {
    sessionId: id,
    branch: 'main',
    tokenHash: Buffer.from('deadbeef'.repeat(8), 'hex'), // 32 bytes (SHA-256)
    participants: new Map([['p1', { displayName: 'Alice', color: '#ff0000', active: true }]]),
    activeCount: 1,
    expiryTimestamp: null,
  };
}

// ---------------------------------------------------------------------------
// Tests — all skipped unless REDIS_URL is set
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_REDIS)(
  'RedisSessionStore (requires real Redis — set REDIS_URL to enable)',
  () => {
    let redis: Redis;
    let store: RedisSessionStore;

    beforeAll(async () => {
      const { Redis: IORedis } = await import('ioredis');
      const { RedisSessionStore } = await import('../src/sessionStore.redis.js');
      redis = new IORedis(REDIS_URL!);
      store = new RedisSessionStore(redis);
    });

    afterAll(async () => {
      await redis.quit();
    });

    it('read of unknown sessionId returns null', async () => {
      await expect(store.read('redis-does-not-exist')).resolves.toBeNull();
    });

    it('update creates a new session', async () => {
      const session = makeSession('redis-create-test');
      await store.update('redis-create-test', () => ({ next: session, result: undefined }));

      const record = await store.read('redis-create-test');
      expect(record).not.toBeNull();
      expect(record!.sessionId).toBe('redis-create-test');
      expect(record!.branch).toBe('main');
      // Token hash should survive base64 round-trip.
      expect(record!.tokenHash.toString('hex')).toBe(session.tokenHash.toString('hex'));
      expect(record!.participants.get('p1')?.displayName).toBe('Alice');

      await store.delete('redis-create-test');
    });

    it('update modifies an existing session', async () => {
      const id = 'redis-modify-test';
      await store.update(id, () => ({ next: makeSession(id), result: undefined }));

      await store.update(id, (current) => ({
        next: { ...current!, activeCount: 5 },
        result: undefined,
      }));

      const record = await store.read(id);
      expect(record!.activeCount).toBe(5);
      await store.delete(id);
    });

    it('update deletes session when transform returns next: null', async () => {
      const id = 'redis-delete-test';
      await store.update(id, () => ({ next: makeSession(id), result: undefined }));
      await store.update(id, () => ({ next: null, result: undefined }));
      await expect(store.read(id)).resolves.toBeNull();
    });

    it('delete removes a session idempotently', async () => {
      const id = 'redis-delete-idem-test';
      await store.update(id, () => ({ next: makeSession(id), result: undefined }));
      await store.delete(id);
      await expect(store.read(id)).resolves.toBeNull();
      await expect(store.delete(id)).resolves.toBeUndefined();
    });

    it('pexpire is set when expiryTimestamp is non-null', async () => {
      const id = 'redis-ttl-test';
      const session: StoredSession = {
        ...makeSession(id),
        expiryTimestamp: Date.now() + 60_000, // 60 seconds
      };
      await store.update(id, () => ({ next: session, result: undefined }));

      const ttl = await redis.pttl(`session:${id}:meta`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);

      await store.delete(id);
    });

    it('persist removes TTL when expiryTimestamp is cleared', async () => {
      const id = 'redis-persist-test';
      // First set with expiry.
      const withExpiry: StoredSession = {
        ...makeSession(id),
        expiryTimestamp: Date.now() + 60_000,
      };
      await store.update(id, () => ({ next: withExpiry, result: undefined }));

      // Verify TTL is set.
      const ttlBefore = await redis.pttl(`session:${id}:meta`);
      expect(ttlBefore).toBeGreaterThan(0);

      // Now clear expiry.
      await store.update(id, (current) => ({
        next: { ...current!, expiryTimestamp: null },
        result: undefined,
      }));

      // TTL should now be -1 (no expiry).
      const ttlAfter = await redis.pttl(`session:${id}:meta`);
      expect(ttlAfter).toBe(-1);

      await store.delete(id);
    });

    it('tokenHash survives base64 round-trip', async () => {
      const id = 'redis-token-test';
      const hash = Buffer.from('a'.repeat(32), 'utf8'); // 32 bytes
      const session: StoredSession = { ...makeSession(id), tokenHash: hash };
      await store.update(id, () => ({ next: session, result: undefined }));

      const record = await store.read(id);
      expect(record!.tokenHash.compare(hash)).toBe(0);
      await store.delete(id);
    });
  },
);

// ---------------------------------------------------------------------------
// Minimal smoke test that always runs (no Redis needed)
// ---------------------------------------------------------------------------

describe('RedisSessionStore import sanity', () => {
  it('module exports RedisSessionStore class', async () => {
    const mod = await import('../src/sessionStore.redis.js');
    expect(typeof mod.RedisSessionStore).toBe('function');
  });
});

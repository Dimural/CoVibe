import { describe, it, expect } from 'vitest';
import { MemorySessionStore } from '../src/sessionStore.memory.js';
import type { StoredSession } from '../src/sessionStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id = 'session-1'): StoredSession {
  return {
    sessionId: id,
    branch: 'main',
    tokenHash: Buffer.from('deadbeef'.repeat(4), 'hex'), // 16 bytes
    participants: new Map([['p1', { displayName: 'Alice', color: '#ff0000', active: true }]]),
    activeCount: 1,
    expiryTimestamp: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemorySessionStore', () => {
  it('read of unknown sessionId returns null', async () => {
    const store = new MemorySessionStore();
    await expect(store.read('does-not-exist')).resolves.toBeNull();
  });

  it('update creates a new session when transform returns a record', async () => {
    const store = new MemorySessionStore();
    const session = makeSession();

    await store.update('session-1', () => ({
      next: session,
      result: undefined,
    }));

    const record = await store.read('session-1');
    expect(record).not.toBeNull();
    expect(record!.sessionId).toBe('session-1');
    expect(record!.branch).toBe('main');
    expect(record!.participants.get('p1')?.displayName).toBe('Alice');
  });

  it('update modifies an existing session', async () => {
    const store = new MemorySessionStore();
    const session = makeSession();

    await store.update('session-1', () => ({ next: session, result: undefined }));

    await store.update('session-1', (current) => {
      expect(current).not.toBeNull();
      const next = { ...current!, activeCount: 2 };
      return { next, result: undefined };
    });

    const record = await store.read('session-1');
    expect(record!.activeCount).toBe(2);
  });

  it('update deletes session when transform returns next: null', async () => {
    const store = new MemorySessionStore();
    await store.update('session-1', () => ({ next: makeSession(), result: undefined }));

    await store.update('session-1', () => ({ next: null, result: undefined }));

    await expect(store.read('session-1')).resolves.toBeNull();
  });

  it('delete removes a session idempotently', async () => {
    const store = new MemorySessionStore();
    await store.update('session-1', () => ({ next: makeSession(), result: undefined }));

    await store.delete('session-1');
    await expect(store.read('session-1')).resolves.toBeNull();

    // Idempotent: second delete should not throw.
    await expect(store.delete('session-1')).resolves.toBeUndefined();
  });

  it('concurrent update calls on the same session serialize — counter increments are not lost', async () => {
    const store = new MemorySessionStore();
    // Create the session first.
    await store.update('session-1', () => ({
      next: { ...makeSession(), activeCount: 0 },
      result: undefined,
    }));

    // Launch two concurrent increments.
    const [a, b] = await Promise.all([
      store.update<number>('session-1', (current) => {
        const next = { ...current!, activeCount: current!.activeCount + 1 };
        return { next, result: next.activeCount };
      }),
      store.update<number>('session-1', (current) => {
        const next = { ...current!, activeCount: current!.activeCount + 1 };
        return { next, result: next.activeCount };
      }),
    ]);

    // Both must have observed different starting values; final count must be 2.
    expect(a + b).toBe(3); // 1 + 2 = 3 (not 1 + 1 = 2 which would indicate a race)
    const record = await store.read('session-1');
    expect(record!.activeCount).toBe(2);
  });

  it('transform receives a clone; mutating it does not affect stored record', async () => {
    const store = new MemorySessionStore();
    await store.update('session-1', () => ({ next: makeSession(), result: undefined }));

    // Read the session and mutate the returned clone.
    const record = await store.read('session-1');
    record!.participants.set('p-mutated', { displayName: 'Mutant', color: '#000', active: false });

    // The stored record must be unaffected.
    const stored = await store.read('session-1');
    expect(stored!.participants.has('p-mutated')).toBe(false);
  });
});

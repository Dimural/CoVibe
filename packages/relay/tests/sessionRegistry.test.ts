/**
 * SessionRegistry integration tests.
 *
 * Uses `SessionRegistryImpl` over `MemorySessionStore`.
 * Fake timers are used to control grace expiry.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemorySessionStore } from '../src/sessionStore.memory.js';
import { SessionRegistryImpl } from '../src/sessionRegistry.impl.js';
import type { SessionRegistryDeps } from '../src/sessionRegistry.impl.js';
import type { AuthorizeRequest } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRACE_MS = 30_000; // 30 seconds
const MAX_PARTICIPANTS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return {
    sessionId: 'sess-abc',
    token: 'super-secret-token',
    displayName: 'Alice',
    color: '#ff0000',
    branch: 'main',
    ...overrides,
  };
}

function makeRegistry(deps: Partial<SessionRegistryDeps> = {}): {
  registry: SessionRegistryImpl;
  store: MemorySessionStore;
} {
  const store =
    (deps.store instanceof MemorySessionStore ? deps.store : null) ?? new MemorySessionStore();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { store: _omit, ...restDeps } = deps;
  const registry = new SessionRegistryImpl({
    config: { maxParticipants: MAX_PARTICIPANTS, sessionGraceMs: GRACE_MS },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    ...restDeps,
    store,
  });
  return { registry, store };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SessionRegistryImpl', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. Create on first join
  it('creates a session and admits the first participant', async () => {
    const { registry } = makeRegistry();
    const outcome = await registry.joinOrCreate(makeReq());

    expect(outcome.kind).toBe('admitted');
    if (outcome.kind !== 'admitted') return;

    expect(outcome.participantId).toBeTruthy();
    expect(outcome.view.sessionId).toBe('sess-abc');
    expect(outcome.view.branch).toBe('main');
    expect(outcome.view.participants).toHaveLength(1);
    expect(outcome.view.participants[0]!.active).toBe(true);
    expect(outcome.view.expiresAt).toBeNull();
  });

  // 2. Capacity: 4 succeed, 5th rejected
  it('enforces capacity — 5th joiner rejected with session-full', async () => {
    const { registry } = makeRegistry();
    const req = makeReq();

    const pids: string[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const o = await registry.joinOrCreate({ ...req, displayName: `User${i}` });
      expect(o.kind).toBe('admitted');
      if (o.kind === 'admitted') pids.push(o.participantId);
    }

    const fifth = await registry.joinOrCreate({ ...req, displayName: 'User5' });
    expect(fifth).toEqual({ kind: 'rejected', reason: 'session-full' });
  });

  // 3. Wrong token rejected
  it('rejects a joiner with a different token', async () => {
    const { registry } = makeRegistry();
    await registry.joinOrCreate(makeReq());

    const result = await registry.joinOrCreate(makeReq({ token: 'wrong-token' }));
    expect(result).toEqual({ kind: 'rejected', reason: 'wrong-token' });
  });

  // 4. Resume — same participantId while active
  it('resume: same participantId re-joins while active — admitted, no extra capacity slot', async () => {
    const { registry } = makeRegistry();
    const o1 = await registry.joinOrCreate(makeReq());
    expect(o1.kind).toBe('admitted');
    if (o1.kind !== 'admitted') return;

    const pid = o1.participantId;

    // Re-join with same participantId.
    const o2 = await registry.joinOrCreate(makeReq({ participantId: pid, displayName: 'Alice2' }));
    expect(o2.kind).toBe('admitted');
    if (o2.kind !== 'admitted') return;
    expect(o2.participantId).toBe(pid);

    // Only one participant slot used — a second new joiner should succeed.
    const o3 = await registry.joinOrCreate(makeReq({ displayName: 'Bob' }));
    expect(o3.kind).toBe('admitted');
  });

  // 5. Leave triggers grace timer
  it('leave: all participants leave → expiresAt populated', async () => {
    vi.useFakeTimers();
    const { registry } = makeRegistry({
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    const o = await registry.joinOrCreate(makeReq());
    expect(o.kind).toBe('admitted');
    if (o.kind !== 'admitted') return;

    await registry.leave('sess-abc', o.participantId);

    const view = await registry.get('sess-abc');
    expect(view).not.toBeNull();
    expect(view!.expiresAt).not.toBeNull();
    expect(view!.expiresAt).toBeGreaterThan(Date.now());
  });

  // 6. Rejoin within grace cancels timer
  it('rejoin within grace cancels expiry timer — session survives', async () => {
    vi.useFakeTimers();
    const { registry } = makeRegistry({
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    // Admit and release two participants.
    const o1 = await registry.joinOrCreate(makeReq());
    expect(o1.kind).toBe('admitted');
    if (o1.kind !== 'admitted') return;
    const pid1 = o1.participantId;

    const o2 = await registry.joinOrCreate(makeReq({ displayName: 'Bob' }));
    expect(o2.kind).toBe('admitted');
    if (o2.kind !== 'admitted') return;
    const pid2 = o2.participantId;

    await registry.leave('sess-abc', pid1);
    await registry.leave('sess-abc', pid2);

    // Session should have an expiry timestamp now.
    const viewAfterLeave = await registry.get('sess-abc');
    expect(viewAfterLeave!.expiresAt).not.toBeNull();

    // Rejoin before grace expires.
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    const o3 = await registry.joinOrCreate(makeReq({ participantId: pid1, displayName: 'Alice' }));
    expect(o3.kind).toBe('admitted');

    // Session should now be active (no expiry).
    const viewAfterRejoin = await registry.get('sess-abc');
    expect(viewAfterRejoin!.expiresAt).toBeNull();

    // Advance past original grace period — session should still exist.
    await vi.advanceTimersByTimeAsync(GRACE_MS + 100);
    const viewLate = await registry.get('sess-abc');
    expect(viewLate).not.toBeNull(); // Timer was cancelled; session is alive.
  });

  // 7. Grace expires — session deleted
  it('grace expiry: all leave then time advances past grace → session deleted', async () => {
    vi.useFakeTimers();
    const { registry } = makeRegistry({
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    const o = await registry.joinOrCreate(makeReq());
    expect(o.kind).toBe('admitted');
    if (o.kind !== 'admitted') return;

    await registry.leave('sess-abc', o.participantId);

    // Advance past grace.
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);

    const view = await registry.get('sess-abc');
    expect(view).toBeNull();
  });

  // 8. Idempotent leave
  it('idempotent leave: leaving the same participant twice does not throw', async () => {
    const { registry } = makeRegistry();
    const o = await registry.joinOrCreate(makeReq());
    expect(o.kind).toBe('admitted');
    if (o.kind !== 'admitted') return;

    await expect(registry.leave('sess-abc', o.participantId)).resolves.toBeUndefined();
    await expect(registry.leave('sess-abc', o.participantId)).resolves.toBeUndefined();
  });

  // 9. get and listParticipants return correct views
  it('get and listParticipants return consistent views', async () => {
    const { registry } = makeRegistry();
    const o1 = await registry.joinOrCreate(makeReq());
    const o2 = await registry.joinOrCreate(makeReq({ displayName: 'Bob', color: '#0000ff' }));
    expect(o1.kind).toBe('admitted');
    expect(o2.kind).toBe('admitted');

    const view = await registry.get('sess-abc');
    expect(view).not.toBeNull();
    expect(view!.participants).toHaveLength(2);

    const list = await registry.listParticipants('sess-abc');
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.active)).toEqual([true, true]);
  });

  // 9b. get / listParticipants return null / empty for missing session
  it('get returns null for unknown session', async () => {
    const { registry } = makeRegistry();
    await expect(registry.get('no-such-session')).resolves.toBeNull();
  });

  it('listParticipants returns empty array for unknown session', async () => {
    const { registry } = makeRegistry();
    const list = await registry.listParticipants('no-such-session');
    expect(list).toHaveLength(0);
  });

  // 10. View returned from joinOrCreate contains all active participants
  it('joinOrCreate view contains all active participants including the new joiner', async () => {
    const { registry } = makeRegistry();

    const o1 = await registry.joinOrCreate(makeReq({ displayName: 'Alice' }));
    expect(o1.kind).toBe('admitted');

    const o2 = await registry.joinOrCreate(makeReq({ displayName: 'Bob' }));
    expect(o2.kind).toBe('admitted');
    if (o2.kind !== 'admitted') return;

    // The view from o2 should include both Alice and Bob.
    expect(o2.view.participants).toHaveLength(2);
    const names = o2.view.participants.map((p) => p.displayName).sort();
    expect(names).toEqual(['Alice', 'Bob']);
    // Bob (the new joiner) must be marked active.
    const bob = o2.view.participants.find((p) => p.displayName === 'Bob');
    expect(bob?.active).toBe(true);
  });

  // authorize shim
  it('authorize returns AuthorizeResult — admitted case', async () => {
    const { registry } = makeRegistry();
    const result = await registry.authorize(makeReq());
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(typeof result.participantId).toBe('string');
  });

  it('authorize returns AuthorizeResult — rejected case (wrong-token)', async () => {
    const { registry } = makeRegistry();
    await registry.authorize(makeReq());
    const result = await registry.authorize(makeReq({ token: 'bad' }));
    expect(result).toEqual({ kind: 'rejected', reason: 'wrong-token' });
  });

  // release shim
  it('release is an alias for leave', async () => {
    vi.useFakeTimers();
    const { registry } = makeRegistry({
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    const o = await registry.joinOrCreate(makeReq());
    expect(o.kind).toBe('admitted');
    if (o.kind !== 'admitted') return;

    await expect(registry.release('sess-abc', o.participantId)).resolves.toBeUndefined();

    const view = await registry.get('sess-abc');
    expect(view!.expiresAt).not.toBeNull();
  });

  // invalid-input
  it('joinOrCreate rejects when required fields are missing', async () => {
    const { registry } = makeRegistry();
    const result = await registry.joinOrCreate({
      sessionId: '',
      token: '',
      displayName: '',
      color: '',
      branch: '',
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'invalid-input' });
  });

  // Active-count correctness: resume does not double-count
  it('resume (same participantId re-joining while active) does not increment activeCount', async () => {
    const { registry, store } = makeRegistry();

    const o = await registry.joinOrCreate(makeReq());
    expect(o.kind).toBe('admitted');
    if (o.kind !== 'admitted') return;

    const pid = o.participantId;

    // Re-join same participantId — should not change activeCount.
    await registry.joinOrCreate(makeReq({ participantId: pid, displayName: 'Alice-2' }));

    const raw = await store.read('sess-abc');
    expect(raw!.activeCount).toBe(1);
  });

  // Capacity check uses activeCount, not participants.size
  it('capacity is based on activeCount, not total participants (inactive do not count)', async () => {
    vi.useFakeTimers();
    const { registry } = makeRegistry({
      now: () => Date.now(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    // Fill up with MAX_PARTICIPANTS participants.
    const pids: string[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const o = await registry.joinOrCreate(makeReq({ displayName: `U${i}` }));
      expect(o.kind).toBe('admitted');
      if (o.kind === 'admitted') pids.push(o.participantId);
    }

    // Leave one, freeing a slot.
    await registry.leave('sess-abc', pids[0]!);

    // A new participant should now be admitted.
    const extra = await registry.joinOrCreate(makeReq({ displayName: 'Extra' }));
    expect(extra.kind).toBe('admitted');
  });
});

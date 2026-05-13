/**
 * Tests for OTEngine — client-side Jupiter / server-ordered operational transform.
 *
 * Layout:
 *   - Single-engine fixture tests cover the basic local/ack/remote flows and
 *     edge cases (stale ack, catch-up via revLog, revLog trimming).
 *   - The convergence property test sets up TWO engines (A and B) plus a
 *     fake in-process server that mirrors what Task 4.4's relay will do:
 *     it linearises incoming deltas, transforms each against any concurrent
 *     server-accepted ops at older baseVersions, and broadcasts the result
 *     as an ack to the originator and a remote-op to the peer.
 *
 * Why model the server transformation here:
 *   When a client sends a delta at baseVersion V but the server has already
 *   accepted other clients' ops with versions > V (because deliveries are
 *   interleaved), the server must rebase the incoming op over those before
 *   assigning it a new version. This mirrors the relay's job and matches
 *   the catch-up logic on the client side — both must agree for TP1 to hold
 *   end-to-end.
 *
 * Op-generator strategy:
 *   We do NOT generate raw TextOp arrays — that risks invalid (non-canonical)
 *   shapes. Instead we generate (insertAt, insertText, deleteCount) tuples
 *   against the current local text and build a canonical op from them. This
 *   keeps the test suite focused on engine semantics, not op-construction
 *   minutiae (already covered by Task 4.2 tests).
 */
import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import * as fc from 'fast-check';
import { applyOp, normalizeOp, type TextOp, type TextOpComponent } from '@covibes/protocol/ot';
import type { SyncedDocument } from '../../../src/sync/document.js';
import { DocumentRepository } from '../../../src/sync/repo.js';
import {
  OTEngine,
  OTEngineGapError,
  OTEngineProtocolError,
  type OTEngineCallbacks,
} from '../../../src/sync/ot/engine.js';

// ---------------------------------------------------------------------------
// Tiny test helpers
// ---------------------------------------------------------------------------

const PATH = 'file.txt';

function makeEngine(initialText = '') {
  const fileUri = Uri.file('/work/file.txt');
  const repo = new DocumentRepository();
  const doc = repo.getOrCreate(PATH, fileUri, initialText);
  const sendDelta = vi.fn<(path: string, baseVersion: number, op: TextOp) => void>();
  const applyRemote = vi.fn<(d: SyncedDocument, op: TextOp) => void>();
  const callbacks: OTEngineCallbacks = { sendDelta, applyRemote };
  const engine = new OTEngine(repo, callbacks);
  return { engine, repo, doc, sendDelta, applyRemote, callbacks };
}

/** Codepoint-length of a string (handles surrogate pairs). */
function cpLen(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

/**
 * Build a canonical TextOp that, applied to `text`, deletes `deleteCount`
 * codepoints starting at `pos` then inserts `insertText` at that position.
 * Caller guarantees `pos + deleteCount <= cpLen(text)`.
 */
function buildOp(text: string, pos: number, deleteCount: number, insertText: string): TextOp {
  // Trailing skip is implicit — ot-text-unicode forbids explicit trailing number components.
  void text; // text is used only for the caller's `cpLen` guard; kept for documentation.
  const op: TextOpComponent[] = [];
  if (pos > 0) op.push(pos);
  if (deleteCount > 0) op.push({ d: deleteCount });
  if (insertText.length > 0) op.push(insertText);
  return op;
}

// ---------------------------------------------------------------------------
// Fixture tests — single engine
// ---------------------------------------------------------------------------

describe('OTEngine — local edit flow', () => {
  it('sends immediately when nothing is pending', () => {
    const { engine, doc, sendDelta } = makeEngine('hello');
    const op = buildOp('hello', 5, 0, '!'); // append "!"
    engine.onLocalEdit(PATH, op);

    expect(sendDelta).toHaveBeenCalledTimes(1);
    expect(sendDelta).toHaveBeenCalledWith(PATH, 0, op);
    const snap = engine.inspect(PATH);
    expect(snap?.pending).toEqual(op);
    expect(snap?.pendingBaseVersion).toBe(0);
    expect(snap?.bufferIsEmpty).toBe(true);
    expect(doc.baseText).toBe('hello!'); // baseText advanced
  });

  it('composes into buffer while pending is in flight', () => {
    const { engine, doc, sendDelta } = makeEngine('hi');
    const op1 = buildOp('hi', 2, 0, '!');
    engine.onLocalEdit(PATH, op1);

    const op2 = buildOp('hi!', 3, 0, '?');
    engine.onLocalEdit(PATH, op2);

    expect(sendDelta).toHaveBeenCalledTimes(1);
    const snap = engine.inspect(PATH);
    expect(snap?.pending).toEqual(op1);
    expect(snap?.bufferIsEmpty).toBe(false);
    expect(doc.baseText).toBe('hi!?'); // both ops advanced baseText
  });
});

describe('OTEngine — ack flow', () => {
  it('ack drains buffer and sends as next pending', () => {
    const { engine, doc, sendDelta } = makeEngine('hi');
    const op1 = buildOp('hi', 2, 0, '!');
    engine.onLocalEdit(PATH, op1);
    const op2 = buildOp('hi!', 3, 0, '?');
    engine.onLocalEdit(PATH, op2);

    engine.onAck(PATH, 0, 1);

    expect(sendDelta).toHaveBeenCalledTimes(2);
    const [secondPath, secondBaseV, secondOp] = sendDelta.mock.calls[1];
    expect(secondPath).toBe(PATH);
    expect(secondBaseV).toBe(1);
    // Buffer content is the second op (composed with NOOP).
    expect(secondOp).toEqual(op2);

    const snap = engine.inspect(PATH);
    expect(snap?.serverVersion).toBe(1);
    expect(snap?.bufferIsEmpty).toBe(true);
    expect(snap?.pendingBaseVersion).toBe(1);
    expect(doc.version).toBe(1);
  });

  it('ack with no buffered ops clears pending', () => {
    const { engine, sendDelta } = makeEngine('hi');
    engine.onLocalEdit(PATH, buildOp('hi', 2, 0, '!'));
    engine.onAck(PATH, 0, 1);
    expect(sendDelta).toHaveBeenCalledTimes(1);
    const snap = engine.inspect(PATH);
    expect(snap?.pending).toBeNull();
    expect(snap?.pendingBaseVersion).toBeNull();
    expect(snap?.serverVersion).toBe(1);
    expect(snap?.revLogSize).toBe(1);
  });

  it('ack with mismatched baseVersion is dropped and state is unchanged', () => {
    const warn = vi.fn();
    const fileUri = Uri.file('/work/file.txt');
    const repo = new DocumentRepository();
    repo.getOrCreate(PATH, fileUri, 'hi');
    const sendDelta = vi.fn();
    const applyRemote = vi.fn();
    const engine = new OTEngine(repo, { sendDelta, applyRemote }, { logger: { warn } });

    const op = buildOp('hi', 2, 0, '!');
    engine.onLocalEdit(PATH, op);
    const before = engine.inspect(PATH);

    engine.onAck(PATH, 999, 999);

    const after = engine.inspect(PATH);
    expect(after).toEqual(before);
    expect(warn).toHaveBeenCalled();
  });
});

describe('OTEngine — remote op flow', () => {
  it('applies a remote op cleanly when no local pending', () => {
    const { engine, doc, applyRemote } = makeEngine('hello');
    const remote = buildOp('hello', 5, 0, '!'); // peer appends "!"
    engine.onRemoteOp(PATH, 0, remote, 1);

    expect(applyRemote).toHaveBeenCalledTimes(1);
    expect(applyRemote.mock.calls[0]?.[1]).toEqual(remote);
    expect(doc.baseText).toBe('hello!');
    expect(doc.version).toBe(1);
    const snap = engine.inspect(PATH);
    expect(snap?.serverVersion).toBe(1);
    expect(snap?.revLogSize).toBe(1);
  });

  it('rebases pending against concurrent remote at same position (server wins ties)', () => {
    // Both clients start at "abc".
    // A inserts "X" at 0 (pending). Then a remote insert "Y" at 0 arrives.
    // Server-ordered convention: remote is canonical-first, our pending is
    // canonical-second, so remote applies unchanged at position 0 and our
    // pending shifts to position 1. Local text: "YXabc". Final server text
    // (after our ack arrives) will be the same "YXabc".
    const { engine, doc, applyRemote, sendDelta } = makeEngine('abc');

    const localInsert = buildOp('abc', 0, 0, 'X');
    engine.onLocalEdit(PATH, localInsert);
    expect(sendDelta).toHaveBeenCalledTimes(1);
    expect(doc.baseText).toBe('Xabc');

    const remoteInsert = buildOp('abc', 0, 0, 'Y');
    engine.onRemoteOp(PATH, 0, remoteInsert, 1);

    expect(applyRemote).toHaveBeenCalledTimes(1);
    const appliedOp = applyRemote.mock.calls[0]?.[1] as TextOp;
    // Applied locally on top of "Xabc" -> "YXabc".
    expect(applyOp('Xabc', appliedOp)).toBe('YXabc');
    expect(doc.baseText).toBe('YXabc');

    const snap = engine.inspect(PATH);
    expect(snap?.serverVersion).toBe(1);
    // Pending shifted from "insert X at 0" to "insert X at 1".
    expect(snap?.pending).toEqual([1, 'X']);
    // pendingBaseVersion still references the version we sent against.
    expect(snap?.pendingBaseVersion).toBe(0);
  });

  it('catches up via revLog when remote baseVersion is older than serverVersion', () => {
    // Sequence:
    //   1. Local insert "A" at 0; ack assigns v1. revLog: [{v1, [insert A]}].
    //   2. Remote op arrives claiming baseVersion=0 (peer was behind),
    //      assigned v2.  Engine must rebase the incoming over revLog entries
    //      with v > 0, i.e. our acked "A" insert.
    const { engine, doc, applyRemote } = makeEngine('hello');

    engine.onLocalEdit(PATH, buildOp('hello', 0, 0, 'A'));
    engine.onAck(PATH, 0, 1);
    expect(doc.baseText).toBe('Ahello');

    // Peer inserts "Z" at codepoint 5 in their stale view ("hello" -> "helloZ").
    // After rebase over our acked insert "A" at 0, peer's position must
    // shift from 5 to 6 -> "AhelloZ".
    const remote = buildOp('hello', 5, 0, 'Z');
    engine.onRemoteOp(PATH, 0, remote, 2);

    const applied = applyRemote.mock.calls[0]?.[1] as TextOp;
    expect(applyOp('Ahello', applied)).toBe('AhelloZ');
    expect(doc.baseText).toBe('AhelloZ');
    expect(doc.version).toBe(2);
  });

  it('throws OTEngineGapError when remote baseVersion is too old to reconcile', () => {
    const fileUri = Uri.file('/work/file.txt');
    const repo = new DocumentRepository();
    repo.getOrCreate(PATH, fileUri, 'hi');
    const sendDelta = vi.fn();
    const applyRemote = vi.fn();
    const engine = new OTEngine(repo, { sendDelta, applyRemote }, { revLogSize: 2 });

    // Push 3 acked ops; revLog keeps last 2 (versions 2, 3).
    for (let i = 0; i < 3; i++) {
      engine.onLocalEdit(PATH, buildOp(repo.get(PATH)!.baseText, 0, 0, 'x'));
      engine.onAck(PATH, i, i + 1);
    }

    expect(() => {
      engine.onRemoteOp(PATH, 0, ['z'], 4);
    }).toThrow(OTEngineGapError);
  });
});

describe('OTEngine — re-entrancy', () => {
  it('onLocalEdit inside applyRemote callback uses the post-remote serverVersion', () => {
    // Re-entrancy scenario: Task 4.5 will call `workspace.applyEdit` inside
    // `applyRemote`, which can trigger VS Code change events that reach
    // `onLocalEdit` synchronously. The engine advances serverVersion BEFORE
    // firing the callback so any re-entrant `onLocalEdit` sends against the
    // correct (post-remote) baseVersion — not the stale pre-remote value.
    const fileUri = Uri.file('/work/file.txt');
    const repo = new DocumentRepository();
    const doc = repo.getOrCreate(PATH, fileUri, 'hello');
    const sendDelta = vi.fn<(path: string, baseVersion: number, op: TextOp) => void>();
    // Declare the spy before the engine so the mock implementation can
    // capture `engine` as a const (assigned after creation).
    const applyRemoteSpy = vi.fn<(d: typeof doc, op: TextOp) => void>();
    const engine = new OTEngine(repo, { sendDelta, applyRemote: applyRemoteSpy });
    // Patch implementation after engine creation so the closure over
    // `engine` is safe — applyRemote is only called during onRemoteOp below.
    applyRemoteSpy.mockImplementation(() => {
      // Simulates the editor applying the remote edit and immediately
      // producing a new local change. At this point (with the fix),
      // serverVersion is already 1 and baseText is already 'hello!'.
      engine.onLocalEdit(PATH, buildOp(doc.baseText, 0, 0, 'Z'));
    });

    engine.onRemoteOp(PATH, 0, buildOp('hello', 5, 0, '!'), 1);

    expect(applyRemoteSpy).toHaveBeenCalledTimes(1);
    expect(sendDelta).toHaveBeenCalledTimes(1);
    // With the fix: the re-entrant edit is sent at baseVersion=1 (post-remote).
    // Under old ordering it would be baseVersion=0 (stale pre-remote).
    const [, sentBaseVersion] = sendDelta.mock.calls[0]!;
    expect(sentBaseVersion).toBe(1);
  });
});

describe('OTEngine — monotonic version guard', () => {
  it('onRemoteOp throws OTEngineProtocolError for non-monotonic newServerVersion', () => {
    const { engine, sendDelta } = makeEngine('hello');
    // Advance to serverVersion=1 via a legitimate remote op.
    engine.onRemoteOp(PATH, 0, buildOp('hello', 5, 0, '!'), 1);
    // Now send a remote with newServerVersion=1 again (non-monotonic).
    expect(() => {
      engine.onRemoteOp(PATH, 1, buildOp('hello!', 0, 0, 'Z'), 1);
    }).toThrow(OTEngineProtocolError);
    void sendDelta; // sendDelta unused in this test; suppress lint.
  });

  it('onAck throws OTEngineProtocolError for non-monotonic newServerVersion', () => {
    const { engine, sendDelta } = makeEngine('hello');
    // Send a local edit so there is a correlated pending.
    engine.onLocalEdit(PATH, buildOp('hello', 5, 0, '!'));
    expect(sendDelta).toHaveBeenCalledTimes(1);
    // Simulate an ack with a stale or equal newServerVersion.
    expect(() => {
      engine.onAck(PATH, 0, 0); // newServerVersion=0, current=0 → non-monotonic
    }).toThrow(OTEngineProtocolError);
  });
});

describe('OTEngine — revLog', () => {
  it('caps the log to revLogSize entries (oldest dropped first)', () => {
    const fileUri = Uri.file('/work/file.txt');
    const repo = new DocumentRepository();
    repo.getOrCreate(PATH, fileUri, '');
    const sendDelta = vi.fn();
    const applyRemote = vi.fn();
    const engine = new OTEngine(repo, { sendDelta, applyRemote }, { revLogSize: 3 });

    for (let i = 0; i < 5; i++) {
      engine.onLocalEdit(PATH, buildOp(repo.get(PATH)!.baseText, 0, 0, 'a'));
      engine.onAck(PATH, i, i + 1);
    }

    expect(engine.inspect(PATH)?.revLogSize).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Property test — convergence of two engines through a fake relay
// ---------------------------------------------------------------------------

/**
 * Fake in-process relay used by the convergence property test.
 *
 * - One document, one path. (The engine indexes by path; using a single path
 *   exercises the OT logic directly and keeps generators simple.)
 * - Two clients: A and B. Each has its own engine and per-client "local text"
 *   tracked outside the engine so we can compare against the engine's view at
 *   the end.
 * - The relay has a serverVersion counter and a list of accepted ops in
 *   server-assigned order. When a client sends a delta at baseVersion V, the
 *   relay transforms the incoming op over every accepted op with version > V
 *   (catch-up, mirroring the client's revLog walk) before assigning it the
 *   next server version and broadcasting it:
 *     - ack to originator: (newServerVersion, baseVersion)
 *     - remote-op to peer: (newServerVersion, ackedBaseVersionUsedByOriginator)
 *
 * Delivery is queue-based and deterministic per generator step. The harness
 * does NOT model partial delivery; either both ack and peer-broadcast for
 * a given delta land in the queue (in that order, ack first), or neither.
 */

import { transformOp as protoTransform } from '@covibes/protocol/ot';

interface RelayAcceptedOp {
  readonly version: number;
  readonly op: TextOp;
}

interface RelayDeliveryAck {
  readonly kind: 'ack';
  readonly to: 'A' | 'B';
  readonly baseVersion: number;
  readonly newServerVersion: number;
}

interface RelayDeliveryRemote {
  readonly kind: 'remote';
  readonly to: 'A' | 'B';
  readonly baseVersion: number;
  readonly newServerVersion: number;
  readonly op: TextOp;
}

type RelayDelivery = RelayDeliveryAck | RelayDeliveryRemote;

class FakeRelay {
  serverVersion = 0;
  readonly accepted: RelayAcceptedOp[] = [];
  readonly queue: RelayDelivery[] = [];
  text = '';

  /** Originator sends an op against `baseVersion`. */
  receive(from: 'A' | 'B', baseVersion: number, op: TextOp): void {
    // Rebase the incoming op over any accepted ops with version > baseVersion
    // — concurrent commits the originator did not yet know about.
    let rebased = op;
    for (const a of this.accepted) {
      if (a.version <= baseVersion) continue;
      rebased = protoTransform(rebased, a.op, 'right');
    }
    const newServerVersion = this.serverVersion + 1;
    this.serverVersion = newServerVersion;
    this.accepted.push({ version: newServerVersion, op: rebased });
    this.text = applyOp(this.text, rebased);

    // Queue ack to originator. We send the ORIGINATOR'S baseVersion back so
    // they can correlate.
    this.queue.push({ kind: 'ack', to: from, baseVersion, newServerVersion });
    // Queue remote-op to peer. The peer's baseVersion for the rebase is the
    // version-after-which the op was inserted — i.e. `newServerVersion - 1`.
    // That's the "fresh" baseVersion against the relay's current state right
    // before this op landed; the peer engine will catch up over any of its
    // acked ops in (newServerVersion-1, peer.serverVersion].
    const peer: 'A' | 'B' = from === 'A' ? 'B' : 'A';
    this.queue.push({
      kind: 'remote',
      to: peer,
      baseVersion: newServerVersion - 1,
      newServerVersion,
      op: rebased,
    });
  }

  /** Pop and return the next delivery, or undefined if queue is empty. */
  drainOne(): RelayDelivery | undefined {
    return this.queue.shift();
  }
}

interface ClientHarness {
  readonly id: 'A' | 'B';
  readonly repo: DocumentRepository;
  readonly engine: OTEngine;
  readonly doc: SyncedDocument;
  /** Tracks the editor's text — equivalent to applying all local + remote ops. */
  text: string;
}

function makeClient(id: 'A' | 'B', relay: FakeRelay): ClientHarness {
  const fileUri = Uri.file(`/work/${id}/file.txt`);
  const repo = new DocumentRepository();
  const doc = repo.getOrCreate(PATH, fileUri, '');
  // Capture mutable `text` via the harness object below.
  const harness: ClientHarness = { id, repo, engine: null as unknown as OTEngine, doc, text: '' };

  const callbacks: OTEngineCallbacks = {
    sendDelta(_path, baseVersion, op) {
      relay.receive(id, baseVersion, op);
    },
    applyRemote(_d, op) {
      // Mirror what the editor wiring will do in Task 4.5: apply the op to
      // the editor text. We use the engine's baseText concept by recomputing
      // against our independent `text` tracker; both must agree because the
      // engine also calls setBaseText right after this.
      harness.text = applyOp(harness.text, op);
    },
  };
  // Use a generous revLogSize so the property test never hits a gap.
  Object.assign(harness, { engine: new OTEngine(repo, callbacks, { revLogSize: 1000 }) });
  return harness;
}

function deliverOne(relay: FakeRelay, clients: Record<'A' | 'B', ClientHarness>): boolean {
  const d = relay.drainOne();
  if (d === undefined) return false;
  const c = clients[d.to];
  if (d.kind === 'ack') {
    c.engine.onAck(PATH, d.baseVersion, d.newServerVersion);
  } else {
    c.engine.onRemoteOp(PATH, d.baseVersion, d.op, d.newServerVersion);
  }
  return true;
}

/**
 * An event in the convergence property test. Op parameters for `local` events
 * are embedded in the arbitrary so every fast-check seed produces a fully
 * deterministic sequence — including shrinks and seeded re-runs. Using
 * `fc.sample` inside the property body would break reproducibility because it
 * runs its own independent RNG.
 */
type Event =
  | {
      kind: 'local';
      who: 'A' | 'B';
      /** Ratio in [0, 1] — multiplied by `cpLen(currentText)` to get the insert/delete position. */
      posRatio: number;
      delMax: number;
      insert: string;
    }
  | { kind: 'deliver' };

describe('OTEngine — convergence (property)', () => {
  it('two clients converge to the same text under arbitrary interleavings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('local' as const),
              who: fc.constantFrom<'A' | 'B'>('A', 'B'),
              posRatio: fc.float({ min: 0, max: 1, noNaN: true }),
              delMax: fc.integer({ min: 0, max: 3 }),
              insert: fc.string({
                minLength: 0,
                maxLength: 3,
                unit: fc.constantFrom('a', 'b', 'c'),
              }),
            }),
            fc.record({ kind: fc.constant('deliver' as const) }),
          ),
          { minLength: 1, maxLength: 30 },
        ),
        (rawEvents) => {
          const relay = new FakeRelay();
          const A = makeClient('A', relay);
          const B = makeClient('B', relay);
          const clients: Record<'A' | 'B', ClientHarness> = { A, B };

          for (const e of rawEvents as Event[]) {
            if (e.kind === 'local') {
              const c = clients[e.who];
              const len = cpLen(c.text);
              const pos = Math.min(len, Math.floor(e.posRatio * (len + 1)));
              const delCount = Math.min(e.delMax, len - pos);
              if (delCount === 0 && e.insert.length === 0) continue;
              const op = normalizeOp(buildOp(c.text, pos, delCount, e.insert));
              if (op.length === 0) continue;
              // Mirror EditCapture's contract: apply to editor first, then
              // hand to engine. The engine advances baseText itself.
              c.text = applyOp(c.text, op);
              c.engine.onLocalEdit(PATH, op);
            } else {
              deliverOne(relay, clients);
            }
          }

          // Drain ALL outstanding deliveries — including ones generated by
          // ack-driven buffer-promotes, which create new ops to deliver.
          // Loop until quiescent.
          let progress = true;
          while (progress) {
            progress = false;
            while (deliverOne(relay, clients)) progress = true;
          }

          // Convergence assertions.
          expect(A.doc.baseText).toBe(B.doc.baseText);
          expect(A.doc.baseText).toBe(relay.text);
          // Both engines should be quiescent: no pending, empty buffer.
          // If an engine never received any event (state never created), it
          // is trivially quiescent — `inspect` returns undefined.
          const snapA = A.engine.inspect(PATH);
          const snapB = B.engine.inspect(PATH);
          if (snapA !== undefined) {
            expect(snapA.pending).toBeNull();
            expect(snapA.bufferIsEmpty).toBe(true);
          }
          if (snapB !== undefined) {
            expect(snapB.pending).toBeNull();
            expect(snapB.bufferIsEmpty).toBe(true);
          }
          // The local "editor text" tracker on each side must match too —
          // this is the bar Task 4.5 will inherit.
          expect(A.text).toBe(A.doc.baseText);
          expect(B.text).toBe(B.doc.baseText);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('regression: A inserts, B inserts at same pos before delivery (TP1 trace)', () => {
    // Hand-curated trace that exercises the "both clients have pending,
    // server sees A first, B's op is rebased over A's, A receives B's
    // (rebased) remote, B receives A's (untransformed) remote" path.
    const relay = new FakeRelay();
    const A = makeClient('A', relay);
    const B = makeClient('B', relay);
    const clients = { A, B } as Record<'A' | 'B', ClientHarness>;

    A.text = applyOp(A.text, ['X']);
    A.engine.onLocalEdit(PATH, ['X']);
    B.text = applyOp(B.text, ['Y']);
    B.engine.onLocalEdit(PATH, ['Y']);

    // Drain — order of delivery: A's ack, B-receives-A, B's ack
    // (transformed), A-receives-B.
    while (deliverOne(relay, clients)) {
      /* loop */
    }

    expect(A.doc.baseText).toBe(B.doc.baseText);
    expect(A.doc.baseText).toBe(relay.text);
  });
});

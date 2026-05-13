import { describe, it, expect } from 'vitest';
import { applyOp, transformOp } from '@covibes/protocol';
import type { TextOp } from '@covibes/protocol';
import { DocSequencer, SequencerGapError } from '../../src/doc/sequencer.js';
import type { SequencerCallbacks } from '../../src/doc/sequencer.js';

// ---------------------------------------------------------------------------
// Helper: build a capture-based callbacks implementation
// ---------------------------------------------------------------------------

interface CapturedSend {
  type: string;
  payload: unknown;
}

type AnyCallbacks = {
  sendToSender(type: string, payload: unknown): void;
  broadcastToPeers(type: string, payload: unknown): void;
};

function makeCallbacks(): {
  senderMessages: CapturedSend[];
  peerMessages: CapturedSend[];
  callbacks: SequencerCallbacks;
} {
  const senderMessages: CapturedSend[] = [];
  const peerMessages: CapturedSend[] = [];

  const impl: AnyCallbacks = {
    sendToSender(type, payload) {
      senderMessages.push({ type, payload });
    },
    broadcastToPeers(type, payload) {
      peerMessages.push({ type, payload });
    },
  };

  return { senderMessages, peerMessages, callbacks: impl };
}

// ---------------------------------------------------------------------------
// 1. Single client, no concurrency
// ---------------------------------------------------------------------------

describe('single client — no concurrency', () => {
  it('assigns serverVersion=1 and sends correct ack and broadcast', () => {
    const seq = new DocSequencer();
    const { senderMessages, peerMessages, callbacks } = makeCallbacks();

    seq.process('sess-1', { path: 'src/a.ts', baseVersion: 0, op: ['X'] }, callbacks);

    expect(senderMessages).toHaveLength(1);
    expect(peerMessages).toHaveLength(1);

    const ack = senderMessages[0];
    expect(ack?.type).toBe('doc.ack');
    const ackPayload = ack?.payload as { baseVersion: number; serverVersion: number };
    expect(ackPayload.baseVersion).toBe(0);
    expect(ackPayload.serverVersion).toBe(1);

    const broadcast = peerMessages[0];
    expect(broadcast?.type).toBe('doc.delta');
    const bcastPayload = broadcast?.payload as {
      baseVersion: number;
      serverVersion: number;
      op: unknown;
    };
    expect(bcastPayload.baseVersion).toBe(0);
    expect(bcastPayload.serverVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Two concurrent ops — core OT convergence case
// ---------------------------------------------------------------------------

describe('two concurrent ops — OT convergence', () => {
  it('transforms concurrent ops and produces identical final text for both clients', () => {
    const seq = new DocSequencer();
    const initialText = 'hello';

    // Client A inserts 'X' at position 0 (trailing skip omitted)
    const opA: TextOp = ['X'];
    // Client B inserts 'Y' at position 5 (end)
    const opB: TextOp = [5, 'Y'];

    // A sends first at baseVersion=0 → serverVersion=1
    const { senderMessages: ackA, peerMessages: broadcastToB, callbacks: cbA } = makeCallbacks();
    seq.process('sess-2', { path: 'src/a.ts', baseVersion: 0, op: opA }, cbA);

    expect(ackA[0]?.payload as { serverVersion: number }).toMatchObject({ serverVersion: 1 });
    const transformedOpA = (broadcastToB[0]?.payload as { op: unknown }).op as TextOp;

    // B sends at baseVersion=0 (concurrent) → serverVersion=2
    const { senderMessages: ackB, peerMessages: broadcastToA, callbacks: cbB } = makeCallbacks();
    seq.process('sess-2', { path: 'src/a.ts', baseVersion: 0, op: opB }, cbB);

    expect(ackB[0]?.payload as { serverVersion: number }).toMatchObject({ serverVersion: 2 });
    const transformedOpB = (broadcastToA[0]?.payload as { op: unknown }).op as TextOp;

    // OT convergence check: both paths produce the same final document.
    // Path A→B: apply opA to initial, then apply transformedOpB
    const textAfterAB = applyOp(applyOp(initialText, opA), transformedOpB);

    // Path B→A: apply opB to initial, then apply transformedOpA
    // transformedOpA was broadcast to B as-is (no concurrency at time A was processed)
    const textAfterBA = applyOp(applyOp(initialText, opB), transformedOpA);

    expect(textAfterAB).toBe(textAfterBA);
    // Sanity check: both contain 'hello', 'X', and 'Y'
    expect(textAfterAB).toContain('hello');
    expect(textAfterAB).toContain('X');
    expect(textAfterAB).toContain('Y');
  });

  it('ack for B contains baseVersion=0 and serverVersion=2', () => {
    const seq = new DocSequencer();
    const opA: TextOp = ['X'];
    const opB: TextOp = [5, 'Y'];

    const { callbacks: cbA } = makeCallbacks();
    seq.process('sess-3', { path: 'src/a.ts', baseVersion: 0, op: opA }, cbA);

    const { senderMessages: ackB, callbacks: cbB } = makeCallbacks();
    seq.process('sess-3', { path: 'src/a.ts', baseVersion: 0, op: opB }, cbB);

    const ack = ackB[0]?.payload as { baseVersion: number; serverVersion: number };
    expect(ack.baseVersion).toBe(0);
    expect(ack.serverVersion).toBe(2);
  });

  it('broadcast to A contains baseVersion=1 (newServerVersion-1) and serverVersion=2', () => {
    const seq = new DocSequencer();
    const opA: TextOp = ['X'];
    const opB: TextOp = [5, 'Y'];

    const { callbacks: cbA } = makeCallbacks();
    seq.process('sess-4', { path: 'src/a.ts', baseVersion: 0, op: opA }, cbA);

    const { peerMessages: broadcastToA, callbacks: cbB } = makeCallbacks();
    seq.process('sess-4', { path: 'src/a.ts', baseVersion: 0, op: opB }, cbB);

    const bcast = broadcastToA[0]?.payload as { baseVersion: number; serverVersion: number };
    expect(bcast.baseVersion).toBe(1);
    expect(bcast.serverVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Gap error — client too far behind
// ---------------------------------------------------------------------------

describe('gap error', () => {
  it('throws SequencerGapError when baseVersion is older than oldest revLog entry', () => {
    const seq = new DocSequencer();
    // Fill revLog beyond 100 entries so the oldest entry is evicted
    for (let i = 0; i < 101; i++) {
      const { callbacks } = makeCallbacks();
      seq.process('sess-gap', { path: 'src/a.ts', baseVersion: i, op: ['x'] }, callbacks);
    }
    // Now the oldest revLog entry is serverVersion=2 (entry 0 was evicted)
    // Client sends baseVersion=0 — older than what revLog can handle
    const { callbacks } = makeCallbacks();
    expect(() =>
      seq.process('sess-gap', { path: 'src/a.ts', baseVersion: 0, op: ['y'] }, callbacks),
    ).toThrow(SequencerGapError);
  });
});

// ---------------------------------------------------------------------------
// 4. disposeSession — clears state; next op restarts from version 0
// ---------------------------------------------------------------------------

describe('disposeSession', () => {
  it('resets serverVersion to 0 after dispose', () => {
    const seq = new DocSequencer();

    // Advance to serverVersion=3
    for (let i = 0; i < 3; i++) {
      const { callbacks } = makeCallbacks();
      seq.process('sess-dispose', { path: 'src/a.ts', baseVersion: i, op: ['x'] }, callbacks);
    }

    seq.disposeSession('sess-dispose');

    // First op after dispose should get serverVersion=1
    const { senderMessages, callbacks } = makeCallbacks();
    seq.process('sess-dispose', { path: 'src/a.ts', baseVersion: 0, op: ['x'] }, callbacks);

    const ack = senderMessages[0]?.payload as { serverVersion: number };
    expect(ack.serverVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-path independence
// ---------------------------------------------------------------------------

describe('cross-path independence', () => {
  it('ops on different paths have independent version counters', () => {
    const seq = new DocSequencer();

    // Three ops on src/a.ts
    for (let i = 0; i < 3; i++) {
      const { callbacks } = makeCallbacks();
      seq.process('sess-paths', { path: 'src/a.ts', baseVersion: i, op: ['x'] }, callbacks);
    }

    // First op on src/b.ts should get serverVersion=1, not 4
    const { senderMessages, callbacks } = makeCallbacks();
    seq.process('sess-paths', { path: 'src/b.ts', baseVersion: 0, op: ['x'] }, callbacks);

    const ack = senderMessages[0]?.payload as { serverVersion: number };
    expect(ack.serverVersion).toBe(1);
  });

  it('ops on src/a.ts continue their own counter independently', () => {
    const seq = new DocSequencer();

    // Two ops on a.ts
    for (let i = 0; i < 2; i++) {
      const { callbacks } = makeCallbacks();
      seq.process('sess-paths2', { path: 'src/a.ts', baseVersion: i, op: ['x'] }, callbacks);
    }

    // One op on b.ts
    const { callbacks: cbB } = makeCallbacks();
    seq.process('sess-paths2', { path: 'src/b.ts', baseVersion: 0, op: ['x'] }, cbB);

    // Third op on a.ts — should get serverVersion=3
    const { senderMessages, callbacks } = makeCallbacks();
    seq.process('sess-paths2', { path: 'src/a.ts', baseVersion: 2, op: ['x'] }, callbacks);

    const ack = senderMessages[0]?.payload as { serverVersion: number };
    expect(ack.serverVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Verify the OT transformation formula directly
// ---------------------------------------------------------------------------

describe('OT transform correctness', () => {
  it('satisfies TP1: apply(apply(s,a), transform(b,a,right)) === apply(apply(s,b), transform(a,b,left))', () => {
    const s = 'abc';
    const a: TextOp = ['1']; // insert '1' at start (trailing skip omitted)
    const b: TextOp = [3, '2']; // skip 3, insert '2' at end

    const lhs = applyOp(applyOp(s, a), transformOp(b, a, 'right'));
    const rhs = applyOp(applyOp(s, b), transformOp(a, b, 'left'));
    expect(lhs).toBe(rhs);
  });
});

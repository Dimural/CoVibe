import { describe, it, expect } from 'vitest';
import { LatencyTracker } from '../../src/sync/latency.js';

// ---------------------------------------------------------------------------
// 1. Basic send → ack returns correct RTT
// ---------------------------------------------------------------------------

describe('recordSend + recordAck — basic RTT', () => {
  it('returns the elapsed time between send and ack', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend(1000);
    const rtt = tracker.recordAck(1050);
    expect(rtt).toBe(50);
  });

  it('stores the RTT in history', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend(0);
    tracker.recordAck(30);
    expect(tracker.history).toEqual([30]);
  });
});

// ---------------------------------------------------------------------------
// 2. FIFO ordering — multiple sends matched in order
// ---------------------------------------------------------------------------

describe('FIFO matching of multiple sends and acks', () => {
  it('matches sends to acks in the order they were recorded', () => {
    const tracker = new LatencyTracker();
    // Send three ops at different times.
    tracker.recordSend(100); // op 1
    tracker.recordSend(200); // op 2
    tracker.recordSend(400); // op 3

    // Acks arrive in the same order.
    expect(tracker.recordAck(130)).toBe(30); // op 1: 130 - 100
    expect(tracker.recordAck(250)).toBe(50); // op 2: 250 - 200
    expect(tracker.recordAck(500)).toBe(100); // op 3: 500 - 400
  });

  it('history preserves insertion order (oldest first)', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend(0);
    tracker.recordSend(100);
    tracker.recordSend(300);

    tracker.recordAck(20); // rtt = 20
    tracker.recordAck(160); // rtt = 60
    tracker.recordAck(400); // rtt = 100

    expect(tracker.history).toEqual([20, 60, 100]);
  });
});

// ---------------------------------------------------------------------------
// 3. recordAck with no pending sends returns undefined
// ---------------------------------------------------------------------------

describe('recordAck with no pending sends', () => {
  it('returns undefined when no sends have been recorded', () => {
    const tracker = new LatencyTracker();
    expect(tracker.recordAck(Date.now())).toBeUndefined();
  });

  it('returns undefined after all sends have been acked', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend(0);
    tracker.recordAck(10); // drains the one pending send
    expect(tracker.recordAck(20)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. averageRttMs — undefined when empty, correct when populated
// ---------------------------------------------------------------------------

describe('averageRttMs', () => {
  it('returns undefined when history is empty', () => {
    const tracker = new LatencyTracker();
    expect(tracker.averageRttMs).toBeUndefined();
  });

  it('returns the single value when only one measurement exists', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend(0);
    tracker.recordAck(40);
    expect(tracker.averageRttMs).toBe(40);
  });

  it('returns the correct mean across multiple measurements', () => {
    const tracker = new LatencyTracker();
    // RTTs: 10, 20, 30 → average = 20
    tracker.recordSend(0);
    tracker.recordSend(100);
    tracker.recordSend(200);
    tracker.recordAck(10); // rtt 10
    tracker.recordAck(120); // rtt 20
    tracker.recordAck(230); // rtt 30
    expect(tracker.averageRttMs).toBeCloseTo(20, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. history is capped at maxHistory
// ---------------------------------------------------------------------------

describe('history capped at maxHistory', () => {
  it('never grows beyond maxHistory entries', () => {
    const maxHistory = 5;
    const tracker = new LatencyTracker(maxHistory);

    for (let i = 0; i < 10; i++) {
      tracker.recordSend(i * 100);
      tracker.recordAck(i * 100 + 10);
    }

    expect(tracker.history.length).toBe(maxHistory);
  });

  it('keeps the most recent entries when the cap is exceeded', () => {
    const tracker = new LatencyTracker(3);
    // RTTs 1..6; after cap the oldest three (1,2,3) are dropped.
    for (let rtt = 1; rtt <= 6; rtt++) {
      tracker.recordSend(0);
      tracker.recordAck(rtt);
    }
    // history should contain the last 3 RTTs: 4, 5, 6
    expect(tracker.history).toEqual([4, 5, 6]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  EditRateHeuristic,
  DEFAULT_HEURISTIC_CONFIG,
  type EditEvent,
  type BurstEvent,
  type HeuristicClock,
} from '../../src/agent/heuristic.js';

function makeClock(startMs = 0) {
  let now = startMs;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const clock: HeuristicClock = {
    now: () => now,
    schedule: vi.fn((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    }),
    cancel: vi.fn((handle: unknown) => {
      timers.delete(handle as number);
    }),
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (ms >= t.ms) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    advanceWithout(ms: number) {
      now += ms;
    },
  };
}

function makeEdit(path: string, timestamp: number, overrides: Partial<EditEvent> = {}): EditEvent {
  return {
    path,
    timestamp,
    insertedChars: 5,
    affectedLines: 1,
    rangeStart: 0,
    rangeEnd: 0,
    ...overrides,
  };
}

describe('EditRateHeuristic', () => {
  it('emits AgentBurstStarted when ≥3 edits within 1s', () => {
    const { clock } = makeClock(1000);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('a.ts', 1000));
    h.push(makeEdit('a.ts', 1300));
    h.push(makeEdit('a.ts', 1600));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'started', path: 'a.ts' });
  });

  it('does not emit burst for 2 slow edits', () => {
    const { clock } = makeClock(1000);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('a.ts', 1000));
    h.push(makeEdit('a.ts', 3000));

    expect(events).toHaveLength(0);
  });

  it('emits AgentBurstStarted on single large insertion', () => {
    const { clock } = makeClock(0);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('b.ts', 0, { insertedChars: 250 }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('started');
  });

  it('emits AgentBurstStarted on single edit affecting ≥5 lines', () => {
    const { clock } = makeClock(0);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('c.ts', 0, { affectedLines: 6 }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('started');
  });

  it('emits AgentBurstStarted on non-contiguous edits within 1s', () => {
    const { clock } = makeClock(0);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('d.ts', 0, { rangeStart: 0, rangeEnd: 10 }));
    h.push(makeEdit('d.ts', 200, { rangeStart: 500, rangeEnd: 510 }));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('started');
  });

  it('emits AgentBurstEnded after quiet period', () => {
    const clockObj = makeClock(0);
    const { clock } = clockObj;
    const advance = (ms: number) => clockObj.advance(ms);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('e.ts', 0, { insertedChars: 300 }));
    expect(events[0].type).toBe('started');

    advance(2000);

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('ended');
  });

  it('does not emit duplicate burst-started for the same ongoing burst', () => {
    const { clock } = makeClock(0);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('f.ts', 0, { insertedChars: 300 }));
    h.push(makeEdit('f.ts', 100, { insertedChars: 300 }));
    h.push(makeEdit('f.ts', 200, { insertedChars: 300 }));

    const started = events.filter((e) => e.type === 'started');
    expect(started).toHaveLength(1);
  });

  it('isolates bursts per path', () => {
    const { clock } = makeClock(0);
    const events: BurstEvent[] = [];
    const h = new EditRateHeuristic(DEFAULT_HEURISTIC_CONFIG, (e) => events.push(e), clock);

    h.push(makeEdit('g.ts', 0, { insertedChars: 300 }));
    h.push(makeEdit('h.ts', 0, { insertedChars: 5 }));

    const startedPaths = events.filter((e) => e.type === 'started').map((e) => e.path);
    expect(startedPaths).toEqual(['g.ts']);
  });
});

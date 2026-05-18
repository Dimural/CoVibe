// packages/extension/tests/agent/conflictDetector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ConflictDetector, type ConcurrentWriteEvent } from '../../src/agent/conflictDetector.js';

describe('ConflictDetector', () => {
  it('does not emit for a single-participant burst', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);

    expect(events).toHaveLength(0);
  });

  it('emits ConcurrentAgentWrite when two participants have overlapping intents on same path', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.recordIntent('p2', 'src/foo.ts', 1600, false); // 600ms gap

    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('src/foo.ts');
    expect(events[0]?.participants).toContain('p1');
    expect(events[0]?.participants).toContain('p2');
  });

  it('suppresses notification if intents start within 500ms of each other', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.recordIntent('p2', 'src/foo.ts', 1300, false); // only 300ms gap — suppressed

    expect(events).toHaveLength(0);
  });

  it('does not emit for intents on different paths', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.recordIntent('p2', 'src/bar.ts', 1600, false);

    expect(events).toHaveLength(0);
  });

  it('clearIntent removes a participant intent', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.clearIntent('p1', 'src/foo.ts');
    detector.recordIntent('p2', 'src/foo.ts', 2000, false);

    expect(events).toHaveLength(0);
  });

  it('tracks hasActiveConcurrentWrite after detection', () => {
    const detector = new ConflictDetector({ onConcurrentWrite: vi.fn() });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.recordIntent('p2', 'src/foo.ts', 1600, false);

    expect(detector.hasActiveConcurrentWrite('src/foo.ts')).toBe(true);

    detector.clearIntent('p1', 'src/foo.ts');
    detector.clearIntent('p2', 'src/foo.ts');

    expect(detector.hasActiveConcurrentWrite('src/foo.ts')).toBe(false);
  });

  it('does not emit duplicate notification for the same path+pair', () => {
    const events: ConcurrentWriteEvent[] = [];
    const detector = new ConflictDetector({ onConcurrentWrite: (e) => events.push(e) });

    detector.recordIntent('p1', 'src/foo.ts', 1000, false);
    detector.recordIntent('p2', 'src/foo.ts', 1600, false);
    detector.recordIntent('p2', 'src/foo.ts', 2000, false); // p2 re-announces

    expect(events).toHaveLength(1);
  });
});

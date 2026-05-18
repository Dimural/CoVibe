export interface EditEvent {
  path: string;
  timestamp: number;
  insertedChars: number;
  affectedLines: number;
  rangeStart: number;
  rangeEnd: number;
}

export interface BurstStarted {
  type: 'started';
  path: string;
  startedAt: number;
}

export interface BurstEnded {
  type: 'ended';
  path: string;
  startedAt: number;
}

export type BurstEvent = BurstStarted | BurstEnded;

export interface HeuristicConfig {
  minEditsPerSecond: number;
  minInsertionChars: number;
  minAffectedLines: number;
  burstEndQuietMs: number;
}

export const DEFAULT_HEURISTIC_CONFIG: HeuristicConfig = {
  minEditsPerSecond: 3,
  minInsertionChars: 200,
  minAffectedLines: 5,
  burstEndQuietMs: 2000,
};

export interface HeuristicClock {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

interface DocState {
  recentEdits: Array<{ timestamp: number; rangeStart: number; rangeEnd: number }>;
  burstActive: boolean;
  burstStartedAt: number;
  quietTimer: unknown;
}

export class EditRateHeuristic {
  private readonly config: HeuristicConfig;
  private readonly onBurst: (event: BurstEvent) => void;
  private readonly clock: HeuristicClock;
  private readonly docs = new Map<string, DocState>();

  constructor(
    config: HeuristicConfig,
    onBurst: (event: BurstEvent) => void,
    clock: HeuristicClock,
  ) {
    this.config = config;
    this.onBurst = onBurst;
    this.clock = clock;
  }

  push(event: EditEvent): void {
    let state = this.docs.get(event.path);
    if (state === undefined) {
      state = {
        recentEdits: [],
        burstActive: false,
        burstStartedAt: 0,
        quietTimer: undefined,
      };
      this.docs.set(event.path, state);
    }

    if (state.quietTimer !== undefined) {
      this.clock.cancel(state.quietTimer);
      state.quietTimer = undefined;
    }

    const now = event.timestamp;
    state.recentEdits.push({
      timestamp: now,
      rangeStart: event.rangeStart,
      rangeEnd: event.rangeEnd,
    });
    state.recentEdits = state.recentEdits.filter((e) => now - e.timestamp <= 1000);

    if (this.isBurstLike(event, state) && !state.burstActive) {
      state.burstActive = true;
      state.burstStartedAt = now;
      this.onBurst({ type: 'started', path: event.path, startedAt: now });
    }

    if (state.burstActive) {
      const startedAt = state.burstStartedAt;
      const path = event.path;
      state.quietTimer = this.clock.schedule(() => {
        const s = this.docs.get(path);
        if (s?.burstActive) {
          s.burstActive = false;
          s.quietTimer = undefined;
          this.onBurst({ type: 'ended', path, startedAt });
        }
      }, this.config.burstEndQuietMs);
    }
  }

  dispose(): void {
    for (const state of this.docs.values()) {
      if (state.quietTimer !== undefined) {
        this.clock.cancel(state.quietTimer);
      }
    }
    this.docs.clear();
  }

  private isBurstLike(event: EditEvent, state: DocState): boolean {
    if (state.recentEdits.length >= this.config.minEditsPerSecond) return true;
    if (event.insertedChars >= this.config.minInsertionChars) return true;
    if (event.affectedLines >= this.config.minAffectedLines) return true;

    if (state.recentEdits.length >= 2) {
      const sorted = [...state.recentEdits].sort((a, b) => a.rangeStart - b.rangeStart);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.rangeStart > sorted[i - 1]!.rangeEnd + 1) return true;
      }
    }

    return false;
  }
}

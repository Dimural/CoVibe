export interface ConcurrentWriteEvent {
  path: string;
  participants: string[];
}

export interface ConflictDetectorOptions {
  onConcurrentWrite(event: ConcurrentWriteEvent): void;
}

interface IntentEntry {
  startedAt: number;
  agentSourced: boolean;
}

export class ConflictDetector {
  private readonly options: ConflictDetectorOptions;
  /** path → (participantId → intent entry) */
  private readonly intents = new Map<string, Map<string, IntentEntry>>();
  /** paths for which we have already notified */
  private readonly notified = new Set<string>();

  constructor(options: ConflictDetectorOptions) {
    this.options = options;
  }

  recordIntent(
    participantId: string,
    path: string,
    startedAt: number,
    agentSourced: boolean,
  ): void {
    let byPath = this.intents.get(path);
    if (byPath === undefined) {
      byPath = new Map();
      this.intents.set(path, byPath);
    }
    byPath.set(participantId, { startedAt, agentSourced });

    if (byPath.size < 2) return;
    if (this.notified.has(path)) return;

    const times = [...byPath.values()].map((e) => e.startedAt).sort((a, b) => a - b);
    const maxGap = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
    if (maxGap <= 500) return;

    this.notified.add(path);
    this.options.onConcurrentWrite({ path, participants: [...byPath.keys()] });
  }

  clearIntent(participantId: string, path: string): void {
    const byPath = this.intents.get(path);
    if (byPath === undefined) return;
    byPath.delete(participantId);
    if (byPath.size === 0) {
      this.intents.delete(path);
      this.notified.delete(path);
    }
  }

  hasActiveConcurrentWrite(path: string): boolean {
    return this.notified.has(path);
  }

  getActiveParticipants(path: string): string[] {
    return [...(this.intents.get(path)?.keys() ?? [])];
  }

  clearAll(): void {
    this.intents.clear();
    this.notified.clear();
  }
}

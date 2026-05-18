import type { BurstEvent } from './heuristic.js';

export interface IntentBroadcasterOptions {
  send(type: string, payload: unknown): void;
  isAgentActive(): boolean;
  throttleMs: number;
}

export class IntentBroadcaster {
  private readonly options: IntentBroadcasterOptions;
  /** path → timestamp of last agent.intent sent */
  private readonly lastIntentAt = new Map<string, number>();

  constructor(options: IntentBroadcasterOptions) {
    this.options = options;
  }

  onBurstEvent(event: BurstEvent): void {
    if (event.type === 'started') {
      const last = this.lastIntentAt.get(event.path) ?? -Infinity;
      if (event.startedAt - last < this.options.throttleMs) return;
      this.lastIntentAt.set(event.path, event.startedAt);
      this.options.send('agent.intent', {
        path: event.path,
        description: 'agent is modifying this file',
        agentSourced: this.options.isAgentActive(),
      });
    } else {
      this.options.send('agent.change', {
        path: event.path,
        mergeKind: 'none',
      });
    }
  }

  clearThrottle(path: string): void {
    this.lastIntentAt.delete(path);
  }
}

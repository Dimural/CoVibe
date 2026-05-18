export interface TerminalLike {
  readonly name: string;
  readonly processRunning: boolean;
}

export interface TerminalMonitorOptions {
  patterns: string[];
  getTerminals(): TerminalLike[];
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export class TerminalMonitor {
  private readonly options: TerminalMonitorOptions;

  constructor(options: TerminalMonitorOptions) {
    this.options = options;
  }

  isAgentActive(): boolean {
    const terminals = this.options.getTerminals();
    return terminals.some(
      (t) => t.processRunning && this.options.patterns.some((p) => globMatch(p, t.name)),
    );
  }
}

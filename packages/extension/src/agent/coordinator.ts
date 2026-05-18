import {
  EditRateHeuristic,
  type BurstEvent,
  type EditEvent,
  type HeuristicConfig,
  type HeuristicClock,
} from './heuristic.js';
import { TerminalMonitor, type TerminalLike } from './terminal.js';
import { IntentBroadcaster } from './intent.js';
import { ConflictDetector } from './conflictDetector.js';
import { computeMergeDecision } from './automerge.js';

export interface CoordinatorOptions {
  localParticipantId: string;
  heuristicConfig: HeuristicConfig;
  getTerminals(): TerminalLike[];
  terminalPatterns: string[];
  send(type: string, payload: unknown): void;
  getDocumentText(path: string): string | undefined;
  applyWorkspaceEdit(path: string, text: string): Promise<void>;
  getWorkspaceRoot(): string;
  showWarningMessage(msg: string): void;
  showInformationMessage(msg: string): void;
  onAgentStatusChange(
    statuses: Record<string, { agentActive: boolean; agentSourced: boolean }>,
  ): void;
  openConflictView(
    conflictId: string,
    path: string,
    leftText: string,
    rightText: string,
    baseText: string,
    peers: string[],
  ): void;
  clock: HeuristicClock;
}

interface RemoteIntentEntry {
  path: string;
  agentSourced: boolean;
  startedAt: number;
}

export class AgentCoordinator {
  private readonly options: CoordinatorOptions;
  private heuristic: EditRateHeuristic | undefined;
  private broadcaster: IntentBroadcaster | undefined;
  private readonly detector: ConflictDetector;
  private readonly remoteIntents = new Map<string, RemoteIntentEntry>();
  private readonly snapshots = new Map<string, string>();
  private readonly agentStatuses = new Map<
    string,
    { agentActive: boolean; agentSourced: boolean }
  >();

  constructor(options: CoordinatorOptions) {
    this.options = options;
    this.detector = new ConflictDetector({
      onConcurrentWrite: ({ path, participants }) => {
        const names = participants.join(' and ');
        options.showWarningMessage(
          `⚠ CoVibes: Concurrent agent writes detected — ${names} are both editing ${path.split('/').pop() ?? path}`,
        );
        if (!this.snapshots.has(path)) {
          const text = options.getDocumentText(path);
          if (text !== undefined) this.snapshots.set(path, text);
        }
      },
    });
  }

  start(): void {
    const terminalMonitor = new TerminalMonitor({
      patterns: this.options.terminalPatterns,
      getTerminals: () => this.options.getTerminals(),
    });

    const broadcaster = new IntentBroadcaster({
      send: (type, payload) => this.options.send(type, payload),
      isAgentActive: () => terminalMonitor.isAgentActive(),
      throttleMs: 5000,
    });
    this.broadcaster = broadcaster;

    this.heuristic = new EditRateHeuristic(
      this.options.heuristicConfig,
      (event: BurstEvent) => {
        broadcaster.onBurstEvent(event);
        if (event.type === 'started') {
          if (!this.snapshots.has(event.path)) {
            const text = this.options.getDocumentText(event.path);
            if (text !== undefined) this.snapshots.set(event.path, text);
          }
          this.detector.recordIntent(
            this.options.localParticipantId,
            event.path,
            event.startedAt,
            terminalMonitor.isAgentActive(),
          );
          this.agentStatuses.set(this.options.localParticipantId, {
            agentActive: true,
            agentSourced: terminalMonitor.isAgentActive(),
          });
          this.options.onAgentStatusChange(this.buildStatusMap());
        } else {
          this.detector.clearIntent(this.options.localParticipantId, event.path);
          this.agentStatuses.set(this.options.localParticipantId, {
            agentActive: false,
            agentSourced: false,
          });
          this.options.onAgentStatusChange(this.buildStatusMap());
          this.maybeRunAutoMerge(event.path);
        }
      },
      this.options.clock,
    );
  }

  onLocalEdit(event: EditEvent): void {
    this.heuristic?.push(event);
  }

  onRemoteMessage(msg: { type: string; payload: unknown }, fromParticipantId: string): void {
    if (msg.type === 'agent.intent') {
      const payload = msg.payload as { path: string; description: string; agentSourced?: boolean };
      const agentSourced = payload.agentSourced ?? false;
      const startedAt = this.options.clock.now();

      this.remoteIntents.set(fromParticipantId, {
        path: payload.path,
        agentSourced,
        startedAt,
      });

      if (!this.snapshots.has(payload.path)) {
        const text = this.options.getDocumentText(payload.path);
        if (text !== undefined) this.snapshots.set(payload.path, text);
      }

      this.detector.recordIntent(fromParticipantId, payload.path, startedAt, agentSourced);
      this.agentStatuses.set(fromParticipantId, { agentActive: true, agentSourced });
      this.options.onAgentStatusChange(this.buildStatusMap());
    } else if (msg.type === 'agent.change') {
      const payload = msg.payload as { path: string; mergeKind: string };
      const intent = this.remoteIntents.get(fromParticipantId);
      this.remoteIntents.delete(fromParticipantId);
      this.detector.clearIntent(fromParticipantId, payload.path);
      this.agentStatuses.set(fromParticipantId, { agentActive: false, agentSourced: false });
      this.options.onAgentStatusChange(this.buildStatusMap());

      if (intent !== undefined) {
        this.maybeRunAutoMerge(payload.path);
      }
    } else if (msg.type === 'conflict.open') {
      const payload = msg.payload as {
        conflictId: string;
        path: string;
        leftText: string;
        rightText: string;
        baseText: string;
        peers: string[];
      };
      this.options.openConflictView(
        payload.conflictId,
        payload.path,
        payload.leftText,
        payload.rightText,
        payload.baseText,
        payload.peers,
      );
    }
  }

  async applyResolvedText(path: string, resolvedText: string): Promise<void> {
    await this.options.applyWorkspaceEdit(path, resolvedText);
    this.options.send('agent.change', { path, mergeKind: 'none' });
  }

  dispose(): void {
    this.heuristic?.dispose();
    this.detector.clearAll();
  }

  private buildStatusMap(): Record<string, { agentActive: boolean; agentSourced: boolean }> {
    return Object.fromEntries(this.agentStatuses);
  }

  private maybeRunAutoMerge(path: string): void {
    if (!this.detector.hasActiveConcurrentWrite(path)) {
      this.snapshots.delete(path);
      return;
    }

    const stillActive = this.detector.getActiveParticipants(path);
    if (stillActive.length > 0) return;

    const snapshot = this.snapshots.get(path);
    if (snapshot === undefined) return;
    this.snapshots.delete(path);

    const currentText = this.options.getDocumentText(path);
    if (currentText === undefined) return;

    const decision = computeMergeDecision(snapshot, currentText, currentText);

    if (decision.kind === 'noop') return;

    if (decision.kind === 'merge') {
      void this.options.applyWorkspaceEdit(path, decision.mergedText);
      this.options.showInformationMessage(
        `CoVibes: Auto-merged concurrent agent changes in ${path.split('/').pop() ?? path}`,
      );
      this.options.send('agent.change', { path, mergeKind: 'auto' });
    }
  }
}

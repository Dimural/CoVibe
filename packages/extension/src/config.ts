import * as vscode from 'vscode';

export interface CoVibesConfig {
  relayUrl: string;
  followModeEnabled: boolean;
  agentDetectionEnabled: boolean;
  gracePeriodSeconds: number;
  agentMinEditsPerSecond: number;
  agentMinInsertionChars: number;
  agentMinAffectedLines: number;
  agentTerminalPatterns: string[];
}

export function getConfig(): CoVibesConfig {
  const cfg = vscode.workspace.getConfiguration('covibes');
  return {
    relayUrl: cfg.get<string>('relayUrl') ?? 'wss://covibes-relay.fly.dev',
    followModeEnabled: cfg.get<boolean>('followMode.enabled') ?? true,
    agentDetectionEnabled: cfg.get<boolean>('agentDetection.enabled') ?? true,
    gracePeriodSeconds: cfg.get<number>('gracePeriodSeconds') ?? 1800,
    agentMinEditsPerSecond: cfg.get<number>('agentDetection.minEditsPerSecond') ?? 3,
    agentMinInsertionChars: cfg.get<number>('agentDetection.minInsertionChars') ?? 200,
    agentMinAffectedLines: cfg.get<number>('agentDetection.minAffectedLines') ?? 5,
    agentTerminalPatterns: cfg.get<string[]>('agentDetection.terminalPatterns') ?? [
      'Claude*',
      'Aider*',
      'Cursor*',
      'GitHub Copilot*',
      'Copilot*',
      'Devin*',
      'Cody*',
    ],
  };
}

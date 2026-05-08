import * as vscode from 'vscode';

export interface CoVibesConfig {
  relayUrl: string;
  followModeEnabled: boolean;
  agentDetectionEnabled: boolean;
  gracePeriodSeconds: number;
}

export function getConfig(): CoVibesConfig {
  const cfg = vscode.workspace.getConfiguration('covibes');
  return {
    relayUrl: cfg.get<string>('relayUrl') ?? 'wss://covibes-relay.fly.dev',
    followModeEnabled: cfg.get<boolean>('followMode.enabled') ?? true,
    agentDetectionEnabled: cfg.get<boolean>('agentDetection.enabled') ?? true,
    gracePeriodSeconds: cfg.get<number>('gracePeriodSeconds') ?? 1800,
  };
}

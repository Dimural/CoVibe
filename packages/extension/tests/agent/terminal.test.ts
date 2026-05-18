// packages/extension/tests/agent/terminal.test.ts
import { describe, it, expect } from 'vitest';
import { TerminalMonitor, type TerminalLike } from '../../src/agent/terminal.js';

function makeTerminal(name: string, running = true): TerminalLike {
  return { name, processRunning: running };
}

describe('TerminalMonitor', () => {
  it('returns false when no terminals exist', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Claude*'],
      getTerminals: () => [],
    });
    expect(monitor.isAgentActive()).toBe(false);
  });

  it('returns true when a matching terminal exists and is running', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Claude*'],
      getTerminals: () => [makeTerminal('Claude Code', true)],
    });
    expect(monitor.isAgentActive()).toBe(true);
  });

  it('returns false when matching terminal exists but is not running', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Claude*'],
      getTerminals: () => [makeTerminal('Claude Code', false)],
    });
    expect(monitor.isAgentActive()).toBe(false);
  });

  it('matches case-insensitively', () => {
    const monitor = new TerminalMonitor({
      patterns: ['claude*'],
      getTerminals: () => [makeTerminal('CLAUDE CODE', true)],
    });
    expect(monitor.isAgentActive()).toBe(true);
  });

  it('matches glob wildcard patterns', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Aider*'],
      getTerminals: () => [makeTerminal('Aider v1.2.3', true)],
    });
    expect(monitor.isAgentActive()).toBe(true);
  });

  it('returns false when non-matching terminal is running', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Claude*'],
      getTerminals: () => [makeTerminal('bash', true)],
    });
    expect(monitor.isAgentActive()).toBe(false);
  });

  it('returns true when any one of multiple patterns matches', () => {
    const monitor = new TerminalMonitor({
      patterns: ['Claude*', 'Aider*'],
      getTerminals: () => [makeTerminal('Aider v2', true)],
    });
    expect(monitor.isAgentActive()).toBe(true);
  });
});

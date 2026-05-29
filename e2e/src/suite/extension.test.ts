import * as assert from 'assert';
import * as vscode from 'vscode';

suite('CoVibes extension smoke tests', () => {
  test('CoVibes commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    const covibesCommands = all.filter((c) => c.startsWith('covibes.'));
    assert.ok(covibesCommands.includes('covibes.startSession'), 'startSession command missing');
    assert.ok(covibesCommands.includes('covibes.joinSession'), 'joinSession command missing');
    assert.ok(covibesCommands.includes('covibes.leaveSession'), 'leaveSession command missing');
    assert.ok(
      covibesCommands.includes('covibes.focusSessionPanel'),
      'focusSessionPanel command missing',
    );
  });

  test('covibes.focusSessionPanel executes without throwing', async () => {
    await vscode.commands.executeCommand('covibes.focusSessionPanel');
  });

  test('covibes.leaveSession executes without throwing when not in session', async () => {
    await vscode.commands.executeCommand('covibes.leaveSession');
  });

  test('CoVibes configuration schema is registered', () => {
    const config = vscode.workspace.getConfiguration('covibes');
    const relayUrl = config.get<string>('relayUrl');
    assert.ok(typeof relayUrl === 'string', 'covibes.relayUrl should be a string');
    assert.ok(
      relayUrl.startsWith('wss://') || relayUrl.startsWith('ws://'),
      'relayUrl should be a WebSocket URL',
    );
  });
});

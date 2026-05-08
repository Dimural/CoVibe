# CoVibes Extension

Real-time collaborative AI-assisted coding sessions for VS Code.

## Features

- **Shared sessions**: Multiple developers can join the same coding session identified by a shared invite link derived from the repository and branch.
- **Live participant awareness**: The status bar shows a headcount of active participants; the Session Panel lists each participant by name and avatar color.
- **Branch-aware**: Sessions are tied to a specific branch. Switching branches automatically ends the session with a notification.
- **Automatic reconnect**: The relay client exponentially backs off and reconnects on transient network failures without user intervention.
- **Clipboard invite link**: Starting a session automatically copies the invite link to the clipboard so you can paste it into Slack or a PR comment.
- **Grace period**: The relay keeps a session alive for a configurable period after the last participant disconnects, so late joiners still connect to the same session.

## Getting Started

### Start a session (Window A)

1. Open a git repository in VS Code.
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Run **CoVibes: Start Session**.
4. Enter a display name when prompted (first run only).
5. The invite link is copied to the clipboard automatically.
6. Share the invite link with your collaborators.

### Join a session (Window B)

1. Open the **same git repository** checked out on the **same branch** in another VS Code window.
2. Open the Command Palette and run **CoVibes: Join Session**.
3. Paste the invite link and press Enter.
4. Both windows now show the participant count in the status bar.

### Leave a session

- Run **CoVibes: Leave Session** from the Command Palette, or close the VS Code window.

## Commands

| Command                        | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `CoVibes: Start Session`       | Start a new collaborative session               |
| `CoVibes: Join Session`        | Join an existing session via an invite link     |
| `CoVibes: Leave Session`       | Leave the current session                       |
| `CoVibes: Focus Session Panel` | Open the Session Panel showing all participants |

## Settings

| Setting                          | Type      | Default                       | Description                                                              |
| -------------------------------- | --------- | ----------------------------- | ------------------------------------------------------------------------ |
| `covibes.relayUrl`               | `string`  | `wss://covibes-relay.fly.dev` | WebSocket URL of the CoVibes relay server                                |
| `covibes.followMode.enabled`     | `boolean` | `true`                        | Auto-scroll to followed participant's cursor position                    |
| `covibes.agentDetection.enabled` | `boolean` | `true`                        | Heuristic AI agent detection (highlights agent-driven edits differently) |
| `covibes.gracePeriodSeconds`     | `number`  | `1800`                        | Seconds to keep a session alive after the last participant disconnects   |

## Requirements

- VS Code ^1.95.0
- A git repository with at least one remote

## Local Development

### Start the relay server

```bash
pnpm --filter @covibes/relay dev
```

The relay listens on `ws://localhost:3000` by default.

### Configure the extension to use the local relay

In VS Code Settings, set:

```json
"covibes.relayUrl": "ws://localhost:3000"
```

### Launch the Extension Development Host

1. Open the CoVibes monorepo in VS Code.
2. Press **F5** (or run **Debug: Start Debugging**) to build and open an Extension Development Host window.
3. In the Extension Development Host, open a git repository folder.
4. Use the Command Palette to run CoVibes commands.

### Run tests

```bash
# Unit tests (extension package)
pnpm --filter @covibes/extension test

# Integration tests (relay)
pnpm --filter @covibes/relay test

# All packages
pnpm test
```

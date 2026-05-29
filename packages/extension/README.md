# CoVibes — Real-Time Collaborative AI Coding

CoVibes brings Google Docs–style live collaboration to VS Code, purpose-built for AI-assisted development. Work on the same branch simultaneously with teammates, with full awareness of each other's edits and AI agent activity.

## Features

- **Real-time document sync** — OT-based; works with any AI agent (Claude, Copilot, Aider, Cursor, etc.)
- **Cursor visibility** — see collaborator cursors and selections with colored decorations
- **Follow mode** — mirror a collaborator's navigation for code reviews or pairing sessions
- **Agent awareness** — detect when a teammate's AI agent is writing to a file; gutter markers + explorer badges
- **Auto-merge** — silently merge non-overlapping concurrent agent edits
- **Collaborative conflict resolution** — three-panel UI when agent edits overlap; both users resolve together
- **Coordinated git ops** — commit and push notifications with acknowledgment windows; auto-pull on remote update
- **Branch scoping** — sessions are branch-scoped; switching branches cleanly exits the session

## Quickstart

1. Install **CoVibes** from the VS Code Marketplace
2. Open a git repository on your working branch
3. **Start a session:** open the Command Palette → `CoVibes: Start Session` — an invite link is copied to your clipboard
4. Share the link with your collaborator(s)
5. **Join a session:** collaborator runs `CoVibes: Join Session` and pastes the link
6. Start coding — edits, cursors, and agent activity sync in real time

## Requirements

- VS Code ≥ 1.95.0
- A git repository with a remote (e.g. GitHub)
- All participants on the same branch

## Settings

| Setting                          | Default                       | Description                     |
| -------------------------------- | ----------------------------- | ------------------------------- |
| `covibes.relayUrl`               | `wss://covibes-relay.fly.dev` | WebSocket relay URL             |
| `covibes.followMode.enabled`     | `true`                        | Enable follow mode              |
| `covibes.agentDetection.enabled` | `true`                        | Detect AI agent activity        |
| `covibes.gracePeriodSeconds`     | `1800`                        | Session grace period (seconds)  |
| `covibes.telemetry.enabled`      | `false`                       | Send anonymous usage statistics |

## Privacy

Telemetry is off by default. When enabled, only anonymous, aggregated events are sent — never code, file paths, or personal data. See [PRIVACY.md](https://github.com/covibes/covibes/blob/main/PRIVACY.md) for full details.

## Troubleshooting

See [docs/troubleshooting.md](../../docs/troubleshooting.md) for common issues and fixes.

## License

MIT

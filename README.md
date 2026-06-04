# CoVibes

> **Real-time collaborative AI-assisted coding for VS Code** — Google Docs for vibe coding.

CoVibes lets 2–4 developers work on the same git branch simultaneously, with full awareness of each other's edits, cursors, and AI agent activity. It uses [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation) to guarantee convergence under concurrent edits, and heuristics to detect when AI agents are writing — so teammates can coordinate instead of collide.

<br>

```
┌─ VS Code (Alice) ─────────────┐     ┌─ VS Code (Bob) ──────────────┐
│                               │     │                              │
│  ████ typing...               │     │  ████ typing...              │
│  ▌ cursor                     │◄───►│               cursor ▌       │
│                               │     │                              │
│  ✨ Bob's agent is writing    │     │  ✨ Alice's agent is writing  │
└───────────────────────────────┘     └──────────────────────────────┘
               │                                     │
               └──────────────┬──────────────────────┘
                              │ WSS
                    ┌─────────▼─────────┐
                    │   CoVibes Relay    │
                    │  OT Sequencer      │
                    │  Session Registry  │
                    └───────────────────┘
```

<br>

## Features

|     | Feature              | Description                                                            |
| --- | -------------------- | ---------------------------------------------------------------------- |
| 📝  | **Real-time sync**   | Every keystroke synced via OT — works with any AI agent                |
| 🖱️  | **Live cursors**     | See every collaborator's cursor and selection in color                 |
| 👁️  | **Follow mode**      | Mirror a teammate's navigation for walkthroughs and review             |
| 🤖  | **Agent detection**  | Heuristics detect AI bursts; intent broadcast shows who's writing what |
| 🔀  | **Auto-merge**       | Non-overlapping agent edits merged silently                            |
| ⚡  | **Conflict UI**      | Three-panel shared editor when agent edits overlap — resolve together  |
| 🔧  | **Git coordination** | Commit and push with a 10s notification window for teammates           |
| 🌿  | **Branch scoping**   | Sessions are branch-scoped; switching branches cleanly exits           |
| 🔒  | **No code stored**   | The relay routes messages only — your code never leaves your machine   |

<br>

## How It Works

```
                          Session Start
                          ─────────────

  Alice                    Relay                     Bob
    │                        │                        │
    │── session.join ────────►│                        │
    │◄─ session.state ────────│                        │
    │                        │◄──── session.join ──────│
    │◄─ session.state ────────│──── session.state ─────►│
    │                        │                        │


                         Real-Time Edit
                         ─────────────

  Alice                    Relay                     Bob
    │                        │                        │
    │── doc.delta ───────────►│                        │
    │                        │  sequence + transform   │
    │◄─ doc.ack (v=1) ────────│── doc.delta (v=1) ─────►│
    │                        │                        │


                       Agent Conflict Flow
                       ──────────────────

  Alice                    Relay                     Bob
    │── agent.intent ────────►│──── agent.intent ──────►│
    │                        │                        │
    │  (agents finish)        │                        │
    │── conflict.resolve ────►│──── conflict.resolve ──►│
    │                        │                        │
```

<br>

## Architecture

```
packages/
├── protocol/     Shared TypeScript types · zod schemas · OT primitives · invite links
├── relay/        Node.js WebSocket server · OT sequencer · session registry · Redis
└── extension/    VS Code extension · OT client · agent heuristic · git coordinator

e2e/              @vscode/test-electron smoke tests
docs/             Architecture diagrams · Troubleshooting guide
```

**Tech stack:** TypeScript 5 (strict) · pnpm workspaces · `ot-text-unicode` · `ws` · Redis (`ioredis`) · Vitest · esbuild · Fly.io

<br>

## Quick Start

### For users

1. Install **CoVibes** from the VS Code Marketplace
2. Open a git repository on your working branch
3. `Cmd+Shift+P` → **CoVibes: Start Session** — invite link copied to clipboard
4. Share the link; collaborators run **CoVibes: Join Session** and paste it
5. Code together in real time

### For developers

```bash
# Clone and install
git clone https://github.com/Dimural/CoVibe
cd covibes
pnpm install && pnpm build

# Start the relay
PORT=3000 pnpm --filter @covibes/relay dev

# Launch extension in VS Code
# Press F5 → Extension Development Host opens
# Set covibes.relayUrl = ws://localhost:3000 in settings
```

Open a second VS Code window with F5 → Start Session in Window A → Join Session in Window B. Both windows should show **Active(2)** in the status bar.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full dev setup guide.

<br>

## Settings

| Setting                          | Default                       | Description                                |
| -------------------------------- | ----------------------------- | ------------------------------------------ |
| `covibes.relayUrl`               | `wss://covibes-relay.fly.dev` | WebSocket relay server URL                 |
| `covibes.followMode.enabled`     | `true`                        | Follow a collaborator's navigation         |
| `covibes.agentDetection.enabled` | `true`                        | Detect AI agent activity                   |
| `covibes.gracePeriodSeconds`     | `1800`                        | Session grace period after last disconnect |
| `covibes.telemetry.enabled`      | `false`                       | Anonymous usage statistics (opt-in)        |

<br>

## Repository Layout

```
CoVibe/
├── packages/
│   ├── protocol/          # @covibes/protocol — wire types, OT, invite links
│   │   ├── src/
│   │   │   ├── messages/  # zod schemas for all 18 message types
│   │   │   ├── ot.ts      # OT primitives (apply, compose, transform)
│   │   │   └── session.ts # session ID derivation + invite link format
│   │   └── tests/
│   ├── relay/             # @covibes/relay — WebSocket server
│   │   ├── src/
│   │   │   ├── server.ts        # HTTP + WS upgrade handler
│   │   │   ├── router.ts        # message routing (never echo to sender)
│   │   │   ├── doc/sequencer.ts # per-document OT sequencer
│   │   │   └── sessionRegistry.ts
│   │   ├── tests/
│   │   │   └── integration/     # real WS client scenarios (10 scenarios)
│   │   ├── Dockerfile
│   │   ├── fly.toml
│   │   └── RUNBOOK.md
│   └── extension/         # covibes — VS Code client
│       ├── src/
│       │   ├── agent/     # heuristic, terminal monitor, conflict detector
│       │   ├── conflict/  # three-panel resolution UI
│       │   ├── git/       # coordinator, auto-pull, context probe
│       │   ├── relay/     # WebSocket client + reconnect
│       │   ├── session/   # state machine + manager
│       │   ├── sync/      # OT engine, edit capture, cursors, follow mode
│       │   ├── ui/        # status bar, session panel, decorations
│       │   ├── errors.ts  # typed error classes + userMessage()
│       │   └── telemetry.ts
│       └── media/         # icon, webview HTML/CSS/JS
├── e2e/                   # @vscode/test-electron smoke tests
├── docs/
│   ├── architecture.md    # Mermaid sequence diagrams
│   └── troubleshooting.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── PRIVACY.md
```

<br>

## Test Coverage

```
Package                Tests    Status
────────────────────────────────────────
@covibes/protocol       155     ✅ passing
@covibes/relay          116     ✅ passing  (9 skipped — need Redis)
@covibes/extension      321     ✅ passing
────────────────────────────────────────
Total                   592     ✅
```

OT convergence is property-tested with `fast-check` — for any string and any pair of concurrent operations, the system proves both clients converge to the same result.

<br>

## Privacy

Telemetry is **off by default**. When enabled, only anonymous, aggregated events are sent — never code, file paths, or personal data. See [PRIVACY.md](./PRIVACY.md) for the full data inventory.

<br>

## License

MIT — see [LICENSE](./LICENSE).

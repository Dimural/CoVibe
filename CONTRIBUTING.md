# Contributing to CoVibes

## Prerequisites

- Node.js ≥ 20.10.0 (use `.nvmrc`: `nvm use`)
- pnpm 9.12.0: `npm install -g pnpm@9.12.0`
- VS Code ≥ 1.95.0
- Redis (optional — only required for relay integration tests with real Redis)

## Setup

```bash
git clone https://github.com/Dimural/CoVibe
cd covibes
pnpm install
pnpm build
pnpm test
```

All 500+ tests should pass on a clean checkout.

## Package Structure

```
packages/
  protocol/   Shared message types, OT primitives, invite link format
  relay/      Node.js WebSocket server
  extension/  VS Code extension
e2e/          End-to-end smoke tests (@vscode/test-electron)
docs/         Architecture, troubleshooting
```

## Running Locally

### Start the relay

```bash
pnpm --filter @covibes/relay dev
# Relay listens on ws://localhost:3000
```

### Launch the extension in a development host

1. Open the repo in VS Code
2. Press **F5** (or Run → Start Debugging)
3. A new VS Code window opens with CoVibes loaded
4. Set `covibes.relayUrl` to `ws://localhost:3000` in that window

### Two-window manual test

1. Start the relay (above)
2. Open VS Code on a git repo → press F5 → Extension Development Host (Window A)
3. Open a second VS Code window on the same repo → press F5 (Window B)
4. Window A: `CoVibes: Start Session` → status bar shows Active(1), invite link copied
5. Window B: `CoVibes: Join Session` → paste the invite link
6. Both windows: status bar shows Active(2)

See `packages/extension/TESTING.md` for detailed soak test scenarios.

## Testing Strategy

- **Run all tests:** `pnpm test`
- **Single package:** `pnpm --filter <package> test`
- **Watch mode:** `pnpm --filter <package> test -- --watch`

Tests use Vitest. TDD throughout: write failing test → minimal impl → green → commit.

OT convergence is property-tested with `fast-check` — see `packages/protocol/tests/ot.test.ts`.

## Commit Convention

Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Scope is the package name (e.g. `feat(extension):`, `fix(relay):`).

## Pre-commit Hooks

`lefthook` runs lint + format + typecheck before every commit. If a hook fails:

```bash
pnpm lint        # see ESLint errors
pnpm format      # auto-fix formatting
pnpm typecheck   # see TypeScript errors
```

## Pull Requests

- One PR per logical change
- Every PR keeps `pnpm test` green
- For OT/sync changes, include a property test demonstrating convergence
- For UI changes, include a screenshot or description of the manual test performed

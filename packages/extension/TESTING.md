# Manual Smoke Test

## Prerequisites

- Node.js 20+, pnpm installed
- Two VS Code windows pointing at the same git repository

## Steps

### Start the relay

pnpm --filter @covibes/relay dev

### Launch Extension Development Hosts

1. Open the CoVibes repo in VS Code
2. Press F5 to launch Extension Development Host (Window A)
3. Open a second Extension Development Host via "Extensions: Start Extension Bisect" or duplicate the launch config

### Window A — Start a session

1. Open the Command Palette (Cmd+Shift+P)
2. Run `CoVibes: Start Session`
3. Verify: status bar shows `$(broadcast) CoVibes: 1`
4. Verify: invite link is in clipboard
5. Verify: Session panel opens showing 1 participant

### Window B — Join the session

1. Open Command Palette
2. Run `CoVibes: Join Session`
3. Paste the invite link from clipboard
4. Verify: both windows show `$(broadcast) CoVibes: 2`
5. Verify: both session panels show 2 participants

### Leave session

1. In Window A, run `CoVibes: Leave Session`
2. Verify: Window A shows `$(circle-slash) CoVibes`
3. Verify: Window B still shows 1 participant after grace period keeps session open

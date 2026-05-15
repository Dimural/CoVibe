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

---

## Phase 4 Soak Protocol — Real-Time Document Sync

Both windows must be in the same session (follow the setup steps above) with the same file open.

### Soak 1: Concurrent edits converge

1. Open the same `.ts` file in both windows.
2. In Window A, type rapidly at the beginning of the file (hold a key for ~2 seconds).
3. Simultaneously, in Window B, type rapidly at the end of the file.
4. Stop typing. Wait 1 second.
5. **Assert:** Both windows show identical text. No duplicate characters. No lost characters.
6. **Assert:** The OT model has converged — switching focus between windows should not produce any further changes.

### Soak 2: Multi-byte input

1. In Window A, paste a line of emoji: `😀🎉🌍🔥💡` (each is a 2-unit UTF-16 surrogate pair).
2. In Window B, simultaneously paste a different emoji line at a different position.
3. **Assert:** Both windows show all emoji from both pastes, in consistent order. No corruption (no half-surrogate pairs, no garbled characters).
4. Repeat with a 1 MB block of text (e.g., paste a large JSON blob) — both windows must converge within 5 seconds.

### Soak 3: Disconnect and reconnect

1. With both windows synced on a file, kill Window B's WebSocket connection by either:
   - Stopping the relay (`Ctrl+C`) and restarting it, then re-joining from Window B, OR
   - Disabling Window B's network interface temporarily.
2. In Window A, make several edits (type 3–4 lines of code).
3. Reconnect Window B to the session.
4. **Assert:** Window B catches up to Window A's current state within 3 seconds of reconnect.
5. **Assert:** No error dialogs appear in either window.

### Soak 4: Cursor decorations

1. With both windows in the same session on the same file:
2. In Window A, move the cursor around. **Assert:** Window B shows a colored caret decoration at the correct position with Window A participant's display name label.
3. Switch Window A to a different file. **Assert:** The stale decoration disappears from the first file in Window B.
4. In Window B, switch to a different file. **Assert:** The navigation is broadcast and reflected in Window A's participant panel (if wired to UI).

### Soak 5: Follow mode

1. In Window B, run `CoVibes: Follow Participant` and select Window A's participant.
2. In Window A, switch to a different file and move the cursor.
3. **Assert:** Window B automatically navigates to the same file and scrolls to Window A's cursor position.
4. In Window B, make an edit. **Assert:** Follow mode does not break — Window B can still edit while following.

### Pass criteria

All 5 soaks pass with no data loss, no crashes, and no error dialogs in either window.

# CoVibes Troubleshooting

## "Cannot reach the relay server"

**Symptom:** Starting or joining a session immediately fails with a relay error.

**Causes & fixes:**

1. No internet connection — check connectivity.
2. Wrong relay URL — open VS Code Settings, search `covibes.relayUrl`, verify it starts with `wss://` or `ws://localhost:PORT` for local dev.
3. Relay is down — check the GitHub issues page for status updates.

## "Authentication failed"

**Symptom:** Joining a session immediately fails with an authentication error.

**Causes & fixes:**

1. The invite link has expired or was used from the wrong repository. Ask the session host to generate a new link via `CoVibes: Start Session`.
2. The invite link was truncated when copying. Copy the full link (it starts with `covibes://join?`).

## "Session is full"

**Symptom:** Cannot join — session is at capacity.

**Fix:** CoVibes sessions support up to 4 participants. Someone must leave before a 5th user can join.

## "Switch to branch X to join this session"

**Symptom:** Join fails with a branch mismatch.

**Fix:** Run `git checkout <branch>` or use VS Code's branch switcher (bottom-left) to switch to the correct branch, then retry `CoVibes: Join Session`.

## "No git remote found"

**Symptom:** Starting a session fails with a git remote error.

**Fix:** Push your repo to a remote (e.g. GitHub) before starting a CoVibes session. Run `git remote add origin <url>`.

## Documents are out of sync / duplicate text

**Symptom:** Text appears duplicated or participants see different content.

**Fix:**

1. Leave and rejoin the session — the resync protocol restores correct state.
2. If the issue persists, close and reopen the affected file; CoVibes will request a fresh snapshot.

## Conflict UI never opens

**Symptom:** Two agents edited the same file but no conflict UI appeared.

**Explanation:** CoVibes first attempts an auto-merge. If edits affected different lines, the merge succeeds silently (you'll see a brief toast). The conflict UI only opens when edits overlap on the same lines.

## Status bar shows "Error" permanently

**Symptom:** Status bar stuck on error state.

**Fix:**

1. Run `CoVibes: Leave Session` to reset state.
2. Reload the VS Code window (`Developer: Reload Window`).
3. Check the Output panel (select "CoVibes" from the dropdown) for detailed error logs.

## Extension not activating

**Symptom:** No CoVibes status bar item appears.

**Fix:**

1. Verify the extension is installed: `code --list-extensions | grep covibes`.
2. Check the Extensions panel for error markers on the CoVibes entry.
3. Open the Developer Tools console (`Help → Toggle Developer Tools`) for uncaught errors.

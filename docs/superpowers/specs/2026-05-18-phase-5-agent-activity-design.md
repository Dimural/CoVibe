# Phase 5 — Agent Activity Layer: Design Spec

**Date:** 2026-05-18
**Status:** Approved

---

## Overview

Phase 5 adds awareness of AI agent activity to CoVibe sessions. When a participant's editor enters a high-velocity edit burst (characteristic of AI agents writing code), all session participants are notified visually, concurrent writes are detected proactively, and post-burst conflicts are resolved either automatically (disjoint edits) or collaboratively via a shared 3-panel UI.

Phase 4 OT sync continues to run beneath all of this — the agent layer is observational and coordinative, not a replacement for OT.

---

## Task 5.1 — Edit-Rate Heuristic

**File:** `src/agent/heuristic.ts`

### What it does

Maintains a per-document sliding window of recent VS Code `onDidChangeTextDocument` events and classifies them as "agent-like" or "human-like".

### Burst detection criteria (any one triggers a burst)

| Condition                                  | Value   | VS Code Setting                            |
| ------------------------------------------ | ------- | ------------------------------------------ |
| ≥ N edits within 1 second                  | N = 3   | `covibes.agentDetection.minEditsPerSecond` |
| Single edit inserts ≥ N chars              | N = 200 | `covibes.agentDetection.minInsertionChars` |
| Single edit affects ≥ N lines              | N = 5   | `covibes.agentDetection.minAffectedLines`  |
| Edits span non-contiguous ranges within 1s | —       | (not configurable)                         |

### Burst lifecycle

- **Burst starts** when any criterion is first met → emits `AgentBurstStarted { path, participantId }`.
- **Burst extends** as long as at least one criterion remains met.
- **Burst ends** after 2s of human-rate (or no) edits → emits `AgentBurstEnded { path, participantId, startedAt }`.
- A pre-burst snapshot of the document text is captured when the **first** burst on a path is detected (either a local `AgentBurstStarted` or an incoming remote `agent.intent`). This ensures both participants snapshot the same OT-converged version.

### Design decisions

- The heuristic is intentionally permissive (false-positives acceptable; PRD §7.3 confirms this gates UX not correctness).
- Implemented as a pure event emitter with no VS Code API dependencies, making it straightforward to unit-test with synthetic edit streams.
- The heuristic is per-document (keyed by URI), so simultaneous human edits in a different file don't interfere.
- Agent detection can be disabled globally via `covibes.agentDetection.enabled` (already in `config.ts`).

---

## Task 5.2 — Terminal Monitoring

**File:** `src/agent/terminal.ts`

### What it does

Subscribes to VS Code terminal lifecycle events and labels incoming edit bursts as "agent-sourced" when an AI agent terminal is active.

### Agent terminal patterns (VS Code setting: `covibes.agentDetection.terminalPatterns`)

Default list: `["Claude*", "Aider*", "Cursor*", "GitHub Copilot*", "Copilot*", "Devin*", "Cody*"]`

Pattern matching: glob-style, case-insensitive, matched against `terminal.name`.

### Labelling logic

A burst is labelled `agentSourced: true` when:

- A terminal whose name matches a pattern is currently active (has focus), **OR**
- Such a terminal exists and its state is `Running` (i.e., the process is executing, even if the panel is hidden).

This covers the common case of agents that write to the editor while running in a background terminal.

### Design decision

The terminal signal is additive, not gating: bursts are detected and broadcast regardless of terminal state. The terminal match upgrades a burst's label from "burst-like" to "agent-confirmed", which affects the session panel indicator text (§5.4) but not the conflict detection logic (§5.5).

---

## Task 5.3 — Intent Broadcasting

**File:** `src/agent/intent.ts`

### What it does

Translates local `AgentBurstStarted`/`AgentBurstEnded` events into wire messages.

### Messages sent

- On `AgentBurstStarted` → `agent.intent { path, agentSourced: boolean }`
- On `AgentBurstEnded` → `agent.change { path }`

### Throttle

- No re-broadcast of `agent.intent` for the same path within 5s (burst extension doesn't spam peers).
- `agent.change` is always sent (no throttle) — peers need to know when the burst ends.

### Relay behavior (no changes needed)

The relay already routes `agent.intent` and `agent.change` to all other participants in the session (Phase 2 implementation). No relay changes required.

---

## Task 5.4 — Visual Indicators

**Files:** `src/ui/agentDecorations.ts`, `src/ui/explorerBadges.ts`

### Three surfaces

#### 1. Gutter decoration (editor)

When a remote participant's `agent.intent` arrives for the currently open file:

- Apply a `TextEditorDecorationType` with a colored **left-border bar** (3px, participant's assigned color, 60% opacity) to all lines being modified.
- Since we receive OT ops in real-time (Phase 4), derive the active line ranges from the pending ops in the `SyncedDocument`.
- Decoration is cleared when `agent.change` arrives for that path, or when the participant leaves.

Visual style: subtle, doesn't obscure code. Consistent with cursor decoration color scheme.

#### 2. File explorer badge

When `agent.intent` arrives:

- Register a `FileDecorationProvider` that adds a colored dot badge (using the participant's color as the badge color where VS Code API allows) to the file in the explorer tree.
- Tooltip: `"{Name}'s agent is editing this file"`.
- Cleared on `agent.change` or participant leave.

Note: VS Code's `FileDecorationProvider` supports `badge` (2-char string) and `color` (ThemeColor). We use `"⚡"` as the badge character and the participant's theme-mapped color. If VS Code strips the emoji in the badge slot, fall back to `"AI"`.

#### 3. Session panel badge

In `sessionPanel.ts` / `sessionPanel.js`, each participant row gains an inline status chip:

- No burst: no chip shown.
- Burst (human-rate): `● writing` in muted color.
- Burst (agent-confirmed): `⚡ agent` in participant's color, slightly bolder.
- State updates are pushed via the existing `postMessage` mechanism.

### Design decision

All three surfaces use the participant's existing assigned color (from `identity.ts`) for visual consistency with cursor decorations. No new color system needed.

---

## Task 5.5 — Concurrent-Write Detection

**File:** `src/agent/conflictDetector.ts`

### What it does

Tracks active `agent.intent` messages per `(path, participantId)`. When ≥2 participants have an active intent on the same path, emits `ConcurrentAgentWrite { path, participants }`.

### UX response

Show a VS Code **warning notification** (non-modal, appears in the notification center):

> **⚠ Concurrent agent writes detected**
> You and **{peer}** are both editing `{filename}` simultaneously.

Shown on both sides. No action required — this is informational. OT handles convergence regardless.

The notification is shown at most once per (path, burst-pair) to avoid spam. It is not shown if the two intents started within 500ms of each other (brief overlap at handoff is normal; only sustained overlap is worth surfacing).

---

## Task 5.6 — Post-Burst Diff and Auto-Merge

**File:** `src/agent/automerge.ts`

### When it runs

When all active `agent.intent`s on a given path have ended (i.e., the last `agent.change` arrives after a `ConcurrentAgentWrite` was detected), the auto-merge flow runs.

If no `ConcurrentAgentWrite` was detected for the path (single-participant burst), auto-merge is skipped — OT already handled convergence.

### Diff computation

Library: `diff-match-patch` (already handles Unicode correctly; consistent with the OT layer).

Steps:

1. Retrieve the **pre-burst snapshot** captured at `AgentBurstStarted`.
2. Each participant's current document text at burst-end is the "after" state.
3. Compute `diff(snapshot, afterA)` and `diff(snapshot, afterB)` to get hunk lists.
4. Check for line-level disjointness: two hunk sets are disjoint if no line number appears in both.

### Outcomes

| Condition                         | Action                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| All hunks line-disjoint           | Silent merge: apply union of both hunk sets as a `WorkspaceEdit`; broadcast `agent.change` with merge result; toast `"Auto-merged {peer}'s changes."` |
| Any hunks overlap                 | Trigger Task 5.7 conflict resolution UI                                                                                                               |
| One side is identical to snapshot | No-op; OT already produced correct result                                                                                                             |

### Design decision

By the time all bursts end, Phase 4 OT guarantees both participants have the **same converged document text**. Both sides independently run the same diff computation against the same pre-burst snapshot and reach identical conclusions. Each side applies the `WorkspaceEdit` locally — no cross-participant coordination is needed for the merge itself. The `agent.change` broadcast is for UX only (to trigger the "Auto-merged" toast on the peer's side).

---

## Task 5.7 — Collaborative Conflict Resolution UI

**Files:** `src/conflict/view.ts`, `media/conflict.html`, `media/conflict.css`, `media/conflict.js`

### Layout

Three-panel webview (implemented as a VS Code `WebviewPanel`):

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠ Conflict in src/foo.ts  — You and Alice are both editing this │
├─────────────────┬──────────────────────┬─────────────────────────┤
│  YOUR VERSION   │   RESOLVED (shared)  │   ALICE'S VERSION       │
│  (read-only)    │   (editable, synced) │   (read-only)           │
│                 │                      │                         │
│  … code …       │  … conflict markers  │  … code …               │
│                 │    shown inline …    │                         │
├─────────────────┴──────────────────────┴─────────────────────────┤
│  [Take Mine →]   [← Take Theirs]   [✓ Confirm]  [✗ Cancel]       │
│  You: ● confirmed    Alice: ○ waiting                            │
└──────────────────────────────────────────────────────────────────┘
```

### Center panel (shared resolution document)

- Initial content: pre-burst snapshot text with conflict markers inserted at overlapping hunk positions (standard `<<<<<<< / ======= / >>>>>>>` format).
- The center panel is a **CoVibe-synced virtual document** — it reuses the Phase 4 OT engine on an in-memory `TextDocument` (not a real file), so both participants' cursors and edits appear live in the center.
- The virtual document URI follows the scheme `covibes-conflict://{sessionId}/{path}`. This scheme must be registered via a `TextDocumentContentProvider` and declared in `package.json` under `contributes.virtualDocuments`.

### Per-hunk actions

Each conflict marker block has inline buttons:

- **"Take mine"** — replaces the conflict block with the local participant's version.
- **"Take theirs"** — replaces with the peer's version.
- Buttons are rendered in the webview HTML, not as editor decorations (simpler, works in webview context).

### Confirmation flow

- Each participant has a **"Confirm Resolution"** button, enabled only when no conflict markers remain in the center text.
- When a participant confirms, their status indicator changes from `○ waiting` to `● confirmed`.
- When **both** confirm: the resolved text is written to the real file via `WorkspaceEdit`; `conflict.resolve` is broadcast; both webviews close.
- **Cancel** (either participant): both webviews close; a toast explains `"Conflict resolution cancelled. Use git merge tools to resolve manually."`; the real file is left unchanged (OT will have the last-known converged state from Phase 4).

### Styling

- VS Code CSS variables throughout (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.) for seamless theme integration.
- Conflict markers highlighted in amber (`--vscode-editorWarning-foreground`).
- Participant cursors in the center panel shown with their assigned colors (same as main editor).
- Professional, minimal — no gratuitous animations.

---

## New VS Code Settings

```json
"covibes.agentDetection.enabled": true,
"covibes.agentDetection.minEditsPerSecond": 3,
"covibes.agentDetection.minInsertionChars": 200,
"covibes.agentDetection.minAffectedLines": 5,
"covibes.agentDetection.terminalPatterns": [
  "Claude*", "Aider*", "Cursor*", "GitHub Copilot*", "Copilot*", "Devin*", "Cody*"
]
```

---

## New Dependencies

| Package            | Used in        | Reason                               |
| ------------------ | -------------- | ------------------------------------ |
| `diff-match-patch` | `automerge.ts` | Hunk computation for post-burst diff |

---

## Testing Strategy

| Task | Test type                 | Key scenarios                                                                                                    |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 5.1  | Unit (Vitest)             | Rapid edits trigger burst; slow edits don't; burst ends after quiet period; large single edit triggers burst     |
| 5.2  | Unit (mocked VS Code API) | Terminal name matching; active vs. background terminal                                                           |
| 5.3  | Unit                      | Intent sent on burst start; throttle prevents repeat within 5s; change sent on burst end                         |
| 5.4  | Unit (mocked decorations) | Decoration applied on intent; cleared on change; session panel message shape                                     |
| 5.5  | Unit                      | Single-participant burst → no detection; two-participant overlap → detection; brief overlap (< 500ms) → no toast |
| 5.6  | Unit                      | Disjoint hunks → merge; overlapping → conflict trigger; identical → no-op                                        |
| 5.7  | Unit (model) + snapshot   | `ConflictResolution` state machine transitions; HTML snapshot for webview layout                                 |

No new relay code is required for Phase 5. All new messages (`agent.intent`, `agent.change`, `conflict.open`, `conflict.resolve`) are already defined in `@covibes/protocol` and routed by the Phase 2 relay.

---

## Out of Scope for Phase 5

- Agent-specific identity (who the agent is, which model). CoVibe treats agents as opaque — the heuristic detects behavior, not identity.
- Rate limiting or blocking of agent edits. OT handles convergence unconditionally.
- Conflict resolution for non-agent (human-speed) concurrent edits. Git handles that.

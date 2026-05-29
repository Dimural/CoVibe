# Changelog

All notable changes to CoVibes are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [0.0.1] — 2026-05-29

Initial pre-release.

### Added

- **Real-time document sync** — OT-based concurrent editing across 2–4 participants; property-tested convergence via `fast-check`.
- **Cursor and selection visibility** — colored cursor decorations per participant with name labels.
- **Follow mode** — optional navigation mirroring to follow a collaborator's active file and cursor.
- **Agent activity detection** — edit-rate heuristic + terminal monitoring to identify AI agent bursts; intent broadcasting with visual gutter markers and explorer badges.
- **Auto-merge** — disjoint concurrent agent edits merged silently; overlapping edits open a collaborative conflict resolution UI.
- **Collaborative conflict resolution UI** — three-panel webview (left/center/right) with live OT sync in the resolution editor; both users must confirm before applying.
- **Coordinated git operations** — commit, push, pull, and branch-switch coordinated across all session participants with notification windows and explicit ack.
- **Session management** — invite-link–based session creation and joining; branch-scoped sessions with grace-period reconnection.
- **Status bar + session panel** — real-time participant list, current file, agent status, and follow mode controls.
- **Relay server** — stateless WebSocket relay with Redis-backed session persistence, OT sequencing, Prometheus metrics, and structured logging.
- **Typed error UX** — actionable VS Code notifications for all error scenarios.
- **Opt-in telemetry** — anonymous usage statistics (off by default); see PRIVACY.md for details.

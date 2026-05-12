/**
 * OTEngine — client-side Jupiter-style (server-ordered) operational transform.
 *
 * One engine instance serves many documents; per-document state is kept in a
 * `Map<path, DocState>` and created lazily on first event for that path.
 *
 * Algorithm summary (Jupiter / server-ordered OT):
 *
 *   For each document we track:
 *     - `serverVersion`            : last server-acknowledged version.
 *     - `pending`                  : a single TextOp in flight to the server, or null.
 *     - `pendingBaseVersion`       : the server version `pending` was sent against.
 *     - `buffer`                   : composed ops produced locally AFTER `pending`
 *                                    was sent and BEFORE its ack. `NOOP` when empty.
 *     - `revLog`                   : recent acked ops, kept for catch-up
 *                                    transformation of remote ops the peer
 *                                    produced against an older `baseVersion`.
 *
 *   Local edit:
 *     - advance `doc.baseText` (the EditCapture-supplied op was built against the
 *       pre-edit snapshot; the engine is the canonical owner of base-text
 *       advancement),
 *     - if nothing in flight, send immediately as `pending`;
 *     - else compose into `buffer`.
 *
 *   Ack (correlated by `pendingBaseVersion`):
 *     - append `pending` to `revLog` and advance `serverVersion`;
 *     - if `buffer` is non-empty, promote it to `pending` and send;
 *     - else clear `pending`.
 *
 *   Remote op (server already assigned it `newServerVersion`):
 *     1. catch-up: if `baseVersion < serverVersion`, walk `revLog` for acked
 *        ops the peer did not see (`version > baseVersion && version <= serverVersion`)
 *        and transform the incoming op over them with `side='right'`;
 *     2. rebase against `pending` (incoming side='left', pending side='right');
 *     3. rebase against `buffer` (incoming side='left', buffer side='right');
 *     4. apply locally via the `applyRemote` callback;
 *     5. advance `doc.baseText` with the transformed op;
 *     6. advance `serverVersion`, push transformed op onto `revLog`.
 *
 * Convention for transform sides (matches `transformOp` TSDoc in
 * `@covibes/protocol/ot`): the server-ordered remote op is treated as having
 * occurred FIRST in the canonical order, our pending/buffer is treated as
 * having occurred SECOND. So:
 *   - rebasing the incoming op over our pending uses `side='left'` (incoming
 *     came first; incoming wins tie-breaks),
 *   - rebasing our pending over the incoming uses `side='right'` (pending
 *     came second; incoming wins tie-breaks).
 * The net effect is that the server-ordered op wins tie-breaks at the
 * client, which is what "server-ordered" means. The convergence property
 * test verifies this end-to-end.
 *
 * What this module does NOT do:
 *   - subscribe to VS Code events (EditCapture's job),
 *   - mutate the VS Code editor (Task 4.5 wires `applyRemote` to
 *     `workspace.applyEdit` and to `EditCapture.markApplyingRemote`),
 *   - touch the relay, sessions, timers, or retry logic.
 *
 * The wire format for the ack message is intentionally undefined here — Task
 * 4.4 owns the protocol design. The engine receives acks as a logical signal
 * via {@link OTEngine.onAck} and emits outbound ops via the `sendDelta`
 * callback.
 */

import {
  applyOp,
  composeOps,
  normalizeOp,
  NOOP,
  transformOp,
  type TextOp,
} from '@covibes/protocol/ot';

import type { SyncedDocument } from '../document.js';
import type { DocumentRepository } from '../repo.js';

/** Outbound + apply hooks. Implementations live in Task 4.5 wiring. */
export interface OTEngineCallbacks {
  /**
   * Send a `doc.delta` upstream. The relay client (Task 4.5) wires this to
   * `RelayClient.send`; tests use a spy.
   */
  sendDelta(path: string, baseVersion: number, op: TextOp): void;
  /**
   * Apply a server-validated remote op to the user's editor. The implementer
   * is responsible for calling `EditCapture.markApplyingRemote(doc.uri)`
   * before invoking `workspace.applyEdit` so the resulting change event is
   * not re-captured as a local edit. For unit tests this is typically a spy.
   */
  applyRemote(doc: SyncedDocument, op: TextOp): void;
}

/**
 * Optional listener for diagnostics. Defaults to a no-op. Currently invoked
 * only when an ack is dropped due to a base-version mismatch (a protocol
 * violation that should never happen over TCP/WebSocket, but is defended
 * against because silent loss would diverge clients).
 */
export interface OTEngineLogger {
  warn(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

export interface OTEngineOptions {
  /**
   * Maximum entries kept in the per-doc `revLog`. Default `100`. Older entries
   * are dropped when the cap is exceeded. A remote op whose `baseVersion` is
   * older than the oldest entry still in the log cannot be transformed via the
   * log — the engine throws because that situation indicates a sync-protocol
   * bug (Task 4.7 will introduce full-document resync to recover).
   */
  readonly revLogSize?: number;
  /** Optional diagnostics sink. */
  readonly logger?: OTEngineLogger;
}

/** Snapshot returned by `inspect()` for tests and debugging. */
export interface OTEngineDocSnapshot {
  readonly serverVersion: number;
  readonly pending: TextOp | null;
  readonly pendingBaseVersion: number | null;
  readonly bufferIsEmpty: boolean;
  readonly revLogSize: number;
}

interface DocState {
  serverVersion: number;
  pending: TextOp | null;
  pendingBaseVersion: number | null;
  buffer: TextOp;
  /** Acked ops; sorted by ascending `version`. Capped at `revLogSize`. */
  readonly revLog: { version: number; op: TextOp }[];
}

const DEFAULT_REV_LOG_SIZE = 100;

/**
 * Thrown when the engine is asked to transform a remote op whose `baseVersion`
 * predates the oldest entry in the local `revLog`. This is a sync-protocol
 * bug, not an edge case: the relay must guarantee that no client sees a
 * `baseVersion` it cannot reconcile from its own acked history. Recovery is a
 * full resync (Task 4.7) — until that exists, throwing is correct because
 * silently mis-transforming would diverge the clients.
 */
export class OTEngineGapError extends Error {
  constructor(detail: {
    path: string;
    baseVersion: number;
    serverVersion: number;
    revLogOldest: number | null;
    revLogSize: number;
  }) {
    super(
      `OT engine cannot catch up remote op for ${detail.path}: ` +
        `baseVersion=${detail.baseVersion}, ` +
        `serverVersion=${detail.serverVersion}, ` +
        `revLogOldest=${detail.revLogOldest ?? 'empty'}, ` +
        `revLogSize=${detail.revLogSize}`,
    );
    this.name = 'OTEngineGapError';
  }
}

export class OTEngine {
  private readonly repo: DocumentRepository;
  private readonly callbacks: OTEngineCallbacks;
  private readonly revLogSize: number;
  private readonly logger: OTEngineLogger;
  private readonly states = new Map<string, DocState>();

  constructor(
    repo: DocumentRepository,
    callbacks: OTEngineCallbacks,
    options: OTEngineOptions = {},
  ) {
    this.repo = repo;
    this.callbacks = callbacks;
    this.revLogSize = options.revLogSize ?? DEFAULT_REV_LOG_SIZE;
    this.logger = options.logger ?? { warn: () => {} };
  }

  /**
   * Process a local edit captured by `EditCapture`.
   *
   * Precondition: `op` is in canonical/normalized form and was built against
   * the document's CURRENT `baseText` (the pre-edit snapshot). We advance
   * `baseText` here so the next captured op will start from the post-edit
   * snapshot.
   *
   * Sends immediately if nothing is in flight; otherwise composes into the
   * buffer to await the in-flight op's ack.
   */
  onLocalEdit(path: string, op: TextOp): void {
    const doc = this.requireDoc(path);
    const state = this.getOrInitState(path);

    // Step 1: advance baseText FIRST so EditCapture's next event has the
    // correct snapshot. Doing this before any send/compose decouples
    // base-text mutation from network-state branching.
    doc.setBaseText(applyOp(doc.baseText, op));

    if (state.pending === null) {
      // Nothing in flight: send immediately.
      state.pending = op;
      state.pendingBaseVersion = state.serverVersion;
      // Mirror to SyncedDocument for debug/inspection. We use appendPending
      // so the data model reflects "one op awaiting ack".
      doc.appendPending(op);
      this.callbacks.sendDelta(path, state.serverVersion, op);
      return;
    }

    // Pending in flight: compose into buffer and wait.
    state.buffer = normalizeOp(composeOps(state.buffer, op));
  }

  /**
   * Handle the server's acknowledgement of our in-flight op.
   *
   * `ackedBaseVersion` is the value the server echoes back to correlate the
   * ack with the op we sent. If it does not match the version `pending` was
   * dispatched against, we treat the ack as bogus and drop it — TCP/WebSocket
   * delivers in-order, so this should never happen; doing nothing is safer
   * than mutating state on a malformed signal.
   *
   * On a valid ack: bump `serverVersion`, push the acked op onto `revLog`,
   * and promote the buffer (if any) to a new in-flight op.
   */
  onAck(path: string, ackedBaseVersion: number, newServerVersion: number): void {
    const state = this.states.get(path);
    if (state === undefined) {
      this.logger.warn('OT engine: ack for unknown path', { path });
      return;
    }
    if (state.pending === null || state.pendingBaseVersion !== ackedBaseVersion) {
      this.logger.warn('OT engine: ack does not correlate with pending', {
        path,
        ackedBaseVersion,
        pendingBaseVersion: state.pendingBaseVersion,
        hasPending: state.pending !== null,
      });
      return;
    }

    const doc = this.requireDoc(path);
    const acked = state.pending;

    // Record in revLog at the version assigned by the server. This is the
    // version a later peer's op might claim as its baseVersion if they were
    // behind, so future remote ops can be caught up by walking this log.
    this.pushRevLog(state, newServerVersion, acked);

    // Mirror to the SyncedDocument: clear pending (we had at most one) and
    // append to acked history.
    doc.clearPending();
    doc.appendAcked(acked);
    state.serverVersion = newServerVersion;
    doc.setVersion(newServerVersion);

    if (!isEmptyOp(state.buffer)) {
      // Drain the buffer as the next pending op, sent against the just-acked
      // version.
      const next = state.buffer;
      state.pending = next;
      state.pendingBaseVersion = newServerVersion;
      state.buffer = NOOP;
      doc.appendPending(next);
      this.callbacks.sendDelta(path, newServerVersion, next);
    } else {
      state.pending = null;
      state.pendingBaseVersion = null;
    }
  }

  /**
   * Handle a remote op that the server has already accepted at
   * `newServerVersion`. `baseVersion` is the version the originating peer
   * built the op against — if it predates `serverVersion`, the engine first
   * rebases the incoming op over the missing acked ops (catch-up via
   * revLog) before transforming against our own pending/buffer.
   *
   * Transform-side rules (see class TSDoc and `transformOp` semantics in
   * `@covibes/protocol/ot`): incoming op uses `side='left'` (came first in
   * canonical order, wins tie-breaks); our pending/buffer uses `side='right'`
   * (came second, yields tie-breaks).
   *
   * The pair-transform pattern requires consistent inputs: we capture each
   * "other" op into a local before mutating either side, to avoid clobbering.
   */
  onRemoteOp(path: string, baseVersion: number, op: TextOp, newServerVersion: number): void {
    const doc = this.requireDoc(path);
    const state = this.getOrInitState(path);

    let incoming = op;

    // Step 1: catch up over our acked-but-not-seen-by-peer history.
    if (baseVersion < state.serverVersion) {
      incoming = this.catchUp(path, state, baseVersion, incoming);
    } else if (baseVersion > state.serverVersion) {
      // The peer claims to have built against a version we have not yet
      // acked. The relay must guarantee monotonic delivery; if this happens
      // it is a protocol bug. Throwing rather than silently treating it as
      // baseVersion === serverVersion prevents undetected divergence.
      throw new OTEngineGapError({
        path,
        baseVersion,
        serverVersion: state.serverVersion,
        revLogOldest: state.revLog[0]?.version ?? null,
        revLogSize: state.revLog.length,
      });
    }

    // Step 2: rebase against our in-flight pending op. Capture the incoming
    // op into a temporary before mutating either side — TP1 requires that
    // both transforms see the SAME input pair.
    if (state.pending !== null) {
      const otherPending = state.pending;
      const incomingBefore = incoming;
      incoming = transformOp(incomingBefore, otherPending, 'left');
      state.pending = transformOp(otherPending, incomingBefore, 'right');
    }

    // Step 3: rebase against our local-only buffer.
    if (!isEmptyOp(state.buffer)) {
      const otherBuffer = state.buffer;
      const incomingBefore = incoming;
      incoming = transformOp(incomingBefore, otherBuffer, 'left');
      state.buffer = normalizeOp(transformOp(otherBuffer, incomingBefore, 'right'));
    }

    // Step 4: apply locally. The callback is responsible for calling
    // `EditCapture.markApplyingRemote` and then invoking `workspace.applyEdit`
    // (Task 4.5). Tests pass a spy.
    this.callbacks.applyRemote(doc, incoming);

    // Step 5: advance the engine's authoritative baseText. We do this here
    // (and not inside the callback) so the OT state is self-consistent
    // regardless of what the editor-side mutation does. Task 4.5's apply
    // path must agree with this — the EditCapture invariant check will fail
    // loudly if it ever drifts.
    doc.setBaseText(applyOp(doc.baseText, incoming));

    // Step 6: book-keeping.
    state.serverVersion = newServerVersion;
    doc.setVersion(newServerVersion);
    this.pushRevLog(state, newServerVersion, incoming);
  }

  /**
   * Snapshot of per-document state for tests / debugging. Returns
   * `undefined` if no state exists for `path` yet. The returned object is a
   * fresh copy — mutating it does not affect engine state.
   */
  inspect(path: string): OTEngineDocSnapshot | undefined {
    const state = this.states.get(path);
    if (state === undefined) return undefined;
    return {
      serverVersion: state.serverVersion,
      pending: state.pending === null ? null : [...state.pending],
      pendingBaseVersion: state.pendingBaseVersion,
      bufferIsEmpty: isEmptyOp(state.buffer),
      revLogSize: state.revLog.length,
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private requireDoc(path: string): SyncedDocument {
    const doc = this.repo.get(path);
    if (doc === undefined) {
      throw new Error(`OT engine: no SyncedDocument registered for path '${path}'`);
    }
    return doc;
  }

  private getOrInitState(path: string): DocState {
    let s = this.states.get(path);
    if (s === undefined) {
      s = {
        serverVersion: 0,
        pending: null,
        pendingBaseVersion: null,
        buffer: NOOP,
        revLog: [],
      };
      this.states.set(path, s);
    }
    return s;
  }

  /**
   * Transform `incoming` over every revLog entry with `version > baseVersion
   * && version <= serverVersion`. Entries are in ascending order so we walk
   * the array directly.
   *
   * Throws `OTEngineGapError` if some of the required entries fell off the
   * end of the capped log.
   */
  private catchUp(path: string, state: DocState, baseVersion: number, incoming: TextOp): TextOp {
    // The oldest version we would need is `baseVersion + 1`. If the log's
    // first entry is newer than that, we cannot reconcile and must signal.
    const oldest = state.revLog[0]?.version ?? null;
    if (oldest === null || oldest > baseVersion + 1) {
      throw new OTEngineGapError({
        path,
        baseVersion,
        serverVersion: state.serverVersion,
        revLogOldest: oldest,
        revLogSize: state.revLog.length,
      });
    }
    let out = incoming;
    for (const entry of state.revLog) {
      if (entry.version <= baseVersion) continue;
      if (entry.version > state.serverVersion) break;
      // The acked op came first in server order (lower version); the
      // incoming op (in the canonical re-ordering the server applies) comes
      // after. So the incoming op uses side='right' meaning it is the
      // second op and yields tie-breaks to the acked op.
      out = transformOp(out, entry.op, 'right');
    }
    return out;
  }

  private pushRevLog(state: DocState, version: number, op: TextOp): void {
    state.revLog.push({ version, op });
    // Capped log; drop oldest. The cap is documented above on `OTEngineOptions`.
    while (state.revLog.length > this.revLogSize) {
      state.revLog.shift();
    }
  }
}

/**
 * Treat the empty array as the canonical NOOP. `normalizeOp` returns `[]` for
 * any composed/transformed sequence that produces no net change, so checking
 * `length === 0` is the right empty-check.
 */
function isEmptyOp(op: TextOp): boolean {
  return op.length === 0;
}

import { transformOp, normalizeOp } from '@covibes/protocol';
import type { TextOp, DocDeltaPayload, MessageType, MessagePayload } from '@covibes/protocol';

export class SequencerGapError extends Error {
  constructor(sessionId: string, path: string, baseVersion: number, oldestKnown: number) {
    super(
      `Gap: baseVersion ${baseVersion} < oldest revLog entry ${oldestKnown} ` +
        `for session=${sessionId} path=${path}`,
    );
    this.name = 'SequencerGapError';
  }
}

const REV_LOG_MAX = 100;

interface RevEntry {
  op: TextOp;
  serverVersion: number;
}

interface DocState {
  serverVersion: number;
  revLog: RevEntry[];
}

export interface SequencerCallbacks {
  sendToSender<T extends MessageType>(type: T, payload: MessagePayload<T>): void;
  broadcastToPeers<T extends MessageType>(type: T, payload: MessagePayload<T>): void;
}

export class DocSequencer {
  // sessionId → (path → DocState)
  readonly #state: Map<string, Map<string, DocState>> = new Map();

  #getOrCreate(sessionId: string, path: string): DocState {
    let sessionMap = this.#state.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.#state.set(sessionId, sessionMap);
    }
    let docState = sessionMap.get(path);
    if (!docState) {
      docState = { serverVersion: 0, revLog: [] };
      sessionMap.set(path, docState);
    }
    return docState;
  }

  process(sessionId: string, payload: DocDeltaPayload, callbacks: SequencerCallbacks): void {
    const { path, baseVersion, op } = payload;
    const state = this.#getOrCreate(sessionId, path);

    // Find the oldest revLog entry to detect gaps.
    const oldest = state.revLog[0];
    if (oldest !== undefined && baseVersion < oldest.serverVersion - 1) {
      throw new SequencerGapError(sessionId, path, baseVersion, oldest.serverVersion);
    }

    // Collect concurrent ops: those accepted after the client's baseVersion.
    const concurrentEntries = state.revLog.filter((e) => e.serverVersion > baseVersion);

    // Normalize before transforming — ot-text-unicode requires canonical form.
    let transformedOp = normalizeOp(op as TextOp);
    for (const entry of concurrentEntries) {
      transformedOp = transformOp(transformedOp, entry.op, 'right');
    }

    const newServerVersion = state.serverVersion + 1;

    // Append to revLog and cap at REV_LOG_MAX.
    state.revLog.push({ op: transformedOp, serverVersion: newServerVersion });
    if (state.revLog.length > REV_LOG_MAX) {
      state.revLog.shift();
    }
    state.serverVersion = newServerVersion;

    // Ack the sender.
    callbacks.sendToSender('doc.ack', {
      path,
      baseVersion,
      serverVersion: newServerVersion,
    });

    // Broadcast transformed op to peers.
    callbacks.broadcastToPeers('doc.delta', {
      path,
      baseVersion: newServerVersion - 1,
      op: transformedOp,
      serverVersion: newServerVersion,
    });
  }

  disposeSession(sessionId: string): void {
    this.#state.delete(sessionId);
  }
}

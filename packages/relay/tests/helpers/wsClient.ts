import { WebSocket } from 'ws';
import {
  decode,
  encode,
  type AnyDecodedMessage,
  type MessageType,
  type MessagePayload,
} from '@covibes/protocol';

export interface RelayClient {
  send(raw: string): void;
  sendEnvelope<T extends MessageType>(
    type: T,
    payload: MessagePayload<T>,
    opts?: { id?: string; ts?: number },
  ): void;
  recv(
    predicate?: (msg: AnyDecodedMessage) => boolean,
    timeoutMs?: number,
  ): Promise<AnyDecodedMessage>;
  expectClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  expectNoMessage(durationMs: number): Promise<void>;
  close(): Promise<void>;
  readonly raw: WebSocket;
}

export interface ConnectClientOpts {
  baseUrl: string;
  sessionId: string;
  token: string;
  user: string;
  branch: string;
  color: string;
  participantId?: string;
}

export async function connectClient(opts: ConnectClientOpts): Promise<RelayClient> {
  const params = new URLSearchParams({
    session: opts.sessionId,
    token: opts.token,
    user: opts.user,
    branch: opts.branch,
    color: opts.color,
  });
  if (opts.participantId !== undefined) {
    params.set('participantId', opts.participantId);
  }
  const url = `${opts.baseUrl}?${params.toString()}`;

  const ws = new WebSocket(url);
  const received: AnyDecodedMessage[] = [];
  const messageListeners: Array<(msg: AnyDecodedMessage) => void> = [];

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
    let decoded: AnyDecodedMessage;
    try {
      decoded = decode(raw);
    } catch {
      // Ignore un-decodable messages in test helper
      return;
    }
    received.push(decoded);
    for (const listener of [...messageListeners]) {
      listener(decoded);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', (code) => reject(new Error(`WS closed before open, code=${String(code)}`)));
  });

  const client: RelayClient = {
    raw: ws,

    send(raw: string): void {
      ws.send(raw);
    },

    sendEnvelope<T extends MessageType>(
      type: T,
      payload: MessagePayload<T>,
      encodeOpts?: { id?: string; ts?: number },
    ): void {
      const wire = encode(type, payload, encodeOpts);
      ws.send(wire);
    },

    recv(
      predicate?: (msg: AnyDecodedMessage) => boolean,
      timeoutMs = 200,
    ): Promise<AnyDecodedMessage> {
      const pred = predicate ?? (() => true);

      // Check buffer first (messages already arrived before recv was called)
      const idx = received.findIndex(pred);
      if (idx !== -1) {
        const [msg] = received.splice(idx, 1);
        return Promise.resolve(msg!);
      }

      return new Promise<AnyDecodedMessage>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = (): void => {
          if (timer !== null) clearTimeout(timer);
          const pos = messageListeners.indexOf(onMsg);
          if (pos !== -1) messageListeners.splice(pos, 1);
        };

        const onMsg = (msg: AnyDecodedMessage): void => {
          if (pred(msg)) {
            // Remove from received buffer if it was pushed there
            const bi = received.indexOf(msg);
            if (bi !== -1) received.splice(bi, 1);
            cleanup();
            resolve(msg);
          }
        };

        messageListeners.push(onMsg);

        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`recv timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      });
    },

    expectClose(timeoutMs = 200): Promise<{ code: number; reason: string }> {
      return new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`expectClose timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);

        ws.once('close', (code, reasonBuf) => {
          clearTimeout(timer);
          const reason = Buffer.isBuffer(reasonBuf)
            ? reasonBuf.toString('utf8')
            : String(reasonBuf);
          resolve({ code, reason });
        });
      });
    },

    expectNoMessage(durationMs: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onMsg = (): void => {
          clearTimeout(timer);
          messageListeners.splice(messageListeners.indexOf(onMsg), 1);
          reject(new Error('Unexpected message received'));
        };
        messageListeners.push(onMsg);

        const timer = setTimeout(() => {
          const pos = messageListeners.indexOf(onMsg);
          if (pos !== -1) messageListeners.splice(pos, 1);
          resolve();
        }, durationMs);
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };

  return client;
}

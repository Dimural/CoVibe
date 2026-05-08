/**
 * RelayClient — typed WebSocket client for the CoVibes relay server.
 *
 * Connection URL format:
 *   ws[s]://<host>/ws?session=<sessionId>&token=<token>&participant=<participantId>
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  encode,
  decode,
  type AnyDecodedMessage,
  type MessageType,
  type MessagePayload,
} from '@covibes/protocol';
import { computeNextDelay, DEFAULT_RECONNECT_OPTIONS, type ReconnectOptions } from './reconnect.js';

// PayloadOf<T> is an alias for MessagePayload<T> for the public API
export type PayloadOf<T extends MessageType> = MessagePayload<T>;

// Close codes that indicate a terminal server-side rejection — do NOT reconnect.
const TERMINAL_CLOSE_CODES = new Set([
  4401, // Unauthorized
  4403, // Forbidden
  4426, // ProtocolMismatch
  4429, // SessionFull
]);

export interface RelayClientOptions {
  sessionId: string;
  participantId: string;
  displayName: string;
  token: string;
  /** Base URL, e.g. "wss://relay.example.com" */
  relayUrl: string;
  /** Branch name for session.join. Defaults to "main". */
  branch?: string;
  /** Color hex for session.join. Defaults to "#888888". */
  color?: string;
  /** Reconnect options. Defaults to DEFAULT_RECONNECT_OPTIONS. */
  reconnect?: Partial<ReconnectOptions>;
}

export type RelayClientEvents = {
  message: [msg: AnyDecodedMessage];
  close: [code: number, reason: string];
  reconnecting: [attempt: number, delayMs: number];
  connected: [];
  error: [err: Error];
};

/**
 * Typed WebSocket client that communicates with the CoVibes relay server.
 *
 * Usage:
 *   const client = new RelayClient({ ... });
 *   await client.connect();
 *   client.on('message', (msg) => { ... });
 *   await client.disconnect();
 */
export class RelayClient {
  private readonly opts: Required<Omit<RelayClientOptions, 'reconnect'>> & {
    reconnect: ReconnectOptions;
  };

  private ws: WebSocket | null = null;
  private _connected = false;
  private _disconnecting = false;

  /** Current reconnect attempt counter. Reset on successful connect. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly emitter = new EventEmitter();

  constructor(opts: RelayClientOptions) {
    this.opts = {
      sessionId: opts.sessionId,
      participantId: opts.participantId,
      displayName: opts.displayName,
      token: opts.token,
      relayUrl: opts.relayUrl,
      branch: opts.branch ?? 'main',
      color: opts.color ?? '#888888',
      reconnect: {
        ...DEFAULT_RECONNECT_OPTIONS,
        ...opts.reconnect,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Returns true when the WebSocket connection is open. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Opens the WebSocket connection and sends session.join.
   * Resolves once the socket is open and session.join has been sent.
   */
  connect(): Promise<void> {
    if (this._connected) {
      return Promise.resolve();
    }
    return this.openSocket();
  }

  /**
   * Sends a typed message to the relay server.
   * Throws if not connected.
   */
  send<T extends MessageType>(type: T, payload: PayloadOf<T>): void {
    if (!this._connected || this.ws === null) {
      throw new Error('RelayClient: not connected');
    }
    const wire = encode(type, payload);
    this.ws.send(wire);
  }

  /**
   * Gracefully disconnects: sends session.leave then closes the socket.
   */
  disconnect(): Promise<void> {
    this._disconnecting = true;
    this.cancelReconnect();

    return new Promise<void>((resolve) => {
      if (this.ws === null || !this._connected) {
        resolve();
        return;
      }

      // Send leave message before closing
      try {
        this.send('session.leave', { reason: 'shutdown' });
      } catch {
        // Ignore send errors during disconnect
      }

      const ws = this.ws;

      const onClose = (): void => {
        resolve();
      };

      ws.once('close', onClose);

      // Give it 2 seconds to close gracefully, then force close
      const timeout = setTimeout(() => {
        ws.off('close', onClose);
        ws.terminate();
        resolve();
      }, 2000);

      ws.close(1000, 'client disconnect');

      // Clear the timeout once closed
      ws.once('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Typed EventEmitter delegation
  // --------------------------------------------------------------------------

  on<E extends keyof RelayClientEvents>(
    event: E,
    listener: (...args: RelayClientEvents[E]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof RelayClientEvents>(
    event: E,
    listener: (...args: RelayClientEvents[E]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<E extends keyof RelayClientEvents>(
    event: E,
    listener: (...args: RelayClientEvents[E]) => void,
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // --------------------------------------------------------------------------
  // Internal: socket lifecycle
  // --------------------------------------------------------------------------

  private buildUrl(): string {
    const { relayUrl, sessionId, token, participantId } = this.opts;
    const base = relayUrl.replace(/\/$/, '');
    const params = new URLSearchParams({
      session: sessionId,
      token,
      participant: participantId,
    });
    return `${base}/ws?${params.toString()}`;
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpen = (): void => {
        this._connected = true;
        this.reconnectAttempt = 0;

        // Send session.join immediately after opening
        try {
          this.send('session.join', {
            sessionId: this.opts.sessionId,
            branch: this.opts.branch,
            displayName: this.opts.displayName,
            color: this.opts.color,
            participantId: this.opts.participantId,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit('error', error);
        }

        this.emit('connected');
        resolve();
      };

      const onError = (err: Error): void => {
        if (!this._connected) {
          // Connection-phase error — reject the connect() promise
          reject(err);
        } else {
          this.emit('error', err);
        }
      };

      const onClose = (code: number, reason: Buffer): void => {
        this._connected = false;
        this.ws = null;

        const reasonStr = reason.toString('utf-8');

        if (this._disconnecting) {
          // Intentional disconnect — emit close and stop
          this.emit('close', code, reasonStr);
          return;
        }

        if (TERMINAL_CLOSE_CODES.has(code)) {
          // Server rejected us — do not reconnect
          this.emit('close', code, reasonStr);
          return;
        }

        // Schedule a reconnect
        this.scheduleReconnect();
      };

      const onMessage = (data: WebSocket.RawData): void => {
        let raw: string;
        if (Buffer.isBuffer(data)) {
          raw = data.toString('utf-8');
        } else if (Array.isArray(data)) {
          raw = Buffer.concat(data).toString('utf-8');
        } else {
          // ArrayBuffer
          raw = Buffer.from(new Uint8Array(data)).toString('utf-8');
        }
        try {
          const msg = decode(raw);
          this.emit('message', msg);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit('error', error);
        }
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
      // ws automatically responds to server ping frames with pong — no manual handling needed
    });
  }

  private scheduleReconnect(): void {
    const { reconnect } = this.opts;

    // Check max attempts
    if (reconnect.maxAttempts !== undefined && this.reconnectAttempt >= reconnect.maxAttempts) {
      this.emit('close', 1006, 'max reconnect attempts exceeded');
      return;
    }

    const delayMs = computeNextDelay(this.reconnectAttempt, reconnect);
    this.emit('reconnecting', this.reconnectAttempt, delayMs);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Only reconnect if we haven't been asked to disconnect
      if (!this._disconnecting) {
        this.openSocket().catch((err: unknown) => {
          // openSocket failure triggers onError which will re-schedule via onClose
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit('error', error);
          // scheduleReconnect will be called from onClose
        });
      }
    }, delayMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internal: typed emit
  // --------------------------------------------------------------------------

  private emit<E extends keyof RelayClientEvents>(event: E, ...args: RelayClientEvents[E]): void {
    this.emitter.emit(event, ...args);
  }
}

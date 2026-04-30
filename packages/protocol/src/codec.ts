/**
 * High-level encode/decode helpers for CoVibes protocol messages.
 * These are the primary entry points — prefer them over raw JSON.
 */
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './version.js';
import { parseEnvelope, ProtocolError, type Envelope } from './envelope.js';
import { MessageMap, type MessagePayload, type MessageType } from './messages/index.js';

/** Options for {@link encode}. */
export interface EncodeOptions {
  /** Custom message id (UUID). Generated via `crypto.randomUUID()` if omitted. */
  id?: string;
  /** Override the `ts` field (Unix ms). Defaults to `Date.now()`. */
  ts?: number;
}

/**
 * Encodes a typed message payload into a wire-ready JSON string.
 *
 * Validates `payload` against `MessageMap[type]` before serialising so encoding
 * bugs are caught early rather than emitting malformed data on the wire.
 *
 * @throws {@link ProtocolError} with code `'invalid-payload'` if `payload` is invalid.
 */
export function encode<T extends MessageType>(
  type: T,
  payload: MessagePayload<T>,
  opts?: EncodeOptions,
): string {
  const schema = MessageMap[type];
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ProtocolError('invalid-payload', `Invalid payload for type '${type}'`, result.error);
  }

  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: opts?.id ?? randomUUID(),
    ts: opts?.ts ?? Date.now(),
    type,
    payload: result.data,
  };

  return JSON.stringify(envelope);
}

/** The fully-decoded and type-narrowed result of {@link decode}. */
export interface DecodedMessage<T extends MessageType> {
  type: T;
  payload: MessagePayload<T>;
  envelope: Envelope;
}

/**
 * Decodes a raw JSON string into a typed, validated message.
 *
 * Steps:
 * 1. Parses and validates the outer envelope via {@link parseEnvelope}.
 * 2. Looks up the type in {@link MessageMap} — unknown types throw `'unknown-type'`.
 * 3. Validates `envelope.payload` against the type's schema — bad payloads throw `'invalid-payload'`.
 *
 * @throws {@link ProtocolError} with code `'invalid-json' | 'invalid-envelope' | 'version-mismatch' | 'unknown-type' | 'invalid-payload'`.
 */
export function decode(input: string): DecodedMessage<MessageType> {
  const envelope = parseEnvelope(input);
  const type = envelope.type;

  if (!(type in MessageMap)) {
    throw new ProtocolError('unknown-type', `Unknown message type: '${type}'`);
  }

  const knownType = type as MessageType;
  const schema = MessageMap[knownType];
  const result = schema.safeParse(envelope.payload);

  if (!result.success) {
    throw new ProtocolError(
      'invalid-payload',
      `Invalid payload for type '${knownType}'`,
      result.error,
    );
  }

  return {
    type: knownType,
    payload: result.data,
    envelope,
  };
}

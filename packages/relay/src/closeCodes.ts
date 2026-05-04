/**
 * Application-level WebSocket close codes (4000-4999 reserved for app use per RFC 6455).
 * Values must remain stable; clients depend on them.
 */
export const CloseCodes = {
  /** Missing or malformed query params or message. */
  InvalidInput: 4400,
  /** Wrong token for sessionId — presented credential does not match stored bearer secret. */
  Unauthorized: 4401,
  /** Reserved for future use. */
  Forbidden: 4403,
  /** Missed too many pongs — connection considered dead. */
  PingTimeout: 4408,
  /** Send buffer exceeded backpressure threshold, or incoming message too large. */
  MessageTooLarge: 4413,
  /** Reserved for protocol-version negotiation. */
  ProtocolMismatch: 4426,
  /** Session capacity exceeded. */
  SessionFull: 4429,
  /** Server-side bug. */
  InternalError: 4500,
} as const;

export type CloseCode = (typeof CloseCodes)[keyof typeof CloseCodes];

/**
 * Wire protocol version. Increment on any breaking change to the message
 * envelope, message types, or session join/state semantics. Clients MUST
 * reject envelopes whose `v` does not equal this constant.
 */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

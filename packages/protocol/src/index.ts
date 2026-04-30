export { PROTOCOL_VERSION, type ProtocolVersion } from './version.js';
export {
  EnvelopeSchema,
  ProtocolError,
  parseEnvelope,
  type Envelope,
  type ProtocolErrorCode,
} from './envelope.js';
export { encode, decode, type EncodeOptions, type DecodedMessage } from './codec.js';
export * from './messages/index.js';

/**
 * Wire envelope shared by every CoVibes protocol message.
 * Every message crossing the network MUST be validated against this schema on receipt.
 */
import { z, type ZodError } from 'zod';
import { PROTOCOL_VERSION } from './version.js';

/**
 * Zod schema for the outer message envelope. Payload shape is validated separately in `decode()`.
 *
 * `from` is an optional field populated **by the relay only** on messages forwarded between
 * participants. It carries the sender's `participantId`. Clients MUST ignore `from` on inbound
 * messages they receive, and MUST NOT set it on outgoing messages (the relay strips and
 * overwrites any client-supplied value with the authoritative participantId).
 */
export const EnvelopeSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().uuid(),
    ts: z.number().int().nonnegative(),
    type: z.string(),
    payload: z.unknown(),
    /** Set by the relay before forwarding. 64 chars accommodates UUIDs (36), base64url-22, or any reasonably short participant ID format. */
    from: z.string().min(1).max(64).optional(),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Discriminating codes for {@link ProtocolError}. */
export type ProtocolErrorCode =
  | 'invalid-json'
  | 'invalid-envelope'
  | 'version-mismatch'
  | 'unknown-type'
  | 'invalid-payload';

/**
 * Thrown whenever parsing or validation of a wire message fails.
 * Callers should inspect `code` to decide whether to reconnect or just log.
 */
export class ProtocolError extends Error {
  /** Discriminator indicating the category of failure. */
  readonly code: ProtocolErrorCode;
  /** Original parse error, if available. */
  override readonly cause: ZodError | SyntaxError | undefined;

  constructor(code: ProtocolErrorCode, message: string, cause?: ZodError | SyntaxError) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Parses a raw JSON string into a validated {@link Envelope}.
 *
 * Only validates the envelope shape — payload contents are opaque here.
 * Callers must further validate the payload using `decode()` from `codec.ts`.
 *
 * Throws {@link ProtocolError} in these cases:
 * - `'invalid-json'`    — input is not valid JSON
 * - `'version-mismatch'` — `v` field is present but does not equal {@link PROTOCOL_VERSION}
 * - `'invalid-envelope'` — any other schema violation (missing fields, bad id format, etc.)
 *
 * Note: `'version-mismatch'` is only thrown when `v` is present but wrong.
 * A missing `v` field is treated as `'invalid-envelope'`.
 */
export function parseEnvelope(input: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    throw new ProtocolError('invalid-json', 'Failed to parse JSON', err as SyntaxError);
  }

  // Pre-check: if `v` is present but wrong, give a clearer error code.
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'v' in raw &&
    (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
  ) {
    throw new ProtocolError(
      'version-mismatch',
      `Unsupported protocol version: expected ${String(PROTOCOL_VERSION)}, got ${String((raw as Record<string, unknown>)['v'])}`,
    );
  }

  const result = EnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new ProtocolError('invalid-envelope', 'Envelope validation failed', result.error);
  }

  return result.data;
}

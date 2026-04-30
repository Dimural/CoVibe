/**
 * `error` — server → client.
 * Signals a protocol-level or application-level error to the client.
 * `recoverable` indicates whether the client may continue without reconnecting.
 */
import { z } from 'zod';

export const ErrorPayload = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2000),
    recoverable: z.boolean(),
  })
  .strict();
export type ErrorPayload = z.infer<typeof ErrorPayload>;

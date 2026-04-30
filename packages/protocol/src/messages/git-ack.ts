/**
 * `git.ack` — bidirectional (relayed).
 * Acknowledges a `git.operation` request, indicating success or failure.
 */
import { z } from 'zod';

export const GitAckPayload = z
  .object({
    operationId: z.string().uuid(),
    accepted: z.boolean(),
    reason: z.string().max(280).optional(),
  })
  .strict();
export type GitAckPayload = z.infer<typeof GitAckPayload>;

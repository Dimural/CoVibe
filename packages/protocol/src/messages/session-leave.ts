/**
 * `session.leave` — client → server.
 * Sent when a participant voluntarily or involuntarily exits the session.
 */
import { z } from 'zod';

export const SessionLeavePayload = z
  .object({
    reason: z.enum(['user', 'branch-switch', 'shutdown']),
  })
  .strict();
export type SessionLeavePayload = z.infer<typeof SessionLeavePayload>;

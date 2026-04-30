/**
 * `pong` — client → server.
 * Heartbeat response to a `ping`. Resets the server-side keepalive timer.
 */
import { z } from 'zod';

export const PongPayload = z.object({}).strict();
export type PongPayload = z.infer<typeof PongPayload>;

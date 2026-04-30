/**
 * `ping` — server → client.
 * Heartbeat probe. Clients must respond with a `pong` within the keepalive window.
 */
import { z } from 'zod';

export const PingPayload = z.object({}).strict();
export type PingPayload = z.infer<typeof PingPayload>;

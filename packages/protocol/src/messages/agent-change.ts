/**
 * `agent.change` — bidirectional (relayed).
 * Reports the outcome of an agent-applied change and whether it merged cleanly.
 */
import { z } from 'zod';
import { RelPath } from './_common.js';

export const AgentChangePayload = z
  .object({
    path: RelPath,
    mergeKind: z.enum(['auto', 'conflict', 'none']),
  })
  .strict();
export type AgentChangePayload = z.infer<typeof AgentChangePayload>;

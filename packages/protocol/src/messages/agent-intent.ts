/**
 * `agent.intent` — bidirectional (relayed).
 * Signals that an agent is about to make changes to a file.
 * Displayed to human participants as a heads-up before the change arrives.
 */
import { z } from 'zod';
import { RelPath } from './_common.js';

export const AgentIntentPayload = z
  .object({
    path: RelPath,
    description: z.string().min(1).max(280),
  })
  .strict();
export type AgentIntentPayload = z.infer<typeof AgentIntentPayload>;

/**
 * `conflict.resolve` — bidirectional (relayed).
 * Carries the mutually agreed resolution text for an open conflict.
 */
import { z } from 'zod';
import { ParticipantId } from './_common.js';

export const ConflictResolvePayload = z
  .object({
    conflictId: z.string().uuid(),
    resolvedText: z.string(),
    confirmedBy: z.array(ParticipantId),
  })
  .strict();
export type ConflictResolvePayload = z.infer<typeof ConflictResolvePayload>;

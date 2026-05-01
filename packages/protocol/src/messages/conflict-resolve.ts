/**
 * `conflict.resolve` — bidirectional (relayed).
 * Carries the mutually agreed resolution text for an open conflict.
 */
import { z } from 'zod';
import { ParticipantId } from './_common.js';

export const ConflictResolvePayload = z
  .object({
    conflictId: z.string().uuid(),
    /** Capped at 1 MiB; transport layer also enforces a hard size limit. */
    resolvedText: z.string().max(1_048_576),
    confirmedBy: z.array(ParticipantId),
  })
  .strict();
export type ConflictResolvePayload = z.infer<typeof ConflictResolvePayload>;

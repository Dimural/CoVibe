/**
 * `conflict.open` — server → clients.
 * Notifies all relevant participants that a merge conflict requires resolution.
 */
import { z } from 'zod';
import { ParticipantId, RelPath } from './_common.js';

export const ConflictOpenPayload = z
  .object({
    path: RelPath,
    conflictId: z.string().uuid(),
    peers: z.array(ParticipantId),
    /** Capped at 1 MiB; transport layer also enforces a hard size limit. */
    leftText: z.string().max(1_048_576),
    /** Capped at 1 MiB; transport layer also enforces a hard size limit. */
    rightText: z.string().max(1_048_576),
    /** Capped at 1 MiB; transport layer also enforces a hard size limit. */
    baseText: z.string().max(1_048_576),
  })
  .strict();
export type ConflictOpenPayload = z.infer<typeof ConflictOpenPayload>;

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
    leftText: z.string(),
    rightText: z.string(),
    baseText: z.string(),
  })
  .strict();
export type ConflictOpenPayload = z.infer<typeof ConflictOpenPayload>;

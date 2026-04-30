/**
 * `session.state` — server → client.
 * Full snapshot of session state sent on join or when membership changes.
 */
import { z } from 'zod';
import { ColorHex, DisplayName, ParticipantId, RelPath, SessionId } from './_common.js';

const ParticipantEntry = z
  .object({
    id: ParticipantId,
    displayName: DisplayName,
    color: ColorHex,
    currentFile: RelPath.nullable(),
    agentActiveOn: RelPath.nullable(),
  })
  .strict();

export const SessionStatePayload = z
  .object({
    sessionId: SessionId,
    branch: z.string().min(1).max(255),
    you: ParticipantId,
    participants: z.array(ParticipantEntry),
  })
  .strict();
export type SessionStatePayload = z.infer<typeof SessionStatePayload>;

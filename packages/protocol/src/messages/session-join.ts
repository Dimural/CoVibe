/**
 * `session.join` — client → server.
 * Sent when a participant wants to enter a collaboration session.
 * `participantId` may be supplied to resume a previous session within the grace period.
 */
import { z } from 'zod';
import { ColorHex, DisplayName, ParticipantId, SessionId } from './_common.js';

export const SessionJoinPayload = z
  .object({
    sessionId: SessionId,
    branch: z.string().min(1).max(255),
    displayName: DisplayName,
    color: ColorHex,
    participantId: ParticipantId.optional(),
  })
  .strict();
export type SessionJoinPayload = z.infer<typeof SessionJoinPayload>;

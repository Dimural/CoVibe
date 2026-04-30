/**
 * `cursor.update` — bidirectional (relayed).
 * Broadcasts a participant's cursor selection within a file.
 * Offsets are Unicode codepoint indices, not UTF-16 code units.
 */
import { z } from 'zod';
import { CodepointOffset, RelPath } from './_common.js';

export const CursorUpdatePayload = z
  .object({
    path: RelPath,
    anchor: CodepointOffset,
    head: CodepointOffset,
  })
  .strict();
export type CursorUpdatePayload = z.infer<typeof CursorUpdatePayload>;

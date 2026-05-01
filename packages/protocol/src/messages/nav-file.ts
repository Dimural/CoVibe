/**
 * `nav.file` — bidirectional (relayed).
 * Broadcast when the active editor changes. `null` indicates no file is open.
 */
import { z } from 'zod';
import { RelPath } from './_common.js';

export const NavFilePayload = z
  .object({
    path: RelPath.nullable(),
  })
  .strict();
export type NavFilePayload = z.infer<typeof NavFilePayload>;

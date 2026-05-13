/**
 * `doc.delta` — bidirectional (relayed).
 * Carries an OT operation against a known base version of a document.
 * The `op` field is intentionally typed as `unknown` — the OT engine (Task 1.4) owns its shape.
 * The `serverVersion` field is absent on client sends; the server injects it when broadcasting.
 */
import { z } from 'zod';
import { DocVersion, RelPath } from './_common.js';

export const DocDeltaPayload = z
  .object({
    path: RelPath,
    baseVersion: DocVersion,
    op: z.unknown(),
    serverVersion: DocVersion.optional(),
  })
  .strict();
export type DocDeltaPayload = z.infer<typeof DocDeltaPayload>;

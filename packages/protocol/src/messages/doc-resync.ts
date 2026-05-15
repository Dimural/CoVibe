import { z } from 'zod';
import { RelPath } from './_common.js';

export const DocResyncPayload = z.object({
  path: RelPath,
});
export type DocResyncPayload = z.infer<typeof DocResyncPayload>;

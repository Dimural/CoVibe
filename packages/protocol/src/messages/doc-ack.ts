import { z } from 'zod';
import { DocVersion, RelPath } from './_common.js';

export const DocAckPayload = z
  .object({
    path: RelPath,
    baseVersion: DocVersion,
    serverVersion: DocVersion,
  })
  .strict();
export type DocAckPayload = z.infer<typeof DocAckPayload>;

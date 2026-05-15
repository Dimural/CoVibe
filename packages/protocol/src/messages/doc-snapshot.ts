import { z } from 'zod';
import { RelPath, DocVersion } from './_common.js';

export const DocSnapshotPayload = z.object({
  path: RelPath,
  serverVersion: DocVersion,
  text: z.string(),
});
export type DocSnapshotPayload = z.infer<typeof DocSnapshotPayload>;

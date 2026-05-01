/**
 * `git.operation` — bidirectional (relayed).
 * Requests a git action on the shared repository.
 * Discriminated by `kind` so callers can switch on the variant.
 */
import { z } from 'zod';

const CommitOp = z
  .object({ kind: z.literal('commit'), message: z.string().min(1).max(2000) })
  .strict();
const PushOp = z.object({ kind: z.literal('push') }).strict();
const PullStagedOp = z.object({ kind: z.literal('pull-staged') }).strict();

export const GitOperationPayload = z.discriminatedUnion('kind', [CommitOp, PushOp, PullStagedOp]);
export type GitOperationPayload = z.infer<typeof GitOperationPayload>;

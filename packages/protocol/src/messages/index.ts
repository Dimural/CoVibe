/**
 * Central registry mapping every wire message type string to its Zod payload schema.
 * Import `MessageMap` to look up a schema by type, or use `encode`/`decode` from `codec.ts`.
 */
import { type z } from 'zod';

// Private imports aliased to avoid duplicate identifier conflicts with re-exports below.
import { SessionJoinPayload as _SessionJoin } from './session-join.js';
import { SessionLeavePayload as _SessionLeave } from './session-leave.js';
import { SessionStatePayload as _SessionState } from './session-state.js';
import { DocDeltaPayload as _DocDelta } from './doc-delta.js';
import { CursorUpdatePayload as _CursorUpdate } from './cursor-update.js';
import { AgentIntentPayload as _AgentIntent } from './agent-intent.js';
import { AgentChangePayload as _AgentChange } from './agent-change.js';
import { ConflictOpenPayload as _ConflictOpen } from './conflict-open.js';
import { ConflictResolvePayload as _ConflictResolve } from './conflict-resolve.js';
import { GitOperationPayload as _GitOperation } from './git-operation.js';
import { GitAckPayload as _GitAck } from './git-ack.js';
import { NavFilePayload as _NavFile } from './nav-file.js';
import { ErrorPayload as _Error } from './error.js';
import { PingPayload as _Ping } from './ping.js';
import { PongPayload as _Pong } from './pong.js';

/**
 * Re-export each payload schema (value) and its inferred TypeScript type (type).
 * A single `export { X }` from a module makes both the value and type available to consumers;
 * a separate `export type { X }` for the same name would cause a duplicate-identifier error.
 */
export { SessionJoinPayload } from './session-join.js';
export { SessionLeavePayload } from './session-leave.js';
export { SessionStatePayload } from './session-state.js';
export { DocDeltaPayload } from './doc-delta.js';
export { CursorUpdatePayload } from './cursor-update.js';
export { AgentIntentPayload } from './agent-intent.js';
export { AgentChangePayload } from './agent-change.js';
export { ConflictOpenPayload } from './conflict-open.js';
export { ConflictResolvePayload } from './conflict-resolve.js';
export { GitOperationPayload } from './git-operation.js';
export { GitAckPayload } from './git-ack.js';
export { NavFilePayload } from './nav-file.js';
export { ErrorPayload } from './error.js';
export { PingPayload } from './ping.js';
export { PongPayload } from './pong.js';

// Re-export the payload types separately so they can be imported with `import type`.
export type { SessionJoinPayload as SessionJoinPayloadType } from './session-join.js';
export type { SessionLeavePayload as SessionLeavePayloadType } from './session-leave.js';
export type { SessionStatePayload as SessionStatePayloadType } from './session-state.js';
export type { DocDeltaPayload as DocDeltaPayloadType } from './doc-delta.js';
export type { CursorUpdatePayload as CursorUpdatePayloadType } from './cursor-update.js';
export type { AgentIntentPayload as AgentIntentPayloadType } from './agent-intent.js';
export type { AgentChangePayload as AgentChangePayloadType } from './agent-change.js';
export type { ConflictOpenPayload as ConflictOpenPayloadType } from './conflict-open.js';
export type { ConflictResolvePayload as ConflictResolvePayloadType } from './conflict-resolve.js';
export type { GitOperationPayload as GitOperationPayloadType } from './git-operation.js';
export type { GitAckPayload as GitAckPayloadType } from './git-ack.js';
export type { NavFilePayload as NavFilePayloadType } from './nav-file.js';
export type { ErrorPayload as ErrorPayloadType } from './error.js';
export type { PingPayload as PingPayloadType } from './ping.js';
export type { PongPayload as PongPayloadType } from './pong.js';

/** Maps every known wire message type string to its payload Zod schema. */
export const MessageMap = {
  'session.join': _SessionJoin,
  'session.leave': _SessionLeave,
  'session.state': _SessionState,
  'doc.delta': _DocDelta,
  'cursor.update': _CursorUpdate,
  'agent.intent': _AgentIntent,
  'agent.change': _AgentChange,
  'conflict.open': _ConflictOpen,
  'conflict.resolve': _ConflictResolve,
  'git.operation': _GitOperation,
  'git.ack': _GitAck,
  'nav.file': _NavFile,
  error: _Error,
  ping: _Ping,
  pong: _Pong,
} as const satisfies Record<string, z.ZodTypeAny>;

/** All known wire message type strings. */
export type MessageType = keyof typeof MessageMap;

/** The validated payload type for a given message type. */
export type MessagePayload<T extends MessageType> = z.infer<(typeof MessageMap)[T]>;

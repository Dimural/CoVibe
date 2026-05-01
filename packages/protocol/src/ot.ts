/**
 * Thin, well-typed wrappers around `ot-text-unicode` OT primitives.
 *
 * `ot-text-unicode` operates in **Unicode codepoints**, not UTF-16 code units,
 * which is essential for correctness with emoji and other supplementary
 * characters. All position values in ops are codepoint offsets.
 *
 * @see https://github.com/ottypes/text
 */

import { type as otType, type TextOp, type TextOpComponent } from 'ot-text-unicode';

// Re-export the TextOp and TextOpComponent types so consumers can reference
// them without importing ot-text-unicode directly.
export type { TextOp, TextOpComponent };

/**
 * Apply an op to a string snapshot, returning the new string.
 *
 * All positions in `op` are Unicode codepoint offsets, not UTF-16 code units.
 */
export const applyOp: (snapshot: string, op: TextOp) => string = otType.apply.bind(otType);

/**
 * Compose two sequential ops into one equivalent op.
 *
 * `op1` is applied first, then `op2`. The resulting composed op is equivalent
 * to applying them in sequence:
 * `apply(apply(s, op1), op2) === apply(s, composeOps(op1, op2))`
 */
export const composeOps: (op1: TextOp, op2: TextOp) => TextOp = otType.compose.bind(otType);

/**
 * Transform `op` against the concurrent `otherOp`.
 *
 * Tie-breaking semantics:
 * - `side='left'`: `op` is treated as having occurred FIRST (this op wins tie-breaks).
 * - `side='right'`: `op` is treated as having occurred SECOND (`otherOp` wins tie-breaks).
 *
 * For server-ordered (Jupiter-style) OT: the **client** transforms its pending
 * op against the acknowledged server op using `side='right'` (server wins
 * tie-breaks); the **server** transforms its op against pending client ops
 * using `side='left'` (server confirms priority).
 *
 * TP1 guarantee: given two concurrent ops `a` and `b` applied to the same
 * snapshot `s`:
 * ```
 * apply(apply(s, a), transform(b, a, 'right')) ===
 * apply(apply(s, b), transform(a, b, 'left'))
 * ```
 */
export const transformOp: (op: TextOp, otherOp: TextOp, side: 'left' | 'right') => TextOp =
  otType.transform.bind(otType);

/**
 * Transform a cursor position through an op.
 *
 * Returns the new codepoint position that `pos` maps to after `op` is applied.
 * Note: the underlying `ot-text-unicode` `transformPosition` does not accept
 * a side parameter — it always positions the cursor before any insertion at the
 * same position.
 */
export const transformPosition: (pos: number, op: TextOp) => number =
  otType.transformPosition.bind(otType);

/** Identity op (frozen array — safe to share) — a no-op that leaves any snapshot unchanged. */
export const NOOP: TextOp = Object.freeze([]) as unknown as TextOp;

/**
 * Normalize an op into canonical form by merging adjacent components of the
 * same kind (adjacent skip integers, adjacent insert strings, adjacent
 * deletions) and removing trailing skips.
 *
 * `ot-text-unicode` requires canonical ops; use this to sanitize ops before
 * passing them to `applyOp`, `composeOps`, or `transformOp`.
 */
export const normalizeOp: (op: TextOp) => TextOp = otType.normalize.bind(otType);

/** Re-exports under the original `ot-text-unicode` method names. */
export { applyOp as apply, composeOps as compose, transformOp as transform };

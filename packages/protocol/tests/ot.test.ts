/**
 * Tests for OT primitives (`src/ot.ts`).
 *
 * Coverage:
 *  - Fixture tests for applyOp, composeOps, transformOp, transformPosition
 *  - Codepoint correctness (emoji / surrogate-pair safety)
 *  - Property 1 (TP1): OT convergence — two clients applying concurrent ops
 *    must arrive at the same state after cross-transformation.
 *  - Property 2: compose correctness — apply(apply(s, a), b) === apply(s, compose(a, b))
 *  - Property 3: transformPosition consistency — cursor is shifted correctly
 *    after an insertion or deletion op.
 *
 * NOTE on trailing skips: `ot-text-unicode` rejects ops that end with a skip
 * component (it throws "Op has a trailing skip"). Trailing codepoints are
 * implied; never append a trailing number to an op.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  applyOp,
  composeOps,
  transformOp,
  transformPosition,
  normalizeOp,
  NOOP,
  type TextOp,
} from '../src/ot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count Unicode codepoints in a string (not UTF-16 code units).
 * Uses the iterator protocol which correctly handles surrogates.
 */
function codepointLength(s: string): number {
  return [...s].length;
}

/**
 * Generate an arbitrary TextOp that is valid against a given snapshot string.
 *
 * The op is built as a sequence of chunks advancing through the codepoints of
 * `snapshot`. Each chunk randomly performs one of:
 *   - skip N codepoints (number component)
 *   - insert a random string at the current position (string component)
 *   - delete N codepoints (deletion object component)
 *
 * Trailing skip components are omitted because `ot-text-unicode` rejects ops
 * that end with a skip — remaining codepoints are implicitly skipped.
 */
function arbValidOpAgainst(snapshot: string): fc.Arbitrary<TextOp> {
  const len = codepointLength(snapshot);

  return fc
    .array(
      fc.record({
        action: fc.constantFrom('skip', 'insert', 'delete' as const),
        count: fc.integer({ min: 1, max: Math.max(1, len) }),
        insertText: fc.string({ maxLength: 10 }),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((chunks) => {
      const op: TextOp = [];
      let pos = 0; // current codepoint position in snapshot

      for (const chunk of chunks) {
        const remaining = len - pos;

        switch (chunk.action) {
          case 'skip': {
            const n = Math.min(chunk.count, remaining);
            if (n > 0) {
              op.push(n);
              pos += n;
            }
            break;
          }
          case 'insert': {
            if (chunk.insertText.length > 0) {
              op.push(chunk.insertText);
            }
            break;
          }
          case 'delete': {
            const n = Math.min(chunk.count, remaining);
            if (n > 0) {
              op.push({ d: n });
              pos += n;
            }
            break;
          }
        }

        if (pos >= len) break;
      }

      // Remove any trailing skip from the end — ot-text-unicode rejects ops
      // that end with a numeric skip component.
      while (op.length > 0 && typeof op[op.length - 1] === 'number') {
        op.pop();
      }

      // Normalize to canonical form: merge adjacent same-kind components
      // (adjacent skips, adjacent inserts, adjacent deletes). ot-text-unicode
      // rejects non-canonical ops with errors like "Adjacent skip components
      // should be combined".
      return op.length > 0 ? normalizeOp(op) : op;
    })
    .filter((op) => op.length > 0);
}

// ---------------------------------------------------------------------------
// Fixture tests
// ---------------------------------------------------------------------------

describe('applyOp', () => {
  it('applies an insertion at the end', () => {
    // No trailing skip needed — remaining chars are implied.
    expect(applyOp('hello', [5, ' world'])).toBe('hello world');
  });

  it('applies an insertion at the start', () => {
    expect(applyOp('world', ['hello '])).toBe('hello world');
  });

  it('applies an insertion in the middle', () => {
    // "helloworld" (10 codepoints) — insert space at position 5.
    // Trailing skip for the remaining 5 codepoints is omitted (implied).
    expect(applyOp('helloworld', [5, ' '])).toBe('hello world');
  });

  it('applies a deletion at the end', () => {
    expect(applyOp('hello world', [5, { d: 6 }])).toBe('hello');
  });

  it('applies a deletion at the start', () => {
    // Trailing skip is implied — do not append the count for remaining chars.
    expect(applyOp('hello world', [{ d: 6 }])).toBe('world');
  });

  it('applies a no-op (NOOP) without changing the snapshot', () => {
    expect(applyOp('hello', NOOP)).toBe('hello');
  });

  it('applies to empty string', () => {
    expect(applyOp('', ['hello'])).toBe('hello');
  });
});

describe('composeOps', () => {
  it('composes two sequential inserts into an equivalent single op', () => {
    // apply 'a' then apply 'b' starting at position 1
    const a: TextOp = ['a'];
    const b: TextOp = [1, 'b'];
    const composed = composeOps(a, b);
    expect(applyOp('', composed)).toBe('ab');
  });

  it('composing with NOOP is identity', () => {
    const op: TextOp = ['hello'];
    expect(applyOp('', composeOps(op, NOOP))).toBe('hello');
    expect(applyOp('', composeOps(NOOP, op))).toBe('hello');
  });

  it('composes insert then delete', () => {
    // insert 'X', then delete 'X'
    const insert: TextOp = ['X'];
    const del: TextOp = [{ d: 1 }];
    const composed = composeOps(insert, del);
    expect(applyOp('', composed)).toBe('');
  });
});

describe('transformOp', () => {
  it('transforms two concurrent inserts at the same position with right-side tie-break', () => {
    // Both clients start from "" and insert at position 0:
    //   A inserts 'X', B inserts 'Y'
    // Server orders A first; B's op is transformed against A with side='right'
    // (B goes after A). Result: 'XY'.
    const a: TextOp = ['X'];
    const b: TextOp = ['Y'];
    const bPrime = transformOp(b, a, 'right');
    expect(applyOp(applyOp('', a), bPrime)).toBe('XY');
  });

  it('transforms two concurrent inserts at the same position with left-side tie-break', () => {
    // A inserts 'X', B inserts 'Y'.
    // Transform A against B with side='left' (A goes before B).
    // Both paths converge to 'XY' (A stays at position 0, B shifts to 1).
    const a: TextOp = ['X'];
    const b: TextOp = ['Y'];
    const aPrime = transformOp(a, b, 'left');
    // TP1: apply(apply('', b), aPrime) === apply(apply('', a), transformOp(b, a, 'right'))
    // Both converge to the same string (verified by TP1 property test).
    expect(applyOp(applyOp('', b), aPrime)).toBe('XY');
  });

  it('transforms a delete against a concurrent insert', () => {
    // Snapshot: 'ab'
    // A: delete 'b' at codepoint position 1
    // B: insert 'X' at position 0, making snapshot 'Xab'
    // A' = transform(A, B, 'left') should delete 'b' at position 2 in 'Xab'
    const a: TextOp = [1, { d: 1 }]; // skip 1, delete 1
    const b: TextOp = ['X']; // insert 'X' at start
    const aPrime = transformOp(a, b, 'left');
    expect(applyOp(applyOp('ab', b), aPrime)).toBe('Xa');
  });
});

describe('transformPosition', () => {
  it('shifts position forward after an insert before it', () => {
    // snapshot: 'abc', insert 'X' at position 0 → 'Xabc'
    // position 2 (was pointing to 'c') should become 3
    const op: TextOp = ['X']; // insert at 0 (no skip, no trailing skip)
    expect(transformPosition(2, op)).toBe(3);
  });

  it('leaves position unchanged when insert is after it', () => {
    // snapshot: 'abc', insert 'X' at position 2 → 'abXc'
    // position 1 (pointing to 'b') stays at 1
    const op: TextOp = [2, 'X']; // skip 2, insert (trailing skip implied)
    expect(transformPosition(1, op)).toBe(1);
  });

  it('leaves position unchanged when cursor equals insert position', () => {
    // Cursor AT the insert position stays there (library behavior).
    // snapshot: 'abc', insert 'X' at position 2 → 'abXc'
    // cursor at 2 stays at 2 (not shifted past the insertion).
    const op: TextOp = [2, 'X'];
    expect(transformPosition(2, op)).toBe(2);
  });

  it('adjusts position when codepoints before it are deleted', () => {
    // snapshot: 'abcd', delete 'bc' (positions 1-2, count=2) → 'ad'
    // position 3 (was 'd') should become 3-2=1
    const op: TextOp = [1, { d: 2 }]; // skip 1, delete 2 (trailing skip implied)
    expect(transformPosition(3, op)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Codepoint correctness
// ---------------------------------------------------------------------------

describe('codepoint correctness', () => {
  it('counts emoji as one codepoint, not two UTF-16 units', () => {
    // 😀 is U+1F600 — one codepoint, two UTF-16 code units.
    // Inserting after it means position 1, not 2.
    const result = applyOp('😀', [1, '!']);
    expect(result).toBe('😀!');
  });

  it('deletes one codepoint of a surrogate pair atomically', () => {
    // 'a😀b' — the emoji is at codepoint index 1.
    // Deleting codepoint 1 should give 'ab'.
    // Trailing skip for 'b' is implied — do not append it.
    const result = applyOp('a😀b', [1, { d: 1 }]);
    expect(result).toBe('ab');
  });

  it('inserts between two emoji correctly', () => {
    // '😀😁' — two emoji, each 1 codepoint.
    // Inserting '-' at codepoint position 1 should give '😀-😁'.
    // Trailing skip for second emoji is implied.
    const result = applyOp('😀😁', [1, '-']);
    expect(result).toBe('😀-😁');
  });

  it('deletes multiple emoji as codepoints', () => {
    // '😀😁😂' — 3 codepoints (6 UTF-16 code units)
    // Deleting all 3 at codepoint offset 0
    const result = applyOp('😀😁😂', [{ d: 3 }]);
    expect(result).toBe('');
  });

  it('codepoint length differs from UTF-16 length for emoji', () => {
    // Sanity check that our codepoint helper differs from .length
    const s = '😀';
    expect(s.length).toBe(2); // UTF-16 code units
    expect(codepointLength(s)).toBe(1); // codepoints
  });
});

// ---------------------------------------------------------------------------
// Property 1: TP1 convergence
// ---------------------------------------------------------------------------

describe('Property 1 — TP1 convergence', () => {
  it('apply(apply(s, a), transform(b, a, right)) === apply(apply(s, b), transform(a, b, left))', () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 30 })
          .chain((s) => fc.tuple(fc.constant(s), arbValidOpAgainst(s), arbValidOpAgainst(s))),
        ([s, a, b]) => {
          const leftResult = applyOp(applyOp(s, a), transformOp(b, a, 'right'));
          const rightResult = applyOp(applyOp(s, b), transformOp(a, b, 'left'));
          return leftResult === rightResult;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: compose correctness
// ---------------------------------------------------------------------------

describe('Property 2 — compose correctness', () => {
  it('apply(apply(s, a), b) === apply(s, compose(a, b))', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).chain((s) =>
          arbValidOpAgainst(s).chain((a) => {
            // Generate b as valid against the snapshot after applying a
            let s2: string;
            try {
              s2 = applyOp(s, a);
            } catch {
              // If this op is somehow invalid (shouldn't happen with our
              // generator, but guard defensively), skip this sample.
              s2 = s;
            }
            return fc.tuple(fc.constant(s), fc.constant(a), arbValidOpAgainst(s2));
          }),
        ),
        ([s, a, b]) => {
          const sequential = applyOp(applyOp(s, a), b);
          const composed = applyOp(s, composeOps(a, b));
          return sequential === composed;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: transformPosition consistency
// ---------------------------------------------------------------------------

describe('Property 3 — transformPosition consistency', () => {
  it('cursor shifts forward exactly by insertLen when cursor > insertAt', () => {
    // For a pure-insert op at position insertAt, the library shifts cursor by
    // insertLen when cursor > insertAt, and leaves it unchanged when
    // cursor <= insertAt.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).chain((s) => {
          const len = codepointLength(s);
          return fc.tuple(
            fc.constant(s),
            // Insert position in the snapshot [0, len]
            fc.integer({ min: 0, max: len }),
            // Text to insert (non-empty to have a meaningful shift)
            fc.string({ minLength: 1, maxLength: 10 }),
            // Cursor position in the original snapshot [0, len]
            fc.integer({ min: 0, max: len }),
          );
        }),
        ([, insertAt, insertText, cursor]) => {
          const insertLen = codepointLength(insertText);
          // Build a pure-insert op: skip insertAt (if > 0), insert insertText.
          // Trailing skip is omitted (implied by ot-text-unicode).
          const op: TextOp = [];
          if (insertAt > 0) op.push(insertAt);
          op.push(insertText);

          const newCursor = transformPosition(cursor, op);

          // Library behavior: cursor strictly AFTER insertAt shifts by insertLen;
          // cursor AT or BEFORE insertAt stays unchanged.
          const expected = cursor > insertAt ? cursor + insertLen : cursor;
          return newCursor === expected;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('cursor shifts backward to delFrom when codepoints before-or-at cursor are deleted', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 30 }).chain((s) => {
          const cps = [...s];
          const len = cps.length;
          // Pick a delete range [delFrom, delTo) within the snapshot
          return fc.tuple(
            fc.constant(s),
            fc
              .integer({ min: 0, max: len - 1 })
              .chain((delFrom) =>
                fc.tuple(fc.constant(delFrom), fc.integer({ min: delFrom + 1, max: len })),
              ),
            // cursor anywhere in [0, len]
            fc.integer({ min: 0, max: len }),
          );
        }),
        ([, [delFrom, delTo], cursor]) => {
          const delCount = delTo - delFrom;

          // Build a pure-delete op: skip delFrom (if > 0), delete delCount.
          // Trailing skip is omitted (implied).
          const op: TextOp = [];
          if (delFrom > 0) op.push(delFrom);
          op.push({ d: delCount });

          const newCursor = transformPosition(cursor, op);

          // Library behavior (verified empirically):
          // cursor <= delFrom            → unchanged
          // cursor in (delFrom, delTo]   → clamps to delFrom
          // cursor > delTo               → cursor - delCount
          let expected: number;
          if (cursor <= delFrom) {
            expected = cursor;
          } else if (cursor <= delTo) {
            expected = delFrom;
          } else {
            expected = cursor - delCount;
          }
          return newCursor === expected;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

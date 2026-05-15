/**
 * UTF-16 <-> Unicode-codepoint offset conversion.
 *
 * VS Code exposes positions and offsets in UTF-16 code units (a JS string's
 * `.length` and `.charCodeAt`). The OT layer (`ot-text-unicode`) operates in
 * Unicode codepoints. A single non-BMP character (e.g. an emoji such as
 * U+1F600) is one codepoint but two UTF-16 code units. Conflating the two
 * silently corrupts documents whenever a surrogate pair sits inside or near
 * an edit range — exactly the failure mode flagged by the Phase 4 plan.
 *
 * These helpers are pure (no VS Code import) so they can be unit-tested and
 * property-tested in isolation.
 *
 * Invariants:
 *  - Offsets at exactly the end of the string are valid in both directions.
 *  - Negative or beyond-end offsets throw.
 *  - A UTF-16 offset that lands between the high and low surrogate of a pair
 *    is illegal and throws. VS Code does not produce such offsets for valid
 *    ranges, but we treat the case defensively rather than silently splitting
 *    a codepoint.
 */

/** Returns true if `c` is a UTF-16 high surrogate (start of a surrogate pair). */
function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * Convert a UTF-16 code-unit offset into `text` into a codepoint offset.
 *
 * @throws if `utf16Offset` is negative, beyond the end of `text`, or lands
 * between the two halves of a surrogate pair.
 */
export function utf16ToCodepoint(text: string, utf16Offset: number): number {
  if (utf16Offset < 0 || utf16Offset > text.length) {
    throw new RangeError(
      `utf16ToCodepoint: offset ${utf16Offset} out of range [0, ${text.length}]`,
    );
  }
  let cp = 0;
  let i = 0;
  while (i < utf16Offset) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      // A complete pair must fit before `utf16Offset`; otherwise the caller
      // is asking for the position between high and low surrogate.
      if (i + 1 >= utf16Offset) {
        throw new RangeError(
          `utf16ToCodepoint: offset ${utf16Offset} splits a surrogate pair at index ${i}`,
        );
      }
      i += 2;
    } else {
      i += 1;
    }
    cp += 1;
  }
  return cp;
}

/**
 * Convert a codepoint offset into `text` into a UTF-16 code-unit offset.
 *
 * @throws if `codepointOffset` is negative or beyond the codepoint length of
 * `text`.
 */
export function codepointToUtf16(text: string, codepointOffset: number): number {
  if (codepointOffset < 0) {
    throw new RangeError(`codepointToUtf16: offset ${codepointOffset} is negative`);
  }
  let cp = 0;
  let i = 0;
  while (cp < codepointOffset) {
    if (i >= text.length) {
      throw new RangeError(
        `codepointToUtf16: offset ${codepointOffset} exceeds codepoint length ${cp}`,
      );
    }
    const code = text.charCodeAt(i);
    i += isHighSurrogate(code) ? 2 : 1;
    cp += 1;
  }
  return i;
}

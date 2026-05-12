/**
 * Tests for the UTF-16 <-> codepoint offset utilities used by editCapture.
 *
 * VS Code's `Range`/`TextDocumentContentChangeEvent` offsets are in UTF-16
 * code units (because JavaScript strings are UTF-16). `ot-text-unicode` works
 * in Unicode codepoints. Any miscount around surrogate pairs silently corrupts
 * documents under emoji / non-BMP input, so these conversions are covered by
 * fixture tests *and* property tests at the boundary.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { utf16ToCodepoint, codepointToUtf16 } from '../../src/sync/offsets.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('utf16ToCodepoint', () => {
  it('is identity for ASCII strings', () => {
    const s = 'hello world';
    for (let i = 0; i <= s.length; i++) {
      expect(utf16ToCodepoint(s, i)).toBe(i);
    }
  });

  it('handles end-of-string offset', () => {
    expect(utf16ToCodepoint('abc', 3)).toBe(3);
    expect(utf16ToCodepoint('', 0)).toBe(0);
  });

  it('counts a single non-BMP emoji as one codepoint (utf16 length 2)', () => {
    // U+1F600 GRINNING FACE — encoded as surrogate pair, UTF-16 length 2.
    const s = '\u{1F600}';
    expect(s.length).toBe(2); // sanity — JS string length is UTF-16 code units
    expect(utf16ToCodepoint(s, 0)).toBe(0);
    expect(utf16ToCodepoint(s, 2)).toBe(1); // after the emoji
  });

  it('handles a mixed string a😀b', () => {
    const s = 'a\u{1F600}b'; // utf16 length 4, codepoints 3
    expect(s.length).toBe(4);
    expect(utf16ToCodepoint(s, 0)).toBe(0); // before 'a'
    expect(utf16ToCodepoint(s, 1)).toBe(1); // before emoji
    expect(utf16ToCodepoint(s, 3)).toBe(2); // before 'b'
    expect(utf16ToCodepoint(s, 4)).toBe(3); // after 'b'
  });

  it('throws on negative offset', () => {
    expect(() => utf16ToCodepoint('abc', -1)).toThrow(/offset/i);
  });

  it('throws on out-of-range offset', () => {
    expect(() => utf16ToCodepoint('abc', 4)).toThrow(/offset/i);
  });

  it('throws when offset lands in the middle of a surrogate pair', () => {
    const s = 'a\u{1F600}b'; // utf16: a, hi, lo, b
    expect(() => utf16ToCodepoint(s, 2)).toThrow(/surrogate/i);
  });
});

describe('codepointToUtf16', () => {
  it('is identity for ASCII strings', () => {
    const s = 'hello world';
    for (let i = 0; i <= s.length; i++) {
      expect(codepointToUtf16(s, i)).toBe(i);
    }
  });

  it('handles end-of-string offset', () => {
    expect(codepointToUtf16('abc', 3)).toBe(3);
    expect(codepointToUtf16('', 0)).toBe(0);
  });

  it('handles a mixed string a😀b', () => {
    const s = 'a\u{1F600}b';
    expect(codepointToUtf16(s, 0)).toBe(0);
    expect(codepointToUtf16(s, 1)).toBe(1);
    expect(codepointToUtf16(s, 2)).toBe(3); // past the surrogate pair
    expect(codepointToUtf16(s, 3)).toBe(4);
  });

  it('throws on negative offset', () => {
    expect(() => codepointToUtf16('abc', -1)).toThrow(/offset/i);
  });

  it('throws on out-of-range offset', () => {
    expect(() => codepointToUtf16('abc', 4)).toThrow(/offset/i);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

/** Codepoint length of `s` (correctly counts surrogate pairs as one). */
function codepointLength(s: string): number {
  return Array.from(s).length;
}

describe('round-trip properties', () => {
  it('codepoint -> utf16 -> codepoint is identity for any valid codepoint offset', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), (s) => {
        const len = codepointLength(s);
        for (let cp = 0; cp <= len; cp++) {
          const u = codepointToUtf16(s, cp);
          expect(utf16ToCodepoint(s, u)).toBe(cp);
        }
      }),
    );
  });

  it('utf16 -> codepoint -> utf16 is identity when offset is NOT mid-surrogate', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString(), (s) => {
        for (let u = 0; u <= s.length; u++) {
          // Skip illegal mid-surrogate offsets — those are documented to throw.
          if (u > 0 && u < s.length) {
            const prev = s.charCodeAt(u - 1);
            if (prev >= 0xd800 && prev <= 0xdbff) continue; // mid pair
          }
          const cp = utf16ToCodepoint(s, u);
          expect(codepointToUtf16(s, cp)).toBe(u);
        }
      }),
    );
  });
});

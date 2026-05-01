/**
 * Tests for shared primitive schemas defined in _common.ts,
 * plus per-message schemas for session, cursor, nav, git, error, and doc.
 */
import { describe, it, expect } from 'vitest';
import {
  RelPath,
  CodepointOffset,
  ColorHex,
  ParticipantId,
  DisplayName,
} from '../../src/messages/_common.js';
import { SessionJoinPayload } from '../../src/messages/session-join.js';
import { DocDeltaPayload } from '../../src/messages/doc-delta.js';
import { CursorUpdatePayload } from '../../src/messages/cursor-update.js';
import { NavFilePayload } from '../../src/messages/nav-file.js';
import { GitOperationPayload } from '../../src/messages/git-operation.js';
import { ErrorPayload } from '../../src/messages/error.js';
import { ConflictOpenPayload } from '../../src/messages/conflict-open.js';

// ---------- RelPath ----------
describe('RelPath', () => {
  it('accepts a valid relative path', () => {
    expect(() => RelPath.parse('src/index.ts')).not.toThrow();
    expect(() => RelPath.parse('a.txt')).not.toThrow();
    expect(() => RelPath.parse('foo/bar/baz.ts')).not.toThrow();
  });

  it("rejects '..'", () => {
    expect(() => RelPath.parse('..')).toThrow();
  });

  it("rejects 'foo/../bar'", () => {
    expect(() => RelPath.parse('foo/../bar')).toThrow();
  });

  it("rejects '/abs/path' (absolute)", () => {
    expect(() => RelPath.parse('/abs/path')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => RelPath.parse('')).toThrow();
  });

  it('rejects backslash paths', () => {
    expect(() => RelPath.parse('foo\\bar')).toThrow();
  });

  it('rejects null byte in path', () => {
    expect(() => RelPath.parse('foo\x00bar')).toThrow();
  });

  it('accepts triple-dot directory name', () => {
    expect(() => RelPath.parse('...')).not.toThrow();
  });

  it('accepts filename containing double-dot (changelog..md)', () => {
    expect(() => RelPath.parse('changelog..md')).not.toThrow();
  });

  it('accepts filename like packages..old/src/a.ts', () => {
    expect(() => RelPath.parse('packages..old/src/a.ts')).not.toThrow();
  });
});

// ---------- ColorHex ----------
describe('ColorHex', () => {
  it('accepts a valid 6-digit hex', () => {
    expect(() => ColorHex.parse('#a3f0cc')).not.toThrow();
    expect(() => ColorHex.parse('#AABBCC')).not.toThrow();
  });

  it("rejects shorthand '#fff'", () => {
    expect(() => ColorHex.parse('#fff')).toThrow();
  });

  it("rejects named color 'red'", () => {
    expect(() => ColorHex.parse('red')).toThrow();
  });

  it('rejects hex without leading #', () => {
    expect(() => ColorHex.parse('a3f0cc')).toThrow();
  });
});

// ---------- ParticipantId / DisplayName ----------
describe('ParticipantId', () => {
  it('rejects empty string', () => {
    expect(() => ParticipantId.parse('')).toThrow();
  });
  it('rejects string over 64 chars', () => {
    expect(() => ParticipantId.parse('x'.repeat(65))).toThrow();
  });
});

describe('DisplayName', () => {
  it('rejects empty string', () => {
    expect(() => DisplayName.parse('')).toThrow();
  });
});

// ---------- CodepointOffset ----------
describe('CodepointOffset', () => {
  it('accepts zero', () => {
    expect(() => CodepointOffset.parse(0)).not.toThrow();
  });
  it('rejects negative', () => {
    expect(() => CodepointOffset.parse(-1)).toThrow();
  });
});

// ---------- session.join ----------
describe('SessionJoinPayload', () => {
  const valid = { sessionId: 's1', branch: 'main', displayName: 'Alice', color: '#a3f0cc' };

  it('accepts valid payload', () => {
    expect(() => SessionJoinPayload.parse(valid)).not.toThrow();
  });

  it('rejects empty displayName', () => {
    expect(() => SessionJoinPayload.parse({ ...valid, displayName: '' })).toThrow();
  });

  it("rejects malformed color '#fff'", () => {
    expect(() => SessionJoinPayload.parse({ ...valid, color: '#fff' })).toThrow();
  });

  it("rejects malformed color 'red'", () => {
    expect(() => SessionJoinPayload.parse({ ...valid, color: 'red' })).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => SessionJoinPayload.parse({ ...valid, extra: true })).toThrow();
  });

  it('accepts optional participantId', () => {
    expect(() => SessionJoinPayload.parse({ ...valid, participantId: 'pid1' })).not.toThrow();
  });
});

// ---------- doc.delta ----------
describe('DocDeltaPayload', () => {
  it('rejects negative baseVersion', () => {
    expect(() =>
      DocDeltaPayload.parse({ path: 'src/index.ts', baseVersion: -1, op: {} }),
    ).toThrow();
  });

  it('accepts baseVersion of 0', () => {
    expect(() =>
      DocDeltaPayload.parse({ path: 'src/index.ts', baseVersion: 0, op: null }),
    ).not.toThrow();
  });

  it('accepts opaque op value', () => {
    expect(() =>
      DocDeltaPayload.parse({
        path: 'src/index.ts',
        baseVersion: 5,
        op: [{ retain: 10 }, { insert: 'x' }],
      }),
    ).not.toThrow();
  });
});

// ---------- cursor.update ----------
describe('CursorUpdatePayload', () => {
  it('rejects negative anchor', () => {
    expect(() => CursorUpdatePayload.parse({ path: 'src/a.ts', anchor: -1, head: 0 })).toThrow();
  });

  it('rejects negative head', () => {
    expect(() => CursorUpdatePayload.parse({ path: 'src/a.ts', anchor: 0, head: -1 })).toThrow();
  });

  it('accepts anchor and head of 0', () => {
    expect(() => CursorUpdatePayload.parse({ path: 'src/a.ts', anchor: 0, head: 0 })).not.toThrow();
  });
});

// ---------- nav.file ----------
describe('NavFilePayload', () => {
  it('accepts null path (no file open)', () => {
    expect(() => NavFilePayload.parse({ path: null })).not.toThrow();
  });

  it('accepts a valid RelPath', () => {
    expect(() => NavFilePayload.parse({ path: 'src/index.ts' })).not.toThrow();
  });

  it('rejects empty string (use null instead)', () => {
    expect(() => NavFilePayload.parse({ path: '' })).toThrow();
  });
});

// ---------- git.operation ----------
describe('GitOperationPayload', () => {
  it("accepts kind 'commit' with a valid message", () => {
    expect(() => GitOperationPayload.parse({ kind: 'commit', message: 'fix: typo' })).not.toThrow();
  });

  it("rejects kind 'commit' with empty message", () => {
    expect(() => GitOperationPayload.parse({ kind: 'commit', message: '' })).toThrow();
  });

  it("accepts kind 'push'", () => {
    expect(() => GitOperationPayload.parse({ kind: 'push' })).not.toThrow();
  });

  it("accepts kind 'pull-staged'", () => {
    expect(() => GitOperationPayload.parse({ kind: 'pull-staged' })).not.toThrow();
  });

  it("rejects kind 'unknown'", () => {
    expect(() => GitOperationPayload.parse({ kind: 'unknown' })).toThrow();
  });

  it("rejects 'push' with extra message field (strict)", () => {
    expect(() =>
      GitOperationPayload.parse({ kind: 'push', message: 'should not be here' }),
    ).toThrow();
  });
});

// ---------- conflict.open ----------
describe('ConflictOpenPayload', () => {
  it('rejects conflict.open texts exceeding 1 MiB', () => {
    const huge = 'x'.repeat(1_048_577);
    expect(() =>
      ConflictOpenPayload.parse({
        path: 'src/a.ts',
        conflictId: '11111111-1111-4111-8111-111111111111',
        peers: ['p1', 'p2'],
        leftText: huge,
        rightText: '',
        baseText: '',
      }),
    ).toThrow();
  });
});

// ---------- error ----------
describe('ErrorPayload', () => {
  it('requires code, message, and recoverable', () => {
    expect(() => ErrorPayload.parse({})).toThrow();
    expect(() => ErrorPayload.parse({ code: 'E', message: 'msg' })).toThrow(); // missing recoverable
    expect(() =>
      ErrorPayload.parse({ code: 'E', message: 'msg', recoverable: false }),
    ).not.toThrow();
  });

  it('rejects empty code', () => {
    expect(() => ErrorPayload.parse({ code: '', message: 'msg', recoverable: true })).toThrow();
  });

  it('rejects empty message', () => {
    expect(() => ErrorPayload.parse({ code: 'E', message: '', recoverable: true })).toThrow();
  });
});

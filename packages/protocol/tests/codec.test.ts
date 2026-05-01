import { describe, it, expect } from 'vitest';
import { encode, decode } from '../src/codec.js';
import { ProtocolError } from '../src/envelope.js';
import { type MessageType, type MessagePayload } from '../src/messages/index.js';

// Representative valid payloads for every message type
const fixtures: { [T in MessageType]: MessagePayload<T> } = {
  'session.join': {
    sessionId: 'sess-1',
    branch: 'main',
    displayName: 'Alice',
    color: '#a3f0cc',
  },
  'session.leave': { reason: 'user' },
  'session.state': {
    sessionId: 'sess-1',
    branch: 'main',
    you: 'part-1',
    participants: [
      {
        id: 'part-1',
        displayName: 'Alice',
        color: '#a3f0cc',
        currentFile: 'src/index.ts',
        agentActiveOn: null,
      },
    ],
  },
  'doc.delta': { path: 'src/index.ts', baseVersion: 0, op: { retain: 10 } },
  'cursor.update': { path: 'src/index.ts', anchor: 0, head: 5 },
  'agent.intent': { path: 'src/index.ts', description: 'Refactor imports' },
  'agent.change': { path: 'src/index.ts', mergeKind: 'auto' },
  'conflict.open': {
    path: 'src/index.ts',
    conflictId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    peers: ['part-1', 'part-2'],
    leftText: 'left',
    rightText: 'right',
    baseText: 'base',
  },
  'conflict.resolve': {
    conflictId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    resolvedText: 'resolved',
    confirmedBy: ['part-1'],
  },
  'git.operation': { kind: 'commit', message: 'chore: initial commit' },
  'git.ack': { operationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', accepted: true },
  'nav.file': { path: 'src/index.ts' },
  error: { code: 'AUTH_FAILED', message: 'Token expired', recoverable: false },
  ping: {},
  pong: {},
};

function tryEncode<T extends MessageType>(type: T, payload: MessagePayload<T>): ProtocolError {
  try {
    encode(type, payload);
    throw new Error(`Expected ProtocolError encoding '${type}' but no error was thrown`);
  } catch (err) {
    if (err instanceof ProtocolError) return err;
    throw err;
  }
}

function tryDecode(wire: string): ProtocolError {
  try {
    decode(wire);
    throw new Error('Expected ProtocolError from decode but no error was thrown');
  } catch (err) {
    if (err instanceof ProtocolError) return err;
    throw err;
  }
}

describe('encode + decode round-trip', () => {
  const types = Object.keys(fixtures) as MessageType[];

  for (const type of types) {
    it(`round-trips '${type}'`, () => {
      const payload = fixtures[type];
      // Cast needed: `type` is a union so TS can't narrow the overload — correctness verified at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const wire = encode(type, payload as any);
      const decoded = decode(wire);
      expect(decoded.type).toBe(type);
      expect(decoded.payload).toEqual(payload);
      expect(decoded.envelope.v).toBe(1);
    });
  }
});

describe('encode rejects invalid payloads', () => {
  it("rejects 'session.join' with empty displayName", () => {
    const err = tryEncode('session.join', {
      sessionId: 'sess-1',
      branch: 'main',
      displayName: '',
      color: '#a3f0cc',
    });
    expect(err.code).toBe('invalid-payload');
  });

  it("rejects 'cursor.update' with negative anchor", () => {
    const err = tryEncode('cursor.update', { path: 'src/index.ts', anchor: -1, head: 0 });
    expect(err.code).toBe('invalid-payload');
  });

  it("rejects 'git.operation' commit with empty message", () => {
    const err = tryEncode('git.operation', { kind: 'commit', message: '' });
    expect(err.code).toBe('invalid-payload');
  });
});

describe('decode type narrowing', () => {
  it('narrows payload type after switching on type', () => {
    const wire = encode('ping', {});
    const msg = decode(wire);
    if (msg.type === 'ping') {
      // Type assertion: msg.payload is PingPayload (empty object)
      expect(msg.payload).toEqual({});
    } else {
      throw new Error('expected ping');
    }
  });
});

describe('decode error cases', () => {
  it("throws 'unknown-type' for unknown message type", () => {
    const wire = JSON.stringify({
      v: 1,
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ts: 0,
      type: 'session.bogus',
      payload: {},
    });
    const err = tryDecode(wire);
    expect(err.code).toBe('unknown-type');
  });

  it("throws 'invalid-payload' for a valid type but malformed payload", () => {
    const wire = JSON.stringify({
      v: 1,
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ts: 0,
      type: 'session.join',
      payload: { sessionId: 'sess-1' }, // missing required fields
    });
    const err = tryDecode(wire);
    expect(err.code).toBe('invalid-payload');
  });

  it('encode opts allow custom id and ts', () => {
    const wire = encode('ping', {}, { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', ts: 1000 });
    const decoded = decode(wire);
    expect(decoded.envelope.id).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(decoded.envelope.ts).toBe(1000);
  });
});

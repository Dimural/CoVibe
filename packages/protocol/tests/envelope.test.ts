import { describe, it, expect } from 'vitest';
import { parseEnvelope, ProtocolError } from '../src/envelope.js';

const validRaw = {
  v: 1,
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  ts: 0,
  type: 'ping',
  payload: {},
};

function tryParse(input: string): ProtocolError {
  try {
    parseEnvelope(input);
    throw new Error('Expected ProtocolError but no error was thrown');
  } catch (err) {
    if (err instanceof ProtocolError) return err;
    throw err;
  }
}

describe('parseEnvelope', () => {
  it('returns a valid Envelope for a well-formed input', () => {
    const env = parseEnvelope(JSON.stringify(validRaw));
    expect(env.v).toBe(1);
    expect(env.type).toBe('ping');
    expect(env.id).toBe(validRaw.id);
  });

  it("throws ProtocolError('invalid-json') for non-JSON input", () => {
    expect(() => parseEnvelope('not json')).toThrow(ProtocolError);
    const err = tryParse('not json');
    expect(err.code).toBe('invalid-json');
  });

  it("throws ProtocolError('invalid-envelope') for a bad UUID in id", () => {
    const bad = JSON.stringify({ ...validRaw, id: '<bad-uuid>' });
    const err = tryParse(bad);
    expect(err.code).toBe('invalid-envelope');
  });

  it("throws ProtocolError('version-mismatch') when v is present but wrong", () => {
    const bad = JSON.stringify({ ...validRaw, v: 2 });
    const err = tryParse(bad);
    expect(err.code).toBe('version-mismatch');
  });

  it("throws ProtocolError('invalid-envelope') when v is missing (not version-mismatch)", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v: _v, ...withoutV } = validRaw;
    const bad = JSON.stringify(withoutV);
    const err = tryParse(bad);
    expect(err.code).toBe('invalid-envelope');
  });

  it("throws ProtocolError('invalid-envelope') when ts is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ts: _ts, ...withoutTs } = validRaw;
    const bad = JSON.stringify(withoutTs);
    const err = tryParse(bad);
    expect(err.code).toBe('invalid-envelope');
  });

  it('does not validate payload shape (opaque at envelope level)', () => {
    // Payload can be anything — validation happens in decode()
    const env = parseEnvelope(JSON.stringify({ ...validRaw, payload: 'arbitrary string' }));
    expect(env.payload).toBe('arbitrary string');
  });

  it("throws 'invalid-envelope' for extra fields on the envelope", () => {
    const bad = JSON.stringify({
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: 0,
      type: 'ping',
      payload: {},
      extra: true,
    });
    const err = tryParse(bad);
    expect(err.code).toBe('invalid-envelope');
  });
});

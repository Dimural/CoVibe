import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');
    expect(config.maxParticipants).toBe(4);
    expect(config.sessionGraceMs).toBe(1_800_000);
    expect(config.nodeEnv).toBe('development');
    expect(config.redisUrl).toBeUndefined();
  });

  it('parses PORT from string to number', () => {
    const config = loadConfig({ PORT: '3000' });
    expect(config.port).toBe(3000);
  });

  it('rejects bogus LOG_LEVEL with a clear error', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrowError(/Invalid relay configuration/);
  });

  it('rejects MAX_PARTICIPANTS below 2', () => {
    expect(() => loadConfig({ MAX_PARTICIPANTS: '1' })).toThrowError(/Invalid relay configuration/);
  });

  it('rejects MAX_PARTICIPANTS above 16', () => {
    expect(() => loadConfig({ MAX_PARTICIPANTS: '17' })).toThrowError(
      /Invalid relay configuration/,
    );
  });

  it('rejects negative SESSION_GRACE_MS', () => {
    expect(() => loadConfig({ SESSION_GRACE_MS: '-1' })).toThrowError(
      /Invalid relay configuration/,
    );
  });

  it('returns a frozen object (mutation throws in strict mode)', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional mutation test
      config.port = 9999;
    }).toThrow();
  });
});

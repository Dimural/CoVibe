import { describe, it, expect, vi } from 'vitest';
import { FollowMode, type FollowModeOptions } from '../../src/sync/followMode.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<FollowModeOptions> = {}): {
  opts: FollowModeOptions;
  showDocument: ReturnType<typeof vi.fn>;
  onFollowStateChange: ReturnType<typeof vi.fn>;
} {
  const showDocument = vi.fn().mockResolvedValue(undefined);
  const onFollowStateChange = vi.fn();

  const opts: FollowModeOptions = {
    showDocument,
    onFollowStateChange,
    ...overrides,
  };

  return { opts, showDocument, onFollowStateChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FollowMode — follow', () => {
  it('sets following and calls onFollowStateChange with the participantId', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');

    expect(fm.following).toBe('alice');
    expect(onFollowStateChange).toHaveBeenCalledOnce();
    expect(onFollowStateChange).toHaveBeenCalledWith('alice');
  });

  it('switches to a new participant when already following someone else', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    fm.follow('bob');

    expect(fm.following).toBe('bob');
    expect(onFollowStateChange).toHaveBeenLastCalledWith('bob');
  });
});

describe('FollowMode — unfollow', () => {
  it('clears following and calls onFollowStateChange with null', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    onFollowStateChange.mockClear();

    fm.unfollow();

    expect(fm.following).toBeNull();
    expect(onFollowStateChange).toHaveBeenCalledOnce();
    expect(onFollowStateChange).toHaveBeenCalledWith(null);
  });

  it('is a no-op (does not throw) when not following anyone', () => {
    const { opts } = makeOptions();
    const fm = new FollowMode(opts);

    expect(() => fm.unfollow()).not.toThrow();
    expect(fm.following).toBeNull();
  });
});

describe('FollowMode — toggle', () => {
  it('starts following when not following anyone', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.toggle('alice');

    expect(fm.following).toBe('alice');
    expect(onFollowStateChange).toHaveBeenCalledWith('alice');
  });

  it('stops following when toggling the currently followed participant', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    onFollowStateChange.mockClear();

    fm.toggle('alice');

    expect(fm.following).toBeNull();
    expect(onFollowStateChange).toHaveBeenCalledWith(null);
  });

  it('switches from participant A to B when toggling B while following A', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    onFollowStateChange.mockClear();

    fm.toggle('bob');

    expect(fm.following).toBe('bob');
    expect(onFollowStateChange).toHaveBeenCalledWith('bob');
  });
});

describe('FollowMode — onRemoteNavFile', () => {
  it('calls showDocument when following that participant', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    fm.onRemoteNavFile('alice', 'src/index.ts');

    expect(showDocument).toHaveBeenCalledOnce();
    expect(showDocument).toHaveBeenCalledWith('src/index.ts');
  });

  it('does NOT call showDocument when NOT following that participant', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('bob');
    fm.onRemoteNavFile('alice', 'src/index.ts');

    expect(showDocument).not.toHaveBeenCalled();
  });

  it('does NOT call showDocument when not following anyone', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.onRemoteNavFile('alice', 'src/index.ts');

    expect(showDocument).not.toHaveBeenCalled();
  });

  it('calls showDocument without a position argument (nav.file has no cursor)', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    fm.onRemoteNavFile('alice', 'src/app.ts');

    expect(showDocument).toHaveBeenCalledWith('src/app.ts');
    // Ensure position arg was NOT passed
    const call = showDocument.mock.calls[0];
    expect(call).toHaveLength(1);
  });
});

describe('FollowMode — onRemoteCursor', () => {
  it('calls showDocument with path and position when following that participant', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    fm.onRemoteCursor('alice', 'src/app.ts', 10, 5);

    expect(showDocument).toHaveBeenCalledOnce();
    expect(showDocument).toHaveBeenCalledWith('src/app.ts', { line: 10, character: 5 });
  });

  it('does NOT call showDocument when NOT following that participant', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('bob');
    fm.onRemoteCursor('alice', 'src/app.ts', 10, 5);

    expect(showDocument).not.toHaveBeenCalled();
  });

  it('does NOT call showDocument when not following anyone', () => {
    const { opts, showDocument } = makeOptions();
    const fm = new FollowMode(opts);

    fm.onRemoteCursor('alice', 'src/app.ts', 10, 5);

    expect(showDocument).not.toHaveBeenCalled();
  });
});

describe('FollowMode — onParticipantLeft', () => {
  it('stops follow mode when the followed participant leaves', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    onFollowStateChange.mockClear();

    fm.onParticipantLeft('alice');

    expect(fm.following).toBeNull();
    expect(onFollowStateChange).toHaveBeenCalledWith(null);
  });

  it('does NOT stop follow mode when a different participant leaves', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    fm.follow('alice');
    onFollowStateChange.mockClear();

    fm.onParticipantLeft('bob');

    expect(fm.following).toBe('alice');
    expect(onFollowStateChange).not.toHaveBeenCalled();
  });

  it('is a no-op when not following anyone', () => {
    const { opts, onFollowStateChange } = makeOptions();
    const fm = new FollowMode(opts);

    expect(() => fm.onParticipantLeft('alice')).not.toThrow();
    expect(onFollowStateChange).not.toHaveBeenCalled();
  });
});

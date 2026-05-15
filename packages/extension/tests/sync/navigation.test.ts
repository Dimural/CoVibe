import { describe, it, expect, vi } from 'vitest';
import { NavigationSync, type NavFileOptions, type NavEditor } from '../../src/sync/navigation.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<NavFileOptions> = {}): {
  opts: NavFileOptions;
  capturedHandler: { current: ((editor: NavEditor | undefined) => void) | undefined };
  sendNavFile: ReturnType<typeof vi.fn>;
  onRemoteNavFile: ReturnType<typeof vi.fn>;
  disposeSubscription: ReturnType<typeof vi.fn>;
} {
  const capturedHandler: { current: ((editor: NavEditor | undefined) => void) | undefined } = {
    current: undefined,
  };
  const sendNavFile = vi.fn();
  const onRemoteNavFile = vi.fn();
  const disposeSubscription = vi.fn();

  const opts: NavFileOptions = {
    onDidChangeActiveTextEditor: (handler) => {
      capturedHandler.current = handler;
      return { dispose: disposeSubscription };
    },
    uriToPath: (uri) => (uri.scheme === 'file' ? uri.fsPath.replace('/ws/', '') : undefined),
    sendNavFile,
    onRemoteNavFile,
    ...overrides,
  };

  return { opts, capturedHandler, sendNavFile, onRemoteNavFile, disposeSubscription };
}

function makeEditor(scheme: string, fsPath: string): NavEditor {
  return {
    document: {
      uri: { scheme, fsPath },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NavigationSync — start() subscribes and sends on file-scheme change', () => {
  it('calls sendNavFile with the correct path when active editor changes to a file URI', () => {
    const { opts, capturedHandler, sendNavFile } = makeOptions();
    const sync = new NavigationSync(opts);
    sync.start();

    expect(capturedHandler.current).toBeDefined();
    capturedHandler.current!(makeEditor('file', '/ws/src/index.ts'));

    expect(sendNavFile).toHaveBeenCalledOnce();
    expect(sendNavFile).toHaveBeenCalledWith('src/index.ts');
  });
});

describe('NavigationSync — start() does not subscribe twice', () => {
  it('calling start() twice still results in a single subscription', () => {
    let subscribeCount = 0;
    const { opts, capturedHandler } = makeOptions({
      onDidChangeActiveTextEditor: (handler) => {
        subscribeCount++;
        capturedHandler.current = handler;
        return { dispose: vi.fn() };
      },
    });

    const sync = new NavigationSync(opts);
    sync.start();
    sync.start();

    expect(subscribeCount).toBe(1);
  });
});

describe('NavigationSync — undefined editor does not call sendNavFile', () => {
  it('does not call sendNavFile when active editor becomes undefined', () => {
    const { opts, capturedHandler, sendNavFile } = makeOptions();
    const sync = new NavigationSync(opts);
    sync.start();

    capturedHandler.current!(undefined);

    expect(sendNavFile).not.toHaveBeenCalled();
  });
});

describe('NavigationSync — non-file URI does not call sendNavFile', () => {
  it('does not call sendNavFile for output:// scheme', () => {
    const { opts, capturedHandler, sendNavFile } = makeOptions();
    const sync = new NavigationSync(opts);
    sync.start();

    capturedHandler.current!(makeEditor('output', '/ws/some-output'));

    expect(sendNavFile).not.toHaveBeenCalled();
  });

  it('does not call sendNavFile for untitled:// scheme', () => {
    const { opts, capturedHandler, sendNavFile } = makeOptions();
    const sync = new NavigationSync(opts);
    sync.start();

    capturedHandler.current!(makeEditor('untitled', 'Untitled-1'));

    expect(sendNavFile).not.toHaveBeenCalled();
  });
});

describe('NavigationSync — handleRemoteNavFile', () => {
  it('stores the path and calls onRemoteNavFile', () => {
    const { opts, onRemoteNavFile } = makeOptions();
    const sync = new NavigationSync(opts);

    sync.handleRemoteNavFile('alice', 'src/app.ts');

    expect(onRemoteNavFile).toHaveBeenCalledOnce();
    expect(onRemoteNavFile).toHaveBeenCalledWith('alice', 'src/app.ts');
  });
});

describe('NavigationSync — getLastKnownFile', () => {
  it('returns the stored path after handleRemoteNavFile', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    sync.handleRemoteNavFile('bob', 'lib/utils.ts');

    expect(sync.getLastKnownFile('bob')).toBe('lib/utils.ts');
  });

  it('returns undefined for an unknown participant', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    expect(sync.getLastKnownFile('unknown')).toBeUndefined();
  });

  it('returns the latest path when handleRemoteNavFile is called multiple times', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    sync.handleRemoteNavFile('alice', 'src/a.ts');
    sync.handleRemoteNavFile('alice', 'src/b.ts');

    expect(sync.getLastKnownFile('alice')).toBe('src/b.ts');
  });
});

describe('NavigationSync — onParticipantLeft', () => {
  it('clears the participant path so getLastKnownFile returns undefined', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    sync.handleRemoteNavFile('alice', 'src/index.ts');
    expect(sync.getLastKnownFile('alice')).toBe('src/index.ts');

    sync.onParticipantLeft('alice');
    expect(sync.getLastKnownFile('alice')).toBeUndefined();
  });

  it('is a no-op for an unknown participant', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    // Should not throw
    expect(() => sync.onParticipantLeft('unknown')).not.toThrow();
  });
});

describe('NavigationSync — dispose', () => {
  it('calls dispose on the subscription', () => {
    const { opts, disposeSubscription } = makeOptions();
    const sync = new NavigationSync(opts);
    sync.start();

    sync.dispose();

    expect(disposeSubscription).toHaveBeenCalledOnce();
  });

  it('is safe to call dispose when start() was never called', () => {
    const { opts } = makeOptions();
    const sync = new NavigationSync(opts);

    expect(() => sync.dispose()).not.toThrow();
  });
});

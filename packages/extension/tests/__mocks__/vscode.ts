// Minimal stub so any accidental static `import from 'vscode'` in tests
// fails loudly with a type error rather than a runtime crash
export const extensions = {
  getExtension: () => undefined,
};
export const window = {
  activeTextEditor: undefined,
};
export class Disposable {
  static from(...disposables: { dispose(): void }[]) {
    return { dispose: () => disposables.forEach((d) => d.dispose()) };
  }
  constructor() {
    // stub — real Disposable takes a callOnDispose callback
  }
  dispose() {}
}

// Minimal Uri stub. Only `Uri.file(path)` is implemented; it stores the path
// verbatim as `fsPath`. This is enough for path-normalization tests (which
// inspect `fsPath`) and lets us construct Windows-style paths under node by
// passing backslash-separated strings. Do NOT expand without need.
export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;

  private constructor(scheme: string, path: string, fsPath: string) {
    this.scheme = scheme;
    this.path = path;
    this.fsPath = fsPath;
  }

  static file(p: string): Uri {
    // Real vscode normalises backslashes to forward slashes in `path` but
    // keeps native separators in `fsPath` on Windows. We preserve the input
    // in `fsPath` so tests can exercise Windows-style separators directly.
    const posixPath = p.replace(/\\/g, '/');
    return new Uri('file', posixPath, p);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

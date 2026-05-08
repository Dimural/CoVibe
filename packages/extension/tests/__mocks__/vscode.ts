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

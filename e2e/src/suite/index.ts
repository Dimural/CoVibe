import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10_000 });
  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    glob('**/*.test.js', { cwd: testsRoot })
      .then((files: string[]) => {
        files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));
        try {
          mocha.run((failures) => {
            if (failures > 0) reject(new Error(`${failures} test(s) failed`));
            else resolve();
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })
      .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

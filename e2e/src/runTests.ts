import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // __dirname in compiled out/runTests.js will be .../e2e/out/
  // extensionDevelopmentPath: where the extension's package.json lives
  const extensionDevelopmentPath = path.resolve(__dirname, '../../packages/extension');
  // extensionTestsPath: compiled suite entry point (no .js extension needed for require)
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  try {
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    process.stderr.write(`E2E tests failed: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();

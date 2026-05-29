import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../packages/extension');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  try {
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    process.stderr.write(`E2E tests failed: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();

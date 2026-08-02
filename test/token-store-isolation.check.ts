// ABOUTME: Verifies package-script and raw Bun test invocations cannot replace a repository token store.
// It creates a known sentinel only when no token store exists, exercises auth writes, then removes the sentinel.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const repositoryStore = resolve('tokens.json');
const sentinel = Buffer.from('tools-mcp-test-token-store-sentinel\n');

if (existsSync(repositoryStore)) {
  throw new Error('Refusing to run isolation check while a repository tokens.json exists');
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed with exit code ${result.exitCode}`);
  }
}

writeFileSync(repositoryStore, sentinel, { flag: 'wx', mode: 0o600 });

try {
  const representativeTests = ['test/preload.test.ts', 'test/dcr.test.ts', 'test/auth-flow.test.ts'];

  run(['bun', 'run', 'test', ...representativeTests]);
  if (!readFileSync(repositoryStore).equals(sentinel)) {
    throw new Error('bun run test changed the repository token-store sentinel');
  }

  run(['bun', 'test', ...representativeTests]);
  if (!readFileSync(repositoryStore).equals(sentinel)) {
    throw new Error('raw bun test changed the repository token-store sentinel');
  }
} finally {
  rmSync(repositoryStore, { force: true });
}

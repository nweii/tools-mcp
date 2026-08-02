// ABOUTME: Pins the test preload contract that keeps all in-process auth state out of the repository.
import { expect, test } from 'bun:test';
import { tmpdir } from 'os';
import { isAbsolute, relative, resolve } from 'path';

test('the Bun preload isolates the OAuth token store', () => {
  const tokenStorePath = process.env.TOKEN_STORE_PATH;

  expect(process.env.TOOLS_MCP_TEST).toBe('1');
  expect(tokenStorePath).toBeDefined();
  expect(isAbsolute(tokenStorePath!)).toBe(true);
  expect(resolve(tokenStorePath!)).not.toBe(resolve('tokens.json'));

  const relativeToTemp = relative(resolve(tmpdir()), resolve(tokenStorePath!));
  expect(relativeToTemp.startsWith('..')).toBe(false);
  expect(relativeToTemp).not.toBe('');
});

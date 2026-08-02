// ABOUTME: Isolates every Bun test process from the repository and production OAuth token stores.
// It runs before test modules import the application, so auth writes always land in a disposable temp directory.
import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tokenStoreDir = mkdtempSync(join(tmpdir(), 'tools-mcp-test-'));

process.env.TOOLS_MCP_TEST = '1';
process.env.TOKEN_STORE_PATH = join(tokenStoreDir, 'tokens.json');

afterAll(() => {
  rmSync(tokenStoreDir, { recursive: true, force: true });
});

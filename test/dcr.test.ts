// ABOUTME: Dynamic client registration wiring — MCP_DCR_ENABLED opens /register so apps that can't be
// pre-configured (e.g. ChatGPT) register themselves with no per-client server change;
// MCP_DCR_ALLOWED_REDIRECT_URIS is optional hardening that also implies enabled; the approval
// password stays the gate, and DCR is off unless one of those is set.
import { test, expect, afterEach, afterAll } from 'bun:test';
import type { Server } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.MCP_CLIENT_ID ??= 'test-client';

const { createApp } = await import('../src/app.ts');

// A representative ChatGPT connector callback — unique per connector, so it can never be pre-listed.
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector/oauth/abc123';

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
afterAll(() => {
  // process.env is shared across suites — leave DCR off for whatever runs next.
  delete process.env.MCP_DCR_ENABLED;
  delete process.env.MCP_DCR_ALLOWED_REDIRECT_URIS;
  delete process.env.APPROVAL_OPEN;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Reset DCR-relevant env to a known "enabled path is available, nothing on" baseline before each case.
function resetDcrEnv(): void {
  process.env.APPROVAL_PASSWORD = 'sekret';
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.APPROVAL_OPEN;
  delete process.env.MCP_DCR_ENABLED;
  delete process.env.MCP_DCR_ALLOWED_REDIRECT_URIS;
}

// Stand up tools-mcp on a fresh port with the current process.env; returns the live base URL.
async function standup(): Promise<string> {
  process.env.TOKEN_STORE_PATH = join(tmpdir(), `tools-dcr-${process.pid}-${open.length}.json`);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  process.env.MCP_BASE_URL = base;
  const { app } = createApp();
  await new Promise<void>(resolve => {
    const s = app.listen(port, () => {
      open.push(s);
      resolve();
    });
  });
  return base;
}

async function register(base: string, redirectUri: string) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      // Mirror ChatGPT's real registration: it declares both grants, which the kit must accept.
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'ChatGPT',
    }),
  });
  return { status: res.status, body: (await res.json()) as { client_id?: string; token_endpoint_auth_method?: string } };
}

async function registrationEndpoint(base: string): Promise<unknown> {
  const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  return meta.registration_endpoint;
}

test('MCP_DCR_ENABLED opens /register and accepts a self-registered ChatGPT callback with no allowlist', async () => {
  resetDcrEnv();
  process.env.MCP_DCR_ENABLED = 'true';
  const base = await standup();
  expect(await registrationEndpoint(base)).toBe(`${base}/register`);

  const reg = await register(base, CHATGPT_CALLBACK);
  expect(reg.status).toBe(201);
  expect(typeof reg.body.client_id).toBe('string');
  expect(reg.body.token_endpoint_auth_method).toBe('none');
});

test('open registration declines plaintext http on a non-loopback host', async () => {
  resetDcrEnv();
  process.env.MCP_DCR_ENABLED = 'true';
  const base = await standup();
  expect((await register(base, 'http://chatgpt.example/cb')).status).toBe(400);
});

test('MCP_DCR_ALLOWED_REDIRECT_URIS alone enables DCR and hardens it to the listed origin', async () => {
  resetDcrEnv();
  process.env.MCP_DCR_ALLOWED_REDIRECT_URIS = 'https://chatgpt.com/*';
  const base = await standup();
  expect(await registrationEndpoint(base)).toBe(`${base}/register`);
  expect((await register(base, CHATGPT_CALLBACK)).status).toBe(201);
  expect((await register(base, 'https://evil.example/cb')).status).toBe(400);
});

test('DCR stays off when neither MCP_DCR_ENABLED nor an allowlist is set', async () => {
  resetDcrEnv();
  const base = await standup();
  expect(await registrationEndpoint(base)).toBeUndefined();
});

test('enabling DCR without an approval password refuses to boot', () => {
  resetDcrEnv();
  delete process.env.APPROVAL_PASSWORD;
  // Guard /authorize another way so only the DCR-specific password guard can fire.
  process.env.APPROVAL_OPEN = 'true';
  process.env.MCP_DCR_ENABLED = 'true';
  try {
    expect(() => createApp()).toThrow(/requires approvalPassword/);
  } finally {
    delete process.env.APPROVAL_OPEN;
    delete process.env.MCP_DCR_ENABLED;
  }
});

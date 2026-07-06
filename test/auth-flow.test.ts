// ABOUTME: HTTP contract pins for the OAuth 2.1 authorization flow — the authorize page and its
// parameter validation, the PKCE (S256) authorize→token exchange, token-endpoint error shapes,
// the static-bearer fallback, and the bearer middleware's 401 responses.
// Characterization: every assertion speaks HTTP; no auth internals are inspected.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import type { Server } from 'http';

process.env.MCP_CLIENT_ID = 'test-client';
process.env.MCP_STATIC_BEARER_TOKEN = 'static-bearer-fixture';
process.env.MCP_BASE_URL = 'http://localhost:0';

const { createApp } = await import('../src/app.ts');

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://localhost:${port}`;
      process.env.MCP_BASE_URL = base;
      resolve();
    });
  });
});

afterAll(() => server?.close());

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// POST the authorize form and return the issued code (parsed from the redirect Location) plus status.
async function approve(challenge: string) {
  const res = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const location = res.headers.get('location') ?? undefined;
  const code = location ? (new URL(location).searchParams.get('code') ?? undefined) : undefined;
  return { status: res.status, code };
}

async function exchange(code: string, verifier: string) {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'test-client',
      redirect_uri: REDIRECT,
    }),
  });
}

test('GET /authorize renders the approval page for valid params', async () => {
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Approve');
});

test('GET /authorize rejects an unknown client_id', async () => {
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=someone-else&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(400);
});

test('GET /authorize rejects a redirect_uri that is not on the allowlist', async () => {
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(400);
});

test('GET /authorize requires PKCE with S256', async () => {
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}`;
  const res = await fetch(url);
  expect(res.status).toBe(400);
});

// PIN OF TEMPORARY BEHAVIOR: POST /authorize currently issues a code to anyone who submits valid
// parameters — there is no approval-password gate. A later change adds that gate; when it does,
// this pin (a bare POST yielding a 302 + code) is expected to change to require the gate.
test('POST /authorize issues a code with no approval gate', async () => {
  const { challenge } = pkce();
  const r = await approve(challenge);
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();
});

test('full PKCE flow: authorize → exchange → token is accepted on /mcp', async () => {
  const { verifier, challenge } = pkce();
  const r = await approve(challenge);
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();

  const tok = await exchange(r.code!, verifier);
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as { access_token?: string; token_type?: string };
  expect(body.access_token).toBeTruthy();
  expect(body.token_type).toBe('bearer');

  const mcp = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  expect(mcp.status).toBe(405); // a valid token reaches the POST-only handler
});

test('token exchange fails with a bad PKCE verifier', async () => {
  const { challenge } = pkce();
  const r = await approve(challenge);
  expect(r.code).toBeTruthy();

  const tok = await exchange(r.code!, 'not-the-verifier');
  expect(tok.status).toBe(400);
  expect(((await tok.json()) as { error?: string }).error).toBe('invalid_grant');
});

test('token endpoint rejects an unsupported grant_type', async () => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe('unsupported_grant_type');
});

test('token endpoint rejects an unknown authorization code', async () => {
  const { verifier } = pkce();
  const res = await exchange('code-that-was-never-issued', verifier);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
});

test('a configured static bearer token is accepted on /mcp', async () => {
  const res = await fetch(`${base}/mcp`, {
    headers: { Authorization: 'Bearer static-bearer-fixture' },
  });
  expect(res.status).toBe(405); // reaches the POST-only handler, so the bearer was accepted
});

test('an invalid bearer token is 401 with an invalid_token challenge', async () => {
  const res = await fetch(`${base}/mcp`, {
    headers: { Authorization: 'Bearer definitely-not-a-real-token' },
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error?: string }).error).toBe('invalid_token');
  expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
});

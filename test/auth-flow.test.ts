// ABOUTME: HTTP contract pins for the OAuth 2.1 authorization flow — the approval page and its
// parameter validation, the password-gated PKCE (S256) authorize→token exchange, token-endpoint
// error shapes, the static-bearer fallback, and the bearer middleware's 401 responses.
// Characterization: every assertion speaks HTTP; no auth internals are inspected.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import type { Server } from 'http';
import { createServer } from 'net';

process.env.MCP_CLIENT_ID = 'test-client';
process.env.MCP_STATIC_BEARER_TOKEN = 'static-bearer-fixture';

const { createApp } = await import('../src/app.ts');

// A free port, so MCP_BASE_URL is final before createApp(): the SDK-backed auth bakes issuer/endpoint
// URLs at construction rather than resolving them live per request.
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

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let server: Server;
let base: string;

beforeAll(async () => {
  // The ungated authorize surface is now guarded by an approval password (createAuth refuses to
  // construct with /authorize unguarded). This suite characterizes the password gate.
  process.env.APPROVAL_PASSWORD = 'sekret';
  delete process.env.MCP_CLIENT_SECRET;
  const port = await freePort();
  base = `http://localhost:${port}`;
  process.env.MCP_BASE_URL = base;
  const { app } = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(port, () => resolve());
  });
});

afterAll(() => {
  server?.close();
  delete process.env.APPROVAL_PASSWORD;
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// POST the approval form (with the approval password) and return the issued code, parsed from the
// redirect Location, plus status.
async function approve(challenge: string, password = 'sekret') {
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
      password,
    }),
  });
  const location = res.headers.get('location') ?? undefined;
  const code = location ? (new URL(location).searchParams.get('code') ?? undefined) : undefined;
  return { status: res.status, code };
}

async function exchange(code: string, verifier: string) {
  // Re-pin (delta: token endpoint /oauth/token → /token).
  return fetch(`${base}/token`, {
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
  // Re-pin (delta: unknown client_id is a 400 JSON invalid_client, not 400 plaintext). No trusted
  // redirect target for an unknown client, so the SDK responds directly rather than redirecting.
  const res = await fetch(url);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe('invalid_client');
});

test('GET /authorize rejects a redirect_uri that is not on the allowlist', async () => {
  const { challenge } = pkce();
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  expect(res.status).toBe(400);
});

test('GET /authorize requires PKCE with S256', async () => {
  const url = `${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(REDIRECT)}`;
  // Re-pin (delta: missing PKCE is an OAuth-spec 302 redirect to the client callback with error
  // params, not a 400 plaintext). client_id and redirect_uri are valid, so the SDK can redirect.
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('error')).toBe('invalid_request');
});

test('POST /authorize with the approval password issues a code', async () => {
  // Re-pin (the ungated authorize is now password-guarded): the correct password yields a 302 + code.
  const { challenge } = pkce();
  const r = await approve(challenge);
  expect(r.status).toBe(302);
  expect(r.code).toBeTruthy();
});

test('POST /authorize with a wrong password issues no code', async () => {
  const { challenge } = pkce();
  const r = await approve(challenge, 'wrong');
  expect(r.status).toBe(401);
  expect(r.code).toBeUndefined();
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

test('a token request with no client_id fails client auth before grant_type validation', async () => {
  // Re-pin (delta: client auth now runs BEFORE grant_type validation, and the endpoint moved to
  // /token). The old server rejected the grant_type first with unsupported_grant_type; the SDK rejects
  // the missing client credential first.
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe('invalid_request');
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

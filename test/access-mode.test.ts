// ABOUTME: MCP_AUTH=access: the server serves /mcp only to requests carrying a valid Cloudflare Access
// JWT for ACCESS_AUD, needs no MCP_CLIENT_ID or approval guard, and mounts none of its own OAuth routes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'crypto';
import type { Server } from 'http';
import express from 'express';
import type { Express } from 'express';

const AUDIENCE = 'tools-aud';
const SAVED_KEYS = ['MCP_AUTH', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'MCP_CLIENT_ID', 'APPROVAL_OPEN', 'APPROVAL_PASSWORD', 'MCP_CLIENT_SECRET'];

let createApp: () => { app: Express; auth: unknown };
let team: Server;
let issuer: string;
const saved: Record<string, string | undefined> = {};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Mints a JWT the way Access does for a Managed OAuth connection.
function mint(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [AUDIENCE], email: 'owner@example.com', sub: 'user-1', iat: now, exp: now + 900,
    oauth: { client_id: 'connection-1' }, ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

beforeAll(async () => {
  const teamApp = express();
  teamApp.get('/cdn-cgi/access/certs', (_req, res) => {
    res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  });
  team = teamApp.listen(0, '127.0.0.1');
  await new Promise(resolve => team.once('listening', resolve));
  issuer = `http://127.0.0.1:${(team.address() as { port: number }).port}`;

  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  for (const k of ['MCP_CLIENT_ID', 'APPROVAL_OPEN', 'APPROVAL_PASSWORD', 'MCP_CLIENT_SECRET']) delete process.env[k];
  Object.assign(process.env, { MCP_AUTH: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: AUDIENCE });
  createApp = (await import('../src/app.ts')).createApp;
});

afterAll(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  team.close();
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function listTools(base: string, jwt?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

describe('with MCP_AUTH=access', () => {
  test('starts without MCP_CLIENT_ID or an approval guard, and has no token store', () => {
    expect(createApp().auth).toBeUndefined();
  });

  test('serves /mcp to a request carrying a valid Access JWT', async () => {
    await withServer(async base => {
      expect((await listTools(base, mint())).status).toBe(200);
    });
  });

  test('refuses requests without a valid Access JWT', async () => {
    await withServer(async base => {
      expect((await listTools(base)).status).toBe(403);
      expect((await listTools(base, mint({ aud: ['other-app'] }))).status).toBe(403);
      expect((await listTools(base, mint().slice(0, -4) + 'AAAA')).status).toBe(403);
    });
  });

  test("mounts none of the server's own OAuth routes", async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/authorize`)).status).toBe(404);
      expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    });
  });

  test('refuses to start without the Access settings', () => {
    delete process.env.ACCESS_AUD;
    try {
      expect(() => createApp()).toThrow(/ACCESS_AUD/);
    } finally {
      process.env.ACCESS_AUD = AUDIENCE;
    }
  });
});

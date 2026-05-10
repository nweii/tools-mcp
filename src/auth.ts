// ABOUTME: OAuth 2.1 authorization server — discovery, authorization code flow with PKCE, token issuance, and bearer-token middleware.
import type { Request, Response, NextFunction } from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH ?? './tokens.json';
const SERVER_DISPLAY_NAME = process.env.MCP_SERVER_DISPLAY_NAME ?? 'nweii-tools-mcp';

// In-memory stores
const tokens = new Map<string, number>();
const authCodes = new Map<string, PendingCode>();

// --- Token persistence -------------------------------------------------------

function loadPersistedTokens() {
  try {
    const data = JSON.parse(readFileSync(TOKEN_STORE_PATH, 'utf-8')) as Record<string, number>;
    const now = Date.now();
    for (const [token, expiry] of Object.entries(data)) {
      if (expiry > now) tokens.set(token, expiry);
    }
    console.log(`[auth] loaded ${tokens.size} token(s) from ${TOKEN_STORE_PATH}`);
  } catch {
    // no store yet — start fresh
  }
}

export function saveTokens() {
  try {
    const data: Record<string, number> = {};
    for (const [token, expiry] of tokens) data[token] = expiry;
    writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data));
  } catch (err) {
    console.error('[auth] failed to save token store:', err);
  }
}

if (process.env.TOOLS_MCP_TEST !== '1') loadPersistedTokens();

interface PendingCode {
  codeChallenge: string;
  codeChallengeMethod: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  expiresAt: number;
}

// --- Helpers -----------------------------------------------------------------

function getBaseUrl(): string {
  return process.env.MCP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3457}`;
}

function getClientId(): string {
  const id = process.env.MCP_CLIENT_ID;
  if (!id) throw new Error('MCP_CLIENT_ID env var is required');
  return id;
}

function getClientSecret(): string | undefined {
  const secret = process.env.MCP_CLIENT_SECRET?.trim();
  return secret ? secret : undefined;
}

function getAllowedRedirectUris(): string[] {
  const env = process.env.MCP_ALLOWED_REDIRECT_URIS;
  if (env) return env.split(',').map((u) => u.trim());
  return ['https://claude.ai/api/mcp/auth_callback'];
}

function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of tokens) if (now > v) tokens.delete(k);
  for (const [k, v] of authCodes) if (now > v.expiresAt) authCodes.delete(k);
}

function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wwwAuthenticate(extra = ''): string {
  const meta = `resource_metadata="${getBaseUrl()}/.well-known/oauth-protected-resource"`;
  return extra ? `Bearer ${meta}, ${extra}` : `Bearer ${meta}`;
}

// --- Discovery endpoints -----------------------------------------------------

export function protectedResourceHandler(_req: Request, res: Response) {
  const base = getBaseUrl();
  res.json({ resource: base, authorization_servers: [base] });
}

export function discoveryHandler(_req: Request, res: Response) {
  const base = getBaseUrl();
  const clientSecret = getClientSecret();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: clientSecret ? ['client_secret_post'] : ['client_secret_post', 'none'],
  });
}

// --- Authorization endpoint --------------------------------------------------

export function authorizationHandler(req: Request, res: Response) {
  const q = req.query as Record<string, string>;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = q;

  if (response_type !== 'code') {
    res.status(400).send('Unsupported response_type');
    return;
  }
  if (client_id !== getClientId()) {
    res.status(400).send('Unknown client_id');
    return;
  }
  if (!getAllowedRedirectUris().includes(redirect_uri)) {
    res.status(400).send('redirect_uri not allowed');
    return;
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    res.status(400).send('PKCE with S256 is required');
    return;
  }

  const params: [string, string][] = [
    ['response_type', response_type],
    ['client_id', client_id],
    ['redirect_uri', redirect_uri],
    ['code_challenge', code_challenge],
    ['code_challenge_method', code_challenge_method],
    ...(state ? [['state', state] as [string, string]] : []),
    ...(scope ? [['scope', scope] as [string, string]] : []),
  ];

  const inputs = params
    .map(([name, val]) => `<input type="hidden" name="${name}" value="${escapeHtml(val)}">`)
    .join('\n    ');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize ${escapeHtml(SERVER_DISPLAY_NAME)}</title>
  <style>
    body   { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 1rem; color: #111; }
    h1     { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p      { color: #555; margin-bottom: 1.5rem; }
    button { padding: 0.5rem 1.5rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Authorize ${escapeHtml(SERVER_DISPLAY_NAME)}</h1>
  <p>Allow this client to call your personal MCP tools?</p>
  <form method="POST" action="/authorize">
    ${inputs}
    <button type="submit">Approve</button>
  </form>
</body>
</html>`);
}

export function authorizationApproveHandler(req: Request, res: Response) {
  const b = req.body as Record<string, string>;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = b;

  if (response_type !== 'code' || client_id !== getClientId()) {
    res.status(400).send('Invalid request');
    return;
  }
  if (!getAllowedRedirectUris().includes(redirect_uri)) {
    res.status(400).send('redirect_uri not allowed');
    return;
  }

  const code = randomUUID();
  authCodes.set(code, {
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

// --- Token endpoint ----------------------------------------------------------

export function tokenHandler(req: Request, res: Response) {
  const { grant_type, code, code_verifier, client_id, client_secret, redirect_uri } = req.body as Record<string, string>;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code) {
    res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
    return;
  }

  pruneExpired();
  const pending = authCodes.get(code);
  if (!pending) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code' });
    return;
  }
  if (client_id !== pending.clientId || redirect_uri !== pending.redirectUri) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  const expectedSecret = getClientSecret();
  if (expectedSecret) {
    if (client_secret !== expectedSecret) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
  } else if (client_secret !== undefined) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }
  if (!verifyPKCE(code_verifier ?? '', pending.codeChallenge)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }

  authCodes.delete(code);
  const token = randomUUID();
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  saveTokens();
  res.json({ access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000 });
}

// --- Auth middleware ----------------------------------------------------------

export function validateToken(token: string): boolean {
  pruneExpired();
  const expiry = tokens.get(token);
  return expiry !== undefined && Date.now() <= expiry;
}

function getStaticBearerToken(): string | undefined {
  const t = process.env.MCP_STATIC_BEARER_TOKEN?.trim();
  return t ? t : undefined;
}

function bearerMatchesStatic(token: string): boolean {
  const expected = getStaticBearerToken();
  if (!expected) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function seedTestToken(): string {
  if (process.env.TOOLS_MCP_TEST !== '1') {
    throw new Error('seedTestToken is only for automated tests (set TOOLS_MCP_TEST=1)');
  }
  pruneExpired();
  const token = randomUUID();
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', wwwAuthenticate());
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  if (!bearerMatchesStatic(token) && !validateToken(token)) {
    res.setHeader('WWW-Authenticate', wwwAuthenticate('error="invalid_token"'));
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  next();
}

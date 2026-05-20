// ABOUTME: Express application factory — OAuth, well-known metadata, and stateless MCP. Used by server entry and tests.
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  authMiddleware,
  authorizationApproveHandler,
  authorizationHandler,
  discoveryHandler,
  protectedResourceHandler,
  tokenHandler,
} from './auth.js';
import { registerAllTools } from './tools.js';

function ts(): string {
  return new Date().toISOString();
}

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded?.split(',')[0] ?? req.socket.remoteAddress ?? '?');
  return ip.trim();
}

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${ts()}] ${clientIp(req)} ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

function getAllowedOrigins(): string[] | null {
  const env = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (!env || env === '*') return null;
  return env.split(',').map((origin) => origin.trim()).filter(Boolean);
}

function setCorsHeaders(req: Request, res: Response): boolean {
  const allowedOrigins = getAllowedOrigins();
  const origin = req.headers.origin;

  if (allowedOrigins === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (req.method === 'OPTIONS' && origin) {
    res.status(403).end();
    return false;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  return true;
}

const SERVER_NAME = 'tools-mcp';
const SERVER_VERSION = '0.1.0';

export function createApp(): Express {
  const app = express();

  app.use((req, res, next) => {
    if (!setCorsHeaders(req, res)) return;
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Liveness probe — useful behind a reverse proxy / health checks.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  // OAuth discovery (unauthenticated)
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-authorization-server', discoveryHandler);

  // Authorization code flow
  app.get('/authorize', authorizationHandler);
  app.post('/authorize', authorizationApproveHandler);
  app.post('/oauth/token', tokenHandler);

  app.get('/mcp', authMiddleware, (_req, res) => {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).end();
  });

  app.post('/mcp', authMiddleware, async (req, res) => {
    const body = req.body as { method?: string; params?: { name?: string } };
    const mcpMethod = body?.method ?? '?';
    const toolName = body?.params?.name;
    console.log(`[${ts()}] MCP ${mcpMethod}${toolName ? ` (${toolName})` : ''}`);

    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

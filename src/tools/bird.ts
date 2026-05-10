// ABOUTME: Registers MCP tools that wrap the @steipete/bird CLI for X/Twitter — read, search, mentions, bookmarks, thread, post, reply.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CliError, parseJsonOutput, runCli } from '../exec.js';

const BIRD_BIN = process.env.BIRD_BIN ?? './node_modules/.bin/bird';

function getCookies(): { authToken: string; ct0: string } {
  const authToken = process.env.BIRD_AUTH_TOKEN?.trim();
  const ct0 = process.env.BIRD_CT0?.trim();
  if (!authToken || !ct0) {
    throw new Error(
      'Bird credentials not configured. Set BIRD_AUTH_TOKEN and BIRD_CT0 in the server environment ' +
        '(extract from a logged-in browser; cookies named auth_token and ct0 on x.com).',
    );
  }
  return { authToken, ct0 };
}

function birdArgs(extra: readonly string[]): string[] {
  const { authToken, ct0 } = getCookies();
  return ['--auth-token', authToken, '--ct0', ct0, ...extra];
}

async function runBirdJson<T>(extra: readonly string[]): Promise<T> {
  const args = birdArgs([...extra, '--json']);
  const { stdout } = await runCli(BIRD_BIN, args, { timeoutMs: 45_000 });
  return parseJsonOutput<T>(stdout);
}

async function runBirdText(extra: readonly string[]): Promise<string> {
  const args = birdArgs([...extra, '--plain', '--no-emoji', '--no-color']);
  const { stdout } = await runCli(BIRD_BIN, args, { timeoutMs: 45_000 });
  return stdout.trim();
}

function toJsonResult(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  // MCP requires structuredContent to be a JSON object, not an array or primitive.
  // Wrap arrays so callers can still read parsed data structurally.
  const structured: Record<string, unknown> | undefined = Array.isArray(data)
    ? { items: data }
    : data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function toTextResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(err: unknown) {
  const msg =
    err instanceof CliError
      ? `bird failed (exit ${err.exitCode ?? 'n/a'})\n${err.stderr.trim() || err.stdout.trim() || err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

export function registerBirdTools(server: McpServer) {
  server.registerTool(
    'bird_whoami',
    {
      title: 'Bird: who am I',
      description:
        'Verify which X/Twitter account the configured cookies authenticate as. Use to debug auth issues before other bird tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return toTextResult(await runBirdText(['whoami']));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_read',
    {
      title: 'Bird: read tweet',
      description:
        'Read a single tweet by ID or full URL. Returns the tweet, author, metrics, and any quoted tweet (one level deep).',
      inputSchema: {
        id_or_url: z.string().min(1).describe('Tweet ID (e.g. "1234567890") or full URL.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id_or_url }) => {
      try {
        return toJsonResult(await runBirdJson(['read', id_or_url]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_thread',
    {
      title: 'Bird: read thread',
      description:
        'Return the full conversation thread containing a tweet. Useful for catching up on a discussion or quoting context. Inputs: tweet ID or URL anywhere in the thread.',
      inputSchema: {
        id_or_url: z.string().min(1).describe('Tweet ID or URL anywhere in the thread.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id_or_url }) => {
      try {
        return toJsonResult(await runBirdJson(['thread', id_or_url]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_replies',
    {
      title: 'Bird: list replies',
      description: 'List replies to a specific tweet.',
      inputSchema: {
        id_or_url: z.string().min(1).describe('Tweet ID or URL whose replies to list.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id_or_url }) => {
      try {
        return toJsonResult(await runBirdJson(['replies', id_or_url]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_search',
    {
      title: 'Bird: search tweets',
      description:
        'Search X/Twitter. Supports the same operators as the search box ("from:user", "@handle", quoted phrases, "since:YYYY-MM-DD", etc.). Default 10 results; raise count for more.',
      inputSchema: {
        query: z.string().min(1).describe('Search query, e.g. \'from:steipete "MCP"\'.'),
        count: z.number().int().min(1).max(100).optional().describe('Max tweets to return (default 10).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, count }) => {
      try {
        const args = ['search', query];
        if (count) args.push('--count', String(count));
        return toJsonResult(await runBirdJson(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_mentions',
    {
      title: 'Bird: mentions',
      description:
        'Tweets mentioning a user. Defaults to the authenticated account when `user` is omitted — useful for triaging your own notifications.',
      inputSchema: {
        user: z
          .string()
          .optional()
          .describe('Handle to query (with or without @). Omit for the authenticated user.'),
        count: z.number().int().min(1).max(100).optional().describe('Max tweets (default 10).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ user, count }) => {
      try {
        const args = ['mentions'];
        if (user) args.push('--user', user);
        if (count) args.push('--count', String(count));
        return toJsonResult(await runBirdJson(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_bookmarks',
    {
      title: 'Bird: bookmarks',
      description:
        'Read your X bookmarks (the authenticated account). Useful for triaging saved-for-later content. Optional folder ID for bookmark collections.',
      inputSchema: {
        count: z.number().int().min(1).max(100).optional().describe('Max bookmarks (default 20).'),
        folder_id: z.string().optional().describe('Bookmark folder/collection ID.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ count, folder_id }) => {
      try {
        const args = ['bookmarks'];
        if (count) args.push('--count', String(count));
        if (folder_id) args.push('--folder-id', folder_id);
        return toJsonResult(await runBirdJson(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_post_tweet',
    {
      title: 'Bird: post tweet',
      description:
        'Post a new tweet from the authenticated account. WRITE OPERATION — confirm with the user before calling. Returns bird CLI output identifying the new tweet.',
      inputSchema: {
        text: z.string().min(1).max(4000).describe('Tweet body. X enforces its own length limit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ text }) => {
      try {
        return toTextResult(await runBirdText(['tweet', text]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'bird_reply',
    {
      title: 'Bird: reply',
      description:
        'Reply to an existing tweet from the authenticated account. WRITE OPERATION — confirm with the user before calling.',
      inputSchema: {
        id_or_url: z.string().min(1).describe('Tweet ID or URL to reply to.'),
        text: z.string().min(1).max(4000).describe('Reply body.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id_or_url, text }) => {
      try {
        return toTextResult(await runBirdText(['reply', id_or_url, text]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

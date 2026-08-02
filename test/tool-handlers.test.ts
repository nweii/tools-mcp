// ABOUTME: No-network handler checks preserve Bird CLI arguments and representative Browser and Perplexity request/result behavior through the SDK v2 registration surface.
import { expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerBirdTools } from '../src/tools/bird.ts';
import { registerBrowserTools } from '../src/tools/browser.ts';
import { registerPerplexityTools } from '../src/tools/perplexity.ts';

type ToolHandler = (args: any) => Promise<any>;
type RegisteredTool = { config: Record<string, any>; handler: ToolHandler };

function capture(register: (server: McpServer) => void): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: Record<string, any>, handler: ToolHandler) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  register(server);
  return tools;
}

function textFrom(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === 'text')?.text ?? '';
}

test('Bird post and reply preserve write annotations and exact CLI argument ordering', async () => {
  const previous = {
    bin: process.env.BIRD_BIN,
    auth: process.env.BIRD_AUTH_TOKEN,
    ct0: process.env.BIRD_CT0,
  };
  process.env.BIRD_BIN = '/bin/echo';
  process.env.BIRD_AUTH_TOKEN = 'fixture-auth';
  process.env.BIRD_CT0 = 'fixture-ct0';
  try {
    const tools = capture(registerBirdTools);
    const writeAnnotations = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    };
    expect(tools.get('bird_post_tweet')?.config.annotations).toEqual(writeAnnotations);
    expect(tools.get('bird_reply')?.config.annotations).toEqual(writeAnnotations);

    const post = await tools.get('bird_post_tweet')!.handler({ text: 'hello world' });
    expect(textFrom(post)).toBe(
      '--auth-token fixture-auth --ct0 fixture-ct0 tweet hello world --plain --no-emoji --no-color',
    );

    const reply = await tools.get('bird_reply')!.handler({ id_or_url: '123', text: 'a reply' });
    expect(textFrom(reply)).toBe(
      '--auth-token fixture-auth --ct0 fixture-ct0 reply 123 a reply --plain --no-emoji --no-color',
    );
  } finally {
    if (previous.bin === undefined) delete process.env.BIRD_BIN;
    else process.env.BIRD_BIN = previous.bin;
    if (previous.auth === undefined) delete process.env.BIRD_AUTH_TOKEN;
    else process.env.BIRD_AUTH_TOKEN = previous.auth;
    if (previous.ct0 === undefined) delete process.env.BIRD_CT0;
    else process.env.BIRD_CT0 = previous.ct0;
  }
});

test.serial('Browser markdown preserves the API request and structured result without network access', async () => {
  const previousFetch = globalThis.fetch;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'fixture-account';
  process.env.CLOUDFLARE_API_TOKEN = 'fixture-token';
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return Response.json({ success: true, result: '# Rendered' });
  }) as typeof fetch;
  try {
    const result = await capture(registerBrowserTools).get('browser_markdown')!.handler({
      url: 'https://example.com/',
      gotoOptions: { waitUntil: 'load' },
      rejectResourceTypes: ['image'],
    });
    expect(request?.url).toEndWith('/accounts/fixture-account/browser-rendering/markdown');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      url: 'https://example.com/',
      gotoOptions: { waitUntil: 'load' },
      rejectResourceTypes: ['image'],
    });
    expect(textFrom(result)).toBe('# Rendered');
    expect(result.structuredContent).toEqual({ markdown: '# Rendered' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test.serial('Perplexity ask preserves the model request and citation result without network access', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'fixture-key';
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      choices: [{ message: { content: 'Answer' } }],
      citations: ['https://example.com/source'],
    });
  }) as typeof fetch;
  try {
    const result = await capture(registerPerplexityTools).get('perplexity_ask')!.handler({
      messages: [{ role: 'user', content: 'Question' }],
      search_recency_filter: 'week',
      search_domain_filter: ['example.com'],
      search_context_size: 'high',
    });
    expect(requestBody).toEqual({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: 'Question' }],
      search_recency_filter: 'week',
      search_domain_filter: ['example.com'],
      web_search_options: { search_context_size: 'high' },
    });
    expect(textFrom(result)).toBe('Answer\n\nCitations:\n[1] https://example.com/source');
    expect(result.structuredContent).toEqual({
      response: 'Answer\n\nCitations:\n[1] https://example.com/source',
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
  }
});

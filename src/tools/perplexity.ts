// ABOUTME: Registers MCP tools that call the Perplexity AI REST API directly — search, ask, research, reason.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const PERPLEXITY_BASE_URL = process.env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai';
const VERSION = '0.1.0';

function getApiKey(): string {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'Perplexity not configured. Set PERPLEXITY_API_KEY in the server environment ' +
        '(get a key at https://www.perplexity.ai/account/api/group).',
    );
  }
  return key;
}

function getTimeoutMs(): number {
  return parseInt(process.env.PERPLEXITY_TIMEOUT_MS ?? '300000', 10);
}

async function callApi(endpoint: string, body: Record<string, unknown>, stream = false): Promise<Response> {
  const url = `${PERPLEXITY_BASE_URL}/${endpoint}`;
  const controller = new AbortController();
  const timeoutMs = getTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getApiKey()}`,
        'User-Agent': `nweii-tools-mcp/${VERSION}`,
        'X-Source': 'nweii-tools-mcp',
      },
      body: JSON.stringify(stream ? { ...body, stream: true } : body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Perplexity API ${response.status} ${response.statusText}: ${text || '(no body)'}`);
    }
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Perplexity API timed out after ${timeoutMs}ms. Set PERPLEXITY_TIMEOUT_MS higher if the model is slow.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type ChatChoice = { message: { content: string } };
type ChatResponse = { choices: ChatChoice[]; citations?: string[] };

async function consumeSseChat(response: Response): Promise<ChatResponse> {
  if (!response.body) throw new Error('Perplexity API returned an empty stream.');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let citations: string[] | undefined;
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed.citations)) citations = parsed.citations;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') parts.push(delta);
      } catch {
        // skip malformed chunk
      }
    }
  }
  return { choices: [{ message: { content: parts.join('') } }], ...(citations && { citations }) };
}

function appendCitations(text: string, citations?: string[]): string {
  if (!citations?.length) return text;
  const list = citations.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  return `${text}\n\nCitations:\n${list}`;
}

function stripThinkingTokens(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const messagesField = z.array(messageSchema).min(1).describe('Conversation history; the last message is the question.');
const recencyField = z
  .enum(['hour', 'day', 'week', 'month', 'year'])
  .optional()
  .describe('Restrict web sources to this recency window.');
const domainFilterField = z
  .array(z.string())
  .optional()
  .describe('Restrict sources to these domains. Prefix with `-` to exclude (e.g. "-reddit.com").');
const contextSizeField = z
  .enum(['low', 'medium', 'high'])
  .optional()
  .describe('How much web context to include in the answer.');
const stripThinkingField = z
  .boolean()
  .optional()
  .describe('If true, remove <think>…</think> chain-of-thought blocks from the answer.');
const reasoningEffortField = z
  .enum(['minimal', 'low', 'medium', 'high'])
  .optional()
  .describe('Depth of the research run; higher = more sources and longer wait.');

type ChatOptions = {
  search_recency_filter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  search_domain_filter?: string[];
  search_context_size?: 'low' | 'medium' | 'high';
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
};

async function chatCompletion(
  messages: z.infer<typeof messagesField>,
  model: string,
  stripThinking: boolean,
  options: ChatOptions,
): Promise<string> {
  const useStream = model === 'sonar-deep-research';
  const body: Record<string, unknown> = { model, messages };
  if (options.search_recency_filter) body.search_recency_filter = options.search_recency_filter;
  if (options.search_domain_filter) body.search_domain_filter = options.search_domain_filter;
  if (options.search_context_size) body.web_search_options = { search_context_size: options.search_context_size };
  if (options.reasoning_effort) body.reasoning_effort = options.reasoning_effort;

  const response = await callApi('chat/completions', body, useStream);
  const data: ChatResponse = useStream ? await consumeSseChat(response) : await response.json();
  let content = data.choices?.[0]?.message?.content ?? '';
  if (stripThinking) content = stripThinkingTokens(content);
  return appendCitations(content, data.citations);
}

type SearchResultItem = { title: string; url: string; snippet?: string; date?: string };
type SearchResponseBody = { results: SearchResultItem[] };

function formatSearchResults(data: SearchResponseBody): string {
  if (!Array.isArray(data.results) || data.results.length === 0) {
    return 'No search results found.';
  }
  const header = `Found ${data.results.length} search results:\n\n`;
  const lines = data.results.map((r, i) => {
    const parts = [`${i + 1}. **${r.title}**`, `   URL: ${r.url}`];
    if (r.snippet) parts.push(`   ${r.snippet}`);
    if (r.date) parts.push(`   Date: ${r.date}`);
    return parts.join('\n');
  });
  return header + lines.join('\n\n') + '\n';
}

function toTextResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerPerplexityTools(server: McpServer) {
  server.registerTool(
    'perplexity_search',
    {
      title: 'Perplexity: search the web',
      description:
        'Search the web via Perplexity. Returns a ranked list of results with titles, URLs, snippets, and dates — no AI synthesis. ' +
        'For AI-generated answers with citations, use perplexity_ask instead.',
      inputSchema: {
        query: z.string().min(1).describe('Search query string.'),
        max_results: z.number().int().min(1).max(20).optional().describe('Max results (1-20, default 10).'),
        max_tokens_per_page: z
          .number()
          .int()
          .min(256)
          .max(2048)
          .optional()
          .describe('Max tokens to extract per page (default 1024).'),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO 3166-1 alpha-2 country code for regional results (e.g. "US", "GB").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, max_results, max_tokens_per_page, country }) => {
      try {
        const body: Record<string, unknown> = {
          query,
          max_results: max_results ?? 10,
          max_tokens_per_page: max_tokens_per_page ?? 1024,
        };
        if (country) body.country = country;
        const response = await callApi('search', body);
        const data = (await response.json()) as SearchResponseBody;
        const formatted = formatSearchResults(data);
        return toTextResult(formatted, { results: formatted });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'perplexity_ask',
    {
      title: 'Perplexity: ask',
      description:
        'Web-grounded answer using the Sonar Pro model. Best for quick factual questions, summaries, and explanations. ' +
        'Returns text with numbered citations. Cheapest and fastest of the chat tools. ' +
        'For deeper investigation use perplexity_research; for step-by-step logic use perplexity_reason.',
      inputSchema: {
        messages: messagesField,
        search_recency_filter: recencyField,
        search_domain_filter: domainFilterField,
        search_context_size: contextSizeField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ messages, search_recency_filter, search_domain_filter, search_context_size }) => {
      try {
        const text = await chatCompletion(messages, 'sonar-pro', false, {
          search_recency_filter,
          search_domain_filter,
          search_context_size,
        });
        return toTextResult(text, { response: text });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'perplexity_research',
    {
      title: 'Perplexity: deep research',
      description:
        'Comprehensive multi-source research using the Sonar Deep Research model. Best for literature reviews and investigative queries needing many sources. ' +
        'SLOW — 30s+ per call. Returns a detailed response with numbered citations.',
      inputSchema: {
        messages: messagesField,
        strip_thinking: stripThinkingField,
        reasoning_effort: reasoningEffortField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ messages, strip_thinking, reasoning_effort }) => {
      try {
        const text = await chatCompletion(messages, 'sonar-deep-research', strip_thinking === true, {
          reasoning_effort,
        });
        return toTextResult(text, { response: text });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'perplexity_reason',
    {
      title: 'Perplexity: reason',
      description:
        'Step-by-step reasoning with web grounding using the Sonar Reasoning Pro model. Best for math, comparisons, complex arguments, and chain-of-thought tasks. ' +
        'Returns a reasoned response with numbered citations.',
      inputSchema: {
        messages: messagesField,
        strip_thinking: stripThinkingField,
        search_recency_filter: recencyField,
        search_domain_filter: domainFilterField,
        search_context_size: contextSizeField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ messages, strip_thinking, search_recency_filter, search_domain_filter, search_context_size }) => {
      try {
        const text = await chatCompletion(messages, 'sonar-reasoning-pro', strip_thinking === true, {
          search_recency_filter,
          search_domain_filter,
          search_context_size,
        });
        return toTextResult(text, { response: text });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

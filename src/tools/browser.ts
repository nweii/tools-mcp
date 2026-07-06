// ABOUTME: Registers MCP tools that call the Cloudflare Browser Rendering (Browser Run) REST API — render pages to Markdown/HTML, screenshot, scrape elements, multi-format snapshot, and extract links.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult } from 'mcp-server-kit';

const VERSION = '0.1.0';
const API_BASE = process.env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4';

function getAccountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!id) {
    throw new Error(
      'Cloudflare Browser Rendering not configured. Set CLOUDFLARE_ACCOUNT_ID in the server environment ' +
        '(Cloudflare dashboard → Workers & Pages → Overview, or the hex string in any dashboard URL).',
    );
  }
  return id;
}

function getApiToken(): string {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'Cloudflare Browser Rendering not configured. Set CLOUDFLARE_API_TOKEN in the server environment ' +
        '(create one at https://dash.cloudflare.com/profile/api-tokens with the "Browser Rendering — Edit" permission).',
    );
  }
  return token;
}

function getTimeoutMs(): number {
  return parseInt(process.env.BROWSER_RENDERING_TIMEOUT_MS ?? '120000', 10);
}

async function callBrowser(endpoint: string, body: Record<string, unknown>): Promise<Response> {
  const url = `${API_BASE}/accounts/${getAccountId()}/browser-rendering/${endpoint}`;
  const controller = new AbortController();
  const timeoutMs = getTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getApiToken()}`,
        'User-Agent': `tools-mcp/${VERSION}`,
      },
      // JSON.stringify drops keys whose value is undefined, so optional fields fall away cleanly.
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Cloudflare Browser Rendering timed out after ${timeoutMs}ms. ` +
          'Raise BROWSER_RENDERING_TIMEOUT_MS, or narrow the load with rejectResourceTypes.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type CfEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: { code?: number; message: string }[];
};

// Cloudflare wraps JSON responses in {success, result, errors}. Unwrap to result, or throw a humanized error.
export async function readJsonResult<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!response.ok || !data?.success) {
    const detail =
      data?.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
      `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare Browser Rendering error: ${detail}`);
  }
  return data.result;
}

type ImageContent = { type: 'image'; mimeType: string; data: string };

// /screenshot returns raw image bytes on success and a JSON error envelope otherwise.
export async function imageContentFromResponse(response: Response): Promise<ImageContent> {
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!response.ok || !contentType.startsWith('image/')) {
    await readJsonResult(response); // reads the envelope and throws its message
    throw new Error('Cloudflare Browser Rendering returned no image.');
  }
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return { type: 'image', mimeType: contentType || 'image/png', data };
}

// A human-readable text block plus a structuredContent object carrying the same payload — distinct
// from the kit's jsonResult (whose text is the JSON itself) and textResult (which has no structured
// field), so it stays local.
function toTextResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

const urlField = z.string().url().describe('URL of the page to render.');

const gotoOptionsField = z
  .object({
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
      .optional()
      .describe('When navigation is considered finished (default "load").'),
    timeout: z.number().int().min(0).max(120000).optional().describe('Max navigation time in ms (default 30000).'),
  })
  .optional()
  .describe('Page navigation options for the headless browser.');

const rejectResourceTypesField = z
  .array(z.enum(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'websocket', 'manifest', 'other']))
  .optional()
  .describe('Block these resource types to speed up rendering and cut billed browser time, e.g. ["image","font","media"].');

export function registerBrowserTools(server: McpServer) {
  server.registerTool(
    'browser_markdown',
    {
      title: 'Browser: page to Markdown',
      description:
        'Render a web page in a headless cloud browser and return its content as clean Markdown. ' +
        'Handles JavaScript-rendered pages that a plain fetch cannot. Billed on browser time (Cloudflare Browser Rendering).',
      inputSchema: { url: urlField, gotoOptions: gotoOptionsField, rejectResourceTypes: rejectResourceTypesField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, gotoOptions, rejectResourceTypes }) => {
      try {
        const response = await callBrowser('markdown', { url, gotoOptions, rejectResourceTypes });
        const result = await readJsonResult<string>(response);
        return toTextResult(result, { markdown: result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_content',
    {
      title: 'Browser: page HTML',
      description:
        'Render a web page in a headless cloud browser and return its full post-JavaScript HTML. ' +
        'Use browser_markdown for readable text; use this when you need the raw rendered DOM.',
      inputSchema: { url: urlField, gotoOptions: gotoOptionsField, rejectResourceTypes: rejectResourceTypesField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, gotoOptions, rejectResourceTypes }) => {
      try {
        const response = await callBrowser('content', { url, gotoOptions, rejectResourceTypes });
        const result = await readJsonResult<string>(response);
        return toTextResult(result, { html: result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Browser: screenshot',
      description:
        'Capture a screenshot of a web page from a headless cloud browser and return it as an image. ' +
        'The only way to "see" a page from a client with no local browser (mobile, headless server). Billed on browser time.',
      inputSchema: {
        url: urlField,
        viewport: z
          .object({
            width: z.number().int().positive().describe('Viewport width in pixels.'),
            height: z.number().int().positive().describe('Viewport height in pixels.'),
          })
          .optional()
          .describe('Browser viewport size (default 800×600).'),
        screenshotOptions: z
          .object({
            fullPage: z.boolean().optional().describe('Capture the full scrollable page, not just the viewport.'),
            type: z.enum(['png', 'jpeg', 'webp']).optional().describe('Image format (default png).'),
            omitBackground: z.boolean().optional().describe('Transparent background where the page allows it.'),
          })
          .optional(),
        gotoOptions: gotoOptionsField,
        rejectResourceTypes: rejectResourceTypesField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, viewport, screenshotOptions, gotoOptions, rejectResourceTypes }) => {
      try {
        const response = await callBrowser('screenshot', {
          url,
          viewport,
          screenshotOptions,
          gotoOptions,
          rejectResourceTypes,
        });
        const image = await imageContentFromResponse(response);
        return { content: [image] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_scrape',
    {
      title: 'Browser: scrape elements',
      description:
        'Render a page and extract the elements matching each CSS selector (text, html, and attributes per match). ' +
        'Use for targeted assertions instead of reading a whole page — e.g. selectors ["h1", ".price"].',
      inputSchema: {
        url: urlField,
        selectors: z.array(z.string().min(1)).min(1).describe('CSS selectors to extract, e.g. ["h1", ".price"].'),
        gotoOptions: gotoOptionsField,
        rejectResourceTypes: rejectResourceTypesField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, selectors, gotoOptions, rejectResourceTypes }) => {
      try {
        const response = await callBrowser('scrape', {
          url,
          elements: selectors.map((selector) => ({ selector })),
          gotoOptions,
          rejectResourceTypes,
        });
        const result = await readJsonResult<unknown>(response);
        return toTextResult(JSON.stringify(result, null, 2), { elements: result as Record<string, unknown> });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_links',
    {
      title: 'Browser: extract links',
      description: 'Render a page and return all of its links. Billed on browser time (Cloudflare Browser Rendering).',
      inputSchema: { url: urlField, gotoOptions: gotoOptionsField },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, gotoOptions }) => {
      try {
        const response = await callBrowser('links', { url, gotoOptions });
        const result = await readJsonResult<unknown>(response);
        const text = Array.isArray(result) ? result.join('\n') : JSON.stringify(result, null, 2);
        return toTextResult(text, { links: result as Record<string, unknown> });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Browser: multi-format snapshot',
      description:
        'Render a page once and return multiple representations in a single call (one browser-time charge): ' +
        'content (HTML), screenshot, markdown, and accessibilityTree. The accessibility tree is a structured semantic ' +
        'view useful for assertions, and is only available here. Request at least two formats; for one, use the dedicated tool.',
      inputSchema: {
        url: urlField,
        formats: z
          .array(z.enum(['content', 'screenshot', 'markdown', 'accessibilityTree']))
          .min(2)
          .describe('Representations to return (at least 2). Default ["content","screenshot"].'),
        gotoOptions: gotoOptionsField,
        rejectResourceTypes: rejectResourceTypesField,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, formats, gotoOptions, rejectResourceTypes }) => {
      try {
        const response = await callBrowser('snapshot', { url, formats, gotoOptions, rejectResourceTypes });
        const result = await readJsonResult<{
          content?: string;
          screenshot?: string;
          markdown?: string;
          accessibilityTree?: unknown;
        }>(response);

        const content: Array<{ type: 'text'; text: string } | ImageContent> = [];
        if (result.markdown) content.push({ type: 'text', text: `# Markdown\n\n${result.markdown}` });
        if (result.content) content.push({ type: 'text', text: `# HTML\n\n${result.content}` });
        if (result.accessibilityTree) {
          content.push({ type: 'text', text: `# Accessibility tree\n\n${JSON.stringify(result.accessibilityTree, null, 2)}` });
        }
        if (result.screenshot) content.push({ type: 'image', mimeType: 'image/png', data: result.screenshot });
        if (content.length === 0) content.push({ type: 'text', text: JSON.stringify(result, null, 2) });
        return { content };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

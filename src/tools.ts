// ABOUTME: Aggregates per-CLI tool modules onto an McpServer. Add new wrappers by importing their register* function and calling it here.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBirdTools } from './tools/bird.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerPerplexityTools } from './tools/perplexity.js';

export function registerAllTools(server: McpServer) {
  registerBirdTools(server);
  registerBrowserTools(server);
  registerPerplexityTools(server);
  // Add additional tool modules here:
  //   registerFooTools(server);
}

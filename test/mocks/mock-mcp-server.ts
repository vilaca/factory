#!/usr/bin/env node
/**
 * Tiny stdio MCP server used by e2e tests. Implements one tool, `echo`,
 * which returns the `text` argument back verbatim. Started by factory via
 * `mcp.servers[]` config; communicates over stdin/stdout with the
 * @modelcontextprotocol/sdk transport.
 *
 * Run directly via `node dist-test/test/mocks/mock-mcp-server.js`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function main(): Promise<void> {
  const server = new Server(
    { name: 'mock-mcp', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Return the provided text unchanged.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== 'echo') {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as { text?: string };
    return {
      content: [{ type: 'text', text: `ECHOED:${args.text ?? ''}` }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`mock-mcp-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition, ToolHandler, ToolResult } from '../tools/types.js';
import { errorMessage } from '../utils/errors.js';

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContentItem {
  type?: string;
  text?: string;
}

export function adaptMcpTool(
  mcpClient: Client,
  serverName: string,
  mcpTool: McpToolDescriptor,
): ToolHandler {
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: mcpTool.name,
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      parameters: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    },
  };

  return {
    name: mcpTool.name,
    description: definition.function.description,
    category: 'execute',
    definition,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await mcpClient.callTool({
          name: mcpTool.name,
          arguments: args,
        });

        const output = Array.isArray(result.content)
          ? result.content
              .map((c: McpContentItem) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
              .join('\n')
          : String(result.content);

        return {
          success: !result.isError,
          output,
        };
      } catch (err: unknown) {
        return {
          success: false,
          output: `MCP tool error (${serverName}/${mcpTool.name}): ${errorMessage(err)}`,
        };
      }
    },
  };
}

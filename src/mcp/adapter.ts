import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StandardToolHandler, ToolDefinition, ToolResult } from '../tools/types.js';
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
): StandardToolHandler {
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

        // Literal-narrow the success flag so it matches the discriminated
        // union (boolean → `true` | `false`). MCP servers signal failure
        // via `isError: true`; we surface that as a graceful failure so
        // the agent loop's corrector can retry without bumping the
        // hard-error counter.
        return result.isError ? { success: false, output } : { success: true, output };
      } catch (err: unknown) {
        return {
          success: false,
          output: `MCP tool error (${serverName}/${mcpTool.name}): ${errorMessage(err)}`,
        };
      }
    },
  };
}

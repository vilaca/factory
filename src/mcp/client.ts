import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './types.js';
import type { ToolHandler } from '../tools/types.js';
import { adaptMcpTool } from './adapter.js';
import { errorMessage } from '../utils/errors.js';
import { getBuildInfo } from '../utils/build-info.js';

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
  tools: ToolHandler[];
}

export class McpManager {
  private connections: McpConnection[] = [];

  async connectServer(config: McpServerConfig): Promise<ToolHandler[]> {
    if (config.transport !== 'stdio') {
      throw new Error(`MCP transport "${config.transport}" not yet supported. Use "stdio".`);
    }

    if (!config.command) {
      throw new Error(`MCP server "${config.name}" requires a "command" for stdio transport.`);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
        ? Object.fromEntries(
            Object.entries({ ...process.env, ...config.env }).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          )
        : undefined,
    });

    const client = new Client(
      { name: 'factory', version: getBuildInfo().version },
      { capabilities: {} },
    );

    await client.connect(transport);

    const toolsResponse = await client.listTools();
    const tools = (toolsResponse.tools ?? []).map(mcpTool =>
      adaptMcpTool(client, config.name, mcpTool),
    );

    this.connections.push({
      client,
      transport,
      serverName: config.name,
      tools,
    });

    return tools;
  }

  async connectAll(configs: McpServerConfig[]): Promise<ToolHandler[]> {
    const allTools: ToolHandler[] = [];

    for (const config of configs) {
      try {
        const tools = await this.connectServer(config);
        allTools.push(...tools);
      } catch (err: unknown) {
        console.error(`Failed to connect MCP server "${config.name}": ${errorMessage(err)}`);
      }
    }

    return allTools;
  }

  getAllTools(): ToolHandler[] {
    return this.connections.flatMap(c => c.tools);
  }

  /**
   * Disconnect all connected servers. Each `close()` is bounded by `perServerTimeoutMs`
   * (default 2000) so a single hung server can't hold the whole shutdown
   * hostage. Returns the names of servers that didn't acknowledge close in
   * time so the caller can surface them.
   */
  async disconnect(perServerTimeoutMs = 2000): Promise<{ pending: string[] }> {
    const pending: string[] = [];
    for (const conn of this.connections) {
      try {
        await Promise.race([
          conn.client.close(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`disconnect timed out after ${perServerTimeoutMs}ms`)),
              perServerTimeoutMs,
            ).unref(),
          ),
        ]);
      } catch {
        pending.push(conn.serverName);
      }
    }
    this.connections = [];
    return { pending };
  }
}

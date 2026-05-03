import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './types.js';
import type { ToolHandler } from '../tools/types.js';
import { adaptMcpTool } from './adapter.js';

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
            Object.entries({ ...process.env, ...config.env })
              .filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
        : undefined,
    });

    const client = new Client(
      { name: 'factory', version: '0.1.0' },
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
      } catch (err: any) {
        console.error(`Failed to connect MCP server "${config.name}": ${err.message}`);
      }
    }

    return allTools;
  }

  getAllTools(): ToolHandler[] {
    return this.connections.flatMap(c => c.tools);
  }

  async disconnect(): Promise<void> {
    for (const conn of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.connections = [];
  }
}

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { adaptMcpTool } from '../../../src/mcp/adapter.js';

// Fake the parts of the SDK Client surface that adapter.ts touches. The
// adapter only calls callTool(); typing as Client lets us exercise the real
// signature without spawning a subprocess.
function fakeClient(callTool: (req: { name: string; arguments: unknown }) => unknown): Client {
  return { callTool: async (req: { name: string; arguments: unknown }) => callTool(req) } as unknown as Client;
}

describe('MCP adapter — adaptMcpTool', () => {
  it('builds a ToolHandler from an MCP tool descriptor', () => {
    const handler = adaptMcpTool(
      fakeClient(() => ({ content: [], isError: false })),
      'srv',
      { name: 'do_thing', description: 'd', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
    );
    assert.strictEqual(handler.name, 'do_thing');
    assert.strictEqual(handler.description, 'd');
    assert.strictEqual(handler.category, 'execute');
    assert.strictEqual(handler.definition.function.name, 'do_thing');
    // Schema is forwarded as-is to satisfy provider tool-call shapes.
    assert.deepStrictEqual(handler.definition.function.parameters, {
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('synthesizes a description when the descriptor omits one', () => {
    const handler = adaptMcpTool(fakeClient(() => ({ content: [] })), 'github', { name: 'list_repos' });
    assert.match(handler.definition.function.description, /github/);
  });

  it('defaults parameters to an empty object schema when the descriptor omits inputSchema', () => {
    const handler = adaptMcpTool(fakeClient(() => ({ content: [] })), 'srv', { name: 'noargs' });
    assert.deepStrictEqual(handler.definition.function.parameters, {
      type: 'object',
      properties: {},
    });
  });

  it('forwards args to callTool and joins text content with newlines', async () => {
    let captured: { name: string; arguments: unknown } | undefined;
    const handler = adaptMcpTool(
      fakeClient(req => {
        captured = req;
        return { content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ] };
      }),
      'srv',
      { name: 'echo' },
    );

    const result = await handler.execute({ q: 'hi' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'line1\nline2');
    assert.deepStrictEqual(captured, { name: 'echo', arguments: { q: 'hi' } });
  });

  it('treats missing text on a text item as empty string (no "undefined" leak)', async () => {
    const handler = adaptMcpTool(
      fakeClient(() => ({ content: [{ type: 'text' }, { type: 'text', text: 'second' }] })),
      'srv',
      { name: 't' },
    );
    const result = await handler.execute({});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, '\nsecond');
  });

  it('JSON-stringifies non-text content items', async () => {
    const handler = adaptMcpTool(
      fakeClient(() => ({ content: [{ type: 'image', data: 'b64' }] })),
      'srv',
      { name: 't' },
    );
    const result = await handler.execute({});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, '{"type":"image","data":"b64"}');
  });

  it('coerces non-array content to a string', async () => {
    const handler = adaptMcpTool(
      fakeClient(() => ({ content: 'just a string' })),
      'srv',
      { name: 't' },
    );
    const result = await handler.execute({});
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'just a string');
  });

  it('returns success=false when the MCP server reports isError', async () => {
    const handler = adaptMcpTool(
      fakeClient(() => ({ content: [{ type: 'text', text: 'boom' }], isError: true })),
      'srv',
      { name: 't' },
    );
    const result = await handler.execute({});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.output, 'boom');
  });

  it('catches thrown errors and includes server+tool name in the message', async () => {
    const handler = adaptMcpTool(
      fakeClient(() => {
        throw new Error('connection lost');
      }),
      'github',
      { name: 'list_issues' },
    );
    const result = await handler.execute({});
    assert.strictEqual(result.success, false);
    assert.match(result.output, /MCP tool error/);
    assert.match(result.output, /github/);
    assert.match(result.output, /list_issues/);
    assert.match(result.output, /connection lost/);
  });

  it('handles non-Error throws (string, plain object) without crashing', async () => {
    const handler1 = adaptMcpTool(
      fakeClient(() => {
        throw 'oops';
      }),
      'srv',
      { name: 't' },
    );
    const r1 = await handler1.execute({});
    assert.strictEqual(r1.success, false);
    assert.match(r1.output, /oops/);

    const handler2 = adaptMcpTool(
      fakeClient(() => {
        throw { message: 'duck' };
      }),
      'srv',
      { name: 't' },
    );
    const r2 = await handler2.execute({});
    assert.strictEqual(r2.success, false);
    assert.match(r2.output, /duck/);
  });
});

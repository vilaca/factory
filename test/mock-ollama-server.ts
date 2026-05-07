/**
 * Mock Ollama HTTP server for e2e tests.
 * Responds to /api/tags (list models) and /api/chat (chat completions).
 * Behavior is configured via `setNextResponse()` before each test.
 */

import http from 'http';

export interface MockToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface MockResponse {
  content?: string;
  tool_calls?: MockToolCall[];
}

let responseQueue: MockResponse[] = [];
let modelCapabilities: string[] = ['completion', 'tools'];

export function setNextResponses(responses: MockResponse[]): void {
  responseQueue = [...responses];
}

export function setNextResponse(response: MockResponse): void {
  responseQueue = [response];
}

export function setModelCapabilities(capabilities: string[]): void {
  modelCapabilities = [...capabilities];
}

function handleShow(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        modelfile: '',
        parameters: '',
        template: '',
        details: { format: 'gguf', family: 'test', parameter_size: '7B' },
        capabilities: modelCapabilities,
      }),
    );
  });
}

function handleTags(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      models: [
        { name: 'test-model:latest', size: 1000000, digest: 'abc123' },
        { name: 'another-model:latest', size: 2000000, digest: 'def456' },
      ],
    }),
  );
}

function handleChat(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const mockResp = responseQueue.shift() ?? { content: 'No mock response configured.' };
    const isStream = parsed.stream !== false;

    if (isStream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

      // Stream content token by token (word by word)
      if (mockResp.content) {
        const words = mockResp.content.split(' ');
        for (const word of words) {
          const chunk = {
            model: parsed.model,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: word + ' ' },
            done: false,
          };
          res.write(JSON.stringify(chunk) + '\n');
        }
      }

      // Send tool calls in final chunk if present
      const finalMessage: any = { role: 'assistant', content: '' };
      if (mockResp.tool_calls) {
        finalMessage.tool_calls = mockResp.tool_calls;
      }

      const done = {
        model: parsed.model,
        created_at: new Date().toISOString(),
        message: finalMessage,
        done: true,
        total_duration: 1000000,
        eval_count: 10,
      };
      res.write(JSON.stringify(done) + '\n');
      res.end();
    } else {
      // Non-streaming response
      const message: any = {
        role: 'assistant',
        content: mockResp.content ?? '',
      };
      if (mockResp.tool_calls) {
        message.tool_calls = mockResp.tool_calls;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed.model,
          created_at: new Date().toISOString(),
          message,
          done: true,
        }),
      );
    }
  });
}

export function createMockServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags' && req.method === 'GET') {
      handleTags(req, res);
    } else if (req.url === '/api/chat' && req.method === 'POST') {
      handleChat(req, res);
    } else if (req.url === '/api/show' && req.method === 'POST') {
      handleShow(req, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return server;
}

export function startMockServer(port = 0): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = createMockServer();
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

export function stopMockServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

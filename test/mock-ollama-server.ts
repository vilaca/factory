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
let modelInfo: Record<string, unknown> | undefined;

// Optional hold/release control for concurrency tests. When `holdMode` is
// true, /api/chat handlers park after the request body is fully read
// (so the test can observe two requests in flight) and only proceed
// once `releaseChat()` is called. The release queue stores per-pending
// resolvers; releaseAll fires them in FIFO order. Default behaviour
// (holdMode=false) is unchanged.
let holdMode = false;
const pendingChatReleases: Array<() => void> = [];
let pendingArrivedListener: (() => void) | undefined;

/** Enable hold-mode. Subsequent /api/chat requests will wait inside the
 *  server until `releaseAllChats()` is called. Tests must call this BEFORE
 *  issuing the chat requests. */
export function holdChats(): void {
  holdMode = true;
}

/** Release every parked chat request in FIFO order. Safe to call when no
 *  requests are parked (no-op). */
export function releaseAllChats(): void {
  while (pendingChatReleases.length > 0) {
    const fn = pendingChatReleases.shift();
    fn?.();
  }
}

/** Resolve once `count` chat requests have arrived at the server (request
 *  body fully read) and are parked. Used by tests to synchronize on
 *  "both concurrent calls are in flight" before aborting one. */
export function waitForChatsHeld(count: number): Promise<void> {
  return new Promise(resolve => {
    const check = (): void => {
      if (pendingChatReleases.length >= count) resolve();
    };
    pendingArrivedListener = check;
    check();
  });
}

/** Disable hold-mode and drop any unfired release resolvers / listener.
 *  Call from test afterEach so a failed test doesn't leak state into
 *  the next one. */
export function resetHoldMode(): void {
  holdMode = false;
  pendingChatReleases.length = 0;
  pendingArrivedListener = undefined;
}

export function setModelInfo(info: Record<string, unknown> | undefined): void {
  modelInfo = info ? { ...info } : undefined;
}

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
    const body: Record<string, unknown> = {
      modelfile: '',
      parameters: '',
      template: '',
      details: { format: 'gguf', family: 'test', parameter_size: '7B' },
      capabilities: modelCapabilities,
    };
    if (modelInfo) body.model_info = modelInfo;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
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

    const proceed = (): void => respondToChat(parsed, res);
    if (holdMode) {
      // Park this handler until releaseAllChats() fires its resolver. The
      // caller-side abort closes the client socket; Node's http server
      // surfaces that as a `close` event on `res`, but we don't need to
      // act on it — the SDK's fetch has already rejected on the client.
      pendingChatReleases.push(proceed);
      pendingArrivedListener?.();
      return;
    }
    proceed();
  });
}

function respondToChat(parsed: any, res: http.ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
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

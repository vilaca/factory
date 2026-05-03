import http from 'http';

function handleGitHubCopilotToken(req: http.IncomingMessage, res: http.ServerResponse): void {
  const host = req.headers.host ?? '127.0.0.1';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    token: 'copilot_session_token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    endpoints: {
      api: `http://${host}`,
    },
    chat_enabled: true,
  }));
}

function handleDeviceCode(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    device_code: 'mock-device-code',
    user_code: 'MOCK-CODE',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 0,
  }));
}

function handleAccessToken(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    access_token: 'gho_mock_auth_token',
    token_type: 'bearer',
  }));
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    data: [
      { id: 'gpt-4.1' },
      { id: 'claude-sonnet-4' },
    ],
  }));
}

function handleChat(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'hello from copilot',
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }));
}

export function createMockCopilotServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/login/device/code' && req.method === 'POST') {
      handleDeviceCode(req, res);
      return;
    }
    if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
      handleAccessToken(req, res);
      return;
    }
    if (req.url === '/copilot_internal/v2/token' && req.method === 'GET') {
      handleGitHubCopilotToken(req, res);
      return;
    }
    if (req.url === '/models' && req.method === 'GET') {
      handleModels(req, res);
      return;
    }
    if (req.url === '/chat/completions' && req.method === 'POST') {
      handleChat(req, res);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
}

export function startMockCopilotServer(port = 0): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = createMockCopilotServer();
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

export function stopMockCopilotServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Deterministic HTTP target for WebFetch tests. Routes:
 *   GET /hello   → 200, text/html with a known heading
 *   GET /huge    → 200, text/html ~ 2 MiB (for size-cap behavior)
 *   GET /404     → 404
 *   GET /redir   → 302 → /hello
 */

import http from 'http';

export function createMockWebServer(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/hello') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body><h1>Hello Markdown</h1><p>WEBFETCH_OK</p></body></html>',
      );
      return;
    }
    if (url === '/huge') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const chunk = '<p>' + 'x'.repeat(1024) + '</p>';
      res.end('<!doctype html><html><body>' + chunk.repeat(2048) + '</body></html>');
      return;
    }
    if (url === '/redir') {
      res.writeHead(302, { Location: '/hello' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
}

export function startMockWebServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = createMockWebServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

export function stopMockWebServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/**
 * Local HTTP test servers shared by stream.test.ts and responses-stream.test.ts.
 * The URL path is parameterized but unused by the streaming code under test —
 * `streamOpenAi*` just POSTs to whatever URL we hand it. Tests pass their
 * API-specific path purely for readability in failure messages.
 */

import http from 'node:http';

interface ServerHelpers {
  /** Stream a scripted sequence of SSE events then close. */
  withSseServer: (events: string[], fn: (url: string) => Promise<void>) => Promise<void>;
  /** Respond with a non-2xx HTTP error and a body, then close. */
  withFailingServer: (
    status: number,
    body: string,
    fn: (url: string) => Promise<void>,
  ) => Promise<void>;
  /** Send a single SSE keepalive comment then hang forever. The test must
   *  trigger an idle timeout to terminate; otherwise it would never finish. */
  withHangingSseServer: (fn: (url: string) => Promise<void>) => Promise<void>;
}

/** Factory that returns the three server helpers preconfigured with a path.
 *  Keeping it a factory (vs free functions taking `path`) lets each test
 *  file destructure once at the top instead of repeating the path per call. */
export function makeSseHelpers(path: string): ServerHelpers {
  return {
    withSseServer: (events, fn) =>
      withServer(
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const e of events) res.write(e);
          res.end();
        },
        path,
        fn,
      ),
    withFailingServer: (status, body, fn) =>
      withServer(
        (_req, res) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(body);
        },
        path,
        fn,
      ),
    withHangingSseServer: fn =>
      withServer(
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.flushHeaders();
          res.write(': keepalive\n\n');
          // Intentionally never end after the keepalive.
        },
        path,
        fn,
        // Force-close in-flight sockets so the hanging response doesn't
        // block server.close() and stall the test runner.
        { forceClose: true },
      ),
  };
}

function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  path: string,
  fn: (url: string) => Promise<void>,
  options: { forceClose?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);

    const shutdown = (done: (err?: Error) => void): void => {
      if (options.forceClose) server.closeAllConnections?.();
      server.close(err => done(err ?? undefined));
    };

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        shutdown(() => reject(new Error('no address')));
        return;
      }
      try {
        await fn(`http://127.0.0.1:${address.port}${path}`);
        shutdown(err => (err ? reject(err) : resolve()));
      } catch (err) {
        shutdown(() => reject(err));
      }
    });
  });
}

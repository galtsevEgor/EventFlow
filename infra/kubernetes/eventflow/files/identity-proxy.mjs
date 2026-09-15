import { createServer, request } from 'node:http';

const port = Number(new URL(process.env.KEYCLOAK_URL).port);
const server = createServer((incoming, response) => {
  const upstream = request(
    {
      hostname: 'keycloak',
      port: 8080,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
      timeout: 8000,
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    },
  );
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(503).end();
  });
  response.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close());

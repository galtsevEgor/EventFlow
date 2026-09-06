import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export async function testIdentity() {
  const pair = await generateKeyPair('RS256');
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const serviceSecret = 'isolated-test-client-secret-32-characters';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/protocol/openid-connect/token')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const fields = new URLSearchParams(Buffer.concat(chunks).toString());
      if (
        fields.get('client_id') !== 'eventflow-payments' ||
        fields.get('client_secret') !== serviceSecret
      ) {
        res.writeHead(401);
        res.end('{}');
        return;
      }
      const token = await new SignJWT({
        sub: 'service-payments',
        iss: issuer,
        aud: 'eventflow-booking',
        azp: 'eventflow-payments',
        realm_access: { roles: ['booking-payments'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey);
      res.end(JSON.stringify({ access_token: token, expires_in: 300 }));
      return;
    }
    res.end(JSON.stringify({ keys: [key] }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    serviceSecret,
    token(sub = 'buyer', claims = {}) {
      return new SignJWT({
        sub,
        iss: issuer,
        aud: 'eventflow-booking',
        azp: 'eventflow-bff',
        email: 'buyer@eventflow.test',
        email_verified: true,
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(pair.privateKey);
    },
    close() {
      return new Promise((done) => server.close(done));
    },
  };
}

export async function jsonRequest(origin, path, token, method = 'GET', data, key) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

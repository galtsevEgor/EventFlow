import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionSchema, unwrap, ApiRequestError } from '../dist/index.js';

test('session boundary accepts guest and authenticated identity, rejects malformed or token-bearing responses', () => {
  assert.deepEqual(sessionSchema.parse({ user: null }), { user: null });
  const session = {
    user: { sub: 'id', email: 'test@eventflow.test', emailVerified: true, name: 'Test' },
    csrfToken: 'csrf',
  };
  assert.deepEqual(sessionSchema.parse(session), session);
  for (const invalid of [
    {},
    { user: session.user },
    { ...session, access_token: 'secret' },
    { user: { ...session.user, emailVerified: 'false' }, csrfToken: 'csrf' },
  ])
    assert.equal(sessionSchema.safeParse(invalid).success, false);
});
test('API errors preserve the support identifier and do not silently return missing data', () => {
  assert.throws(
    () =>
      unwrap({
        error: { code: 'FORBIDDEN', message: 'Denied', requestId: 'request-id', retryable: false },
      }),
    (error) => error instanceof ApiRequestError && error.problem.requestId === 'request-id',
  );
  assert.throws(() => unwrap({}));
});

export async function operatorSession(
  replica,
  identity,
  {
    subject = 'human-operator',
    roles = ['ops-view', 'ops-recover'],
    origin = 'http://127.0.0.1:18000',
  } = {},
) {
  const accessToken = await identity.token(subject, {
      aud: ['eventflow-payments', 'eventflow-booking', 'eventflow-catalog', 'eventflow-tickets'],
      realm_access: { roles },
    }),
    csrf = 'x'.repeat(43);
  const id = await replica.store.create({
    user: { sub: subject, email: `${subject}@eventflow.test`, emailVerified: true, name: subject },
    accessToken,
    refreshToken: 'synthetic-refresh',
    idToken: 'synthetic-id',
    csrf,
    accessExpiresAt: Date.now() + 240000,
    absoluteExpiresAt: Date.now() + 3600000,
  });
  return {
    id,
    token: accessToken,
    headers: { cookie: `eventflow_session=${id}`, origin, 'x-csrf-token': csrf },
  };
}

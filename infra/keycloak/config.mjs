export const realmName = 'eventflow';

export function realmConfiguration() {
  return {
    realm: realmName,
    enabled: true,
    displayName: 'EventFlow',
    registrationAllowed: true,
    registrationEmailAsUsername: true,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    verifyEmail: true,
    resetPasswordAllowed: true,
    bruteForceProtected: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 28800,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    passwordPolicy: 'length(12)',
    smtpServer: {
      host: 'mailpit',
      port: '1025',
      from: 'hello@eventflow.test',
      fromDisplayName: 'EventFlow',
    },
  };
}

const audience = {
  name: 'catalog-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  config: {
    'included.custom.audience': 'eventflow-catalog',
    'access.token.claim': 'true',
    'id.token.claim': 'false',
  },
};

export function clientConfigurations(env) {
  return [
    {
      clientId: env.OIDC_CLIENT_ID,
      name: 'EventFlow web session',
      protocol: 'openid-connect',
      publicClient: false,
      secret: env.OIDC_CLIENT_SECRET,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [`${env.PUBLIC_ORIGIN}/api/v1/auth/callback`],
      webOrigins: [env.PUBLIC_ORIGIN],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${env.PUBLIC_ORIGIN}/`,
      },
      defaultClientScopes: ['profile', 'email'],
      protocolMappers: [audience],
    },
    {
      clientId: 'eventflow-policy',
      protocol: 'openid-connect',
      publicClient: false,
      secret: env.POLICY_CLIENT_SECRET,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      defaultClientScopes: ['roles'],
      protocolMappers: [audience],
    },
  ];
}

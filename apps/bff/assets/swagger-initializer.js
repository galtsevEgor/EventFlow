const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

window.SwaggerUIBundle({
  dom_id: '#swagger-ui',
  url: '/api/v1/openapi.json',
  deepLinking: true,
  filter: true,
  queryConfigEnabled: false,
  validatorUrl: null,
  persistAuthorization: false,
  showMutatedRequest: false,
  async requestInterceptor(request) {
    const url = new URL(request.url, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/v1/')) {
      throw new Error('Swagger UI может отправлять запросы только в API EventFlow.');
    }

    request.credentials = 'same-origin';
    if (
      mutationMethods.has(request.method?.toUpperCase()) &&
      !url.pathname.startsWith('/api/v1/webhooks/')
    ) {
      const response = await fetch('/api/v1/auth/session', { cache: 'no-store' });
      if (response.ok) {
        const { csrfToken } = await response.json();
        if (typeof csrfToken === 'string') {
          request.headers = { ...request.headers, 'x-csrf-token': csrfToken };
        }
      }
    }
    return request;
  },
});

import { createGateway } from '/app/scripts/gateway.mjs';

const gateway = createGateway({
  bff: 'http://bff:4000',
  organizer: 'http://organizer:3001',
  storefront: 'http://storefront:3000',
});
gateway.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => {
  gateway.close();
  setTimeout(() => gateway.closeAllConnections(), 8000).unref();
});

import { Module, type DynamicModule } from '@nestjs/common';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Broker, MessageWorker } from '@eventflow/messaging';
import { HealthModule, Readiness, TokenVerifier } from '@eventflow/service-runtime';
import type { TicketsConfig } from './config';
import { Database } from './database';
import { TicketController } from './controller';
import { IssueTickets } from './issue';
import { QrCredentials } from './qr-credentials';

@Module({ imports: [HealthModule.forService('tickets')] })
export class AppModule {
  static configure(config: TicketsConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [TicketController],
      providers: [
        { provide: Database, useFactory: () => new Database(config.TICKETS_DATABASE_URL) },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-tickets'),
        },
        { provide: QrCredentials, useFactory: () => new QrCredentials(config.TICKET_QR_KEYS) },
        IssueTickets,
        {
          provide: MessageWorker,
          inject: [IssueTickets],
          useFactory: (issue: IssueTickets) =>
            new MessageWorker(
              new Broker({
                url: config.AMQP_URL,
                namespace: config.MESSAGE_NAMESPACE,
                consumer: 'tickets',
                routes: commerceRoutes,
              }),
              undefined,
              (event) => issue.handle(event),
            ),
        },
        {
          provide: 'TICKETS_READINESS',
          inject: [Database, Readiness],
          useFactory: (db: Database, readiness: Readiness) => {
            readiness.register('postgres', () =>
              db.ticket.count({ where: { id: '00000000-0000-0000-0000-000000000000' } }),
            );
            return readiness;
          },
        },
      ],
    };
  }
}

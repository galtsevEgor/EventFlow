import { Module, type DynamicModule } from '@nestjs/common';
import {
  HealthModule,
  MailOperator,
  MailQueue,
  Readiness,
  TokenVerifier,
} from '@eventflow/service-runtime';
import type { TicketsConfig } from './config';
import { Database } from './database';
import { TicketController } from './controller';
import { IssueTickets } from './issue';
import { QrCredentials } from './qr-credentials';
import { AdmissionPolicy } from './admission-policy';
import { CheckInController } from './check-in.controller';
import { CheckInTicket } from './check-in';
import { OfflineMetrics } from './offline-metrics';
import { OfflineCheckIn } from './offline-check-in';
import { OfflineCheckInController } from './offline-check-in.controller';
import { TicketOps } from './ops.controller';

import { ticketsBrokerReadiness, ticketsWorkerProviders } from './worker-providers';

@Module({ imports: [HealthModule.forService('tickets')] })
export class AppModule {
  static configure(config: TicketsConfig): DynamicModule {
    const runWorkers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers:
        config.EVENTFLOW_WORKLOAD === 'worker'
          ? []
          : [
              TicketController,
              MailOperator,
              CheckInController,
              TicketOps,
              OfflineCheckInController,
            ],
      providers: [
        ...(runWorkers ? ticketsWorkerProviders(config) : []),
        {
          provide: Database,
          useFactory: () => new Database(config.TICKETS_DATABASE_URL, config.DATABASE_POOL_SIZE),
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-tickets'),
        },
        { provide: QrCredentials, useFactory: () => new QrCredentials(config.TICKET_QR_KEYS) },
        {
          provide: OfflineCheckIn,
          inject: [Database],
          useFactory: (db: Database) => new OfflineCheckIn(db, config.OFFLINE_CHECK_IN_KEY),
        },
        {
          provide: OfflineMetrics,
          inject: [Database],
          useFactory: (db: Database) => new OfflineMetrics(db),
        },
        IssueTickets,
        { provide: AdmissionPolicy, useFactory: () => new AdmissionPolicy(config) },
        {
          provide: CheckInTicket,
          inject: [Database],
          useFactory: (db: Database) => new CheckInTicket(db),
        },
        {
          provide: MailQueue,
          inject: [Database],
          useFactory: (db: Database) =>
            new MailQueue(
              (sql, ...values) => db.$queryRawUnsafe(sql, ...values),
              (operation) =>
                db.$transaction((tx) =>
                  operation((sql, ...values) => tx.$queryRawUnsafe(sql, ...values)),
                ),
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
        ...(config.EVENTFLOW_WORKLOAD === 'worker' ? [ticketsBrokerReadiness] : []),
      ],
    };
  }
}

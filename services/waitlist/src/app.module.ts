import { Module, type DynamicModule } from '@nestjs/common';
import {
  ClientCredentials,
  HealthModule,
  Readiness,
  SecretBox,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { Database } from './database';
import { Booking } from './booking';
import { WaitlistQueue } from './queue';
import { Coordinator } from './coordinator';
import { TemporalRuntime } from './runtime';
import { WaitlistMetrics } from './metrics';
import { CONFIG, WaitlistController } from './controller';
import type { WaitlistConfig } from './config';
import { waitlistWorkerProviders } from './worker-providers';
@Module({ imports: [HealthModule.forService('waitlist')] })
export class AppModule {
  static configure(config: WaitlistConfig): DynamicModule {
    const workers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers: config.EVENTFLOW_WORKLOAD === 'worker' ? [] : [WaitlistController],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: WaitlistMetrics,
          inject: [Database, ...(workers ? [TemporalRuntime] : [])],
          useFactory: (db: Database, runtime?: TemporalRuntime) => new WaitlistMetrics(db, runtime),
        },
        { provide: Database, useFactory: () => new Database(config.WAITLIST_DATABASE_URL) },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-waitlist'),
        },
        {
          provide: ClientCredentials,
          useFactory: () =>
            new ClientCredentials(
              config.OIDC_ISSUER,
              'eventflow-policy',
              config.POLICY_CLIENT_SECRET,
            ),
        },
        { provide: SecretBox, useFactory: () => new SecretBox(config.WAITLIST_CONTACT_KEY) },
        {
          provide: Booking,
          useFactory: () =>
            new Booking(
              config.BOOKING_URL,
              new ClientCredentials(
                config.OIDC_ISSUER,
                'eventflow-waitlist',
                config.WAITLIST_CLIENT_SECRET,
              ),
            ),
        },
        {
          provide: WaitlistQueue,
          inject: [Database, Booking, SecretBox],
          useFactory: (db: Database, b: Booking, s: SecretBox) => new WaitlistQueue(db, b, s),
        },
        {
          provide: Coordinator,
          inject: [Database, Booking, SecretBox],
          useFactory: (db: Database, b: Booking, s: SecretBox) => new Coordinator(db, b, s),
        },
        ...(workers ? waitlistWorkerProviders(config) : []),
        {
          provide: 'WAITLIST_READINESS',
          inject: [Readiness, Database, ...(workers ? [TemporalRuntime] : [])],
          useFactory: (ready: Readiness, db: Database, runtime?: TemporalRuntime) => {
            ready.register('postgres', async () => {
              await db.query('SELECT 1');
            });
            if (runtime) ready.register('temporal', () => runtime.status());
            return ready;
          },
        },
      ],
    };
  }
}

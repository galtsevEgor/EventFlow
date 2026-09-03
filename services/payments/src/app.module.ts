import { Module } from '@nestjs/common';
import { HealthModule } from '@eventflow/service-runtime';

@Module({ imports: [HealthModule.forService('payments')] })
export class AppModule {}

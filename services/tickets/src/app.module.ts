import { Module } from '@nestjs/common';
import { HealthModule } from '@eventflow/service-runtime';

@Module({ imports: [HealthModule.forService('tickets')] })
export class AppModule {}

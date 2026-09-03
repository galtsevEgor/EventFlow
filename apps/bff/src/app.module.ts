import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from '@eventflow/service-runtime';
import { AuthModule } from './auth/auth.module';
import type { AuthConfig } from './auth/config';

@Module({ imports: [HealthModule.forService('bff')] })
export class AppModule {
  static configure(config: AuthConfig): DynamicModule {
    return { module: AppModule, imports: [AuthModule.configure(config)] };
  }
}

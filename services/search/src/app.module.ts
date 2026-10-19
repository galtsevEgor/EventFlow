import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness } from '@eventflow/service-runtime';
import type { SearchConfig } from './config';
import { OpenSearch } from './opensearch';

@Module({ imports: [HealthModule.forService('search')] })
export class AppModule {
  static configure(config: SearchConfig): DynamicModule {
    return {
      module: AppModule,
      providers: [
        {
          provide: OpenSearch,
          inject: [Readiness],
          useFactory: (readiness: Readiness) => {
            const engine = new OpenSearch(config);
            readiness.register('opensearch', () => engine.health());
            return engine;
          },
        },
      ],
    };
  }
}

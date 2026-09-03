import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';

const SERVICE_NAME = Symbol('SERVICE_NAME');

@Controller('health')
class HealthController {
  constructor(@Inject(SERVICE_NAME) private readonly serviceName: string) {}

  @Get('live')
  live() {
    return { status: 'ok', service: this.serviceName };
  }

  @Get('ready')
  ready() {
    // Dependency readiness checks join this endpoint when a service owns real connections.
    return { status: 'ok', service: this.serviceName };
  }
}

@Module({})
export class HealthModule {
  static forService(name: string): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: SERVICE_NAME, useValue: name }],
    };
  }
}

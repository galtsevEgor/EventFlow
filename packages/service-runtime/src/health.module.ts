import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import { ApiError } from './http';

const SERVICE_NAME = Symbol('SERVICE_NAME');

export class Readiness {
  private readonly checks = new Map<string, () => Promise<unknown>>();
  register(name: string, check: () => Promise<unknown>) {
    this.checks.set(name, check);
  }
  async verify() {
    const results = await Promise.allSettled([...this.checks.values()].map((check) => check()));
    if (results.some((result) => result.status === 'rejected'))
      throw new ApiError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Сервис временно не готов принимать запросы.',
      );
  }
}
export async function probeIdentity(issuer: string) {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok || (await response.json()).issuer !== issuer)
    throw new Error('Identity unavailable');
}

@Controller('health')
class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly serviceName: string,
    @Inject(Readiness) private readonly readiness: Readiness,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', service: this.serviceName };
  }

  @Get('ready')
  async ready() {
    await this.readiness.verify();
    return { status: 'ok', service: this.serviceName };
  }
}

@Module({})
export class HealthModule {
  static forService(name: string): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: SERVICE_NAME, useValue: name }, Readiness],
      exports: [Readiness],
    };
  }
}

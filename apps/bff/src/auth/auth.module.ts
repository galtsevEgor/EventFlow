import { Module, type DynamicModule } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionStore } from './session-store';
import { IdentityProvider } from './oidc';
import { AUTH_CONFIG, type AuthConfig } from './config';

@Module({})
export class AuthModule {
  static configure(config: AuthConfig): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        { provide: AUTH_CONFIG, useValue: config },
        { provide: SessionStore, useFactory: () => new SessionStore(config) },
        { provide: IdentityProvider, useFactory: () => new IdentityProvider(config) },
        {
          provide: AuthService,
          useFactory: (store: SessionStore, identity: IdentityProvider) =>
            new AuthService(config, store, identity),
          inject: [SessionStore, IdentityProvider],
        },
      ],
      exports: [AuthService, SessionStore, AUTH_CONFIG],
    };
  }
}

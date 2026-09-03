import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { TokenVerifier, type UserIdentity } from '@eventflow/service-runtime';

export interface UserRequest extends Request {
  actor: UserIdentity;
}
@Injectable()
export class UserGuard implements CanActivate {
  constructor(@Inject(TokenVerifier) private readonly verifier: TokenVerifier) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<UserRequest>();
    request.actor = await this.verifier.user(request.header('authorization'));
    return true;
  }
}

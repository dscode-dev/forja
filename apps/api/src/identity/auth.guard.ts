import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionPrincipal } from '../platform/auth-control';
import { IdentityService } from './identity.service';
export interface AuthenticatedRequest {
  headers: { authorization?: string };
  principal: SessionPrincipal;
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/iu.test(authorization))
      throw new UnauthorizedException();
    request.principal = await this.identity.authenticate(
      authorization.slice(7),
    );
    return true;
  }
}

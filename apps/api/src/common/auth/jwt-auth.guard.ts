import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { AccessTokenClaims, AuthenticatedUser } from './authenticated-user';
import { verifyAccessToken } from './verify-access-token';

/** Express request carrying the resolved principal. */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Verifies the `Authorization: Bearer <jwt>` header.
 *
 * Deliberately dependency-free: it validates an HS256 token with `node:crypto`
 * rather than pulling in a JWT library. Swap `verifyToken` for `jose`/`jwks-rsa`
 * when moving to RS256 and an external identity provider — nothing else changes.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const claims = this.verifyToken(header.slice('Bearer '.length).trim());

    request.user = {
      userId: claims.sub,
      role: claims.role,
      merchantIds: claims.merchantIds ?? [],
    };
    return true;
  }

  private verifyToken(token: string): AccessTokenClaims {
    return verifyAccessToken(token, this.config.jwt.secret);
  }
}

/**
 * Ensures the principal may act for the `:merchantId` in the route.
 *
 * Must run AFTER `JwtAuthGuard`. Admin bypasses the check; a merchant owner who
 * guesses another merchant's id gets a 403, not a data leak.
 */
@Injectable()
export class MerchantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) throw new UnauthorizedException('Not authenticated');

    const merchantId = request.params.merchantId;
    if (!merchantId) return true;

    if (user.role === UserRole.ADMIN) return true;

    if (!user.merchantIds.includes(merchantId)) {
      throw new ForbiddenException('You do not have access to this merchant');
    }
    return true;
  }
}

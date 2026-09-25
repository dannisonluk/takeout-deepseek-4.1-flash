import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { InsufficientRoleError } from '../../modules/auth/domain/auth.errors';
import { AuthenticatedRequest } from './jwt-auth.guard';

export const ROLES_KEY = 'takeout:roles';

/**
 * `@Roles(UserRole.ADMIN)` — declarative role gate.
 *
 * Must run AFTER `JwtAuthGuard`, which is what populates `request.user`. The
 * guard throws a domain error rather than returning `false` so the client gets
 * a `FORBIDDEN` code instead of a bare 403 with no explanation.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No decorator means no restriction — the route is guarded by JWT alone.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) throw new UnauthorizedException('Not authenticated');

    if (!required.includes(user.role)) {
      throw new InsufficientRoleError(required.join(' | '), user.role);
    }
    return true;
  }
}

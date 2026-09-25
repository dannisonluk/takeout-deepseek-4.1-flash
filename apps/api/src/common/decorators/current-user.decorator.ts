import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * `@CurrentUser() user: AuthenticatedUser` — reads the principal the
 * `JwtAuthGuard` attached to the request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used without JwtAuthGuard');
    }
    return request.user;
  },
);

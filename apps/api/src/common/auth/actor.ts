import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AuthenticatedUser } from './authenticated-user';

/** Who is making a change, for the audit trail. */
export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly ip?: string | null;
}

/**
 * Best-effort client address.
 *
 * Prefers `x-forwarded-for` because behind a load balancer `request.ip` is the
 * proxy's address for every request, which would make the audit trail useless
 * for answering "where did this change come from".
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return raw?.split(',')[0]?.trim() || request.ip || null;
}

export function toActor(user: AuthenticatedUser, request: Request): Actor {
  return { userId: user.userId, role: user.role, ip: clientIp(request) };
}

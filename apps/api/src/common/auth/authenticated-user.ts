import { UserRole } from '@prisma/client';

/** The authenticated principal, decoded from the access token. */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly role: UserRole;
  /** Merchants this principal may act for. Empty for customers. */
  readonly merchantIds: readonly string[];
}

/** Claims we expect inside the JWT access token. */
export interface AccessTokenClaims {
  /** Subject — the user id. */
  readonly sub: string;
  readonly role: UserRole;
  readonly merchantIds?: readonly string[];
  readonly iat?: number;
  readonly exp?: number;
}

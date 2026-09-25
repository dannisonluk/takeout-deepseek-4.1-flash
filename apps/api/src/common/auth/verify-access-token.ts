import { UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AccessTokenClaims } from './authenticated-user';

/**
 * Verifies an HS256 access token.
 *
 * Dependency-free on purpose — one implementation shared by the HTTP guard and
 * the WebSocket handshake, so the two can never drift apart on what "valid"
 * means. Replace with `jose` + JWKS when moving to RS256.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new UnauthorizedException('Malformed token');
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  const provided = Buffer.from(signaturePart);
  const wanted = Buffer.from(expected);
  // Constant-time compare; a length check first because timingSafeEqual throws
  // on mismatched buffers.
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    throw new UnauthorizedException('Invalid token signature');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException('Malformed token payload');
  }

  if (!claims.sub) throw new UnauthorizedException('Token is missing a subject');
  if (claims.exp !== undefined && claims.exp * 1000 < Date.now()) {
    throw new UnauthorizedException('Token has expired');
  }
  return claims;
}

import { Inject, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';

/**
 * Issues the two token kinds this platform uses.
 *
 * Access tokens are stateless HS256 JWTs — verified by the shared
 * `verifyAccessToken`, which the HTTP guard and the WebSocket handshake both
 * use, so the two can never disagree about what "valid" means.
 *
 * Refresh tokens are **opaque random strings, not JWTs**. There is nothing to
 * decode and therefore nothing for a client to trust or tamper with; the server
 * is the only authority, and it stores only a SHA-256 hash of the value.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get accessTokenTtlSeconds(): number {
    return parseDurationSeconds(this.config.jwt.accessTokenTtl, 900);
  }

  get refreshTokenTtlSeconds(): number {
    return parseDurationSeconds(this.config.jwt.refreshTokenTtl, 30 * 24 * 3600);
  }

  signAccessToken(claims: {
    sub: string;
    role: UserRole;
    merchantIds: readonly string[];
  }): { token: string; expiresIn: number } {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = this.accessTokenTtlSeconds;

    const payload = {
      sub: claims.sub,
      role: claims.role,
      merchantIds: [...claims.merchantIds],
      iat: issuedAt,
      exp: issuedAt + expiresIn,
    };

    return { token: this.signHmac(payload), expiresIn };
  }

  /**
   * A fresh refresh token. Returns the raw value **once** — it is handed to the
   * client and never persisted; only `hash` goes to the database.
   */
  issueRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
    const raw = randomBytes(32).toString('base64url');
    return {
      raw,
      hash: hashToken(raw),
      expiresAt: new Date(Date.now() + this.refreshTokenTtlSeconds * 1000),
    };
  }

  /** Six digits, cryptographically random — not `Math.random()`. */
  generateOtpCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** Salted with the phone so a stolen hash cannot be replayed against another number. */
  hashOtpCode(phone: string, code: string): string {
    return createHash('sha256').update(`${phone}:${code}`).digest('hex');
  }

  /** Constant-time compare of two hex digests. */
  safeEqualHex(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length !== right.length || left.length === 0) return false;
    return timingSafeEqual(left, right);
  }

  private signHmac(payload: object): string {
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const signature = createHmac('sha256', this.config.jwt.secret)
      .update(`${header}.${body}`)
      .digest('base64url');

    return `${header}.${body}.${signature}`;
  }
}

/** SHA-256 hex. Used for refresh tokens, which need no salt (256 bits of entropy). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * `15m` / `30d` / `12h` / `900` → seconds.
 *
 * Falls back rather than throwing: a malformed TTL in `.env` should not stop
 * the API from booting, and the fallback is the documented default anyway.
 */
export function parseDurationSeconds(value: string, fallback: number): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) return fallback;

  const amount = Number.parseInt(match[1]!, 10);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    default:
      return amount;
  }
}

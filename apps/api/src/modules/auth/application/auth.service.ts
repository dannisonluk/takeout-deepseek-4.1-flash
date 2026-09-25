import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  AccountDisabledError,
  InvalidOtpError,
  OtpRateLimitedError,
  SessionExpiredError,
} from '../domain/auth.errors';
import { hashToken, TokenService } from '../domain/token.service';
import { OTP_SENDER, OtpSenderPort } from '../infrastructure/otp-sender.port';

/** 5 codes per phone per window, and at least 60 s between two requests. */
const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 5;
const OTP_MIN_INTERVAL_MS = 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
/** A code dies after this many wrong guesses, so 10^6 is not brute-forceable. */
const OTP_MAX_ATTEMPTS = 5;

export interface AuthProfileView {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly role: UserRole;
  readonly locale: string;
  /** Merchants this principal may act for — the same list embedded in the JWT. */
  readonly merchantIds: readonly string[];
}

export interface SessionView {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly user: AuthProfileView;
}

export interface OtpRequestedView {
  readonly phone: string;
  readonly expiresInSeconds: number;
  readonly retryAfterSeconds: number;
  /**
   * Present only outside production. There is no SMS contract yet, so the
   * development login flow needs the code to be reachable — but echoing it back
   * in production would defeat the entire mechanism.
   */
  readonly devCode?: string;
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Phone-OTP authentication.
 *
 * Postgres stores both OTP codes and refresh tokens, so a missing Redis
 * degrades idempotency and realtime but never login.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(OTP_SENDER) private readonly otpSender: OtpSenderPort,
  ) {}

  // ---- step 1: request a code ---------------------------------------------

  async requestOtp(phone: string, purpose = 'LOGIN'): Promise<OtpRequestedView> {
    const since = new Date(Date.now() - OTP_WINDOW_MS);

    const [recentCount, latest] = await Promise.all([
      this.prisma.otpCode.count({ where: { phone, purpose, createdAt: { gte: since } } }),
      this.prisma.otpCode.findFirst({
        where: { phone, purpose },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    if (recentCount >= OTP_MAX_PER_WINDOW) {
      throw new OtpRateLimitedError(Math.ceil(OTP_WINDOW_MS / 1000));
    }
    if (latest) {
      const elapsed = Date.now() - latest.createdAt.getTime();
      if (elapsed < OTP_MIN_INTERVAL_MS) {
        throw new OtpRateLimitedError(Math.ceil((OTP_MIN_INTERVAL_MS - elapsed) / 1000));
      }
    }

    const code = this.tokens.generateOtpCode();

    await this.prisma.otpCode.create({
      data: {
        phone,
        purpose,
        codeHash: this.tokens.hashOtpCode(phone, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    await this.otpSender.send(phone, code, purpose);

    return {
      phone,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      retryAfterSeconds: Math.floor(OTP_MIN_INTERVAL_MS / 1000),
      ...(this.otpSender.exposesCode ? { devCode: code } : {}),
    };
  }

  // ---- step 2: exchange the code for a session ----------------------------

  async verifyOtp(
    phone: string,
    code: string,
    meta: RequestMeta = {},
    purpose = 'LOGIN',
  ): Promise<SessionView> {
    const record = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) throw new InvalidOtpError({ reason: 'no_live_code' });
    if (record.expiresAt.getTime() < Date.now()) throw new InvalidOtpError({ reason: 'expired' });
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      throw new InvalidOtpError({ reason: 'too_many_attempts' });
    }

    const provided = this.tokens.hashOtpCode(phone, code);
    if (!this.tokens.safeEqualHex(record.codeHash, provided)) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new InvalidOtpError({
        reason: 'mismatch',
        attemptsRemaining: OTP_MAX_ATTEMPTS - record.attempts - 1,
      });
    }

    // Burn the code before anything else can fail, so it cannot be replayed.
    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    const user = await this.findOrCreateUser(phone);
    if (!user.isActive) throw new AccountDisabledError();

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const { session } = await this.issueSession(user, meta);

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login',
      targetType: 'User',
      targetId: user.id,
      ip: meta.ip ?? null,
    });

    return session;
  }

  // ---- session lifecycle ---------------------------------------------------

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been rotated means either a replay or a
   * stolen copy — indistinguishable, and both are treated as a breach: the whole
   * chain is revoked and the client must log in again.
   */
  async refresh(rawToken: string, meta: RequestMeta = {}): Promise<SessionView> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });

    if (!record) throw new SessionExpiredError('找不到此登入狀態');

    if (record.revokedAt) {
      await this.revokeChain(record.userId, record.id);
      throw new SessionExpiredError('此登入狀態已被使用過，為安全起見已登出所有裝置');
    }
    if (record.expiresAt.getTime() < Date.now()) throw new SessionExpiredError('登入狀態已過期');
    if (!record.user.isActive) throw new AccountDisabledError();

    const { session, refreshTokenId } = await this.issueSession(record.user, meta);

    // Point the retired token at its exact successor, so a later reuse can be
    // traced forward through the chain rather than guessed at.
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedById: refreshTokenId },
    });

    return session;
  }

  async logout(rawToken: string): Promise<{ revoked: boolean }> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!record) return { revoked: false };

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  /** Sign out every device — used after a reuse detection or an admin action. */
  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  // ---- profile ------------------------------------------------------------

  async profile(userId: string): Promise<AuthProfileView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new SessionExpiredError('使用者不存在');
    return this.toProfile(user);
  }

  // ---- internals ----------------------------------------------------------

  private async issueSession(
    user: User,
    meta: RequestMeta,
  ): Promise<{ session: SessionView; refreshTokenId: string }> {
    const merchantIds = await this.resolveMerchantIds(user.id, user.role);
    const access = this.tokens.signAccessToken({ sub: user.id, role: user.role, merchantIds });
    const refresh = this.tokens.issueRefreshToken();

    const stored = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.hash,
        expiresAt: refresh.expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ip: meta.ip ?? null,
      },
      select: { id: true },
    });

    return {
      refreshTokenId: stored.id,
      session: {
        accessToken: access.token,
        refreshToken: refresh.raw,
        expiresIn: access.expiresIn,
        user: {
          id: user.id,
          displayName: user.displayName,
          phone: user.phone,
          email: user.email,
          role: user.role,
          locale: user.locale,
          merchantIds,
        },
      },
    };
  }

  /**
   * The merchants this principal may act for.
   *
   * Owners come from `merchants.ownerId`, staff from `merchant_staff`. An admin
   * gets every merchant id so `MerchantScopeGuard` passes without a special
   * case — the guard's admin bypass stays as belt and braces.
   */
  private async resolveMerchantIds(userId: string, role: UserRole): Promise<string[]> {
    if (role === UserRole.ADMIN) {
      const all = await this.prisma.merchant.findMany({ select: { id: true } });
      return all.map((merchant) => merchant.id);
    }

    const [owned, staff] = await Promise.all([
      this.prisma.merchant.findMany({
        where: { ownerId: userId, status: { not: 'CLOSED' } },
        select: { id: true },
      }),
      this.prisma.merchantStaff.findMany({ where: { userId }, select: { merchantId: true } }),
    ]);

    return [...new Set([...owned.map((m) => m.id), ...staff.map((s) => s.merchantId)])];
  }

  private async findOrCreateUser(phone: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) return existing;

    try {
      return await this.prisma.user.create({
        data: {
          phone,
          // Placeholder the user can change later.
          displayName: `用戶${phone.replace(/\D/g, '').slice(-4)}`,
          role: UserRole.CUSTOMER,
        },
      });
    } catch (error) {
      // Two concurrent verifies for the same new phone: one wins, the other
      // re-reads. Cheaper and more honest than an upsert on a non-unique field.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.user.findUnique({ where: { phone } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async toProfile(user: User): Promise<AuthProfileView> {
    return {
      id: user.id,
      displayName: user.displayName,
      phone: user.phone,
      email: user.email,
      role: user.role,
      locale: user.locale,
      merchantIds: await this.resolveMerchantIds(user.id, user.role),
    };
  }

  /**
   * Revoke every live token for the user, then record it. Called on reuse
   * detection, where the safe assumption is that the whole session family is
   * compromised.
   */
  private async revokeChain(userId: string, offendingTokenId: string): Promise<void> {
    const count = await this.revokeAllSessions(userId);
    this.logger.warn(
      `Refresh-token reuse detected for user ${userId} (token ${offendingTokenId}); revoked ${count} session(s)`,
    );
    await this.audit.record({
      actorId: userId,
      action: 'auth.refresh_reuse_detected',
      targetType: 'User',
      targetId: userId,
      after: { revokedSessions: count },
    });
  }
}

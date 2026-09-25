import { Inject, Injectable, Logger } from '@nestjs/common';
import { WaitlistPartySizeError, WaitlistPolicy } from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { WAITLIST_REPOSITORY } from '../../../common/tokens';
import { WaitlistRepositoryPort } from '../domain/waitlist.repository.port';
import { WaitlistSettingsNotFoundError } from '../domain/waitlist.errors';
import { UpdateWaitlistSettingsDto } from '../interface/dto/waitlist.dto';
import { WaitlistSettingsView } from '../interface/waitlist.views';

/**
 * The queue's settings screen.
 *
 * A separate service from the query service because writing settings has to
 * audit, and the read side has no business holding an `AuditService`.
 *
 * The one real rule enforced here — rather than in the DTO — is that
 * `minPartySize <= maxPartySize`. The DTO validates each field's own range
 * independently and cannot see the other; a form that saved `min: 6, max: 4`
 * would produce a queue that refuses everyone, and the failure would surface as
 * a guest being told their party is too small AND too large.
 */
@Injectable()
export class WaitlistSettingsService {
  private readonly logger = new Logger(WaitlistSettingsService.name);

  constructor(
    private readonly audit: AuditService,
    @Inject(WAITLIST_REPOSITORY) private readonly waitlist: WaitlistRepositoryPort,
  ) {}

  async read(merchantId: string): Promise<WaitlistSettingsView | null> {
    const merchant = await this.waitlist.findQueueMerchant(merchantId);
    if (!merchant) return null;
    const settings = await this.waitlist.findSettings(merchant.id);
    // The domain policy carries `customerNotice` alongside the tunables, but the
    // settings screen reads it from the top level only. Spreading the policy
    // whole would emit the notice twice — once where the view declares it and
    // once where it does not — and a client that read the wrong copy would show
    // a stale notice after the first save.
    const { customerNotice, ...policy } = settings.policy;
    return { merchantId, policy, customerNotice, openNow: settings.openNow };
  }

  async update(
    merchantId: string,
    dto: UpdateWaitlistSettingsDto,
    actor: Actor,
  ): Promise<WaitlistSettingsView> {
    const before = await this.read(merchantId);
    if (!before) throw new WaitlistSettingsNotFoundError(merchantId);

    // Validate the PAIR against the merged result, not against the DTO: a patch
    // that sends only `minPartySize: 6` is legal in isolation and illegal
    // against the stored `maxPartySize: 4`, and only the merge can see that.
    const merged = {
      minPartySize: dto.minPartySize ?? before.policy.minPartySize,
      maxPartySize: dto.maxPartySize ?? before.policy.maxPartySize,
    };
    if (merged.minPartySize > merged.maxPartySize) {
      throw new WaitlistPartySizeError(merged.minPartySize, merged.maxPartySize);
    }

    const saved = await this.waitlist.saveSettings(merchantId, {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.acceptWhenClosed !== undefined ? { acceptWhenClosed: dto.acceptWhenClosed } : {}),
      ...(dto.minPartySize !== undefined ? { minPartySize: dto.minPartySize } : {}),
      ...(dto.maxPartySize !== undefined ? { maxPartySize: dto.maxPartySize } : {}),
      ...(dto.averageTurnMinutes !== undefined
        ? { averageTurnMinutes: dto.averageTurnMinutes }
        : {}),
      ...(dto.callTimeoutMinutes !== undefined
        ? { callTimeoutMinutes: dto.callTimeoutMinutes }
        : {}),
      ...(dto.customerNotice !== undefined ? { customerNotice: dto.customerNotice } : {}),
      updatedById: actor.userId,
    });

    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      action: 'merchant.waitlist_settings_update',
      targetType: 'WaitlistSettings',
      targetId: merchantId,
      before: { policy: before.policy },
      after: { policy: saved.policy },
      ip: actor.ip ?? null,
    });

    this.logger.log(
      `Queue settings for ${merchantId}: enabled=${saved.policy.enabled}, turn=${saved.policy.averageTurnMinutes}`,
    );

    const { customerNotice, ...policy } = saved.policy;
    return { merchantId, policy, customerNotice, openNow: saved.openNow };
  }
}

export type { WaitlistPolicy };

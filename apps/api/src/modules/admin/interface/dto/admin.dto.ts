import { UserRole } from '@prisma/client';
import { OrderStatus } from '@takeout/domain';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MAX_PAGE_SIZE,
  toBoolean,
  toNumber,
} from '../../../../common/validation/query';
import { MerchantAdminAction } from '../../../merchants/domain/merchant-status.machine';

/**
 * Shared paging fields. `offset` rather than a cursor: admins jump to page 7.
 *
 * Data fields only — no getters. See `paginate()` for why that matters.
 */
class PageQueryDto {
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------

export class AdminUserQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;

  /** Matches display name, phone or email. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

// ---------------------------------------------------------------------------
//  Merchants
// ---------------------------------------------------------------------------

export class AdminMerchantQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'CLOSED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class MerchantActionDto {
  @IsEnum(MerchantAdminAction)
  action!: MerchantAdminAction;

  /** Required by the console, optional here — a reason makes the audit trail useful. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ---------------------------------------------------------------------------
//  Orders
// ---------------------------------------------------------------------------

export class AdminOrderQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsUUID('4')
  merchantId?: string;

  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Order number, pickup code, or customer/merchant name fragment. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * A forced status change.
 *
 * `reason` is mandatory and `MIN_REASON_LENGTH` is enforced: an admin moving an
 * order the normal flow would not allow is exactly the case where the audit
 * trail has to explain itself.
 */
export class ForceTransitionDto {
  @IsEnum(OrderStatus)
  to!: OrderStatus;

  @IsString()
  @MinLength(4, { message: '請填寫至少 4 個字的原因，此操作會寫入稽核記錄' })
  @MaxLength(500)
  reason!: string;
}

export class AdminRefundDto {
  /** Omit for a full refund of the captured amount. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  amountMinor?: number;

  @IsString()
  @MinLength(4, { message: '請填寫至少 4 個字的原因，此操作會寫入稽核記錄' })
  @MaxLength(500)
  reason!: string;
}

// ---------------------------------------------------------------------------
//  platform_config
// ---------------------------------------------------------------------------

export class UpsertPlatformConfigDto {
  /**
   * `@Allow()` because the value is genuinely free-form JSON: a fee is a number,
   * `count_add_on_items` is a boolean, and a future key may be an object. Every
   * specific key is validated by `AdminConfigService` against its own schema —
   * a generic validator here could only be wrong.
   */
  @Allow()
  value!: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// ---------------------------------------------------------------------------
//  Payouts
// ---------------------------------------------------------------------------

export class AdminPayoutQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSING', 'PAID', 'FAILED'])
  status?: string;

  @IsOptional()
  @IsUUID('4')
  merchantId?: string;
}

export class MarkPayoutDto {
  /** Bank transfer / FPS reference, recorded for reconciliation. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class FailPayoutDto {
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}

// ---------------------------------------------------------------------------
//  Ops
// ---------------------------------------------------------------------------

export class AdminOutboxQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventType?: string;

  @IsOptional()
  @IsUUID('4')
  aggregateId?: string;
}

export class AdminAuditQueryDto extends PageQueryDto {
  @IsOptional()
  @IsUUID('4')
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;
}

export class ReconciliationQueryDto {
  /** Inclusive. Defaults to 30 days before `to`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive. Defaults to now. */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  /** Return only the merchant-days where the two ledgers disagree. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyMismatched?: boolean;
}

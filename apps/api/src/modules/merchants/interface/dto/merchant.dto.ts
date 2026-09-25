import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AnalyticsTier, ClosureReason } from '@takeout/domain';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$/;
const PHONE = /^\+?[0-9]{8,15}$/;

/** 商戶申請入駐. The caller becomes the owner; status starts at PENDING_REVIEW. */
export class CreateMerchantDto {
  @IsString()
  @Matches(SLUG, { message: '代稱只可用小寫英文字母、數字與連字號，長度 3–120' })
  slug!: string;

  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE, { message: '請輸入有效的聯絡電話' })
  phone?: string;

  @IsString()
  @MaxLength(255)
  addressLine1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  region?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  pickupWindowMinutes?: number;
}

/**
 * Partial update. Every field optional; only what is present is written, so a
 * settings form can save one tab without clobbering another.
 */
export class UpdateMerchantDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE, { message: '請輸入有效的聯絡電話' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  region?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  pickupWindowMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  acceptTimeoutMinutes?: number;

  @IsOptional()
  @IsBoolean()
  autoAcceptOrders?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImageKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

/** 接單 / 停單. The switch the `MERCHANT_ACCEPTING` guard reads. */
export class IntakeSwitchDto {
  @IsBoolean()
  accepting!: boolean;
}

export class OperatingHourDto {
  /** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  /** Minutes from local midnight. 11:00 => 660. */
  @IsInt()
  @Min(0)
  @Max(1440)
  opensAtMinute!: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  closesAtMinute!: number;

  @IsBoolean()
  isClosed!: boolean;
}

/**
 * Replaces the whole week in one call.
 *
 * A PUT rather than a per-day PATCH: the settings UI edits all seven rows and
 * saves once, and a partial write would leave the merchant open on a day the
 * operator thought they had closed.
 */
export class ReplaceOperatingHoursDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OperatingHourDto)
  hours!: OperatingHourDto[];
}

/**
 * 特別休息日 — close one dated trading day.
 *
 * `serviceDate` is `YYYY-MM-DD`, and it is the SHOP'S local date, not UTC. The
 * narrow pattern rather than `@IsISO8601`: a full instant would be ambiguous
 * about which trading day it means, and a shop closing "the 25th" must not
 * become a closure on the 24th because the client sent midnight UTC.
 */
export class SetClosureDto {
  @IsEnum(ClosureReason)
  reason!: ClosureReason;

  /** Free text shown to the customer verbatim. `null` clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

/** Path parameter for the closure endpoints: `YYYY-MM-DD`. */
export class ClosureDateDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'serviceDate must be YYYY-MM-DD' })
  serviceDate!: string;
}

/** One dated closure, as the merchant's rest-day screen reads it. */
export interface ClosureView {
  readonly id: string;
  /** Merchant-local `YYYY-MM-DD`. */
  readonly serviceDate: string;
  readonly reason: ClosureReason;
  readonly note: string | null;
  /**
   * When the auto-cancel sweep last ran for this day. `null` means "not yet".
   *
   * Part of the API surface on purpose: it is what makes the cascade idempotent,
   * and a client that sees `null` on a day in the past knows the sweep never
   * completed rather than assuming it did.
   */
  readonly cancelledReservationsAt: string | null;
  readonly cancelledReservationCount: number;
  readonly createdAt: string;
}

/** The save response — the closure plus what the sweep did to the book. */
export interface ClosureWriteResultView {
  readonly closure: ClosureView;
  /** Bookings cancelled by this call. `0` when the latch was already set. */
  readonly cancelledReservations: number;
  /** True when a previous save had already swept this date. */
  readonly alreadySwept: boolean;
  /** Active bookings still on the closed day after a capped sweep. */
  readonly remainingActive: number;
  /** Prose for the banner, built server-side so the numbers cannot drift. */
  readonly message: string;
}

// ============================================================================
//  商戶營業報表 — query parameters
// ============================================================================

/**
 * The report window.
 *
 * Both bounds are the SHOP'S local calendar dates (`YYYY-MM-DD`), not instants,
 * for the same reason `serviceDate` is: an owner who clicks "this month" means
 * the 1st to the 30th as their shop experienced them, and a UTC instant would
 * clip the first and last evening of trade for a +08 shop.
 *
 * Both are optional — omitted, the service uses "the last 30 local days", which
 * is the only default that is useful for a shop that has not chosen a period.
 */
export class AnalyticsWindowDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

/**
 * Set a shop's reporting entitlement.
 *
 * Admin-only, and the only way a tier changes. The DTO validates against the
 * *domain* `AnalyticsTier` enum rather than the Prisma one so the vocabulary has
 * one definition — a value Prisma knows and the domain does not would fail
 * `toAnalyticsTier`'s switch and silently degrade the shop to `NONE`.
 */
export class SetAnalyticsTierDto {
  @IsEnum(AnalyticsTier)
  tier!: AnalyticsTier;
}

/** 匯出 — the same window, as query parameters. */
export class AnalyticsExportQueryDto extends AnalyticsWindowDto {}


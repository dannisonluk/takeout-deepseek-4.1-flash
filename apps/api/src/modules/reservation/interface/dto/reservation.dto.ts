import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Book a table.
 *
 * `startsAt` is an ISO-8601 instant, not a local wall-clock string. The client
 * knows the merchant's timezone (the availability response carries it) and is
 * expected to send the UTC instant it means. Accepting "19:00" and guessing the
 * zone server-side is how a booking lands an hour out after a DST change.
 *
 * The party-size bounds here are shape checks only — the real ones come from
 * the merchant's policy and are enforced by `PartySizeNotAllowedError`. Keeping
 * a loose `@Min(1)` / `@Max(50)` guard means a fat-fingered `1000000` is a 400
 * with a field name rather than a 422 from inside a transaction.
 */
export class PlaceReservationDto {
  /** The shop being booked. */
  @IsString()
  @IsUUID('4', { message: 'merchantId must be a UUID' })
  merchantId!: string;

  @IsISO8601({ strict: true }, { message: 'startsAt must be an ISO-8601 instant' })
  startsAt!: string;

  @IsInt()
  @Min(1, { message: 'partySize must be at least 1' })
  @Max(50, { message: 'partySize cannot exceed 50' })
  partySize!: number;

  @IsString()
  @MaxLength(80)
  customerName!: string;

  /**
   * Contact number the shop will ring if the party is late.
   *
   * Kept loose on purpose. A strict HK-only pattern would lock out a tourist's
   * number, and a booking is not a payment — there is nothing to protect by
   * refusing a format the shop can simply read.
   */
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9+\-\s()]{5,32}$/, { message: 'contactPhone contains invalid characters' })
  contactPhone!: string;

  /** Free text for the kitchen: allergies, a high chair, a birthday. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  customerNote?: string;

  /** Ignored by the API. Declared so `forbidNonWhitelisted` does not 400 a
   *  client that echoes it back from the availability response. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  merchantSlug?: string;
}

/** Merchant endpoints encode the target status in the path. */
export class ReservationReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** The shop's reply to the customer, shown verbatim. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  merchantNote?: string;
}

/**
 * The shop's reservation book settings.
 *
 * Every field is optional so the same DTO serves a partial patch, but the
 * cross-field rules (min <= max, turn >= slot) are enforced in the controller
 * rather than with class-validator — a `@ValidateIf` chain for "minPartySize
 * must be <= maxPartySize when both are present" is harder to read than the two
 * lines it replaces.
 */
export class UpdateReservationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoConfirm?: boolean;

  /** Grid size in minutes. 5-minute multiples keep the grid readable. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  slotMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(360)
  turnMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  seatsPerSlot?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  minPartySize?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxPartySize?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  leadTimeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  advanceDays?: number;

  /** Verbatim prose for the booking page. `null` clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  customerNotice?: string | null;
}

/** Query string for the availability endpoint. */
export class AvailabilityQueryDto {
  /** `YYYY-MM-DD` local date, or a full ISO instant. */
  @IsString()
  @MaxLength(40)
  from!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  partySize?: number;
}

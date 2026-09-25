import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WaitlistStatus } from '@takeout/domain';

const PHONE = /^\+?[0-9]{8,15}$/;

/**
 * 現場候位 — request payloads.
 *
 * Note what is NOT here: a position, a status, or a ticket number. All three
 * are derived by the server — the number from what has already been issued, the
 * position from the queue, the status from the machine — and accepting any of
 * them from a client would make the queue something a guest can negotiate.
 */

/**
 * Take a number.
 *
 * `merchantId` is in the body rather than the path because this is a POST to a
 * collection: "add me to the queue for this shop". The path variant
 * (`POST /merchants/:slug/queue`) exists too and takes the same payload minus
 * the id, for the unauthenticated take-a-number page which only ever has a slug.
 */
export class TakeNumberDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  merchantId?: string;

  @IsInt()
  @Min(1)
  @Max(50)
  partySize!: number;

  @IsString()
  @MaxLength(80)
  guestName!: string;

  /**
   * The guest's phone.
   *
   * Required, and that is a real decision rather than a lazy one: the host has
   * to be able to call a number, and a walk-in queue whose tickets have no
   * contact is a queue that only works when the guest stands at the door —
   * which is the case the feature exists to fix.
   */
  @Matches(PHONE, { message: '請輸入有效的聯絡電話' })
  contactPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** The host's settings form. A patch — only what is present is written. */
export class UpdateWaitlistSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  acceptWhenClosed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  minPartySize?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxPartySize?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  averageTurnMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  callTimeoutMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  customerNotice?: string | null;
}

/**
 * Advance one ticket.
 *
 * `to` is validated against the domain enum, not the Prisma one, so the
 * vocabulary has one definition — a value Prisma knows and the domain does not
 * would fail the machine's lookup and surface as a confusing 409.
 */
export class TransitionQueueEntryDto {
  @IsEnum(WaitlistStatus)
  to!: WaitlistStatus;

  /** Free text for the log. Carried into `statusReason`. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** Query for the host board. */
export class MerchantQueueQueryDto {
  /** Merchant-local `YYYY-MM-DD`. Defaults to today in the shop's zone. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

/** Query for the guest's own ticket lookup on the take-a-number page. */
export class MyTicketQueryDto {
  /**
   * The phone the guest queued with.
   *
   * The lookup key, because the page is used by people who are not signed in.
   * It is what they typed and what the host would ring — not a session id they
   * would have lost the moment they closed the tab.
   */
  @Matches(PHONE, { message: '請輸入有效的聯絡電話' })
  phone!: string;
}

/** The sweep request. Merchant-scoped so one shop cannot sweep another's. */
export class SweepQueueDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

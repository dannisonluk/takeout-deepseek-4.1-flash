import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  REFUND_NOTE_MAX_LENGTH,
  REFUND_REFERENCE_MAX_LENGTH,
  REFUND_REPLY_MAX_LENGTH,
  RefundReasonCode,
  RefundRequestStatus,
} from '@takeout/domain';

/**
 * File a refund request.
 *
 * `requestedAmountMinor` is optional and **advisory**. The platform never moves
 * this money — the shop and the customer settle it between themselves — so an
 * amount is a way for the customer to say "this much, please", not an
 * instruction to anyone. Omitting it means "the whole thing, we'll talk".
 *
 * `reasonCode` is a closed list so the shop can triage; `OTHER` needs `note`.
 * The bounds here are shape checks only, so a fat-fingered `1000000` is a 400
 * with a field name rather than a 422 from inside a transaction.
 */
export class FileRefundRequestDto {
  @IsEnum(RefundReasonCode)
  reasonCode!: RefundReasonCode;

  /** Advisory ask, in minor units. Never a payment instruction. */
  @IsOptional()
  @IsInt()
  @Min(1)
  requestedAmountMinor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(REFUND_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * The shop's move on a ticket.
 *
 * One DTO for all four moves rather than four DTOs, because the fields overlap
 * so heavily and the *state machine* is what decides which combination is
 * legal. `settledAmountMinor` / `settlementReference` are only meaningful for
 * `RESOLVED_OFFLINE`, and the machine refuses that move without at least one of
 * them — so a client that sends neither gets a 422 naming the rule rather than
 * a silently empty record.
 */
export class TransitionRefundRequestDto {
  @IsEnum(RefundRequestStatus)
  to!: RefundRequestStatus;

  /** The shop's reply, shown verbatim to the customer. */
  @IsOptional()
  @IsString()
  @MaxLength(REFUND_REPLY_MAX_LENGTH)
  merchantNote?: string;

  /** What the shop says it handed back. A claim, not a settlement record. */
  @IsOptional()
  @IsInt()
  @Min(1)
  settledAmountMinor?: number;

  /** Cash, a bank transfer, a voucher — anything the customer can quote. */
  @IsOptional()
  @IsString()
  @MaxLength(REFUND_REFERENCE_MAX_LENGTH)
  settlementReference?: string;
}

/** The customer's own move: withdraw. Nothing else is theirs to make. */
export class CancelRefundRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(REFUND_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * Queue filters.
 *
 * `status` accepts the literal `'ACTIVE'`, which is the default — a work queue
 * should not open on a year of resolved tickets.
 */
export class RefundQueueQueryDto {
  @IsOptional()
  @IsString()
  status?: RefundRequestStatus | 'ACTIVE' | 'ALL';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Admin view: same filters plus a merchant scope. */
export class AdminRefundQueryDto extends RefundQueueQueryDto {
  @IsOptional()
  @IsString()
  merchantId?: string;
}

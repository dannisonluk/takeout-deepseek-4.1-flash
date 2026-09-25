import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * 店內點餐 — request payloads.
 *
 * Two rules run through this file:
 *
 *   1. **No client sends an id it could have got from a scan.** The QR token,
 *      the table code and the session id are all things the server resolves;
 *      accepting them as independent inputs would let a guest order onto another
 *      table's tab by editing a request body.
 *   2. **No client sends a price.** The scan-to-order body carries a table code
 *      and a list of dish ids — exactly `PlaceOrderDto` minus the merchant,
 *      which is derived from the table.
 */

/** Create a table on the floor plan. */
export class CreateDiningTableDto {
  /**
   * The code printed on the QR label. Uppercased and stripped server-side, so
   * `a-12`, `A 12` and `A12` cannot become three tables.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9 -]{1,32}$/, { message: '桌號只可包含英文字母、數字、空格或連字號' })
  code!: string;

  /** Human label, e.g. `靠窗四人桌`. Optional — the code is the identity. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  seats?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Edit a table. A patch — only what is present is written. */
export class UpdateDiningTableDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  seats?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Rotate the QR token, invalidating the printed code for this table.
   *
   * The only lever a shop has when a code leaks — onto a photo, a review site,
   * or a previous diner's screenshot. `true` generates a new token; the old
   * printed label stops resolving.
   */
  @IsOptional()
  @IsBoolean()
  rotateQr?: boolean;
}

/**
 * Open a sitting at a table.
 *
 * The token is in the PATH (`POST /dine/table/:qrToken/session`), not the body:
 * the guest's device holds a URL, and requiring the same value twice would make
 * the two able to disagree. Only the party size is client-supplied.
 */
export class OpenDiningSessionDto {
  /**
   * The party size, shown on the kitchen ticket header.
   *
   * Optional rather than required: a guest who scans to order should not be
   * blocked by a field the host can fill in, and a table of one should not have
   * to lie. The host board can set it later.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  partySize?: number;
}

/** One dish and a quantity. Shared by every ordering body. */
export class DiningOrderItemDto {
  @IsString()
  @MaxLength(64)
  menuItemId!: string;

  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;
}

/**
 * Scan-and-order.
 *
 * The sitting is identified by the one-time token in the PATH
 * (`POST /dine/s/:guestToken/orders`), so the body never names a merchant, a
 * table or a session. Letting it name its own merchant would make "order from
 * shop A while seated in shop B" a two-field edit.
 */
export class ScanAndOrderDto {
  /**
   * The dishes for this round.
   *
   * `@IsArray` + `@ValidateNested` + `@Type` together, and all three are load-
   * bearing: `whitelist: true` strips any property without decorators, so a
   * nested array carrying only `@Type` is dropped before it is read and the
   * request fails as "items should not exist". An empty round is refused here
   * rather than in the use case so the error names the field.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DiningOrderItemDto)
  items!: DiningOrderItemDto[];

  /** Free text for the kitchen, e.g. `走冰`. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  customerNote?: string;

  /**
   * The guest's phone, optional here.
   *
   * Unlike the waitlist, a dine-in guest is already seated — the phone is not
   * how the shop finds them. It is captured only when they want the receipt.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactPhone?: string;

  /**
   * The caller's idempotency key.
   *
   * Worth accepting on this route specifically: a guest on a flaky in-store
   * Wi-Fi will tap 送出 twice, and a duplicate dine-in round is a real cost.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

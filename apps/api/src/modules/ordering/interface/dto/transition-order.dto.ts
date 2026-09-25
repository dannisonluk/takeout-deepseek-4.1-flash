import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { OrderStatus } from '@takeout/domain';

/** Generic transition body — used by the admin endpoint. */
export class TransitionOrderDto {
  @IsEnum(OrderStatus)
  to!: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** Merchant endpoints encode the target status in the path, so only a reason is sent. */
export class TransitionReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/**
 * `POST /merchant/:merchantId/orders/:orderId/confirm`.
 *
 * One call that does what the shop actually does in one motion: take the money
 * (for a pay-at-store order), take the order, and say when it will be ready.
 *
 * Both bounds are enforced here rather than in the use case so a bad value is a
 * 400 with a field name, not a 500 from deep inside a transaction. 240 minutes
 * is four hours — far beyond any kitchen's honest estimate, and short enough
 * that a fat-fingered `2400` cannot promise a customer a pickup time tomorrow.
 */
export class ConfirmOrderDto {
  /**
   * Minutes from now until the food is ready. Omit to use the merchant's own
   * `prepTimeMinutes`, which is the number the customer already saw.
   */
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'readyInMinutes must be at least 1' })
  @Max(240, { message: 'readyInMinutes cannot exceed 240 (4 hours)' })
  readyInMinutes?: number;

  /** Kitchen's message to the customer, shown verbatim on the tracking page. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FulfilmentMode, PaymentMode } from '@takeout/domain';

export class PlaceOrderItemDto {
  @IsUUID('4', { message: 'menuItemId must be a UUID' })
  menuItemId!: string;

  @IsInt()
  @Min(1)
  @Max(50, { message: 'A single line cannot exceed 50 units' })
  quantity!: number;
}

export class PlaceOrderDto {
  @IsUUID('4')
  merchantId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'An order must contain at least one item' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlaceOrderItemDto)
  items!: PlaceOrderItemDto[];

  /**
   * 指定時間預訂取餐. Omit for 即時製作. Prices are never sent by the client —
   * they are read from the menu inside the transaction.
   */
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'scheduledPickupAt must be an ISO-8601 timestamp' })
  scheduledPickupAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  customerNote?: string;

  @IsOptional()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'contactPhone must be a valid phone number' })
  contactPhone?: string;

  @IsOptional()
  @IsEnum(FulfilmentMode)
  fulfilmentMode?: FulfilmentMode;

  /**
   * How the customer intends to pay.
   *
   * `PAY_AT_STORE` is a first-class choice, not a fallback: the order is held
   * for the merchant to confirm receipt, and no payment intent is ever opened
   * for it. Omitting the field means `ONLINE`, which is what every existing
   * client sends implicitly.
   */
  @IsOptional()
  @IsEnum(PaymentMode)
  paymentMode?: PaymentMode;
}

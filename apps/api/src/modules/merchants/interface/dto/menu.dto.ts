import { MenuItemAvailability } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * HK$10,000.00 in minor units.
 *
 * A cap rather than none: `priceMinor` is a 32-bit `Int`, and a client that
 * sends dollars where minor units are expected ("58" for a HK$58 dish, or
 * "5800.5" for HK$58.005) is a bug that is much easier to catch here than in a
 * receipt. The ceiling is high enough that no legitimate menu hits it.
 */
const MAX_PRICE_MINOR = 1_000_000;
/** A per-day cap above this is a typo, not a supply constraint. */
const MAX_DAILY_QUOTA = 100_000;

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export class CreateMenuCategoryDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMenuCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  /**
   * Hiding a category is the recommended way to retire one: unlike DELETE it
   * keeps the items and their category grouping intact, so the menu can be
   * brought back for a seasonal special.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
//  Items
// ---------------------------------------------------------------------------

export class CreateMenuItemDto {
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

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
  @MaxLength(512)
  imageKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  imageBlurhash?: string;

  /** Minor units. HK$58.00 => 5800. */
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMinor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  /**
   * THE flag that drives the per-item platform fee. Set it deliberately: a
   * drink marked as a main item charges the customer HK$3.50 extra and pays
   * HK$3.50 less to the merchant.
   */
  @IsOptional()
  @IsBoolean()
  isMainItem?: boolean;

  @IsOptional()
  @IsEnum(MenuItemAvailability)
  availability?: MenuItemAvailability;

  /**
   * Daily supply cap. `null` (or omitted) means unlimited. `0` also means
   * unlimited — that is the convention the reservation SQL uses, so it is
   * normalised to `null` on write rather than stored as a second flavour of
   * "no cap".
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DAILY_QUOTA)
  dailyQuota?: number | null;

  /** Overrides the merchant's own prep time for this dish. `null` = inherit. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

export class UpdateMenuItemDto {
  /** Pass `null` to move the item out of every category. */
  @IsOptional()
  @IsUUID('4')
  categoryId?: string | null;

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
  @MaxLength(512)
  imageKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  imageBlurhash?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMinor?: number;

  @IsOptional()
  @IsBoolean()
  isMainItem?: boolean;

  @IsOptional()
  @IsEnum(MenuItemAvailability)
  availability?: MenuItemAvailability;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DAILY_QUOTA)
  dailyQuota?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

/** The one-tap switch on the kitchen menu screen. */
export class SetItemAvailabilityDto {
  @IsEnum(MenuItemAvailability)
  availability!: MenuItemAvailability;
}

// ---------------------------------------------------------------------------
//  Bulk reorder
// ---------------------------------------------------------------------------

export class ReorderEntryDto {
  @IsUUID('4')
  id!: string;

  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder!: number;
}

/**
 * Drag-and-drop reorder.
 *
 * One request rather than N: writing 40 items in 40 round-trips would leave the
 * menu in a half-reordered state if the operator navigated away mid-save, and
 * `sortOrder` has no uniqueness constraint that would catch the mess.
 */
export class ReorderMenuDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  entries!: ReorderEntryDto[];
}

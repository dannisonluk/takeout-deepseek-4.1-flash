import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RANKING_PRESET_NAMES, type RankingPresetName } from '@takeout/domain';
import { toBoolean, toNumber } from '../../../../common/validation/query';

export class DiscoveryQueryDto {
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  /**
   * Ignored unless both `latitude` and `longitude` are given. Capped at 30 km —
   * beyond that a "nearby merchants" list stops being about proximity and
   * becomes a directory, which is what `district` and `q` are for.
   */
  @IsOptional()
  @Transform(toNumber)
  @IsNumber()
  @Min(0.1)
  @Max(30)
  radiusKm?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  acceptingOnly?: boolean;

  /**
   * Ranking preset.
   *
   * `NEAREST` is the default and reproduces the original distance-only
   * ordering, so a client that never sends this is unaffected. Validated
   * against the domain's own preset list rather than a hand-copied array — a
   * new preset must not need a second edit here before it becomes usable.
   */
  @IsOptional()
  @IsIn(RANKING_PRESET_NAMES)
  sort?: RankingPresetName;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

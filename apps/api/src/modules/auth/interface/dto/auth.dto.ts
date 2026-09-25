import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Hong Kong numbers, with or without the +852 country code. The service
 * normalises to E.164 before anything is stored, so `9123 4567` and
 * `+85291234567` are the same account rather than two.
 */
const HK_PHONE = /^(?:\+?852[\s-]?)?[2-9]\d{7}$/;

export class RequestOtpDto {
  @IsString()
  @Matches(HK_PHONE, { message: '請輸入有效的香港電話號碼（8 位數字）' })
  phone!: string;

  @IsOptional()
  @IsIn(['LOGIN'])
  purpose?: string;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(HK_PHONE, { message: '請輸入有效的香港電話號碼（8 位數字）' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: '驗證碼為 6 位數字' })
  @Matches(/^\d{6}$/, { message: '驗證碼為 6 位數字' })
  code!: string;
}

export class RefreshTokenDto {
  @IsString()
  @Length(16, 512)
  refreshToken!: string;
}

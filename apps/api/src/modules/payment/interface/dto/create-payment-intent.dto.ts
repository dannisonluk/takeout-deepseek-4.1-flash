import { IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { PaymentProviderName } from '../../../../infrastructure/payment/payment-provider.port';

/** The rails a customer may name. Kept next to the DTO so the 400 is a 400. */
const RAIL_NAMES: readonly PaymentProviderName[] = ['STRIPE', 'PAYME', 'OCTOPUS', 'FPS_QR'];

/**
 * Body of `POST /orders/:orderId/payment-intent`.
 *
 * Empty is valid — card and wallet flows that stay inside the app need nothing
 * here. `returnUrl` only matters for redirect-based rails (PayMe, FPS), where
 * the provider has to know where to send the customer back to.
 */
export class CreatePaymentIntentDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_tld: false }, { message: 'returnUrl 必須是有效的網址' })
  returnUrl?: string;

  /**
   * Which rail to open the payment on. Omit for `PAYMENT_PROVIDER`.
   *
   * Validated against the full list rather than against the *configured* rails,
   * so a deployment that has not set up PayMe answers `422
   * PAYMENT_RAIL_UNAVAILABLE` — which names the environment variables — instead
   * of a generic "invalid value", which would read as a client bug.
   */
  @IsOptional()
  @IsIn(RAIL_NAMES, { message: 'provider 必須是 STRIPE / PAYME / OCTOPUS / FPS_QR 其中之一' })
  provider?: PaymentProviderName;
}

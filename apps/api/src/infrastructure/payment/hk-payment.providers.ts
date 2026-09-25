import { Inject, Injectable } from '@nestjs/common';
import { buildFpsQrPayload } from '@takeout/domain';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ManualSettlementPaymentProvider } from './manual-settlement.provider';
import {
  CreateIntentParams,
  PaymentIntentResult,
  PaymentProviderName,
} from './payment-provider.port';

/**
 * The three Hong Kong rails that are not card rails.
 *
 * They live in one file because they are the same adapter three times over —
 * the behaviour is entirely in `ManualSettlementPaymentProvider`, and each
 * subclass contributes an identifier, a reference prefix and a header name.
 * Splitting them would produce three files whose only difference is four lines
 * of constants, which is harder to keep consistent, not easier.
 *
 * Each is registered whether or not it is configured. A rail with no webhook
 * secret reports `configured: false`, and the registry refuses to open an intent
 * with it — so a half-configured deployment fails at checkout with a clear
 * message instead of accepting a payment it can never verify.
 */

/**
 * PayMe for Business.
 *
 * The customer pays inside the PayMe app. Our page shows a button that opens the
 * payment request; the acquirer confirms by signed callback.
 */
@Injectable()
export class PayMePaymentProvider extends ManualSettlementPaymentProvider {
  readonly name: PaymentProviderName = 'PAYME';
  protected readonly referencePrefix = 'payme_';
  protected readonly signatureHeader = 'x-payme-signature';
  protected readonly webhookSecret: string;
  private readonly merchantId: string;
  private readonly checkoutBaseUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.webhookSecret = config.payment.payme.webhookSecret;
    this.merchantId = config.payment.payme.merchantId;
    this.checkoutBaseUrl = config.payment.checkoutBaseUrl;
  }

  protected paymentLink(params: CreateIntentParams, providerRef: string): string {
    return `${this.checkoutBaseUrl}/payme/${providerRef}?order=${encodeURIComponent(params.orderNo)}`;
  }

  protected extraIntentFields({
    params,
    providerRef,
  }: {
    readonly params: CreateIntentParams;
    readonly providerRef: string;
  }): Partial<PaymentIntentResult> {
    // The merchant id travels in the payload rather than being assumed by the
    // client: a multi-merchant deployment routes the request to a specific
    // PayMe Business account.
    return { clientSecret: `${this.merchantId}:${providerRef}:${params.amountMinor}` };
  }
}

/**
 * Octopus / O! ePay.
 *
 * Same shape as PayMe. Kept as its own adapter because the reference namespace,
 * the signature header and the acquirer's settlement file are all different —
 * and a shared "wallet" adapter would have to branch on which one it is at every
 * step anyway.
 */
@Injectable()
export class OctopusPaymentProvider extends ManualSettlementPaymentProvider {
  readonly name: PaymentProviderName = 'OCTOPUS';
  protected readonly referencePrefix = 'oct_';
  protected readonly signatureHeader = 'x-octopus-signature';
  protected readonly webhookSecret: string;
  private readonly merchantId: string;
  private readonly checkoutBaseUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.webhookSecret = config.payment.octopus.webhookSecret;
    this.merchantId = config.payment.octopus.merchantId;
    this.checkoutBaseUrl = config.payment.checkoutBaseUrl;
  }

  protected paymentLink(params: CreateIntentParams, providerRef: string): string {
    return `${this.checkoutBaseUrl}/octopus/${providerRef}?order=${encodeURIComponent(params.orderNo)}`;
  }

  protected override extraIntentFields({
    providerRef,
  }: {
    readonly params: CreateIntentParams;
    readonly providerRef: string;
  }): Partial<PaymentIntentResult> {
    return { clientSecret: `${this.merchantId}:${providerRef}` };
  }
}

/**
 * 轉數快 (FPS QR).
 *
 * The only rail of the three that produces a genuinely scannable artefact: an
 * EMVCo merchant-presented QR built by the domain layer, carrying the amount and
 * our order reference. The customer scans it with any Hong Kong banking app and
 * the transfer lands in the merchant's account.
 *
 * There is no callback from the banking system for a plain FPS transfer, so
 * settlement is either confirmed by the acquirer's aggregation service or by an
 * operator who can see the statement. `verifyWebhook` supports the former;
 * `RefundService`'s `PENDING` semantics cover the latter.
 */
@Injectable()
export class FpsQrPaymentProvider extends ManualSettlementPaymentProvider {
  readonly name: PaymentProviderName = 'FPS_QR';
  protected readonly referencePrefix = 'fps_';
  protected readonly signatureHeader = 'x-fps-signature';
  protected readonly webhookSecret: string;

  private readonly fpsId: string;
  private readonly merchantName: string;
  private readonly checkoutBaseUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.webhookSecret = config.payment.fps.webhookSecret;
    this.fpsId = config.payment.fps.fpsId;
    this.merchantName = config.payment.fps.merchantName;
    this.checkoutBaseUrl = config.payment.checkoutBaseUrl;
  }

  /** A rail with no payee identity cannot produce a QR anybody can pay. */
  override get configured(): boolean {
    return super.configured && this.fpsId.length > 0 && this.merchantName.length > 0;
  }

  protected paymentLink(params: CreateIntentParams, providerRef: string): string {
    return `${this.checkoutBaseUrl}/fps/${providerRef}?order=${encodeURIComponent(params.orderNo)}`;
  }

  protected override extraIntentFields({
    params,
  }: {
    readonly params: CreateIntentParams;
    readonly providerRef: string;
  }): Partial<PaymentIntentResult> {
    return {
      // The client renders this as a QR. Returned as the `clientSecret` slot
      // because that is the field a client hands to a payment UI — for a QR rail
      // the "secret" is the payload itself.
      clientSecret: buildFpsQrPayload({
        fpsId: this.fpsId,
        merchantName: this.merchantName,
        amountMinor: params.amountMinor,
        currency: params.currency,
        reference: params.orderNo,
      }),
    };
  }
}

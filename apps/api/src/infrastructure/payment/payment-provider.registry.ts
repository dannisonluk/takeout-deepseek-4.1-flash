import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { PaymentRailUnavailableError, UnknownPaymentProviderError } from '../../modules/payment/domain/payment.errors';
import {
  FpsQrPaymentProvider,
  OctopusPaymentProvider,
  PayMePaymentProvider,
} from './hk-payment.providers';
import { IPaymentProvider, PaymentProviderName } from './payment-provider.port';
import { StripePaymentProvider } from './stripe-payment.provider';

/** What a rail looks like to the checkout page. */
export interface PaymentRailView {
  readonly name: PaymentProviderName;
  /** Human label for the payment-method picker. */
  readonly label: string;
  /** `false` when the deployment has no credentials for it. */
  readonly configured: boolean;
  /** Whether the customer leaves the app or the payment happens in-page. */
  readonly flow: 'IN_APP' | 'REDIRECT' | 'QR';
}

const LABELS: Readonly<Record<PaymentProviderName, string>> = {
  STRIPE: '信用卡 / 扣帳卡',
  PAYME: 'PayMe',
  OCTOPUS: '八達通 O! ePay',
  FPS_QR: '轉數快 FPS QR',
};

const FLOWS: Readonly<Record<PaymentProviderName, PaymentRailView['flow']>> = {
  STRIPE: 'IN_APP',
  PAYME: 'REDIRECT',
  OCTOPUS: 'REDIRECT',
  FPS_QR: 'QR',
};

/**
 * The environment variables each rail needs, for an error message that can
 * actually be acted on.
 */
const ENV_HINTS: Readonly<Record<PaymentProviderName, string>> = {
  STRIPE: 'STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET',
  PAYME: 'PAYME_MERCHANT_ID / PAYME_WEBHOOK_SECRET',
  OCTOPUS: 'OCTOPUS_MERCHANT_ID / OCTOPUS_WEBHOOK_SECRET',
  FPS_QR: 'FPS_ID / FPS_MERCHANT_NAME / FPS_WEBHOOK_SECRET',
};

/**
 * The set of payment rails this deployment can actually use.
 *
 * Exists for one reason: before it, `payment.module.ts` hardcoded
 * `useClass: StripePaymentProvider` for the `PAYMENT_PROVIDER` token, so
 * `PAYMENT_PROVIDER=PAYME` in the environment was read, parsed, validated and
 * then ignored. Every order went to Stripe regardless.
 *
 * Three rules it enforces:
 *
 *  1. **A rail is only usable if it is configured.** `resolve()` throws for an
 *     unconfigured rail rather than opening an intent that can never be
 *     settled. The failure is at checkout with a clear message, not three days
 *     later as an order that will not reconcile.
 *  2. **The default must be a real rail.** If `PAYMENT_PROVIDER` names something
 *     unconfigured, the registry says so loudly at boot and falls back to any
 *     configured rail — a deployment whose payment provider is silently
 *     unavailable is worse than one that starts with a warning.
 *  3. **A refund goes back the way it came.** `railFor()` looks a rail up by the
 *     name recorded on the payment, so a PayMe payment is never refunded
 *     through Stripe — which would fail, because Stripe has never heard of a
 *     `payme_…` reference.
 *
 * Nothing here throws during `onModuleInit`. Booting must not depend on payment
 * credentials: an API that refuses to start because a wallet secret is missing
 * is an outage, whereas an API that starts and refuses one payment method is a
 * degraded service. The refusal happens at the request that needs it.
 */
@Injectable()
export class PaymentProviderRegistry implements OnModuleInit {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly providers = new Map<PaymentProviderName, IPaymentProvider>();

  constructor(
    stripe: StripePaymentProvider,
    payme: PayMePaymentProvider,
    octopus: OctopusPaymentProvider,
    fps: FpsQrPaymentProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    for (const provider of [stripe, payme, octopus, fps]) {
      this.providers.set(provider.name, provider);
    }
  }

  onModuleInit(): void {
    this.logger.log(
      `payment rails: ${this.list()
        .map((rail) => `${rail.name}${rail.configured ? '' : ' (unconfigured)'}`)
        .join(', ')}; default=${this.defaultName}`,
    );
    if (!this.isConfigured(this.config.payment.defaultProvider)) {
      this.logger.warn(
        `PAYMENT_PROVIDER=${this.config.payment.defaultProvider} is not configured; ` +
          `falling back to ${this.defaultName}. Set its credentials or change the default.`,
      );
    }
  }

  /** Every rail name the registry knows, configured or not. */
  get names(): PaymentProviderName[] {
    return [...this.providers.keys()];
  }

  /** Whether a named rail is both known and usable. */
  isConfigured(name: string): boolean {
    return this.find(name)?.configured ?? false;
  }

  /**
   * The rail an order uses when the customer does not choose one.
   *
   * Falls back rather than throwing: the warning in `onModuleInit` makes the
   * situation visible without turning it into a boot failure.
   */
  get defaultName(): PaymentProviderName {
    const preferred = this.config.payment.defaultProvider;
    if (this.isConfigured(preferred)) return preferred;

    const fallback = this.list().find((entry) => entry.configured);
    return fallback?.name ?? preferred;
  }

  /**
   * The default rail, resolved strictly.
   *
   * Only ever called from a request, never from `onModuleInit` — so a
   * deployment with no payment credentials boots and then fails the one request
   * it cannot serve, with a 422 naming the variables to set.
   */
  get default(): IPaymentProvider {
    return this.resolve(this.defaultName);
  }

  /**
   * Look up a rail, refusing one that cannot be used.
   *
   * The message names the environment variable the operator has to set, because
   * "PAYME is not configured" without that is a support ticket.
   */
  resolve(name: PaymentProviderName): IPaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new UnknownPaymentProviderError(name, this.names);
    if (!provider.configured) {
      throw new PaymentRailUnavailableError(name, ENV_HINTS[name]);
    }
    return provider;
  }

  /**
   * Look up a rail without the configuration check — for the webhook endpoint.
   *
   * A settlement callback for an unconfigured rail still has to reach
   * `verifyWebhook`, because that is what rejects it: the signature cannot be
   * verified without the secret, and the provider throws rather than trusting
   * the body. Refusing earlier would hide the real reason behind a generic
   * "unknown provider".
   */
  find(name: string): IPaymentProvider | undefined {
    return this.providers.get(name.toUpperCase() as PaymentProviderName);
  }

  /**
   * The rail that actually took a payment, for refunding it.
   *
   * Deliberately **lenient**: if the recorded rail is gone or unconfigured
   * (credentials rotated away, a rail decommissioned), this returns the default
   * rather than throwing. The refund row still has to be written — a `PENDING`
   * record an operator can settle by hand beats a 500 that leaves the customer
   * with no trace of their request.
   */
  railFor(provider: string | null | undefined): IPaymentProvider {
    const named = provider ? this.find(provider) : undefined;
    if (named) return named;

    const fallback = this.providers.get(this.defaultName);
    if (!fallback) throw new UnknownPaymentProviderError(provider ?? this.defaultName, this.names);
    return fallback;
  }

  /** Every rail, for the payment-method picker. */
  list(): PaymentRailView[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      label: LABELS[provider.name],
      configured: provider.configured,
      flow: FLOWS[provider.name],
    }));
  }
}

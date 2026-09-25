import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import {
  InvalidWebhookSignatureError,
  WebhookNotConfiguredError,
} from '../../modules/payment/domain/payment.errors';
import {
  CreateIntentParams,
  IPaymentProvider,
  PaymentIntentResult,
  PaymentProviderName,
  RefundParams,
  RefundResult,
  WebhookEvent,
} from './payment-provider.port';

/**
 * Stripe adapter — the MVP rail for card payments in Hong Kong.
 *
 * `apiVersion` is intentionally omitted so the SDK's pinned version is used;
 * bumping it becomes an explicit dependency upgrade rather than a silent change.
 */
@Injectable()
export class StripePaymentProvider implements IPaymentProvider {
  readonly name: PaymentProviderName = 'STRIPE';

  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly secretKey: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secretKey = config.payment.stripe.secretKey;
    this.stripe = new Stripe(this.secretKey, {
      // Let a slow PSP call surface as an error instead of hanging a request.
      timeout: 10_000,
      maxNetworkRetries: 2,
    });
    this.webhookSecret = config.payment.stripe.webhookSecret;
  }

  /**
   * Both halves matter. A secret key with no webhook secret can open an intent
   * but can never confirm one — the order would sit at PENDING_PAYMENT until it
   * expired, with the customer's money already taken.
   */
  get configured(): boolean {
    return this.secretKey.length > 0 && this.webhookSecret.length > 0;
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: params.amountMinor,
        currency: params.currency.toLowerCase(),
        metadata: { orderId: params.orderId, orderNo: params.orderNo },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: params.idempotencyKey },
    );

    return {
      providerRef: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      status: mapIntentStatus(intent.status),
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): WebhookEvent {
    const signature = headers['stripe-signature'];
    if (!signature) {
      throw new InvalidWebhookSignatureError('STRIPE', 'missing stripe-signature header');
    }
    if (!this.webhookSecret) {
      throw new WebhookNotConfiguredError('STRIPE', 'STRIPE_WEBHOOK_SECRET');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (error) {
      // Normalised rather than rethrown raw. The SDK's verification error is a
      // plain `Error`, so it reached the exception filter unmapped and became a
      // 500 — which tells the sender to retry a signature that will never
      // become valid, and hides a rejected forgery behind an alert about a
      // server bug.
      throw new InvalidWebhookSignatureError('STRIPE', (error as Error).message);
    }

    const object = event.data.object as Stripe.PaymentIntent | Stripe.Refund;

    return {
      eventId: event.id,
      type: mapEventType(event.type),
      providerRef: object.id,
      amountMinor: 'amount' in object ? (object.amount ?? 0) : 0,
      currency: ('currency' in object ? object.currency : 'hkd').toUpperCase(),
      raw: event,
    };
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: params.providerRef,
        amount: params.amountMinor,
        reason: 'requested_by_customer',
        metadata: { reason: params.reason },
      },
      { idempotencyKey: params.idempotencyKey },
    );

    return {
      refundRef: refund.id,
      status: refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'failed' ? 'FAILED' : 'PENDING',
    };
  }
}

function mapIntentStatus(status: Stripe.PaymentIntent.Status): PaymentIntentResult['status'] {
  switch (status) {
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'REQUIRES_ACTION';
    case 'processing':
      return 'PENDING';
    case 'requires_capture':
      return 'AUTHORIZED';
    case 'succeeded':
      return 'CAPTURED';
    default:
      return 'PENDING';
  }
}

function mapEventType(type: string): WebhookEvent['type'] {
  switch (type) {
    case 'payment_intent.succeeded':
      return 'PAYMENT_CAPTURED';
    case 'payment_intent.payment_failed':
      return 'PAYMENT_FAILED';
    case 'charge.refunded':
    case 'refund.updated':
      return 'REFUND_SETTLED';
    default:
      return 'UNKNOWN';
  }
}

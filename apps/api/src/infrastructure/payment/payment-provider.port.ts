/**
 * Payment provider port.
 *
 * Hong Kong needs more than one rail — Stripe for cards, PayMe and Octopus for
 * wallets, FPS QR for bank transfer. Each becomes an adapter behind this
 * interface; `PaymentModule` picks one per merchant.
 */

export type PaymentProviderName = 'STRIPE' | 'PAYME' | 'OCTOPUS' | 'FPS_QR';

export interface CreateIntentParams {
  readonly orderId: string;
  readonly orderNo: string;
  /** Minor units. HK$58.00 => 5800. */
  readonly amountMinor: number;
  readonly currency: string;
  /** Idempotency key so a retried request cannot create a second charge. */
  readonly idempotencyKey: string;
  readonly customerId: string;
  /** Where the provider should send the customer back after 3-DS. */
  readonly returnUrl?: string;
}

export interface PaymentIntentResult {
  /** Provider-side identifier — Stripe PaymentIntent id, PayMe txn id, … */
  readonly providerRef: string;
  /** Handed to the client SDK to complete the payment. */
  readonly clientSecret?: string;
  readonly status: 'REQUIRES_ACTION' | 'PENDING' | 'AUTHORIZED' | 'CAPTURED';
  /** Present when the provider supports redirect-based flows (PayMe, FPS). */
  readonly redirectUrl?: string;
}

export interface RefundParams {
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly refundRef: string;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

/** Normalised webhook event, whatever the provider's payload looked like. */
export interface WebhookEvent {
  readonly eventId: string;
  readonly type: 'PAYMENT_CAPTURED' | 'PAYMENT_FAILED' | 'REFUND_SETTLED' | 'UNKNOWN';
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly raw: unknown;
}

export interface IPaymentProvider {
  readonly name: PaymentProviderName;

  /**
   * Whether this deployment holds the credentials the rail needs.
   *
   * Part of the contract rather than an optional extra: `PaymentProviderRegistry`
   * refuses to open an intent on an unconfigured rail, and it can only do that
   * if every adapter answers the question. An adapter that silently defaults to
   * `true` would let a half-configured deployment accept a payment it can never
   * verify.
   */
  readonly configured: boolean;

  createIntent(params: CreateIntentParams): Promise<PaymentIntentResult>;

  /**
   * Verify the signature and normalise the body.
   * MUST throw on a bad signature — an unverified webhook is an open door to
   * marking any order as paid.
   */
  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): WebhookEvent;

  refund(params: RefundParams): Promise<RefundResult>;
}

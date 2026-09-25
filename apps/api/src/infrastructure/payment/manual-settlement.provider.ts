import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
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
 * Shared behaviour for the Hong Kong rails that are **not** card rails.
 *
 * PayMe, Octopus and FPS QR all work the same way in practice, and it is not
 * the way Stripe works:
 *
 *  - The platform does **not** capture anything. It presents a payment request —
 *    a QR to scan, or a deep link into the customer's wallet app — and the money
 *    arrives later, out of band.
 *  - Settlement is announced by a **signed callback** from the acquirer, or, for
 *    a plain FPS transfer, confirmed by an operator who can see the bank
 *    statement. There is no `capture` call to make.
 *  - **Refunds are not an API call.** Every one of these rails settles a refund
 *    through the merchant's own banking or wallet portal. Pretending otherwise
 *    — returning `SUCCEEDED` from a method that contacted nobody — is how a
 *    system reports money as returned while it is still in the account.
 *
 * So the honest contract is: `createIntent` produces a payload and a reference;
 * `verifyWebhook` authenticates the callback; `refund` records an intent and
 * leaves it `PENDING` for a human. `RefundService` already treats `PENDING` as
 * "recorded, not settled" and never renders it as refunded.
 *
 * The provider reference is derived from the idempotency key rather than
 * generated. A retried checkout must produce the *same* reference, or the
 * `payments.(provider, providerRef)` unique index would reject the second one
 * and the customer would be looking at an error for a payment that is fine.
 */
export abstract class ManualSettlementPaymentProvider implements IPaymentProvider {
  abstract readonly name: PaymentProviderName;

  protected readonly logger = new Logger(this.constructor.name);

  /**
   * Prefix on the provider reference, so a reference is self-describing in the
   * database and in a bank statement reconciliation.
   */
  protected abstract readonly referencePrefix: string;

  /** Header carrying the HMAC. Each acquirer names it differently. */
  protected abstract readonly signatureHeader: string;

  /** Shared secret for that HMAC. Empty means "this rail is not configured". */
  protected abstract readonly webhookSecret: string;

  /** Whether the identifiers this rail needs are present. */
  get configured(): boolean {
    return this.webhookSecret.length > 0;
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    const providerRef = `${this.referencePrefix}${digest(params.idempotencyKey)}`;

    return {
      providerRef,
      // No client secret: there is no SDK session to confirm. The customer
      // completes the payment in their own app, which is what `REQUIRES_ACTION`
      // means for these rails.
      status: 'REQUIRES_ACTION',
      redirectUrl: this.paymentLink(params, providerRef),
      ...(await this.extraIntentFields({ params, providerRef })),
    };
  }

  /**
   * Verify the callback.
   *
   * `timingSafeEqual` rather than `===`. A byte-by-byte comparison leaks how
   * many leading characters of a forged signature were right, which is enough
   * to reconstruct a valid one. The lengths are compared first because
   * `timingSafeEqual` throws on a length mismatch — and the length of an HMAC is
   * not a secret.
   *
   * A missing secret is a hard failure, never a pass. A rail that accepts
   * unsigned callbacks is a rail that lets anybody mark any order as paid.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): WebhookEvent {
    const presented = headers[this.signatureHeader] ?? headers['x-signature'];
    if (!presented) {
      throw new InvalidWebhookSignatureError(this.name, `missing ${this.signatureHeader} header`);
    }
    if (!this.webhookSecret) {
      throw new WebhookNotConfiguredError(this.name, `${this.name}_WEBHOOK_SECRET`);
    }

    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (!safeEqual(presented.trim().toLowerCase(), expected)) {
      throw new InvalidWebhookSignatureError(this.name, 'signature does not match the body');
    }

    return this.parseWebhook(rawBody);
  }

  /**
   * Record the refund; a human settles it.
   *
   * `refundRef` is deterministic for the same reason the payment reference is:
   * a retried `RefundService.issue` must not look like a second refund.
   */
  async refund(params: RefundParams): Promise<RefundResult> {
    this.logger.log(
      `${this.name} refund ${params.amountMinor} minor units for ${params.providerRef} ` +
        `recorded — ${this.name} has no refund API; settle it in the merchant portal`,
    );
    return {
      refundRef: `${this.referencePrefix}rf_${digest(params.idempotencyKey)}`,
      status: 'PENDING',
    };
  }

  /** The deep link or payload the customer acts on. Rail-specific. */
  protected abstract paymentLink(params: CreateIntentParams, providerRef: string): string | undefined;

  /**
   * Anything extra this rail wants to return — FPS puts the QR payload here.
   *
   * Takes **one object** rather than two positional arguments on purpose. When
   * this was `(params, providerRef)`, a subclass that only needed the reference
   * could declare `(providerRef: string)` and TypeScript would accept it —
   * because a function with fewer parameters is assignable to one with more —
   * and then receive `params` in that slot. That shipped an Octopus client
   * secret of `"merchant:[object Object]"` with no compile error. A single
   * destructured argument cannot be mis-ordered.
   */
  protected extraIntentFields(_context: {
    readonly params: CreateIntentParams;
    readonly providerRef: string;
  }): Promise<Partial<PaymentIntentResult>> | Partial<PaymentIntentResult> {
    return {};
  }

  /** Decode an authenticated body into the normalised event. */
  protected parseWebhook(rawBody: Buffer): WebhookEvent {
    const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    return {
      eventId: String(parsed.eventId ?? parsed.id ?? ''),
      // Every key an acquirer might use for the event name. `event_type` was
      // missing here while the comment below claimed the snake form was
      // accepted, so a real `payment.captured` payload normalised to UNKNOWN
      // and the settlement was dropped — the exact failure the comment warns
      // about. The key list is the contract; keep it in step with the comment.
      type: normaliseEventType(parsed.type ?? parsed.eventType ?? parsed.event_type),
      providerRef: String(parsed.providerRef ?? parsed.reference ?? parsed.provider_ref ?? ''),
      amountMinor: Number(parsed.amountMinor ?? parsed.amount ?? parsed.amount_minor ?? 0),
      currency: String(parsed.currency ?? 'HKD').toUpperCase(),
      raw: parsed,
    };
  }
}

function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Map an acquirer's own event vocabulary onto ours.
 *
 * Accepts both the camelCase names we emit in our own fixtures and the
 * snake/dot forms a real acquirer uses, because getting this wrong means a
 * settled payment is silently ignored — the worst kind of bug, since the
 * customer has paid and the order still says otherwise.
 */
function normaliseEventType(raw: unknown): WebhookEvent['type'] {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('captur') || value.includes('succeed') || value.includes('paid')) {
    return 'PAYMENT_CAPTURED';
  }
  if (value.includes('fail') || value.includes('declin') || value.includes('expire')) {
    return 'PAYMENT_FAILED';
  }
  if (value.includes('refund')) {
    return 'REFUND_SETTLED';
  }
  return 'UNKNOWN';
}

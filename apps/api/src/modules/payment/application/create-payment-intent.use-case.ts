import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import {
  IPaymentProvider,
  PaymentProviderName,
} from '../../../infrastructure/payment/payment-provider.port';
import { PaymentProviderRegistry } from '../../../infrastructure/payment/payment-provider.registry';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  PaymentIntentFailedError,
  PaymentNotRequiredError,
} from '../../ordering/domain/ordering.errors';

/** What the client needs to actually pay. Provider-shaped, not our shape. */
export interface PaymentIntentView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly provider: PaymentProviderName;
  readonly providerRef: string;
  /** Handed to the provider's client SDK. Absent for redirect flows. */
  readonly clientSecret: string | null;
  /** PayMe / FPS send the customer here instead. */
  readonly redirectUrl: string | null;
  readonly status: 'REQUIRES_ACTION' | 'PENDING' | 'AUTHORIZED' | 'CAPTURED';
  readonly amountMinor: number;
  readonly currency: string;
  /** Non-null when no real PSP was contacted. Must be shown, never swallowed. */
  readonly notice: string | null;
}

/** Stashed on `payments.rawPayload` so a repeat request reuses the same intent. */
interface StoredIntent {
  readonly clientSecret: string | null;
  readonly redirectUrl: string | null;
  readonly status: PaymentIntentView['status'];
  readonly simulated: boolean;
}

/**
 * Opens (or re-opens) the payment session for an order.
 *
 * Idempotent by construction, and at three levels:
 *
 *  1. `payments.idempotencyKey` is `pi:<orderId>` and unique, so two concurrent
 *     requests cannot create two payment rows for one order.
 *  2. A row that already carries a stored intent is returned as-is. This is the
 *     normal case — a customer who reloads the checkout page, or retries after
 *     a 3-DS redirect, must NOT get a second charge.
 *  3. The provider call is made *outside* any transaction, after the row is
 *     durable, so a crash mid-call leaves a recoverable `PENDING` row rather
 *     than an orphaned charge with no local record.
 *
 * The rail is chosen per request, not per deployment. `PAYMENT_PROVIDER` only
 * decides what happens when the customer does not pick one; the idempotency key
 * is still just `pi:<orderId>`, so a customer who switches from card to FPS
 * before paying gets the same single payment row rather than two.
 */
@Injectable()
export class CreatePaymentIntentUseCase {
  private readonly logger = new Logger(CreatePaymentIntentUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rails: PaymentProviderRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `null` when the order does not exist *or* belongs to someone else. */
  async execute(input: {
    orderId: string;
    customerId: string;
    returnUrl?: string;
    /** Omit to use the deployment default. */
    provider?: PaymentProviderName;
  }): Promise<PaymentIntentView | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, customerId: input.customerId },
      select: {
        id: true,
        orderNo: true,
        status: true,
        merchantId: true,
        currency: true,
        totalMinor: true,
        paymentMode: true,
      },
    });
    if (!order) return null;

    if (order.status !== 'PENDING_PAYMENT') {
      throw new PaymentNotRequiredError(order.id, order.status);
    }

    // A pay-at-store order must never open a card intent. Without this, a
    // customer who chose 到店付款 could be charged online *and* at the counter,
    // and the platform would have taken a processing fee on money the merchant
    // collected by hand. 409 rather than 422: the request is well-formed and
    // the order is real — it is the state of the order that makes it wrong.
    if (order.paymentMode === 'PAY_AT_STORE') {
      throw new PaymentNotRequiredError(order.id, `${order.status} (PAY_AT_STORE)`);
    }

    // Resolved after the ownership check on purpose. An unconfigured rail is
    // not order-specific, so answering 422 first would tell a caller that a
    // given order id exists without ever proving they own it.
    const rail: IPaymentProvider = input.provider
      ? this.rails.resolve(input.provider)
      : this.rails.default;

    const idempotencyKey = `pi:${order.id}`;

    // Step 1: make the row durable. `upsert` rather than `create` so a retried
    // request is a no-op instead of a unique-constraint 500.
    const payment = await this.prisma.payment.upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        orderId: order.id,
        merchantId: order.merchantId,
        provider: rail.name,
        idempotencyKey,
        status: PaymentStatus.PENDING,
        currency: order.currency,
        amountMinor: order.totalMinor,
      },
      select: { id: true, providerRef: true, rawPayload: true, amountMinor: true },
    });

    // Step 2: reuse an intent we already opened.
    const stored = readStoredIntent(payment.rawPayload);
    if (payment.providerRef && stored) {
      return this.toView(order, rail, payment.providerRef, stored);
    }

    // Step 3: open one.
    if (!this.config.payment.liveMode) {
      // No PSP is contacted. Return a clearly-labelled simulated intent so the
      // whole checkout flow is exercisable in development — and say so in the
      // payload, because a client that renders this as "paid" would be lying to
      // the customer.
      const simulated: StoredIntent = {
        clientSecret: `simulated_secret_${order.id}`,
        redirectUrl: null,
        status: 'REQUIRES_ACTION',
        simulated: true,
      };
      const providerRef = `sim_${order.id}`;

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef, rawPayload: { ...simulated } },
      });

      this.logger.warn(
        `PAYMENT_LIVE_MODE=false — simulated intent for order ${order.orderNo}. ` +
          `No payment provider was contacted.`,
      );

      return this.toView(order, rail, providerRef, simulated);
    }

    let result;
    try {
      result = await rail.createIntent({
        orderId: order.id,
        orderNo: order.orderNo,
        amountMinor: order.totalMinor,
        currency: order.currency,
        idempotencyKey,
        customerId: input.customerId,
        returnUrl: input.returnUrl,
      });
    } catch (error) {
      const reason = (error as Error).message;
      // Record the failure on the row so the console can explain a stuck order,
      // then surface it. The row stays PENDING: the customer may retry.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { failureCode: 'INTENT_FAILED', failureMessage: reason },
      });
      throw new PaymentIntentFailedError(order.id, reason);
    }

    const created: StoredIntent = {
      clientSecret: result.clientSecret ?? null,
      redirectUrl: result.redirectUrl ?? null,
      status: result.status,
      simulated: false,
    };

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: result.providerRef, rawPayload: { ...created } },
    });

    return this.toView(order, rail, result.providerRef, created);
  }

  private toView(
    order: { id: string; orderNo: string; currency: string; totalMinor: number },
    rail: IPaymentProvider,
    providerRef: string,
    intent: StoredIntent,
  ): PaymentIntentView {
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      provider: rail.name,
      providerRef,
      clientSecret: intent.clientSecret,
      redirectUrl: intent.redirectUrl,
      status: intent.status,
      amountMinor: order.totalMinor,
      currency: order.currency,
      notice: intent.simulated
        ? 'PAYMENT_LIVE_MODE=false：此為模擬付款，未聯絡任何支付服務。切勿當作已付款處理。'
        : null,
    };
  }
}

/** Tolerant read: `rawPayload` is `Json`, so it is `unknown` until checked. */
function readStoredIntent(raw: unknown): StoredIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.status !== 'string') return null;

  return {
    clientSecret: typeof value.clientSecret === 'string' ? value.clientSecret : null,
    redirectUrl: typeof value.redirectUrl === 'string' ? value.redirectUrl : null,
    status: value.status as StoredIntent['status'],
    simulated: value.simulated === true,
  };
}

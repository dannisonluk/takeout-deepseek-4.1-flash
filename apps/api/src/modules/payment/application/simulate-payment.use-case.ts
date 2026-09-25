import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderActor, OrderStatus } from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TransitionOrderUseCase } from '../../ordering/application/transition-order.use-case';
import { PaymentNotRequiredError } from '../../ordering/domain/ordering.errors';

export interface SimulatedPaymentView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: string;
  readonly paidAt: string;
  readonly notice: string;
}

/**
 * Settle an order without a payment provider.
 *
 * **Development only.** With `PAYMENT_LIVE_MODE=true` this use case is never
 * reachable — the controller returns 404, so the endpoint does not even
 * advertise its existence in production.
 *
 * It exists because the second half of the order lifecycle is otherwise
 * untestable: a real capture arrives by signed webhook from Stripe, and without
 * a way to stand in for that, nobody can exercise the kitchen board, the accept
 * deadline, the payout ledger or the refund path locally. The alternative
 * people reach for instead — pasting the webhook secret into a browser — is far
 * worse than a guarded endpoint that refuses to exist in production.
 *
 * It advances the order through exactly the same `TransitionOrderUseCase` the
 * webhook uses, so the side effects (merchant notification, accept-deadline
 * timer, outbox event) are the real ones.
 */
@Injectable()
export class SimulatePaymentUseCase {
  private readonly logger = new Logger(SimulatePaymentUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitionOrder: TransitionOrderUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `false` means "this deployment does not offer simulation". */
  get enabled(): boolean {
    return !this.config.payment.liveMode;
  }

  /** `null` when the order does not exist *or* belongs to someone else. */
  async execute(input: { orderId: string; customerId: string }): Promise<SimulatedPaymentView | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, customerId: input.customerId },
      select: {
        id: true,
        orderNo: true,
        status: true,
        totalMinor: true,
        currency: true,
        merchantId: true,
        paymentMode: true,
      },
    });
    if (!order) return null;

    if (order.status !== 'PENDING_PAYMENT') {
      throw new PaymentNotRequiredError(order.id, order.status);
    }

    // Simulating a payment on a pay-at-store order would let a customer mark
    // their own order paid without the merchant ever confirming the cash — and
    // it would record a STRIPE capture that never happened. The merchant is the
    // only actor that may settle these.
    if (order.paymentMode === 'PAY_AT_STORE') {
      throw new PaymentNotRequiredError(order.id, `${order.status} (PAY_AT_STORE)`);
    }

    // Mark the payment captured first, then advance the order. That order is
    // deliberate and matches the webhook: if the transition fails (say a
    // concurrent cancel won the race), the money record is already correct and
    // the discrepancy is visible rather than hidden.
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (payment) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CAPTURED', capturedAt: new Date() },
      });
    } else {
      // No intent was ever opened. Record one anyway, so the payout ledger and
      // the reconciliation view have something to balance against.
      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          merchantId: order.merchantId,
          provider: 'STRIPE',
          idempotencyKey: `sim:${order.id}`,
          providerRef: `sim_${order.id}`,
          status: 'CAPTURED',
          currency: order.currency,
          amountMinor: order.totalMinor,
          capturedAt: new Date(),
        },
      });
    }

    await this.transitionOrder.execute({
      orderId: order.id,
      to: OrderStatus.PAID,
      actor: OrderActor.SYSTEM,
      reason: 'payment simulated (PAYMENT_LIVE_MODE=false)',
    });

    this.logger.warn(
      `Simulated payment for order ${order.orderNo} — no provider was contacted.`,
    );

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      status: OrderStatus.PAID,
      paidAt: new Date().toISOString(),
      notice: 'PAYMENT_LIVE_MODE=false：此為模擬付款，未聯絡任何支付服務。',
    };
  }
}

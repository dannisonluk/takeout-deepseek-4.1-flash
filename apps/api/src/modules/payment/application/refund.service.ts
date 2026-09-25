import { Inject, Injectable, Logger } from '@nestjs/common';
import { RefundStatus } from '@prisma/client';
import { OrderActor, OrderStateMachine, OrderStatus } from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { ORDER_STATE_MACHINE } from '../../../common/tokens';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PaymentProviderRegistry } from '../../../infrastructure/payment/payment-provider.registry';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TransitionOrderUseCase } from '../../ordering/application/transition-order.use-case';

/** Why an attempt did not result in a refund row. */
export type RefundAttemptKind =
  /** A refund row was written. Inspect `providerStatus` for what the PSP said. */
  | 'ISSUED'
  /** No captured payment, or nothing left to refund. */
  | 'NOT_REFUNDABLE'
  /** Requested more than remains refundable. */
  | 'EXCEEDS_CAPTURE';

export interface RefundAttempt {
  readonly kind: RefundAttemptKind;
  readonly refundId: string | null;
  readonly paymentId: string | null;
  readonly amountMinor: number;
  readonly refundableMinor: number;
  readonly alreadyRefundedMinor: number;
  /** `null` when no row was written. `PENDING` when live mode is off. */
  readonly providerStatus: RefundStatus | null;
  readonly providerRef: string | null;
  /** Which rail the money is going back through. */
  readonly provider: string | null;
  readonly failureReason: string | null;
  /** Present when the PSP was deliberately not called. Never silently omitted. */
  readonly notice: string | null;
  /** Set when the refund also moved the order; `null` when the status allows no move. */
  readonly orderTransition: { readonly from: OrderStatus; readonly to: OrderStatus } | null;
}

export interface IssueRefundParams {
  readonly orderId: string;
  /** Minor units. Defaults to everything still refundable. */
  readonly amountMinor?: number;
  readonly reason: string;
  /**
   * Who asked. `null` for the order state machine's own `ISSUE_REFUND` side
   * effect — the `refunds.requestedBy` column is nullable for exactly this case.
   */
  readonly requestedBy: string | null;
  /** Which actor drives the follow-on `-> REFUNDED` transition. */
  readonly actor: OrderActor;
  readonly actorId?: string;
  /** When present an `order.refund_requested` audit row is written in the same transaction. */
  readonly audit?: {
    readonly actorId: string;
    readonly actorRole: string;
    readonly ip: string | null;
  };
}

/**
 * The one place money is given back.
 *
 * Two callers, one implementation:
 *  - `AdminOrdersService.refund` — an operator refunding by hand.
 *  - `OrderRefundReactorService` — the `ISSUE_REFUND` side effect the order
 *    state machine has always declared on `-> REJECTED`, `-> CANCELLED` and
 *    `PAID -> EXPIRED`. Before this service existed that side effect was
 *    declared and never discharged, so a merchant rejecting a paid order left
 *    the customer's money captured with nothing to release it.
 *
 * Order of operations is deliberate:
 *
 *  1. **Record before calling.** A `PENDING` row is written first, so a process
 *     that dies mid-flight leaves something an operator can reconcile instead
 *     of money that moved with no trace.
 *  2. **The provider call happens outside any transaction.** A network round
 *     trip must never hold a database transaction open.
 *  3. **The order only advances along a transition the state machine permits.**
 *     A terminal status (`EXPIRED`) has no `-> REFUNDED` edge, so the money
 *     moves and the order keeps its history. "Refund" does not mean "rewrite
 *     the past".
 *
 * The rail is read off the payment row, never off the deployment default. An
 * order paid by PayMe that is refunded through Stripe fails at the PSP, because
 * Stripe has never heard of a `payme_…` reference — and it fails *after* the
 * refund row is written, which reads as "refund attempted and rejected" rather
 * than "wrong rail".
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transitionOrder: TransitionOrderUseCase,
    @Inject(ORDER_STATE_MACHINE) private readonly stateMachine: OrderStateMachine,
    private readonly rails: PaymentProviderRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(params: IssueRefundParams): Promise<RefundAttempt> {
    const order = await this.prisma.order.findUnique({
      where: { id: params.orderId },
      select: {
        id: true,
        status: true,
        payments: {
          where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
          orderBy: { capturedAt: 'desc' },
          select: { id: true, provider: true, providerRef: true, amountMinor: true },
        },
      },
    });

    if (!order) return notRefundable();

    const payment = order.payments[0];
    if (!payment?.providerRef) return notRefundable(payment?.id ?? null);

    // Money taken at the counter is not in anybody's PSP ledger. Calling a rail
    // with a `manual_…` reference would fail at the provider — after the refund
    // row was written — and read as "refund rejected" rather than "there is no
    // rail to reject it". So the row is recorded and a human settles it.
    const isManualSettlement = payment.provider === 'MANUAL';

    // The rail that took the money. `railFor` is lenient by design: a refund
    // must still be *recorded* even when the rail is no longer configured, so
    // an operator can settle it by hand.
    const rail = isManualSettlement ? null : this.rails.railFor(payment.provider);
    const railName = rail?.name ?? 'MANUAL';

    const alreadyRefundedMinor = await this.refundedTotal(payment.id);
    const refundableMinor = payment.amountMinor - alreadyRefundedMinor;
    if (refundableMinor <= 0) return notRefundable(payment.id, alreadyRefundedMinor);

    const amountMinor = params.amountMinor ?? refundableMinor;
    if (amountMinor > refundableMinor) {
      return {
        ...notRefundable(payment.id, alreadyRefundedMinor),
        kind: 'EXCEEDS_CAPTURE',
        amountMinor,
        refundableMinor,
        provider: railName,
      };
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.refund.create({
        data: {
          paymentId: payment.id,
          amountMinor,
          reason: params.reason,
          status: 'PENDING',
          requestedBy: params.requestedBy,
        },
        select: { id: true },
      });

      if (params.audit) {
        await this.audit.record(
          {
            actorId: params.audit.actorId,
            actorRole: params.audit.actorRole,
            action: 'order.refund_requested',
            targetType: 'Order',
            targetId: params.orderId,
            before: { refundedMinor: alreadyRefundedMinor },
            after: { amountMinor, reason: params.reason, refundableMinor },
            ip: params.audit.ip,
          },
          tx,
        );
      }

      return row;
    });

    let providerStatus: RefundStatus = 'PENDING';
    let providerRef: string | null = null;
    let failureReason: string | null = null;
    let notice: string | null = null;

    if (isManualSettlement) {
      // Not a failure and not a success. The merchant is holding the money;
      // the platform can only record that it owes the customer.
      notice =
        '此訂單為到店付款，款項由商戶直接收取，平台無法自動退款。' +
        '退款已記錄為待處理，請商戶以現金／轉數快退回顧客後再標記完成。';
    } else if (!this.config.payment.liveMode) {
      // Not a failure, and not a success — the money has not moved. Say so
      // explicitly so no console can render this as "refunded".
      notice =
        'PAYMENT_LIVE_MODE=false：未呼叫支付服務，退款已記錄為待處理，需人手於支付平台完成。';
    } else {
      try {
        const result = await rail!.refund({
          providerRef: payment.providerRef,
          amountMinor,
          reason: params.reason,
          // Deterministic, so a retried request cannot refund twice.
          idempotencyKey: `refund:${created.id}`,
        });
        providerRef = result.refundRef;
        providerStatus = result.status;
      } catch (error) {
        providerStatus = 'FAILED';
        failureReason = (error as Error).message;
        this.logger.error(`refund ${created.id} failed at the provider: ${failureReason}`);
      }
    }

    await this.prisma.refund.update({
      where: { id: created.id },
      data: {
        status: providerStatus,
        providerRef,
        settledAt: providerStatus === 'SUCCEEDED' ? new Date() : null,
      },
    });

    if (providerStatus === 'SUCCEEDED') {
      const refunded = await this.refundedTotal(payment.id);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: refunded >= payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
    }

    // Only a settled, full refund closes the order out. A partial or pending
    // refund leaves it where it is — the order status means "what happened to
    // the food", not "what happened to the money".
    let orderTransition: { from: OrderStatus; to: OrderStatus } | null = null;
    if (providerStatus === 'SUCCEEDED' && amountMinor >= refundableMinor) {
      const from = order.status as unknown as OrderStatus;
      const allowed = this.stateMachine.allowedTransitions(from, params.actor);
      if (allowed.includes(OrderStatus.REFUNDED)) {
        const result = await this.transitionOrder.execute({
          orderId: params.orderId,
          to: OrderStatus.REFUNDED,
          actor: params.actor,
          actorId: params.actorId,
          reason: `refund settled: ${params.reason}`,
        });
        orderTransition = { from: result.fromStatus, to: result.toStatus };
      }
    }

    return {
      kind: 'ISSUED',
      refundId: created.id,
      paymentId: payment.id,
      amountMinor,
      refundableMinor,
      alreadyRefundedMinor,
      providerStatus,
      providerRef,
      provider: railName,
      failureReason,
      notice,
      orderTransition,
    };
  }

  /** Sum of settled refunds for a payment. */
  private async refundedTotal(paymentId: string): Promise<number> {
    const totals = await this.prisma.refund.aggregate({
      where: { paymentId, status: 'SUCCEEDED' },
      _sum: { amountMinor: true },
    });
    return totals._sum.amountMinor ?? 0;
  }
}

function notRefundable(
  paymentId: string | null = null,
  alreadyRefundedMinor = 0,
): RefundAttempt {
  return {
    kind: 'NOT_REFUNDABLE',
    refundId: null,
    paymentId,
    amountMinor: 0,
    refundableMinor: 0,
    alreadyRefundedMinor,
    providerStatus: null,
    providerRef: null,
    provider: null,
    failureReason: null,
    notice: null,
    orderTransition: null,
  };
}

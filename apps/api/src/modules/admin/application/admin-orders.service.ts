import { Inject, Injectable } from '@nestjs/common';
import { Prisma, RefundStatus } from '@prisma/client';
import {
  OrderActor,
  OrderSideEffect,
  OrderStateMachine,
  OrderStatus as DomainOrderStatus,
} from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { ORDER_STATE_MACHINE } from '../../../common/tokens';
import { paginate } from '../../../common/validation/query';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TransitionOrderUseCase } from '../../ordering/application/transition-order.use-case';
import { RefundService } from '../../payment/application/refund.service';
import {
  AdminTargetNotFoundError,
  RefundExceedsCaptureError,
  RefundNotAvailableError,
} from '../domain/admin.errors';
import {
  AdminOrderEventView,
  AdminOrderSummaryView,
  AdminOrderView,
  AdminPaymentView,
  AdminRefundView,
} from '../interface/admin.views';
import {
  AdminOrderQueryDto,
  AdminRefundDto,
  ForceTransitionDto,
} from '../interface/dto/admin.dto';

const lineSelect = {
  menuItemId: true,
  nameSnapshot: true,
  imageKeySnapshot: true,
  unitPriceMinor: true,
  quantity: true,
  lineTotalMinor: true,
  isMainItem: true,
} as const;

const paymentSelect = {
  id: true,
  provider: true,
  status: true,
  providerRef: true,
  amountMinor: true,
  processingFeeMinor: true,
  currency: true,
  failureCode: true,
  authorizedAt: true,
  capturedAt: true,
  createdAt: true,
  refunds: {
    select: {
      id: true,
      paymentId: true,
      amountMinor: true,
      reason: true,
      status: true,
      providerRef: true,
      requestedBy: true,
      createdAt: true,
      settledAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
} as const;

const adminOrderSelect = {
  id: true,
  orderNo: true,
  pickupCode: true,
  status: true,
  fulfilmentMode: true,
  priority: true,
  createdAt: true,
  serviceDate: true,
  scheduledPickupAt: true,
  prepTimeMinutes: true,
  acceptDeadlineAt: true,
  acceptedAt: true,
  readyAt: true,
  completedAt: true,
  cancelledAt: true,
  currency: true,
  subtotalMinor: true,
  platformFeeMinor: true,
  paymentFeeMinor: true,
  customerServiceFeeMinor: true,
  totalMinor: true,
  merchantPayoutMinor: true,
  mainItemCount: true,
  pricingSnapshot: true,
  customerNote: true,
  contactPhone: true,
  customer: { select: { id: true, displayName: true, phone: true, email: true } },
  merchant: { select: { id: true, slug: true, name: true } },
  items: { select: lineSelect, orderBy: { id: 'asc' } },
  payments: { select: paymentSelect, orderBy: { createdAt: 'desc' } },
  statusEvents: {
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      actor: true,
      reason: true,
      sideEffects: true,
      createdAt: true,
      actorUser: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

const adminOrderSummarySelect = {
  id: true,
  orderNo: true,
  pickupCode: true,
  status: true,
  createdAt: true,
  serviceDate: true,
  scheduledPickupAt: true,
  currency: true,
  subtotalMinor: true,
  platformFeeMinor: true,
  totalMinor: true,
  merchantPayoutMinor: true,
  mainItemCount: true,
  customer: { select: { id: true, displayName: true, phone: true, email: true } },
  merchant: { select: { id: true, slug: true, name: true } },
  _count: { select: { items: true } },
  payments: {
    select: { status: true, amountMinor: true, refunds: { select: { status: true, amountMinor: true } } },
  },
} as const;

export interface ForceTransitionOutcome {
  readonly order: AdminOrderView;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly sideEffects: readonly OrderSideEffect[];
}

export interface RefundOutcome {
  readonly order: AdminOrderView;
  readonly refund: AdminRefundView;
  /** What the PSP said, or `PENDING` when live mode is off. */
  readonly providerStatus: RefundStatus;
  readonly failureReason: string | null;
  /** Set when the refund also moved the order; `null` when the status allows no move. */
  readonly orderTransition: { readonly from: string; readonly to: string } | null;
  /** Present when the PSP was deliberately not called. Never silently omitted. */
  readonly notice: string | null;
}

/**
 * Order oversight.
 *
 * Two capabilities the merchant and customer endpoints deliberately lack:
 *
 *  1. **Force a transition.** The state machine already permits an ADMIN actor
 *     for most moves, and `MERCHANT_ACCEPTING` is waived for admins (support may
 *     have taken the order by phone). Anything the table does not allow is still
 *     refused — "force" means "on behalf of", not "bypass the rules".
 *  2. **Refund.** Recorded first, provider second, and the order only advances
 *     to `REFUNDED` if the state machine allows it from where it is.
 */
@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transitionOrder: TransitionOrderUseCase,
    @Inject(ORDER_STATE_MACHINE) private readonly stateMachine: OrderStateMachine,
    // The PSP and the live-mode flag used to be injected here; both now belong
    // to `RefundService`, so that the manual and automatic refund paths cannot
    // drift apart.
    private readonly refunds: RefundService,
  ) {}

  async list(
    query: AdminOrderQueryDto,
  ): Promise<{ data: AdminOrderSummaryView[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.merchantId ? { merchantId: query.merchantId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { orderNo: { contains: query.q, mode: 'insensitive' } },
              { pickupCode: { contains: query.q, mode: 'insensitive' } },
              { customer: { displayName: { contains: query.q, mode: 'insensitive' } } },
              { merchant: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const { take, skip } = paginate(query);
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: adminOrderSummarySelect,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        orderNo: row.orderNo,
        pickupCode: row.pickupCode,
        status: row.status as unknown as DomainOrderStatus,
        createdAt: row.createdAt.toISOString(),
        serviceDate: row.serviceDate.toISOString().slice(0, 10),
        scheduledPickupAt: row.scheduledPickupAt?.toISOString() ?? null,
        currency: row.currency,
        subtotalMinor: row.subtotalMinor,
        platformFeeMinor: row.platformFeeMinor,
        totalMinor: row.totalMinor,
        merchantPayoutMinor: row.merchantPayoutMinor,
        mainItemCount: row.mainItemCount,
        itemCount: row._count.items,
        paidMinor: row.payments
          .filter((payment) => payment.status === 'CAPTURED' || payment.status === 'PARTIALLY_REFUNDED')
          .reduce((sum, payment) => sum + payment.amountMinor, 0),
        refundedMinor: row.payments
          .flatMap((payment) => payment.refunds)
          .filter((refund) => refund.status === 'SUCCEEDED')
          .reduce((sum, refund) => sum + refund.amountMinor, 0),
        customer: row.customer,
        merchant: row.merchant,
      })),
      total,
    };
  }

  async get(orderId: string): Promise<AdminOrderView> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: adminOrderSelect,
    });
    if (!row) throw new AdminTargetNotFoundError('訂單', orderId);

    const refunds: AdminRefundView[] = row.payments.flatMap((payment) =>
      payment.refunds.map((refund) => ({
        id: refund.id,
        paymentId: refund.paymentId,
        amountMinor: refund.amountMinor,
        reason: refund.reason,
        status: refund.status,
        providerRef: refund.providerRef,
        requestedBy: refund.requestedBy,
        createdAt: refund.createdAt.toISOString(),
        settledAt: refund.settledAt?.toISOString() ?? null,
      })),
    );

    const payments: AdminPaymentView[] = row.payments.map((payment) => ({
      id: payment.id,
      provider: payment.provider,
      status: payment.status,
      providerRef: payment.providerRef,
      amountMinor: payment.amountMinor,
      processingFeeMinor: payment.processingFeeMinor,
      currency: payment.currency,
      failureCode: payment.failureCode,
      authorizedAt: payment.authorizedAt?.toISOString() ?? null,
      capturedAt: payment.capturedAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
      refundedMinor: payment.refunds
        .filter((refund) => refund.status === 'SUCCEEDED')
        .reduce((sum, refund) => sum + refund.amountMinor, 0),
    }));

    const statusEvents: AdminOrderEventView[] = row.statusEvents.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actor: event.actor,
      actorName: event.actorUser?.displayName ?? null,
      reason: event.reason,
      sideEffects: event.sideEffects,
      createdAt: event.createdAt.toISOString(),
    }));

    return {
      id: row.id,
      orderNo: row.orderNo,
      pickupCode: row.pickupCode,
      status: row.status as unknown as DomainOrderStatus,
      fulfilmentMode: row.fulfilmentMode,
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      serviceDate: row.serviceDate.toISOString().slice(0, 10),
      scheduledPickupAt: row.scheduledPickupAt?.toISOString() ?? null,
      prepTimeMinutes: row.prepTimeMinutes,
      acceptDeadlineAt: row.acceptDeadlineAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      currency: row.currency,
      subtotalMinor: row.subtotalMinor,
      platformFeeMinor: row.platformFeeMinor,
      paymentFeeMinor: row.paymentFeeMinor,
      customerServiceFeeMinor: row.customerServiceFeeMinor,
      totalMinor: row.totalMinor,
      merchantPayoutMinor: row.merchantPayoutMinor,
      mainItemCount: row.mainItemCount,
      pricingSnapshot: row.pricingSnapshot,
      customerNote: row.customerNote,
      contactPhone: row.contactPhone,
      customer: row.customer,
      merchant: row.merchant,
      items: row.items.map((item) => ({
        menuItemId: item.menuItemId,
        nameSnapshot: item.nameSnapshot,
        imageKeySnapshot: item.imageKeySnapshot,
        unitPriceMinor: item.unitPriceMinor,
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor,
        isMainItem: item.isMainItem,
      })),
      payments,
      refunds,
      statusEvents,
      allowedAdminTransitions: this.stateMachine.allowedTransitions(
        row.status as unknown as DomainOrderStatus,
        OrderActor.ADMIN,
      ),
    };
  }

  /**
   * Move an order on behalf of the customer or the merchant.
   *
   * The state machine is the gate, not this method. `OrderActor.ADMIN` is
   * accepted for most transitions and waives the merchant-intake guard, but an
   * illegal move still throws `ILLEGAL_ORDER_TRANSITION`.
   */
  async forceTransition(
    orderId: string,
    dto: ForceTransitionDto,
    actor: Actor,
  ): Promise<ForceTransitionOutcome> {
    const exists = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new AdminTargetNotFoundError('訂單', orderId);

    const result = await this.transitionOrder.execute({
      orderId,
      to: dto.to,
      actor: OrderActor.ADMIN,
      actorId: actor.userId,
      reason: dto.reason,
    });

    /*
     * The authoritative record of this change is the `order_status_events` row,
     * which the use case writes inside the same transaction as the status
     * update. This audit row is a cross-reference so an intervention is
     * findable from the platform audit screen without joining the ordering
     * tables. It is written outside that transaction on purpose — and if it
     * fails, `AuditService` logs rather than throwing, because the change it
     * describes has already committed.
     */
    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      action: 'order.force_transition',
      targetType: 'Order',
      targetId: orderId,
      before: { status: result.fromStatus },
      after: { status: result.toStatus, reason: dto.reason, sideEffects: result.sideEffects },
      ip: actor.ip ?? null,
    });

    return {
      order: await this.get(orderId),
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      sideEffects: result.sideEffects,
    };
  }

  /**
   * Refund a captured payment — the manual path.
   *
   * The money-moving sequence itself lives in `RefundService`, which the
   * automatic `ISSUE_REFUND` reactor also uses. This method adds only what is
   * specific to an operator: the admin-facing error codes, and a 404 when the
   * order does not exist at all.
   */
  async refund(orderId: string, dto: AdminRefundDto, actor: Actor): Promise<RefundOutcome> {
    const exists = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new AdminTargetNotFoundError('訂單', orderId);

    const attempt = await this.refunds.issue({
      orderId,
      amountMinor: dto.amountMinor,
      reason: dto.reason,
      requestedBy: actor.userId,
      actor: OrderActor.ADMIN,
      actorId: actor.userId,
      audit: { actorId: actor.userId, actorRole: actor.role, ip: actor.ip ?? null },
    });

    if (attempt.kind === 'NOT_REFUNDABLE') throw new RefundNotAvailableError(orderId);
    if (attempt.kind === 'EXCEEDS_CAPTURE') {
      throw new RefundExceedsCaptureError(attempt.amountMinor, attempt.refundableMinor);
    }

    const view = await this.get(orderId);
    const refund = view.refunds.find((entry) => entry.id === attempt.refundId);
    if (!refund) {
      // The row was written but the read cannot see it. Fail loudly rather than
      // return a shape with a hole in it.
      throw new AdminTargetNotFoundError('退款記錄', attempt.refundId ?? orderId);
    }

    return {
      order: view,
      refund,
      providerStatus: attempt.providerStatus ?? 'PENDING',
      failureReason: attempt.failureReason,
      orderTransition: attempt.orderTransition
        ? { from: attempt.orderTransition.from, to: attempt.orderTransition.to }
        : null,
      notice: attempt.notice,
    };
  }
}

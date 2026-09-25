import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderActor, OrderStateMachine, OrderStatus, PaymentMode } from '@takeout/domain';
import { ORDER_REPOSITORY, ORDER_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TransitionOrderUseCase } from '../../ordering/application/transition-order.use-case';
import { OrderNotFoundError } from '../../ordering/domain/ordering.errors';
import { OrderRepositoryPort, PersistedOrder } from '../../ordering/domain/order.repository.port';

export interface ConfirmOrderCommand {
  readonly merchantId: string;
  readonly orderId: string;
  readonly actorId: string;
  /** Omit to fall back to the merchant's own `prepTimeMinutes`. */
  readonly readyInMinutes?: number;
  /** Kitchen's message to the customer. */
  readonly note?: string;
  /** The merchant's intake switch, so `MERCHANT_ACCEPTING` has something to read. */
  readonly merchantAcceptingOrders: boolean;
}

export interface ConfirmOrderResult {
  readonly orderId: string;
  readonly orderNo: string;
  /** `true` when this call also recorded the counter payment. */
  readonly settledOffline: boolean;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  readonly estimatedReadyAt: string | null;
  readonly readyInMinutes: number | null;
  /** What the merchant may do next, straight from the state machine. */
  readonly allowedNextTransitions: readonly OrderStatus[];
}

/**
 * The merchant's single "確認訂單" action.
 *
 * This is what a shop actually does in one motion when a customer walks up to
 * the counter: take the money, take the order, and say when it will be ready.
 * Splitting it into three buttons would be modelling the state machine rather
 * than the shop.
 *
 * Two transitions, both through the state machine:
 *
 *   `PENDING_PAYMENT -> PAID`  (only for a pay-at-store order, and only by the
 *                               merchant — enforced by `MANUAL_SETTLEMENT_ALLOWED`)
 *   `PAID -> ACCEPTED`         (carrying the pickup promise)
 *
 * **Partial success is the correct outcome**, and the ordering is deliberate.
 * If the merchant has paused intake, the money is still recorded as received —
 * they are holding it — and the accept step answers 409 so they can flip the
 * switch and try again. Rolling the payment back would make the system deny
 * something that physically happened.
 *
 * The state machine is consulted **before** the payment row is written. That is
 * not a duplicated rule: it is the same `transition()` call the use case will
 * make, run once for its side-effect-free verdict, so an order the merchant is
 * not allowed to settle is refused while there is still nothing to clean up.
 */
@Injectable()
export class ConfirmOrderUseCase {
  private readonly logger = new Logger(ConfirmOrderUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(ORDER_STATE_MACHINE) private readonly stateMachine: OrderStateMachine,
    private readonly transitionOrder: TransitionOrderUseCase,
  ) {}

  async execute(command: ConfirmOrderCommand): Promise<ConfirmOrderResult> {
    const order = await this.orders.findById(command.orderId);
    if (!order || order.merchantId !== command.merchantId) {
      throw new OrderNotFoundError(command.orderId);
    }

    const settledOffline = await this.settleIfAwaitingCounterPayment(order, command);

    const accepted = await this.transitionOrder.execute({
      orderId: order.id,
      to: OrderStatus.ACCEPTED,
      actor: OrderActor.MERCHANT,
      actorId: command.actorId,
      merchantAcceptingOrders: command.merchantAcceptingOrders,
      ...(command.readyInMinutes !== undefined ? { readyInMinutes: command.readyInMinutes } : {}),
      ...(command.note !== undefined ? { merchantNote: command.note } : {}),
    });

    this.logger.log(
      `Order ${order.orderNo} confirmed by merchant ${command.merchantId}` +
        `${settledOffline ? ' (counter payment recorded)' : ''}` +
        `; ready ${accepted.estimatedReadyAt ?? 'unspecified'}`,
    );

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      settledOffline,
      fromStatus: accepted.fromStatus,
      toStatus: accepted.toStatus,
      estimatedReadyAt: accepted.estimatedReadyAt,
      readyInMinutes: accepted.readyInMinutes,
      allowedNextTransitions: accepted.allowedNextTransitions,
    };
  }

  /** `true` when this call recorded the counter payment and moved the order to `PAID`. */
  private async settleIfAwaitingCounterPayment(
    order: PersistedOrder,
    command: ConfirmOrderCommand,
  ): Promise<boolean> {
    if (order.status !== OrderStatus.PENDING_PAYMENT) return false;

    // Ask the state machine first — no writes yet, so a refusal costs nothing.
    this.stateMachine.transition({
      orderId: order.id,
      from: order.status,
      to: OrderStatus.PAID,
      actor: OrderActor.MERCHANT,
      actorId: command.actorId,
      paymentMode: order.paymentMode as unknown as PaymentMode,
      paidAmountMinor: order.totalMinor,
    });

    // `upsert` on the deterministic key, so a double-tap cannot record two
    // payments for one order.
    await this.prisma.payment.upsert({
      where: { idempotencyKey: `manual:${order.id}` },
      update: {},
      create: {
        orderId: order.id,
        merchantId: order.merchantId,
        provider: 'MANUAL',
        idempotencyKey: `manual:${order.id}`,
        providerRef: `manual_${order.id}`,
        status: 'CAPTURED',
        currency: order.currency,
        amountMinor: order.totalMinor,
        // No PSP touched this money, so there is no processing cost to pass on.
        // The order was priced with a zero payment fee for the same reason —
        // see `PlaceOrderUseCase`.
        processingFeeMinor: 0,
        capturedAt: new Date(),
      },
    });

    await this.transitionOrder.execute({
      orderId: order.id,
      to: OrderStatus.PAID,
      actor: OrderActor.MERCHANT,
      actorId: command.actorId,
      reason: 'merchant confirmed payment received at the counter',
    });

    return true;
  }
}

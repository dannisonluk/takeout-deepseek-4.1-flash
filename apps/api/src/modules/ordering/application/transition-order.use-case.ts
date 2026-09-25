import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  OrderActor,
  OrderSideEffect,
  OrderStateMachine,
  OrderStatus,
} from '@takeout/domain';
import { ID_GENERATOR, ORDER_REPOSITORY, ORDER_STATE_MACHINE } from '../../../common/tokens';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { PricingConfigService } from '../../pricing/pricing.module';
import {
  OrderRepositoryPort,
  OrderStatusPatch,
  PersistedOrder,
} from '../domain/order.repository.port';
import { ConcurrentOrderModificationError, OrderNotFoundError } from '../domain/ordering.errors';

export interface TransitionOrderCommand {
  readonly orderId: string;
  readonly to: OrderStatus;
  readonly actor: OrderActor;
  readonly actorId?: string;
  readonly reason?: string;
  /**
   * The merchant's intake switch, passed in by the caller. Required for the
   * `MERCHANT_ACCEPTING` guard to be meaningful.
   */
  readonly merchantAcceptingOrders?: boolean;
  /**
   * Operator-chosen refund ratio, in basis points. Only meaningful for an
   * `ADMIN` actor; the policy engine ignores it for everybody else, so a
   * customer cannot raise their own refund.
   */
  readonly refundOverrideBps?: number;
  /**
   * The kitchen's promise, supplied when a merchant confirms an order.
   *
   * Two ways to express the same thing: `readyInMinutes` is what a person
   * actually knows ("about twenty minutes"), `estimatedReadyAt` is what a
   * system knows. `readyInMinutes` wins when both are present, because it is
   * the one measured from the moment of confirmation — the only clock the
   * kitchen is actually working from.
   */
  readonly readyInMinutes?: number;
  readonly estimatedReadyAt?: Date;
  /** Free-text message from the kitchen, shown verbatim to the customer. */
  readonly merchantNote?: string | null;
}

export interface TransitionOrderResult {
  readonly orderId: string;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  readonly occurredAt: Date;
  /** Obligations the caller must discharge (publish, schedule, refund). */
  readonly sideEffects: readonly OrderSideEffect[];
  /** What this actor may do next — drives the merchant UI buttons. */
  readonly allowedNextTransitions: readonly OrderStatus[];
  /**
   * What the cancellation policy decided to return, in minor units. `null` when
   * this transition does not return money.
   */
  readonly refundDueMinor: number | null;
  /** The tier behind `refundDueMinor`, or `null`. */
  readonly cancellationTier: string | null;
  /**
   * The kitchen's promise for this order after the transition, ISO-8601.
   *
   * Echoed back so the merchant's own screen can show the same number the
   * customer will see, without a second round trip. `null` on a transition
   * that carries no promise (everything except `-> ACCEPTED`).
   */
  readonly estimatedReadyAt: string | null;
  readonly readyInMinutes: number | null;
}

/**
 * The single write path for every order status change.
 *
 * Order of operations inside the transaction matters:
 *   1. `SELECT ... FOR UPDATE` — serialise concurrent transitions on this order.
 *   2. `OrderStateMachine.transition` — authorise and derive the obligations.
 *   3. conditional `UPDATE ... WHERE status = expected` — belt and braces; if a
 *      writer slipped past the row lock we fail loudly instead of double-applying.
 *   4. side effects (quota release, refund decision) and the audit row.
 *   5. outbox row — same transaction, so the notification cannot be lost.
 */
@Injectable()
export class TransitionOrderUseCase {
  private readonly logger = new Logger(TransitionOrderUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(ORDER_STATE_MACHINE) private readonly stateMachine: OrderStateMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(command: TransitionOrderCommand): Promise<TransitionOrderResult> {
    const now = new Date();

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const order = await this.orders.findByIdForUpdate(tx, command.orderId);
      if (!order) throw new OrderNotFoundError(command.orderId);

      // Throws IllegalOrderTransitionError / ActorNotPermittedError /
      // OrderAlreadyTerminalError / MerchantNotAcceptingOrdersError.
      const transition = this.stateMachine.transition({
        orderId: order.id,
        from: order.status,
        to: command.to,
        actor: command.actor,
        actorId: command.actorId,
        reason: command.reason,
        now,
        merchantAcceptingOrders: command.merchantAcceptingOrders,
        // Refund guards need to know money actually moved.
        paidAmountMinor: order.totalMinor,
        // `MANUAL_SETTLEMENT_ALLOWED` needs to know who is allowed to settle.
        paymentMode: order.paymentMode,
      });

      const applied = await this.orders.updateStatus(
        tx,
        order.id,
        transition.from,
        transition.to,
        {
          ...buildTimestampPatch(
            transition.to,
            now,
            this.refundDecision(order, transition, command, now),
            await this.acceptDeadlineFor(order, transition, now),
          ),
          ...this.pickupPromise(order, transition, command, now),
        },
      );
      if (!applied) {
        throw new ConcurrentOrderModificationError(order.id, order.status);
      }

      await this.orders.appendStatusEvent(tx, {
        orderId: order.id,
        fromStatus: transition.from,
        toStatus: transition.to,
        actor: command.actor,
        actorId: command.actorId,
        reason: command.reason,
        sideEffects: transition.sideEffects,
      });

      // Quota settlement. Exactly one of these fires per transition — a unit is
      // either returned to the pool or consumed, never both — but they share
      // the context read, so it happens once and only when needed.
      const releasesQuota = transition.sideEffects.includes(OrderSideEffect.RELEASE_DAILY_QUOTA);
      const convertsQuota = transition.sideEffects.includes(OrderSideEffect.CONVERT_HOLD_TO_SOLD);
      if (releasesQuota || convertsQuota) {
        const context = await this.orders.findReleaseContext(tx, order.id);
        if (context) {
          if (releasesQuota) {
            await this.orders.releaseDailyQuota(
              tx,
              order.merchantId,
              context.serviceDate,
              context.lines,
            );
          }
          if (convertsQuota) {
            await this.orders.convertHoldToSold(
              tx,
              order.merchantId,
              context.serviceDate,
              context.lines,
            );
          }
        }
      }

      // Settlement. The order's payout is fixed on the order row at placement
      // time; this mirrors it into the merchant's weekly ledger so the
      // reconciliation view can prove the two agree.
      if (transition.sideEffects.includes(OrderSideEffect.RECORD_PAYOUT_LEDGER)) {
        await this.orders.recordPayoutLedger(tx, order.id);
      }

      const lines = await this.orders.listOrderLines(order.id);
      // Must read through `tx` so this transition's own status event is counted.
      const version = await this.orders.countStatusEvents(tx, order.id);

      await this.outbox.enqueue(
        tx,
        this.outbox.buildOrderEvent({
          idGenerator: this.idGenerator,
          order: { ...order, status: transition.to },
          items: lines,
          version,
          occurredAt: now,
        }),
      );

      return { order, transition };
    });

    const { transition } = outcome;
    this.logger.log(
      `Order ${outcome.order.orderNo}: ${transition.from} -> ${transition.to} by ${command.actor}`,
    );

    const decision = this.refundDecision(outcome.order, transition, command, now);
    const promise = this.pickupPromise(outcome.order, transition, command, now);

    return {
      orderId: outcome.order.id,
      fromStatus: transition.from,
      toStatus: transition.to,
      occurredAt: transition.occurredAt,
      sideEffects: transition.sideEffects,
      allowedNextTransitions: this.stateMachine.allowedTransitions(transition.to, command.actor),
      refundDueMinor: decision?.refundDueMinor ?? null,
      cancellationTier: decision?.cancellationTier ?? null,
      estimatedReadyAt: promise.estimatedReadyAt?.toISOString() ?? null,
      readyInMinutes: promise.readyInMinutes ?? null,
    };
  }

  /**
   * Restart the merchant's accept clock when the money actually lands.
   *
   * See `OrderStatusPatch.acceptDeadlineAt` for why this is not simply the
   * value written at placement. Only `-> PAID` produces one; every other
   * transition returns `undefined` so the column is left alone.
   *
   * The timeout is read from the merchant row rather than frozen on the order,
   * because a shop that shortens its accept window expects that to apply to the
   * next payment — not to take effect one order-cycle later. The platform
   * default is the fallback for a merchant row that has gone missing.
   */
  private async acceptDeadlineFor(
    order: PersistedOrder,
    transition: { to: OrderStatus },
    now: Date,
  ): Promise<Date | undefined> {
    if (transition.to !== OrderStatus.PAID) return undefined;

    const minutes =
      (await this.orders.findAcceptTimeoutMinutes(order.merchantId)) ??
      this.config.ordering.acceptTimeoutMinutes;

    return new Date(now.getTime() + minutes * 60_000);
  }

  /**
   * Translate "when will it be ready" into the two columns that carry it.
   *
   * Only `-> ACCEPTED` writes a promise. Two reasons, and both are the kind of
   * thing that only shows up months later: a later transition (say the merchant
   * moving the order to `PREPARING`) must not be able to silently *erase* the
   * time the customer is already planning around, and it must not be able to
   * overwrite it either — the customer was told 18:45 and that is the number
   * they will hold the shop to.
   *
   * `readyInMinutes` is preferred over `estimatedReadyAt` when both are sent:
   * a duration is measured from the moment of confirmation, which is the only
   * clock the kitchen is actually working from. Falling back to the merchant's
   * own `prepTimeMinutes` (captured on the order at placement) means "接單" with
   * no argument still produces a real promise rather than a null the customer
   * page would have to invent a message for.
   */
  private pickupPromise(
    order: PersistedOrder,
    transition: { to: OrderStatus },
    command: TransitionOrderCommand,
    now: Date,
  ): Pick<OrderStatusPatch, 'estimatedReadyAt' | 'readyInMinutes' | 'merchantNote'> {
    if (transition.to !== OrderStatus.ACCEPTED) return {};

    const estimatedReadyAt =
      command.readyInMinutes !== undefined
        ? new Date(now.getTime() + command.readyInMinutes * 60_000)
        : (command.estimatedReadyAt ??
          new Date(now.getTime() + order.prepTimeMinutes * 60_000));

    // Derived from the final timestamp rather than copied from the command, so
    // an explicit `estimatedReadyAt` also reports a duration the UI can render
    // as "約 25 分鐘" without doing its own arithmetic against a server clock.
    const readyInMinutes = Math.max(
      0,
      Math.round((estimatedReadyAt.getTime() - now.getTime()) / 60_000),
    );

    return {
      estimatedReadyAt,
      readyInMinutes,
      // `!== undefined` so an explicit `null` clears a stale note.
      ...(command.merchantNote !== undefined ? { merchantNote: command.merchantNote } : {}),
    };
  }

  /**
   * Ask `CancellationPolicyEngine` what this transition owes the customer.
   *
   * Called once per transition and only when the state machine declared
   * `ISSUE_REFUND`. A transition that does not return money gets `undefined`,
   * which leaves both columns untouched — importantly, it does **not** write
   * `null`, so an order that is already carrying a decision cannot have it
   * erased by a later, unrelated transition.
   *
   * Pure: the same inputs always produce the same number, which is what makes
   * the quote endpoint able to show the customer the exact figure before they
   * commit.
   */
  private refundDecision(
    order: PersistedOrder,
    transition: { from: OrderStatus; to: OrderStatus; sideEffects: readonly OrderSideEffect[] },
    command: TransitionOrderCommand,
    now: Date,
  ): Pick<OrderStatusPatch, 'refundDueMinor' | 'cancellationTier'> | undefined {
    if (!transition.sideEffects.includes(OrderSideEffect.ISSUE_REFUND)) return undefined;

    const quote = this.pricing.quoteCancellation({
      orderId: order.id,
      from: transition.from,
      to: transition.to,
      actor: command.actor,
      // `totalMinor` is what the customer was charged; the reactor clamps to the
      // actually-refundable balance, so a partial prior refund cannot be
      // exceeded here.
      paidAmountMinor: order.totalMinor,
      currency: order.currency as 'HKD' | 'CNY' | 'USD',
      acceptedAt: order.acceptedAt,
      now,
      overrideBps: command.refundOverrideBps,
    });

    return {
      refundDueMinor: quote.refund.minor,
      cancellationTier: quote.tier,
    };
  }
}

/** Stamp the timestamp column that belongs to the status being entered. */
function buildTimestampPatch(
  status: OrderStatus,
  now: Date,
  refund?: Pick<OrderStatusPatch, 'refundDueMinor' | 'cancellationTier'>,
  acceptDeadlineAt?: Date,
): OrderStatusPatch {
  const withRefund: OrderStatusPatch = refund
    ? { refundDueMinor: refund.refundDueMinor, cancellationTier: refund.cancellationTier }
    : {};
  const withDeadline: OrderStatusPatch = acceptDeadlineAt ? { acceptDeadlineAt } : {};

  switch (status) {
    case OrderStatus.PAID:
      return { ...withDeadline, ...withRefund };
    case OrderStatus.ACCEPTED:
      return { acceptedAt: now, ...withRefund };
    case OrderStatus.READY_FOR_PICKUP:
      return { readyAt: now, ...withRefund };
    case OrderStatus.COMPLETED:
      return { completedAt: now, ...withRefund };
    case OrderStatus.CANCELLED:
    case OrderStatus.EXPIRED:
    case OrderStatus.REJECTED:
      return { cancelledAt: now, ...withRefund };
    default:
      return { ...withRefund };
  }
}

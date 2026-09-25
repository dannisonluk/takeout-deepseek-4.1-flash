import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EmptyOrderError,
  FulfilmentMode,
  IdGenerator,
  OrderActor,
  OrderStatus,
  PaymentMode,
  PricingEngine,
  PricingSnapshot,
} from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { ID_GENERATOR, ORDER_REPOSITORY, PRICING_ENGINE } from '../../../common/tokens';
import { localDateString, serviceDateIn } from '../../../common/time/service-date';
import {
  checkOpening,
  earliestPickupAt,
  latestPickupAt,
  MAX_ADVANCE_HOURS,
} from '../../../common/time/pickup-policy';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  OrderRepositoryPort,
  OrderableMerchant,
  PersistedOrder,
} from '../domain/order.repository.port';
import { buildPickupNotice, PickupNotice } from '../domain/pickup-notice';
import {
  DailyQuotaExhaustedError,
  MenuItemNotFoundError,
  MenuItemUnavailableError,
  MerchantNotFoundError,
  PickupTimeNotFeasibleError,
} from '../domain/ordering.errors';
import { PRICING_ENGINE as PRICING_ENGINE_TOKEN } from '../../pricing/pricing.module';

export interface PlaceOrderCommand {
  readonly customerId: string;
  readonly merchantId: string;
  readonly items: readonly { menuItemId: string; quantity: number }[];
  /** Omit for 即時製作 (as soon as possible). */
  readonly scheduledPickupAt?: Date;
  readonly customerNote?: string;
  readonly contactPhone?: string;
  readonly fulfilmentMode?: FulfilmentMode;
  /** Defaults to `ONLINE` — the rail that a webhook settles. */
  readonly paymentMode?: PaymentMode;
  /**
   * The caller's `Idempotency-Key`. Written to the order row, where a UNIQUE
   * index makes a replay a database-level refusal.
   */
  readonly idempotencyKey?: string;
  /**
   * 店內點餐 — the sitting this order belongs to.
   *
   * Set only by the scan-to-order flow. Everything else about the order is
   * unchanged: it is priced by the same engine, prepared by the same kitchen
   * board and moved by the same state machine. The session is a grouping, not a
   * second lifecycle — see the note at the top of the dining domain file for
   * why that is not a `DINING_*` branch on `OrderStatus`.
   */
  readonly diningSessionId?: string;
}

export interface PlaceOrderResult {
  readonly order: PersistedOrder;
  readonly pickupCode: string;
  readonly pricing: PricingSnapshot;
  readonly estimatedReadyAt: Date;
  readonly paymentMode: PaymentMode;
  /**
   * The sentence the confirmation screen must show. Built here rather than in
   * the controller because the merchant's timezone and pickup window are in
   * scope at this point and would otherwise need a second read.
   */
  readonly pickupNotice: PickupNotice | null;
  readonly lines: readonly {
    menuItemId: string;
    nameSnapshot: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    isMainItem: boolean;
  }[];
}

/**
 * Places an order: validate -> price -> reserve quota -> persist -> emit.
 *
 * Everything that mutates state happens in ONE transaction, including the
 * outbox row. The pricing call happens *before* the transaction because it is
 * pure, and its frozen snapshot is written inside it — so a concurrent rate
 * change can never half-apply to this order.
 */
@Injectable()
export class PlaceOrderUseCase {
  private readonly logger = new Logger(PlaceOrderUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    private readonly outbox: OutboxService,
    @Inject(PRICING_ENGINE_TOKEN) private readonly pricing: PricingEngine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const now = new Date();

    if (command.fulfilmentMode && command.fulfilmentMode !== FulfilmentMode.SELF_PICKUP) {
      throw new PickupTimeNotFeasibleError(
        'Fleet delivery is not enabled yet; use SELF_PICKUP',
        { fulfilmentMode: command.fulfilmentMode },
      );
    }

    const merchant = await this.orders.findMerchantForOrdering(command.merchantId);
    if (!merchant) throw new MerchantNotFoundError(command.merchantId);

    const requestedLines = mergeDuplicateLines(command.items);
    if (requestedLines.length === 0) throw new EmptyOrderError();

    const serviceDate = serviceDateIn(merchant.timezone, now);
    const menuItems = await this.orders.findMenuItems(
      merchant.id,
      requestedLines.map((line) => line.menuItemId),
      serviceDate,
    );

    if (menuItems.length !== requestedLines.length) {
      const found = new Set(menuItems.map((item) => item.id));
      throw new MenuItemNotFoundError(
        requestedLines.filter((line) => !found.has(line.menuItemId)).map((line) => line.menuItemId),
      );
    }

    const itemById = new Map(menuItems.map((item) => [item.id, item]));

    const pricingLines = requestedLines.map((line) => {
      const item = itemById.get(line.menuItemId);
      // Guaranteed by the count check above; the throw keeps the type honest.
      if (!item) throw new MenuItemNotFoundError([line.menuItemId]);

      if (item.availability !== 'AVAILABLE') {
        throw new MenuItemUnavailableError(item.id, item.availability);
      }
      if (item.remainingToday !== null && item.remainingToday < line.quantity) {
        throw new DailyQuotaExhaustedError([item.id]);
      }

      return {
        menuItemId: item.id,
        name: item.name,
        unitPriceMinor: item.priceMinor,
        quantity: line.quantity,
        isMainItem: item.isMainItem,
      };
    });

    const paymentMode = command.paymentMode ?? PaymentMode.ONLINE;

    // Pure. Throws NegativeMerchantPayoutError on a basket too small to settle.
    //
    // A pay-at-store order is priced with **no payment processing fee**. No PSP
    // touches that money, so charging the merchant 3.40% + HK$2.35 for it would
    // be the platform quietly taking a cut of a cash payment it never handled —
    // and it would be invisible, because the payout simply came out lower.
    // The override is recorded in `pricingSnapshot.appliedPolicy`, so a later
    // reconciliation can prove why this order's payout differs.
    const breakdown = this.pricing.calculate({
      lines: pricingLines,
      ...(paymentMode === PaymentMode.PAY_AT_STORE
        ? { policyOverrides: { paymentFee: { rateBps: 0, fixedMinor: 0 } } }
        : {}),
    });
    const snapshot = breakdown.toSnapshot();

    await this.assertPickupSlotFeasible(merchant, command.scheduledPickupAt, now);
    const estimatedReadyAt =
      command.scheduledPickupAt ?? new Date(now.getTime() + merchant.prepTimeMinutes * 60_000);
    // The merchant's clock. For a pay-at-store order this is the window in
    // which they must confirm they received the money; for an online one it is
    // the window in which they must accept the order. Either way an order
    // nobody acts on must not sit in the queue forever.
    const acceptDeadlineAt = new Date(now.getTime() + merchant.acceptTimeoutMinutes * 60_000);

    const order = await this.prisma.runInTransaction(async (tx) => {
      const held = await this.orders.holdDailyQuota(
        tx,
        merchant.id,
        serviceDate,
        requestedLines,
      );
      if (!held) throw new DailyQuotaExhaustedError(requestedLines.map((line) => line.menuItemId));

      const sequence = await this.orders.nextPickupSequence(tx, merchant.id, serviceDate);
      const dateKey = serviceDate.toISOString().slice(0, 10).replace(/-/g, '');

      const created = await this.orders.insertOrder(tx, {
        orderNo: `${dateKey}-${String(sequence).padStart(6, '0')}`,
        pickupCode: this.idGenerator.nextPickupCode(sequence),
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
        customerId: command.customerId,
        merchantId: merchant.id,
        currency: snapshot.currency,
        serviceDate,
        prepTimeMinutes: merchant.prepTimeMinutes,
        paymentMode,
        scheduledPickupAt: command.scheduledPickupAt ?? null,
        acceptDeadlineAt,
        customerNote: command.customerNote ?? null,
        contactPhone: command.contactPhone ?? null,
        subtotalMinor: snapshot.subtotalMinor,
        platformFeeMinor: snapshot.platformFeeMinor,
        paymentFeeMinor: snapshot.paymentProcessingFeeMinor,
        customerServiceFeeMinor: snapshot.customerServiceFeeMinor,
        totalMinor: snapshot.totalMinor,
        merchantPayoutMinor: snapshot.merchantPayoutMinor,
        mainItemCount: snapshot.mainItemCount,
        pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        // 店內點餐. Absent for every collection order, which is what keeps this
        // change invisible to Phase 1.
        ...(command.diningSessionId ? { diningSessionId: command.diningSessionId } : {}),
        items: pricingLines.map((line) => ({
          menuItemId: line.menuItemId,
          nameSnapshot: line.name,
          imageKeySnapshot: itemById.get(line.menuItemId)?.imageKey ?? null,
          unitPriceMinor: line.unitPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: line.unitPriceMinor * line.quantity,
          isMainItem: line.isMainItem,
        })),
      });

      // Creation row. `from === to` because there is no prior state; the audit
      // trail still needs a row at the head of the sequence.
      await this.orders.appendStatusEvent(tx, {
        orderId: created.id,
        fromStatus: OrderStatus.PENDING_PAYMENT,
        toStatus: OrderStatus.PENDING_PAYMENT,
        actor: OrderActor.CUSTOMER,
        actorId: command.customerId,
        sideEffects: [],
      });

      const event = this.outbox.buildOrderEvent({
        idGenerator: this.idGenerator,
        order: {
          id: created.id,
          orderNo: created.orderNo,
          customerId: created.customerId,
          merchantId: created.merchantId,
          status: OrderStatus.PENDING_PAYMENT,
          currency: created.currency,
          totalMinor: created.totalMinor,
          merchantPayoutMinor: created.merchantPayoutMinor,
          mainItemCount: created.mainItemCount,
          scheduledPickupAt: created.scheduledPickupAt,
        },
        items: pricingLines.map((line) => ({
          menuItemId: line.menuItemId,
          nameSnapshot: line.name,
          quantity: line.quantity,
        })),
        version: 1,
        occurredAt: now,
      });
      await this.outbox.enqueue(tx, event);

      return created;
    });

    this.logger.log(
      `Order ${order.orderNo} placed (merchant=${merchant.id}, mainItems=${snapshot.mainItemCount}, platformFee=${snapshot.platformFeeMinor})`,
    );

    return {
      order,
      pickupCode: order.pickupCode ?? '',
      pricing: snapshot,
      estimatedReadyAt,
      paymentMode,
      pickupNotice: buildPickupNotice({
        status: OrderStatus.PENDING_PAYMENT,
        paymentMode,
        scheduledPickupAt: order.scheduledPickupAt,
        estimatedReadyAt: null,
        readyAt: null,
        acceptDeadlineAt: order.acceptDeadlineAt,
        pickupWindowMinutes: merchant.pickupWindowMinutes,
        pickupCode: order.pickupCode,
        totalMinor: order.totalMinor,
        currency: order.currency,
        timeZone: merchant.timezone,
        now,
      }),
      lines: pricingLines.map((line) => ({
        menuItemId: line.menuItemId,
        nameSnapshot: line.name,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        lineTotalMinor: line.unitPriceMinor * line.quantity,
        isMainItem: line.isMainItem,
      })),
    };
  }

  /**
   * A requested slot must be reachable by the kitchen and fall inside opening
   * hours. Both checks use the merchant's timezone, not the server's.
   *
   * The rules themselves live in `common/time/pickup-policy.ts`, which the
   * public `pickup-slots` endpoint also uses to *generate* the times the
   * customer chooses from. Keeping one implementation is what makes "the app
   * offered me 12:15 and then rejected it" impossible.
   */
  private async assertPickupSlotFeasible(
    merchant: OrderableMerchant,
    scheduledPickupAt: Date | undefined,
    now: Date,
  ): Promise<void> {
    if (!scheduledPickupAt) return;

    const earliest = earliestPickupAt(now, merchant.prepTimeMinutes);
    if (scheduledPickupAt.getTime() < earliest.getTime()) {
      throw new PickupTimeNotFeasibleError(
        `Requested pickup time is sooner than the kitchen can prepare (earliest ${earliest.toISOString()})`,
        { earliest, requested: scheduledPickupAt, prepTimeMinutes: merchant.prepTimeMinutes },
      );
    }

    const latest = latestPickupAt(now);
    if (scheduledPickupAt.getTime() > latest.getTime()) {
      throw new PickupTimeNotFeasibleError(
        `Orders can only be scheduled up to ${MAX_ADVANCE_HOURS} hours ahead`,
        { latest, requested: scheduledPickupAt },
      );
    }

    const hours = await this.orders.findOperatingHours(merchant.id);
    // The closure set has to be read for the SAME local date the slot falls on,
    // so it is derived from the requested instant in the merchant's timezone
    // rather than from the server's "today". A 23:45 HKT order placed at 15:45
    // UTC belongs to tomorrow's HKT trading day and must be checked against
    // tomorrow's closures.
    const requestedDate = localDateString(merchant.timezone, scheduledPickupAt);
    const closures = new Set(
      await this.orders.findClosureDates(merchant.id, requestedDate, requestedDate),
    );
    const opening = checkOpening(hours, merchant.timezone, scheduledPickupAt, closures);

    if (opening.open || opening.reason === 'NO_HOURS_CONFIGURED') {
      // Not configured yet — do not block ordering.
      return;
    }

    if (opening.reason === 'CLOSED_FOR_CLOSURE') {
      throw new PickupTimeNotFeasibleError('Merchant is closed for a rest day at the requested pickup time', {
        serviceDate: opening.serviceDate,
        requested: scheduledPickupAt,
      });
    }

    if (opening.reason === 'CLOSED_TODAY') {
      throw new PickupTimeNotFeasibleError('Merchant is closed at the requested pickup time', {
        dayOfWeek: opening.dayOfWeek,
        requested: scheduledPickupAt,
      });
    }

    throw new PickupTimeNotFeasibleError('Requested pickup time is outside opening hours', {
      dayOfWeek: opening.dayOfWeek,
      minuteOfDay: opening.minuteOfDay,
      opensAtMinute: opening.window.opensAtMinute,
      closesAtMinute: opening.window.closesAtMinute,
    });
  }
}

/** Two taps on the same dish is one line of quantity 2, not two lines. */
function mergeDuplicateLines(
  items: readonly { menuItemId: string; quantity: number }[],
): { menuItemId: string; quantity: number }[] {
  const merged = new Map<string, number>();
  for (const item of items) {
    merged.set(item.menuItemId, (merged.get(item.menuItemId) ?? 0) + item.quantity);
  }
  return [...merged.entries()].map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
}

/** Re-exported so consumers do not need a second import path. */
export { PRICING_ENGINE };

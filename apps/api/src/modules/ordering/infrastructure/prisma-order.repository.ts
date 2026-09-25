import { Injectable } from '@nestjs/common';
import {
  OrderActorType,
  OrderStatus as PrismaOrderStatus,
  PaymentMode as PrismaPaymentMode,
  Prisma,
} from '@prisma/client';
import { OrderActor, OrderStatus, PaymentMode } from '@takeout/domain';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ConflictOnIdempotencyKey } from '../domain/ordering.errors';
import {
  CreateOrderData,
  OperatingHour,
  OrderRepositoryPort,
  OrderStatusPatch,
  OrderableMenuItem,
  OrderableMerchant,
  PersistedOrder,
  StatusEventRecord,
} from '../domain/order.repository.port';

/** Domain enum <-> Prisma enum. Same string values, different TS types. */
const toPrismaStatus = (status: OrderStatus): PrismaOrderStatus =>
  status as unknown as PrismaOrderStatus;
const fromPrismaStatus = (status: PrismaOrderStatus): OrderStatus =>
  status as unknown as OrderStatus;
const toPrismaActor = (actor: OrderActor): OrderActorType => actor as unknown as OrderActorType;

@Injectable()
export class PrismaOrderRepository implements OrderRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findMerchantForOrdering(merchantId: string): Promise<OrderableMerchant | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        status: true,
        acceptsOrders: true,
        autoAcceptOrders: true,
        prepTimeMinutes: true,
        pickupWindowMinutes: true,
        acceptTimeoutMinutes: true,
      },
    });

    if (!merchant || merchant.status !== 'ACTIVE') return null;

    return {
      id: merchant.id,
      name: merchant.name,
      timezone: merchant.timezone,
      acceptsOrders: merchant.acceptsOrders,
      autoAcceptOrders: merchant.autoAcceptOrders,
      prepTimeMinutes: merchant.prepTimeMinutes,
      pickupWindowMinutes: merchant.pickupWindowMinutes,
      acceptTimeoutMinutes: merchant.acceptTimeoutMinutes,
    };
  }

  async findAcceptTimeoutMinutes(merchantId: string): Promise<number | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { acceptTimeoutMinutes: true },
    });
    return merchant?.acceptTimeoutMinutes ?? null;
  }

  async findOperatingHours(merchantId: string): Promise<OperatingHour[]> {
    return this.prisma.merchantOperatingHour.findMany({
      where: { merchantId },
      select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  /**
   * `serviceDate` is a `@db.Date`, so it round-trips as UTC midnight — the
   * bounds are built the same way rather than from local time, otherwise a
   * +08 merchant asking for "today" would miss its own rows by eight hours.
   */
  async findClosureDates(merchantId: string, from: string, to: string): Promise<string[]> {
    const rows = await this.prisma.merchantClosure.findMany({
      where: {
        merchantId,
        serviceDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      select: { serviceDate: true },
      orderBy: { serviceDate: 'asc' },
    });
    return rows.map((row) => row.serviceDate.toISOString().slice(0, 10));
  }

  async findMenuItems(
    merchantId: string,
    menuItemIds: readonly string[],
    serviceDate: Date,
  ): Promise<OrderableMenuItem[]> {
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: [...menuItemIds] }, merchantId },
      select: {
        id: true,
        merchantId: true,
        name: true,
        imageKey: true,
        priceMinor: true,
        isMainItem: true,
        availability: true,
        dailyQuota: true,
        dailyStocks: {
          where: { serviceDate },
          select: { quota: true, sold: true, held: true },
        },
      },
    });

    return items.map((item) => {
      const stock = item.dailyStocks[0];
      // No stock row yet means nothing has been sold today; the cap is the item's.
      const quota = stock?.quota ?? item.dailyQuota ?? 0;
      const remaining =
        quota === 0 ? null : Math.max(0, quota - (stock?.sold ?? 0) - (stock?.held ?? 0));

      return {
        id: item.id,
        merchantId: item.merchantId,
        name: item.name,
        imageKey: item.imageKey,
        priceMinor: item.priceMinor,
        isMainItem: item.isMainItem,
        availability: item.availability,
        remainingToday: remaining,
      };
    });
  }

  /**
   * Two statements per line:
   *   1. make sure today's stock row exists (seeded from `menu_items.dailyQuota`)
   *   2. conditionally reserve, in one atomic UPDATE
   *
   * Step 2 carries the whole concurrency story: `affected = 0` means sold out.
   * No advisory lock, no read-then-write race.
   *
   * NOTE ON IDENTIFIERS: Prisma emits camelCase column names for any model
   * field without an explicit `@map`, so hand-written SQL must quote them
   * ("serviceDate"). Only table names are snake_case, via `@@map`.
   */
  async holdDailyQuota(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<boolean> {
    for (const line of lines) {
      await tx.$executeRaw`
        INSERT INTO menu_item_daily_stock
               (id, "menuItemId", "merchantId", "serviceDate", quota, sold, held, "updatedAt")
        SELECT gen_random_uuid(), mi.id, mi."merchantId", ${serviceDate}::date,
               COALESCE(mi."dailyQuota", 0), 0, 0, now()
          FROM menu_items mi
         WHERE mi.id = ${line.menuItemId}::uuid
        ON CONFLICT ("menuItemId", "serviceDate") DO NOTHING
      `;

      const affected = await tx.$executeRaw`
        UPDATE menu_item_daily_stock
           SET held = held + ${line.quantity},
               "updatedAt" = now()
         WHERE "menuItemId" = ${line.menuItemId}::uuid
           AND "serviceDate" = ${serviceDate}::date
           AND "merchantId"  = ${merchantId}::uuid
           AND (quota = 0 OR sold + held + ${line.quantity} <= quota)
      `;

      if (affected === 0) return false;
    }
    return true;
  }

  async releaseDailyQuota(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE menu_item_daily_stock
           SET held = GREATEST(held - ${line.quantity}, 0),
               "updatedAt" = now()
         WHERE "menuItemId" = ${line.menuItemId}::uuid
           AND "serviceDate" = ${serviceDate}::date
           AND "merchantId"  = ${merchantId}::uuid
      `;
    }
  }

  /**
   * `held` -> `sold`, in one statement per line so the two counters can never
   * disagree about a line that has been counted twice.
   *
   * `GREATEST(held - n, 0)` rather than a bare subtraction: a replayed
   * transition must not be able to drive `held` negative, and clamping keeps
   * the anomaly in the numbers (where a report can see it) instead of throwing
   * inside a settlement transaction and rolling the whole thing back.
   */
  async convertHoldToSold(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE menu_item_daily_stock
           SET held = GREATEST(held - ${line.quantity}, 0),
               sold = sold + ${line.quantity},
               "updatedAt" = now()
         WHERE "menuItemId" = ${line.menuItemId}::uuid
           AND "serviceDate" = ${serviceDate}::date
           AND "merchantId"  = ${merchantId}::uuid
      `;
    }
  }

  /**
   * Serialise the per-merchant-per-day counter with an advisory transaction
   * lock, so two simultaneous orders cannot both be told they are `A-07`.
   * The lock is scoped to `hashtext(merchantId || date)` and released with the
   * transaction — no table-level contention.
   */
  async nextPickupSequence(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
  ): Promise<number> {
    const dateKey = serviceDate.toISOString().slice(0, 10);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${merchantId}:${dateKey}`}))`;

    const used = await tx.order.count({
      where: { merchantId, serviceDate, pickupCode: { not: null } },
    });
    return used + 1;
  }

  async insertOrder(tx: Prisma.TransactionClient, data: CreateOrderData): Promise<PersistedOrder> {
    try {
      const order = await tx.order.create({
        data: {
          orderNo: data.orderNo,
          pickupCode: data.pickupCode,
          // The durable half of idempotency. `orders.idempotency_key` is
          // UNIQUE, so a replayed submission loses here even when the Redis
          // lock in front of it was unavailable and let both through.
          ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
          customerId: data.customerId,
          merchantId: data.merchantId,
          currency: data.currency,
          serviceDate: data.serviceDate,
          prepTimeMinutes: data.prepTimeMinutes,
          paymentMode: data.paymentMode as unknown as PrismaPaymentMode,
          scheduledPickupAt: data.scheduledPickupAt,
          acceptDeadlineAt: data.acceptDeadlineAt,
          customerNote: data.customerNote,
          contactPhone: data.contactPhone,
          subtotalMinor: data.subtotalMinor,
          platformFeeMinor: data.platformFeeMinor,
          paymentFeeMinor: data.paymentFeeMinor,
          customerServiceFeeMinor: data.customerServiceFeeMinor,
          totalMinor: data.totalMinor,
          merchantPayoutMinor: data.merchantPayoutMinor,
          mainItemCount: data.mainItemCount,
          pricingSnapshot: data.pricingSnapshot,
          // 店內點餐. Spread in only when present, so a collection order leaves
          // the column at its default `null` rather than writing an explicit
          // one — the `@@index([diningSessionId, createdAt])` is smaller and
          // better-selecting when the dine-in rows are the only ones in it.
          ...(data.diningSessionId !== undefined
            ? { diningSessionId: data.diningSessionId }
            : {}),
          items: { create: data.items.map((item) => ({ ...item })) },
        },
        select: orderSelect,
      });

      return mapOrder(order);
    } catch (error) {
      throw translateInsertError(error, data.idempotencyKey);
    }
  }

  async findById(orderId: string): Promise<PersistedOrder | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: orderSelect,
    });
    return order ? mapOrder(order) : null;
  }

  async findByIdForUpdate(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PersistedOrder | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return null;

    const order = await tx.order.findUnique({ where: { id: orderId }, select: orderSelect });
    return order ? mapOrder(order) : null;
  }

  /** `WHERE status = expected` — the optimistic lock that makes transitions safe. */
  async updateStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    expectedStatus: OrderStatus,
    nextStatus: OrderStatus,
    patch: OrderStatusPatch,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id: orderId, status: toPrismaStatus(expectedStatus) },
      data: {
        status: toPrismaStatus(nextStatus),
        ...(patch.acceptedAt ? { acceptedAt: patch.acceptedAt } : {}),
        ...(patch.acceptDeadlineAt ? { acceptDeadlineAt: patch.acceptDeadlineAt } : {}),
        ...(patch.readyAt ? { readyAt: patch.readyAt } : {}),
        ...(patch.completedAt ? { completedAt: patch.completedAt } : {}),
        ...(patch.cancelledAt ? { cancelledAt: patch.cancelledAt } : {}),
        ...(patch.estimatedReadyAt ? { estimatedReadyAt: patch.estimatedReadyAt } : {}),
        ...(patch.readyInMinutes !== undefined ? { readyInMinutes: patch.readyInMinutes } : {}),
        // `!== undefined` again: `null` is a real value here ("clear the note"),
        // and a truthiness check would silently keep the old one.
        ...(patch.merchantNote !== undefined ? { merchantNote: patch.merchantNote } : {}),
        // `!== undefined`, not truthiness: `refundDueMinor: 0` is a decision
        // ("the customer gets nothing"), and dropping it would make the reactor
        // fall back to refunding the whole capture.
        ...(patch.refundDueMinor !== undefined ? { refundDueMinor: patch.refundDueMinor } : {}),
        ...(patch.cancellationTier !== undefined
          ? { cancellationTier: patch.cancellationTier }
          : {}),
      },
    });
    return result.count === 1;
  }

  async appendStatusEvent(tx: Prisma.TransactionClient, event: StatusEventRecord): Promise<void> {
    await tx.orderStatusEvent.create({
      data: {
        orderId: event.orderId,
        fromStatus: toPrismaStatus(event.fromStatus),
        toStatus: toPrismaStatus(event.toStatus),
        actor: toPrismaActor(event.actor),
        actorId: event.actorId ?? null,
        reason: event.reason ?? null,
        sideEffects: [...event.sideEffects] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async countStatusEvents(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
    // `tx`, NOT `this.prisma` — see the port's doc comment. Using the plain
    // client here made every outbox version lag by one.
    return tx.orderStatusEvent.count({ where: { orderId } });
  }

  async findReleaseContext(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
    readonly serviceDate: Date;
    readonly lines: readonly { menuItemId: string; quantity: number }[];
  } | null> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        serviceDate: true,
        items: { select: { menuItemId: true, quantity: true } },
      },
    });
    if (!order) return null;

    return {
      serviceDate: order.serviceDate,
      lines: order.items
        .filter((item): item is { menuItemId: string; quantity: number } => item.menuItemId !== null)
        .map((item) => ({ menuItemId: item.menuItemId, quantity: item.quantity })),
    };
  }

  async listOrderLines(
    orderId: string,
  ): Promise<readonly { menuItemId: string | null; nameSnapshot: string; quantity: number }[]> {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { menuItemId: true, nameSnapshot: true, quantity: true },
      orderBy: { id: 'asc' },
    });
    return items;
  }

  /**
   * Appends the order to its merchant's weekly settlement batch.
   *
   * Two concurrency properties, both load-bearing:
   *
   *  1. The batch is upserted with a single `INSERT ... ON CONFLICT DO UPDATE`.
   *     A read-then-write upsert would race: two orders for the same merchant
   *     completing simultaneously would both miss the row and both try to
   *     create it, and one would fail the `(merchantId, periodStart, periodEnd)`
   *     unique constraint. The aggregate increments happen inside the statement,
   *     so they are atomic under any interleaving.
   *  2. `status` is deliberately absent from the DO UPDATE clause — a batch that
   *     has already been paid out must never be reopened by a late arrival.
   *
   * The line insert is idempotent via `ON CONFLICT ("orderId") DO NOTHING`,
   * which is what makes a replayed transition harmless.
   */
  async recordPayoutLedger(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        merchantId: true,
        serviceDate: true,
        currency: true,
        subtotalMinor: true,
        platformFeeMinor: true,
        paymentFeeMinor: true,
        merchantPayoutMinor: true,
      },
    });
    if (!order) return;

    const { periodStart, periodEnd } = settlementPeriodFor(order.serviceDate);

    const [payout] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO merchant_payouts
             (id, "merchantId", "periodStart", "periodEnd", status, currency,
              "grossSubtotalMinor", "platformFeeMinor", "paymentFeeMinor",
              "netPayoutMinor", "orderCount", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${order.merchantId}::uuid, ${periodStart}, ${periodEnd},
              'PENDING'::"PayoutStatus", ${order.currency},
              ${order.subtotalMinor}, ${order.platformFeeMinor}, ${order.paymentFeeMinor},
              ${order.merchantPayoutMinor}, 1, now(), now())
      ON CONFLICT ("merchantId", "periodStart", "periodEnd") DO UPDATE
         SET "grossSubtotalMinor" = merchant_payouts."grossSubtotalMinor" + EXCLUDED."grossSubtotalMinor",
             "platformFeeMinor"   = merchant_payouts."platformFeeMinor"   + EXCLUDED."platformFeeMinor",
             "paymentFeeMinor"    = merchant_payouts."paymentFeeMinor"    + EXCLUDED."paymentFeeMinor",
             "netPayoutMinor"     = merchant_payouts."netPayoutMinor"     + EXCLUDED."netPayoutMinor",
             "orderCount"         = merchant_payouts."orderCount"         + 1,
             "updatedAt"          = now()
      RETURNING id
    `;

    await tx.$executeRaw`
      INSERT INTO merchant_payout_lines
             (id, "payoutId", "orderId", "subtotalMinor", "platformFeeMinor",
              "paymentFeeMinor", "merchantPayoutMinor")
      VALUES (gen_random_uuid(), ${payout!.id}::uuid, ${order.id}::uuid,
              ${order.subtotalMinor}, ${order.platformFeeMinor},
              ${order.paymentFeeMinor}, ${order.merchantPayoutMinor})
      ON CONFLICT ("orderId") DO NOTHING
    `;
  }
}

/**
 * The weekly settlement window containing `serviceDate`.
 *
 * Weeks run Monday 00:00 UTC to the following Monday, so the batch a given
 * order belongs to is a pure function of its service date — no clock read, no
 * "current period" state to drift.
 */
export function settlementPeriodFor(serviceDate: Date): {
  periodStart: Date;
  periodEnd: Date;
} {
  const periodStart = new Date(
    Date.UTC(serviceDate.getUTCFullYear(), serviceDate.getUTCMonth(), serviceDate.getUTCDate()),
  );
  // getUTCDay(): 0 = Sunday … 6 = Saturday. Shift so Monday is offset 0.
  const daysSinceMonday = (periodStart.getUTCDay() + 6) % 7;
  periodStart.setUTCDate(periodStart.getUTCDate() - daysSinceMonday);

  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 7);

  return { periodStart, periodEnd };
}

const orderSelect = {
  id: true,
  orderNo: true,
  pickupCode: true,
  customerId: true,
  merchantId: true,
  status: true,
  paymentMode: true,
  currency: true,
  subtotalMinor: true,
  platformFeeMinor: true,
  paymentFeeMinor: true,
  totalMinor: true,
  merchantPayoutMinor: true,
  mainItemCount: true,
  prepTimeMinutes: true,
  scheduledPickupAt: true,
  estimatedReadyAt: true,
  acceptedAt: true,
  readyAt: true,
  completedAt: true,
  acceptDeadlineAt: true,
  pricingSnapshot: true,
  updatedAt: true,
} as const;

function mapOrder(order: {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  customerId: string;
  merchantId: string;
  status: PrismaOrderStatus;
  paymentMode: PrismaPaymentMode;
  currency: string;
  subtotalMinor: number;
  platformFeeMinor: number;
  paymentFeeMinor: number;
  totalMinor: number;
  merchantPayoutMinor: number;
  mainItemCount: number;
  prepTimeMinutes: number;
  scheduledPickupAt: Date | null;
  estimatedReadyAt: Date | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
  acceptDeadlineAt: Date | null;
  pricingSnapshot: unknown;
  updatedAt: Date;
}): PersistedOrder {
  return {
    id: order.id,
    orderNo: order.orderNo,
    pickupCode: order.pickupCode,
    customerId: order.customerId,
    merchantId: order.merchantId,
    status: fromPrismaStatus(order.status),
    paymentMode: order.paymentMode as unknown as PaymentMode,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    platformFeeMinor: order.platformFeeMinor,
    paymentFeeMinor: order.paymentFeeMinor,
    totalMinor: order.totalMinor,
    merchantPayoutMinor: order.merchantPayoutMinor,
    mainItemCount: order.mainItemCount,
    prepTimeMinutes: order.prepTimeMinutes,
    scheduledPickupAt: order.scheduledPickupAt,
    estimatedReadyAt: order.estimatedReadyAt,
    acceptedAt: order.acceptedAt,
    readyAt: order.readyAt,
    completedAt: order.completedAt,
    acceptDeadlineAt: order.acceptDeadlineAt,
    pricingSnapshot: order.pricingSnapshot,
    updatedAt: order.updatedAt,
  };
}

/**
 * Turn a Prisma write failure into a domain error the filter can map.
 *
 * Only `P2002` on `idempotencyKey` is translated. Everything else is rethrown
 * untouched on purpose: a unique clash on `orderNo` is a sequence generator bug
 * and swallowing it into "duplicate idempotency key" would hide a real defect
 * behind a message that tells the caller to stop retrying.
 */
function translateInsertError(error: unknown, idempotencyKey?: string): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    idempotencyKey &&
    String(error.meta?.target ?? '').includes('idempotencyKey')
  ) {
    return new ConflictOnIdempotencyKey(idempotencyKey);
  }
  return error;
}

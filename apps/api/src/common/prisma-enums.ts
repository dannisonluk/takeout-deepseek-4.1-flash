import { OrderStatus as PrismaOrderStatus } from '@prisma/client';
import { isActiveStatus, OrderStatus as DomainOrderStatus } from '@takeout/domain';

/**
 * The "still in flight" order statuses, as Prisma enum values.
 *
 * `@takeout/domain` and Prisma each declare an `OrderStatus`. They hold exactly
 * the same string values — the schema says so and `docs/ARCHITECTURE.md` keeps
 * them in lockstep — but they are distinct TypeScript types, so passing one
 * where the other is expected needs a cast.
 *
 * Doing that cast here, once, means call sites read as what they mean. The
 * alternative is the `as unknown as never[]` that had to be sprinkled at every
 * `where: { status: { in: ... } }` site.
 */
export const ACTIVE_ORDER_STATUSES: readonly PrismaOrderStatus[] = Object.values(
  DomainOrderStatus,
).filter(isActiveStatus) as unknown as PrismaOrderStatus[];

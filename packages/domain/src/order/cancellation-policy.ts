import { CurrencyCode, Money } from '../shared/index';
import { ValidationError } from '../shared/domain-error';
import { OrderActor, OrderStatus } from './order-status';

/**
 * Why a cancellation was priced the way it was.
 *
 * The tier is the *explanation*; the basis points are the number. Keeping them
 * separate is what lets the admin portal say "the customer cancelled 40 seconds
 * after the merchant accepted, so they get everything back" instead of showing a
 * bare `0` or `10000`.
 */
export enum CancellationTier {
  /** Nothing was committed in the kitchen. Full refund. */
  FREE = 'FREE',
  /** The customer walked away after the grace window — the merchant has committed. */
  LATE = 'LATE',
  /** The food was ready and nobody collected it. Not refundable. */
  NON_REFUNDABLE = 'NON_REFUNDABLE',
  /** The merchant refused or cancelled. Never the customer's fault. */
  MERCHANT_FAULT = 'MERCHANT_FAULT',
  /** A timer expired the order — nobody failed, but the customer paid for nothing. */
  PLATFORM_FAULT = 'PLATFORM_FAULT',
  /** An operator decided on the customer's behalf; the ratio is theirs to set. */
  GOODWILL = 'GOODWILL',
}

export interface CancellationPolicy {
  /**
   * Minutes after the merchant accepted during which a customer may still walk
   * away for free.
   *
   * This is the "oops" window. Without it, a mis-tapped order costs the customer
   * the whole basket the instant the merchant taps 接單, which is both hostile
   * and — since the kitchen has not started — unjustifiable.
   */
  readonly graceMinutes: number;
  /** Refund ratio per tier, in basis points (10_000 = 100%). */
  readonly refundBps: Readonly<Record<CancellationTier, number>>;
}

/**
 * The shipped default.
 *
 * Two numbers carry the whole business decision: `LATE` is 0 because the
 * merchant has already bought and committed ingredients by then, and
 * `NON_REFUNDABLE` is 0 because a cooked meal that was never collected is a
 * total loss for the merchant. Every value is overridable per deployment
 * through `platform_config`, which is the same three-tier resolution the
 * pricing fee uses.
 */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = Object.freeze({
  graceMinutes: 2,
  refundBps: Object.freeze({
    [CancellationTier.FREE]: 10_000,
    [CancellationTier.LATE]: 0,
    [CancellationTier.NON_REFUNDABLE]: 0,
    [CancellationTier.MERCHANT_FAULT]: 10_000,
    [CancellationTier.PLATFORM_FAULT]: 10_000,
    [CancellationTier.GOODWILL]: 10_000,
  }),
});

export interface CancellationQuoteRequest {
  readonly orderId: string;
  /** Status the order is leaving. */
  readonly from: OrderStatus;
  /** `CANCELLED`, `REJECTED` or `EXPIRED` — the only statuses that return money. */
  readonly to: OrderStatus;
  readonly actor: OrderActor;
  /** Captured amount in minor units. `0` means nothing was ever charged. */
  readonly paidAmountMinor: number;
  readonly currency?: CurrencyCode;
  /** When the merchant accepted. Absent means they never did. */
  readonly acceptedAt?: Date | null;
  readonly now: Date;
  /**
   * Operator-chosen ratio for a `GOODWILL` cancellation, in basis points.
   * Ignored for every other tier, because a non-operator cannot choose how much
   * of somebody else's money to give back.
   */
  readonly overrideBps?: number;
}

export interface CancellationQuote {
  readonly orderId: string;
  readonly tier: CancellationTier;
  readonly refundBps: number;
  /** What goes back to the customer. */
  readonly refund: Money;
  /** What the merchant keeps for work already done. */
  readonly retained: Money;
  /** One sentence, safe to show a customer or an operator. */
  readonly reason: string;
}

const REFUNDABLE_TARGETS: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
]);

function assertRatio(label: string, bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new ValidationError(
      `${label} must be an integer number of basis points between 0 and 10000, received ${bps}`,
      { label, bps },
    );
  }
}

/**
 * Decides **how much** of a captured payment goes back when an order ends.
 *
 * This is deliberately not part of `OrderStateMachine`. The state machine
 * answers *whether* a transition is allowed — a binary, authorisation-shaped
 * question with one right answer. This answers *what it costs*, which is a
 * commercial policy the business will want to tune, A/B and argue about. Merging
 * them would mean editing the authorisation table every time finance changes a
 * refund percentage.
 *
 * Pure and immutable: `withPolicy` returns a new engine rather than mutating
 * this one, because a shared mutable engine would let two concurrent requests
 * price each other's cancellations.
 */
export class CancellationPolicyEngine {
  constructor(private readonly policy: CancellationPolicy = DEFAULT_CANCELLATION_POLICY) {
    if (!Number.isInteger(policy.graceMinutes) || policy.graceMinutes < 0) {
      throw new ValidationError(
        `graceMinutes must be a non-negative integer, received ${policy.graceMinutes}`,
      );
    }
    for (const tier of Object.values(CancellationTier)) {
      const bps = policy.refundBps[tier];
      // A missing tier would silently price as `undefined` and produce a NaN
      // refund, which is the kind of bug that only shows up as a wrong bank
      // balance three weeks later.
      if (bps === undefined) {
        throw new ValidationError(`Cancellation policy is missing a ratio for ${tier}`, { tier });
      }
      assertRatio(`refundBps.${tier}`, bps);
    }
  }

  get config(): CancellationPolicy {
    return this.policy;
  }

  /** A new engine with some values replaced. Never mutates this one. */
  withPolicy(overrides: Partial<CancellationPolicy>): CancellationPolicyEngine {
    return new CancellationPolicyEngine({
      graceMinutes: overrides.graceMinutes ?? this.policy.graceMinutes,
      refundBps: { ...this.policy.refundBps, ...(overrides.refundBps ?? {}) },
    });
  }

  /** Price a cancellation that is about to happen. */
  quote(request: CancellationQuoteRequest): CancellationQuote {
    if (!REFUNDABLE_TARGETS.has(request.to)) {
      throw new ValidationError(
        `${request.to} does not return money to the customer; only CANCELLED, REJECTED and EXPIRED do`,
        { to: request.to, from: request.from },
      );
    }

    const { tier, reason } = this.classify(request);
    const refundBps =
      tier === CancellationTier.GOODWILL
        ? (request.overrideBps ?? this.policy.refundBps[CancellationTier.GOODWILL])
        : this.policy.refundBps[tier];
    assertRatio(`overrideBps for ${tier}`, refundBps);

    const captured = Money.of(Math.max(0, request.paidAmountMinor), request.currency ?? 'HKD');
    const refund = captured.applyBasisPoints(refundBps);
    const retained = captured.subtract(refund);

    return Object.freeze({
      orderId: request.orderId,
      tier,
      refundBps,
      refund,
      retained,
      reason,
    });
  }

  /**
   * Which tier applies. Actor first, then status — a merchant cancelling is a
   * merchant fault no matter how far along the order was, and an operator is
   * always a judgement call rather than a rule.
   */
  private classify(request: CancellationQuoteRequest): {
    tier: CancellationTier;
    reason: string;
  } {
    const { from, to, actor } = request;

    if (to === OrderStatus.REJECTED) {
      return {
        tier: CancellationTier.MERCHANT_FAULT,
        reason: 'The merchant declined the order, so the customer gets everything back.',
      };
    }

    if (actor === OrderActor.MERCHANT) {
      return {
        tier: CancellationTier.MERCHANT_FAULT,
        reason: 'The merchant cancelled, so the customer gets everything back.',
      };
    }

    if (actor === OrderActor.ADMIN) {
      return {
        tier: CancellationTier.GOODWILL,
        reason: 'An operator cancelled this order and chose the refund.',
      };
    }

    // SYSTEM: a timer or a payment webhook. The customer did nothing wrong —
    // except in one case, handled below.
    if (actor === OrderActor.SYSTEM) {
      if (from === OrderStatus.READY_FOR_PICKUP) {
        return {
          tier: CancellationTier.NON_REFUNDABLE,
          reason: 'The food was ready and the pickup window lapsed without collection.',
        };
      }
      return {
        tier: CancellationTier.PLATFORM_FAULT,
        reason: 'The order expired before it could be fulfilled, so the customer gets everything back.',
      };
    }

    // CUSTOMER.
    if (from === OrderStatus.READY_FOR_PICKUP) {
      // Unreachable through the state machine, which offers a customer no exit
      // from READY_FOR_PICKUP. Priced defensively rather than left undefined.
      return {
        tier: CancellationTier.NON_REFUNDABLE,
        reason: 'The food was already prepared when the order was cancelled.',
      };
    }

    if (from === OrderStatus.PREPARING) {
      // Also unreachable for a customer — `PREPARING -> CANCELLED` lists only
      // MERCHANT and ADMIN. Kept explicit so that widening the transition table
      // cannot silently start handing out refunds.
      return {
        tier: CancellationTier.LATE,
        reason: 'The kitchen had already started cooking.',
      };
    }

    if (from === OrderStatus.ACCEPTED) {
      const elapsedMinutes = elapsedMinutesSince(request.acceptedAt, request.now);
      if (elapsedMinutes !== null && elapsedMinutes <= this.policy.graceMinutes) {
        return {
          tier: CancellationTier.FREE,
          reason: `Cancelled within ${this.policy.graceMinutes} minutes of the merchant accepting, so nothing is charged.`,
        };
      }
      return {
        tier: CancellationTier.LATE,
        reason: 'The merchant had already accepted and committed to the order.',
      };
    }

    // PENDING_PAYMENT / PAID — the kitchen has not been involved at all.
    return {
      tier: CancellationTier.FREE,
      reason: 'Nothing had been prepared, so the customer gets everything back.',
    };
  }
}

function elapsedMinutesSince(from: Date | null | undefined, now: Date): number | null {
  if (!from) return null;
  const milliseconds = now.getTime() - from.getTime();
  if (!Number.isFinite(milliseconds)) return null;
  // A negative elapsed time means the clock moved backwards or the timestamp is
  // in the future; treat it as "inside the window" rather than punishing the
  // customer for our own clock skew.
  return milliseconds < 0 ? 0 : milliseconds / 60_000;
}

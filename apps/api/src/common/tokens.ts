/**
 * Injection tokens for the domain-layer abstractions.
 *
 * Application code depends on these tokens, never on a concrete class, which is
 * what lets `dispatch` swap `SelfPickupDispatchService` for
 * `FleetDispatchService` by changing one provider registration.
 */
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const ORDER_STATE_MACHINE = Symbol('ORDER_STATE_MACHINE');
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const DISPATCH_SERVICE = Symbol('DISPATCH_SERVICE');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/**
 * The reservation book's persistence port.
 *
 * A separate token from `ORDER_REPOSITORY` even though both are backed by the
 * same database: a reservation is a different aggregate, and a use case that
 * could reach the order repository through this token would be able to write
 * `orders` from inside a booking transaction — exactly the cross-context reach
 * the per-module ports exist to prevent.
 */
export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

/**
 * The `ReservationStateMachine` instance.
 *
 * Registered as a singleton for the same reason as `ORDER_STATE_MACHINE`: the
 * transitions the merchant board offers and the ones the write path authorises
 * must be computed by the *same* object, or a button can appear that the server
 * will refuse.
 */
export const RESERVATION_STATE_MACHINE = Symbol('RESERVATION_STATE_MACHINE');

/**
 * The refund ticket's persistence port.
 *
 * Its own token for the same reason `RESERVATION_REPOSITORY` has one: a use case
 * that could reach the order repository through this token would be able to
 * write `orders` from inside a ticket transaction. This flow is explicitly
 * forbidden from touching the money path, and the port is the enforcement point
 * a code review can actually see.
 */
export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');

/**
 * The `RefundRequestStateMachine` instance.
 *
 * Singleton for the same reason as the other two: the moves the shop's queue
 * offers and the ones the write path authorises must come from the *same*
 * object, or a button can appear that the server will refuse.
 */
export const REFUND_STATE_MACHINE = Symbol('REFUND_STATE_MACHINE');

/**
 * The walk-in queue's persistence port.
 *
 * Its own token for the established reason: a use case that could reach the
 * reservation or order repository through this token would be able to write
 * another aggregate from inside a queue transaction. A queue ticket is a
 * different aggregate from a booking — it holds no capacity — and the port is
 * what makes that boundary visible in a code review.
 */
export const WAITLIST_REPOSITORY = Symbol('WAITLIST_REPOSITORY');

/**
 * The `WaitlistStateMachine` instance.
 *
 * Singleton for the same reason as the other three: the moves the host board
 * offers and the ones the write path authorises must come from the *same*
 * object, or a button can appear that the server will refuse.
 */
export const WAITLIST_STATE_MACHINE = Symbol('WAITLIST_STATE_MACHINE');

/**
 * The in-store seating's persistence port.
 *
 * `DiningTable` + `DiningSession` together: a table without its sitting has no
 * meaning on this side of the boundary (the code printed on the QR is only
 * useful in order to open one), so they share a port rather than pretending to
 * be two aggregates.
 */
export const DINING_REPOSITORY = Symbol('DINING_REPOSITORY');

/** The `DiningSessionMachine` instance — tiny, but still one shared object. */
export const DINING_STATE_MACHINE = Symbol('DINING_STATE_MACHINE');

// There is deliberately no `PAYMENT_PROVIDER` token. There used to be, bound to
// `StripePaymentProvider`, and it made `PAYMENT_PROVIDER=PAYME` a lie: the env
// var was read, validated and then ignored because the token always resolved to
// Stripe. Payment rails are now reached through `PaymentProviderRegistry`, which
// resolves per request and per payment row — a single token cannot express
// "whichever rail this particular order used".

/**
 * The `PricingEngine` instance. Declared here so every module resolves the same
 * token; `PricingModule` re-exports it for convenience.
 */
export const PRICING_ENGINE = Symbol('PRICING_ENGINE');

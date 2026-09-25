/**
 * @takeout/domain — the pure business core.
 *
 * No framework, no ORM, no HTTP, no `process.env`. Everything here is plain
 * TypeScript with zero runtime dependencies, which is what makes the money
 * rules and the order lifecycle testable in milliseconds.
 *
 *   shared/    Money, GeoPoint, Clock, IdGenerator, DomainError
 *   pricing/   PricingEngine  — per-main-item platform fee, merchant payout
 *   order/     OrderStateMachine — lifecycle, authorisation, side effects
 *              CancellationPolicyEngine — what a cancellation refunds
 *   reservation/ ReservationStateMachine — 預約訂位 lifecycle
 *              planAvailability — the bookable grid, seats per slot
 *   merchant/  ClosureReason + describeClosure — 特別休息日
 *              AnalyticsTier + buildAnalyticsReport + CSV export — 商戶營業報表
 *   waitlist/  WaitlistStateMachine — 現場候位
 *   refund/    RefundRequestStateMachine — 退款申請工單（tickets only, no money)
 *   feedback/  rating vocabulary + RatingSummary
 *   payment/   EMVCo / FPS QR payload builder
 *   discovery/ MerchantRankingEngine — distance / rating / prep-time ordering
 *   dispatch/  IDispatchService — self-pickup now, fleet later
 *   fleet/     phase-2 ports (registry, geo tracking, task assignment)
 */
export * from './shared/index';
export * from './pricing/index';
export * from './order/index';
export * from './reservation/index';
export * from './merchant/index';
export * from './waitlist/index';
export * from './refund/index';
export * from './feedback/index';
export * from './payment/index';
export * from './discovery/index';
export * from './dispatch/index';
export * from './fleet/index';

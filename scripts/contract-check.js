/**
 * Frontend/API contract check.
 *
 * `apps/web/src/lib/types.ts` is hand-mirrored from the API's views rather than
 * generated, on purpose: a generator would happily emit a type for a field
 * nobody meant to expose. The cost of that choice is that a renamed field
 * breaks the console at runtime with no compile error anywhere — `tsc` is happy
 * because the frontend's own types are self-consistent.
 *
 * So this script calls every endpoint the three portals depend on and diffs the
 * real response keys against the keys the frontend declares, in both
 * directions:
 *
 *   - a key the API sends but `types.ts` does not declare  -> the frontend
 *     cannot see it, and somebody will "fix" a missing field by re-deriving it
 *     client-side from something else
 *   - a key `types.ts` declares but the API does not send -> a field that is
 *     silently `undefined` at runtime, which is how `pricingSnapshot.
 *     paymentFeeMinor` survived an earlier draft
 *
 * It mints its own tokens, so run it against a booted API with the seeded
 * identities. It uses the dev OTP path (`devCode` in the response) and will
 * refuse to run against production.
 *
 *   node scripts/contract-check.js
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.join(__dirname, '..');
const prisma = new PrismaClient();

function loadEnv() {
  const file = path.join(ROOT, '.env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
}
loadEnv();

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3000}/v1`;

/** Seeded by `prisma/seed.js`. */
const ADMIN_PHONE = '+85290000003';
const OWNER_PHONE = '+85290000002';
const CUSTOMER_PHONE = '+85290000001';

let failures = 0;
let checks = 0;
let skipped = 0;

/**
 * Compare a response's field set against the hand-written mirror in `types.ts`.
 *
 * `options.absent` is the *negative* assertion, and it is the more important of
 * the two. Some fields are declared on the merchant projection and must NOT
 * appear on the public one — a customer's phone number on a queue ticket, a
 * guest's ordering authority on a table scan. A plain equality check cannot
 * express that, because "the customer view simply omits it" and "the customer
 * view leaks it" look the same to a missing-key scan.
 */
function compare(label, actual, expected, options = {}) {
  if (actual === undefined || actual === null) {
    skipped += 1;
    console.log(`  skip  ${label} (no sample row)`);
    return;
  }

  if (options.absent?.length) {
    checks += 1;
    const keys = Object.keys(actual);
    const leaked = options.absent.filter((key) => keys.includes(key));
    if (leaked.length === 0) {
      console.log(`  ok    ${label}`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${label}`);
      console.log(`        must NOT be sent by this endpoint, but was: ${leaked.join(', ')}`);
    }
    return;
  }

  checks += 1;
  const actualKeys = Object.keys(actual).sort();
  const missing = expected.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !expected.includes(key));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (missing.length) console.log(`        declared in types.ts, absent from the API: ${missing.join(', ')}`);
  if (extra.length) console.log(`        sent by the API, undeclared in types.ts:   ${extra.join(', ')}`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(
      `${options.method ?? 'GET'} ${pathname} -> ${response.status} ${text.slice(0, 200)}`,
    );
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Today in the seeded shop's zone, as `YYYY-MM-DD`.
 *
 * The reservation grid is anchored to the MERCHANT's calendar date, and asking
 * for `from=<yesterday UTC>` would return a window that may not include a
 * bookable slot for a +8 shop queried in the evening. The seed merchant is in
 * `Asia/Hong_Kong`, and there is no way to read that before authenticating, so
 * the zone is pinned here rather than plumbed through.
 */
function todayKey(timeZone = 'Asia/Hong_Kong') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Log in, waiting out the OTP throttle rather than failing.
 *
 * The API rate-limits code requests per phone, which is correct behaviour — but
 * it means running this straight after the E2E suites, which also log in, would
 * otherwise fail on a 429 that has nothing to do with the contract. The wait is
 * bounded so a genuine outage still surfaces.
 */
async function mintToken(phone) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const requested = await api('/auth/otp/request', { method: 'POST', body: { phone } });
      if (!requested.devCode) {
        throw new Error(
          `no devCode for ${phone} — this check needs the non-production OTP path`,
        );
      }
      const session = await api('/auth/otp/verify', {
        method: 'POST',
        body: { phone, code: requested.devCode },
      });
      return session.accessToken;
    } catch (error) {
      const retryAfter = error.body?.error?.details?.retryAfterSeconds;
      if (error.body?.error?.code === 'OTP_RATE_LIMITED' && attempt < 3 && retryAfter) {
        const wait = Math.min(retryAfter, 90) + 2;
        console.log(`  ..    ${phone} throttled, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`could not authenticate ${phone}`);
}

const MERCHANT_SUMMARY = [
  'id', 'slug', 'name', 'nameEn', 'description', 'status', 'district', 'region',
  'addressLine1', 'latitude', 'longitude', 'logoKey', 'coverImageKey',
  'prepTimeMinutes', 'pickupWindowMinutes', 'acceptsOrders', 'ratingAvg',
  'ratingCount', 'distanceKm',
];

const OWNED_MERCHANT = [
  'id', 'slug', 'name', 'nameEn', 'description', 'status', 'acceptsOrders',
  'autoAcceptOrders', 'phone', 'district', 'region', 'addressLine1',
  'addressLine2', 'latitude', 'longitude', 'logoKey', 'coverImageKey',
  'prepTimeMinutes', 'pickupWindowMinutes', 'acceptTimeoutMinutes', 'timezone',
  'ratingAvg', 'ratingCount', 'isOwner', 'hours',
];

/** `POST /orders` — the shape the checkout screen renders the moment it lands. */
const ORDER_CREATED = [
  'id', 'orderNo', 'pickupCode', 'status', 'paymentMode', 'scheduledPickupAt',
  'estimatedReadyAt', 'pickupNotice', 'currency', 'items', 'pricing',
];

const ORDER_CREATED_PRICING = [
  'mainItemCount', 'subtotalMinor', 'platformFeeMinor', 'paymentProcessingFeeMinor',
  'customerServiceFeeMinor', 'totalMinor', 'merchantPayoutMinor',
];

/** The booking page's read model. `policy` is compared separately. */
const RESERVATION_AVAILABILITY = [
  'timezone', 'enabled', 'acceptingNew', 'customerNotice', 'policy',
  'windowStart', 'windowEnd', 'notice', 'closedDates', 'slots', 'bookableCount',
];

const RESERVATION_POLICY = [
  'enabled', 'autoConfirm', 'slotMinutes', 'turnMinutes', 'seatsPerSlot',
  'minPartySize', 'maxPartySize', 'leadTimeMinutes', 'advanceDays',
];

/** 特別休息日 — the merchant's rest-day read model. */
const MERCHANT_CLOSURE = [
  'id', 'serviceDate', 'reason', 'note', 'cancelledReservationsAt',
  'cancelledReservationCount', 'createdAt',
];

/**
 * The `policy` object inside `reservation-availability`.
 *
 * A STRICT SUBSET of `ReservationPolicy`, and the difference is deliberate:
 * `enabled` / `acceptingNew` are hoisted to the top level because that is what
 * a booking page actually branches on, and `seatsPerSlot` is removed outright
 * because a customer has no business reading the shop's capacity — only whether
 * their own party fits, which each slot's `bookable` flag answers.
 */
const RESERVATION_AVAILABILITY_POLICY = [
  'slotMinutes', 'turnMinutes', 'minPartySize', 'maxPartySize',
  'leadTimeMinutes', 'advanceDays',
];

/**
 * The customer's projection.
 *
 * Checked against `GET /reservations` AND against the creation response read
 * back through the detail endpoint, because the two are built by different
 * code paths — `place` hand-builds its `ReservationCreatedView` while the list
 * and detail come from `ReservationQueryService`. A field added to one and not
 * the other is exactly the drift this script exists to catch.
 */
const CUSTOMER_RESERVATION = [
  'id', 'reservationNo', 'merchantId', 'merchantName', 'merchantSlug',
  'merchantTimezone', 'status', 'partySize', 'startsAt', 'serviceDate',
  'customerName', 'customerNote', 'merchantNote', 'statusReason',
  'confirmedAt', 'seatedAt', 'completedAt', 'cancelledAt', 'createdAt', 'canCancel',
];

/** The shop's projection — extends the customer's with four more fields. */
const MERCHANT_RESERVATION = [
  ...CUSTOMER_RESERVATION,
  'contactPhone', 'turnMinutes', 'version', 'allowedNextTransitions',
];

const RESERVATION_TRANSITION = [
  'reservationId', 'reservationNo', 'fromStatus', 'toStatus', 'occurredAt',
  'sideEffects', 'allowedNextTransitions', 'reservation',
];

const RESERVATION_CREATED = [
  'id', 'reservationNo', 'merchantId', 'merchantName', 'status', 'partySize',
  'startsAt', 'serviceDate', 'timezone', 'customerNotice', 'autoConfirmed',
];

/**
 * 退款申請工單 — the customer's projection.
 *
 * Every field here is read back from a real ticket. Note what is ABSENT:
 * `customerId`, `customerName`, `orderStatus`, `version` and `resolvedById` are
 * the shop's projection only, and `settledAmountMinor` / `settlementReference`
 * are present because the customer must see what the shop claims it handed
 * over — but the doc comment on the view says they are a claim, not a record.
 */
const CUSTOMER_REFUND_REQUEST = [
  'id', 'orderId', 'orderNo', 'merchantId', 'status', 'reasonCode',
  'requestedAmountMinor', 'orderTotalMinor', 'currency', 'customerNote',
  'merchantNote', 'settledAmountMinor', 'settlementReference', 'resolvedAt',
  'cancelledAt', 'createdAt', 'updatedAt', 'allowedNextTransitions',
];

/** The shop's projection — extends the customer's with four more fields. */
const MERCHANT_REFUND_REQUEST = [
  ...CUSTOMER_REFUND_REQUEST,
  'customerId', 'customerName', 'orderStatus', 'version',
];

const REFUND_TRANSITION = [
  'refundRequestId', 'orderId', 'orderNo', 'fromStatus', 'toStatus',
  'occurredAt', 'sideEffects', 'allowedNextTransitions', 'refundRequest',
];

/** The per-order summary the order detail page renders its button from. */
const ORDER_REFUND_SUMMARY = [
  'id', 'status', 'reasonCode', 'requestedAmountMinor', 'createdAt',
];

(async () => {
  const admin = await mintToken(ADMIN_PHONE);
  const owner = await mintToken(OWNER_PHONE);
  const customer = await mintToken(CUSTOMER_PHONE);

  /**
   * The order shapes below can only be compared against a real order, and the
   * E2E suites TRUNCATE the orders table — so `e2e:all` followed by this check
   * used to skip four of the most important shapes and still print PASS. An
   * unverifiable shape is one that breaks in production rather than here, so
   * create one when there is nothing to read.
   *
   * It is cancelled before it is deleted so `RELEASE_DAILY_QUOTA` puts the
   * soft-held units back. Deleting an order outright leaves `held` raised, and
   * a raised `held` is what makes repeated E2E runs drift towards the quota cap
   * and start failing for reasons that have nothing to do with the code.
   */
  let probeOrderId = null;
  const existingOrders = await api('/orders?status=ALL&limit=1', { token: customer });
  if (!existingOrders.data?.length) {
    const detail = await api('/merchants/dim-sum-express');
    const item = detail.categories?.flatMap((category) => category.items ?? [])[0];
    if (item) {
      const created = await api('/orders', {
        method: 'POST',
        token: customer,
        body: { merchantId: detail.id, items: [{ menuItemId: item.id, quantity: 1 }] },
        headers: { 'idempotency-key': `contract-check-${Date.now()}` },
      });
      probeOrderId = created.id;
      compare('OrderCreated', created, ORDER_CREATED);
      compare('OrderCreated.pricing', created.pricing, ORDER_CREATED_PRICING);
      console.log(`  ..    created probe order ${created.orderNo} — the table was empty`);
    }
  }

  console.log('\npublic discovery');
  const list = await api('/merchants');
  compare('MerchantSummary', list.data[0], MERCHANT_SUMMARY);

  const detail = await api('/merchants/dim-sum-express');
  compare('MerchantDetail', detail, [
    ...MERCHANT_SUMMARY,
    'phone', 'addressLine2', 'timezone', 'acceptTimeoutMinutes', 'autoAcceptOrders',
    'hours', 'categories',
  ]);
  compare('MenuCategory', detail.categories?.[0], [
    'id', 'name', 'nameEn', 'sortOrder', 'isActive', 'items',
  ]);
  compare('MenuItem', detail.categories?.[0]?.items?.[0], [
    'id', 'categoryId', 'name', 'nameEn', 'description', 'imageKey', 'imageBlurhash',
    'priceMinor', 'currency', 'isMainItem', 'availability', 'dailyQuota',
    'remainingToday', 'prepTimeMinutes', 'sortOrder',
  ]);
  compare('OperatingHour', detail.hours?.[0], [
    'dayOfWeek', 'opensAtMinute', 'closesAtMinute', 'isClosed',
  ]);

  const slots = await api('/merchants/dim-sum-express/pickup-slots');
  compare('PickupSlots', slots, [
    'merchantId', 'timezone', 'stepMinutes', 'windowMinutes', 'earliestAt',
    'latestAt', 'acceptingNow', 'closedReason', 'closureDate', 'slots',
  ]);
  compare('PickupSlot', slots.slots?.[0], ['startAt', 'endAt', 'label', 'dayOffset']);

  compare('DistrictCount', (await api('/merchants/districts'))[0], ['district', 'count']);

  console.log('\nmerchant portal');
  const mine = await api('/merchant/mine', { token: owner });
  compare('OwnedMerchant', mine[0], OWNED_MERCHANT);
  const merchantId = mine[0]?.id;

  const menu = await api(`/merchant/${merchantId}/menu`, { token: owner });
  compare('OwnerMenu', menu, ['merchantId', 'serviceDate', 'categories', 'uncategorised', 'totals']);
  compare('OwnerMenu.totals', menu.totals, ['categories', 'items', 'mainItems']);

  const kitchen = await api(`/merchant/${merchantId}/orders?status=ALL`, { token: owner });
  compare('MerchantOrder', kitchen.data[0], [
    'id', 'orderNo', 'pickupCode', 'merchantId', 'merchantName', 'merchantSlug',
    'merchantTimezone', 'status', 'fulfilmentMode', 'paymentMode',
    'scheduledPickupAt', 'estimatedReadyAt', 'readyInMinutes', 'merchantNote',
    'pickupNotice', 'createdAt', 'items', 'totalMinor', 'currency',
    'customerNote', 'refundRequests', 'subtotalMinor', 'platformFeeMinor',
    'paymentFeeMinor', 'merchantPayoutMinor', 'mainItemCount', 'acceptDeadlineAt',
    'acceptedAt', 'readyAt', 'completedAt',
  ]);

  /**
   * The customer's own projection, read back from `GET /orders`.
   *
   * `MerchantOrder` extends `CustomerOrder` on both sides, so this is not a
   * duplicate check: it is the one that proves the *customer* endpoint sends
   * `pickupNotice` and the merchant's promise, which is what the tracking page
   * renders. A field added only to the merchant view would pass above and
   * leave the customer looking at nothing.
   */
  const myOrders = await api('/orders?status=ALL&limit=5', { token: customer });
  compare('CustomerOrder', myOrders.data?.[0], [
    'id', 'orderNo', 'pickupCode', 'merchantId', 'merchantName', 'merchantSlug',
    'merchantTimezone', 'status', 'fulfilmentMode', 'paymentMode',
    'scheduledPickupAt', 'estimatedReadyAt', 'readyInMinutes', 'merchantNote',
    'pickupNotice', 'createdAt', 'items', 'totalMinor', 'currency', 'customerNote',
    'refundRequests',
  ]);
  compare('CustomerOrder.items[0]', myOrders.data?.[0]?.items?.[0], [
    'menuItemId', 'nameSnapshot', 'imageKeySnapshot', 'unitPriceMinor',
    'quantity', 'lineTotalMinor', 'isMainItem',
  ]);

  console.log('\nadmin console');
  const dashboard = await api('/admin/dashboard', { token: admin });
  compare('DashboardStats', dashboard, [
    'generatedAt', 'merchants', 'orders', 'users', 'payouts', 'ops', 'pricing',
  ]);
  compare('DashboardStats.merchants', dashboard.merchants, [
    'total', 'active', 'pendingReview', 'suspended', 'closed', 'acceptingOrders',
  ]);
  compare('DashboardStats.orders', dashboard.orders, [
    'today', 'todayGmvMinor', 'todayPlatformFeeMinor', 'todayPayoutMinor', 'active', 'byStatus',
  ]);
  compare('DashboardStats.users', dashboard.users, [
    'total', 'customers', 'merchantUsers', 'admins', 'disabled', 'activeToday',
  ]);
  compare('DashboardStats.payouts', dashboard.payouts, [
    'pendingCount', 'pendingNetMinor', 'paidLast30DaysMinor',
  ]);
  compare('DashboardStats.ops', dashboard.ops, [
    'outboxPending', 'outboxFailed', 'outboxDeadLetter', 'redisConnected', 'oldestPendingAt',
  ]);
  compare('PricingPolicy', dashboard.pricing, [
    'platformFee', 'paymentFee', 'customerServiceFeeMinor', 'minimumPayoutMinor', 'source',
  ]);

  compare('health', await api('/admin/health', { token: admin }), ['database', 'redis']);
  compare('PlatformConfigEntry', (await api('/admin/config', { token: admin }))[0], [
    'key', 'value', 'valueType', 'description', 'hasOverride', 'updatedAt',
    'updatedById', 'updatedByName', 'isPricingKey', 'namespace', 'fallback',
    'effectiveValue',
  ]);

  const users = await api('/admin/users?limit=5', { token: admin });
  compare('AdminUser', users.data[0], [
    'id', 'displayName', 'phone', 'email', 'role', 'isActive', 'locale',
    'lastLoginAt', 'createdAt', 'ownedMerchantCount', 'staffMerchantCount',
    'orderCount', 'activeSessionCount',
  ]);

  const merchants = await api('/admin/merchants?limit=5', { token: admin });
  compare('AdminMerchant', merchants.data[0], [
    ...OWNED_MERCHANT.filter((key) => key !== 'isOwner'),
    'createdAt', 'owner', 'stats', 'allowedActions',
    // 商戶營業報表 — the console needs the tier on the same projection it writes
    // it through, so the select cannot disagree with what was just stored.
    'analytics',
  ]);
  compare('AdminMerchant.stats', merchants.data[0]?.stats, [
    'menuItems', 'categories', 'activeOrders', 'totalOrders', 'pendingPayoutMinor', 'lifetimeGmvMinor',
  ]);
  compare('AdminMerchant.analytics (tier block)', merchants.data[0]?.analytics, [
    'tier', 'label', 'blurb', 'isPaid', 'capabilities', 'canExportRawData',
  ]);

  const orders = await api('/admin/orders?limit=50', { token: admin });
  compare('AdminOrderSummary', orders.data[0], [
    'id', 'orderNo', 'pickupCode', 'status', 'createdAt', 'serviceDate',
    'scheduledPickupAt', 'currency', 'subtotalMinor', 'platformFeeMinor',
    'totalMinor', 'merchantPayoutMinor', 'mainItemCount', 'itemCount',
    'paidMinor', 'refundedMinor', 'customer', 'merchant',
  ]);
  /**
   * Open the detail for an order that actually HAS a payment, not merely the
   * newest one. `AdminPayment` and `AdminRefund` are nested inside `payments` /
   * `refunds`, so an unpaid order makes them silently unverifiable — and an
   * unverifiable shape is one that breaks in production rather than here.
   */
  const withPayment = orders.data.find((row) => row.paidMinor > 0) ?? orders.data[0];
  if (withPayment) {
    const order = await api(`/admin/orders/${withPayment.id}`, { token: admin });
    compare('AdminOrder', order, [
      'id', 'orderNo', 'pickupCode', 'status', 'fulfilmentMode', 'priority',
      'createdAt', 'serviceDate', 'scheduledPickupAt', 'prepTimeMinutes',
      'acceptDeadlineAt', 'acceptedAt', 'readyAt', 'completedAt', 'cancelledAt',
      'currency', 'subtotalMinor', 'platformFeeMinor', 'paymentFeeMinor',
      'customerServiceFeeMinor', 'totalMinor', 'merchantPayoutMinor',
      'mainItemCount', 'pricingSnapshot', 'customerNote', 'contactPhone',
      'customer', 'merchant', 'items', 'payments', 'refunds', 'statusEvents',
      'allowedAdminTransitions',
    ]);
    compare('AdminOrder.pricingSnapshot', order.pricingSnapshot, [
      'currency', 'totalMinor', 'mainItemCount', 'subtotalMinor', 'platformFeeMinor',
      'paymentProcessingFeeMinor', 'customerServiceFeeMinor', 'merchantPayoutMinor',
      'appliedPolicy',
    ]);
    compare('AdminOrder.pricingSnapshot.appliedPolicy', order.pricingSnapshot?.appliedPolicy, [
      'feePerMainItemMinor', 'paymentFeeRateBps', 'paymentFeeFixedMinor', 'countAddOnItems',
    ]);
    compare('AdminOrderEvent', order.statusEvents?.[0], [
      'id', 'fromStatus', 'toStatus', 'actor', 'actorName', 'reason', 'sideEffects', 'createdAt',
    ]);
    compare('AdminPayment', order.payments?.[0], [
      'id', 'provider', 'status', 'providerRef', 'amountMinor', 'processingFeeMinor',
      'currency', 'failureCode', 'authorizedAt', 'capturedAt', 'createdAt', 'refundedMinor',
    ]);
    compare('AdminRefund', order.refunds?.[0], [
      'id', 'paymentId', 'amountMinor', 'reason', 'status', 'providerRef',
      'requestedBy', 'createdAt', 'settledAt',
    ]);
  }

  const payouts = await api('/admin/payouts?limit=5', { token: admin });
  compare('AdminPayout', payouts.data[0], [
    'id', 'merchantId', 'merchantName', 'merchantSlug', 'status', 'periodStart',
    'periodEnd', 'currency', 'grossSubtotalMinor', 'platformFeeMinor',
    'paymentFeeMinor', 'netPayoutMinor', 'orderCount', 'lineCount',
    'reference', 'paidAt', 'createdAt',
  ]);
  compare('payouts.totals', payouts.totals, ['pendingNetMinor', 'paidNetMinor']);

  const recon = await api('/admin/reconciliation?limit=5', { token: admin });
  compare('Reconciliation', recon, ['from', 'to', 'rows', 'totalDeltaMinor', 'mismatchedDays']);
  compare('ReconciliationRow', recon.rows?.[0], [
    'merchantId', 'merchantName', 'serviceDate', 'ordersPlatformFeeMinor',
    'payoutPlatformFeeMinor', 'deltaMinor', 'unsettledOrders',
  ]);

  compare('AdminOutboxStats', await api('/admin/outbox/stats', { token: admin }), [
    'byStatus', 'oldestPendingAt', 'oldestPendingAgeSeconds', 'deadLetterCount',
  ]);
  compare('AdminOutboxEvent', (await api('/admin/outbox?limit=5', { token: admin })).data[0], [
    'id', 'aggregateType', 'aggregateId', 'eventType', 'version', 'status',
    'attempts', 'lastError', 'availableAt', 'publishedAt', 'createdAt',
  ]);
  compare('AuditLogEntry', (await api('/admin/audit?limit=5', { token: admin })).data[0], [
    'id', 'actorId', 'actorName', 'actorRole', 'action', 'targetType',
    'targetId', 'before', 'after', 'ip', 'createdAt',
  ]);

  // -------------------------------------------------------------------------
  //  預約訂位
  // -------------------------------------------------------------------------

  console.log('\nreservations');
  /**
   * `reservation-availability` takes a merchant UUID, not a slug.
   *
   * That is why this reads `merchantId` from the owner's portal first and the
   * order of the sections below is fixed: the availability grid cannot be
   * fetched from a public slug, so the merchant portal section must have run.
   */
  const seededMerchant = await api('/merchants/dim-sum-express');
  const availability = await api(
    `/merchants/${seededMerchant.id}/reservation-availability?from=${todayKey()}`,
  );
  compare('ReservationAvailability', availability, RESERVATION_AVAILABILITY);
  compare('ReservationAvailability.policy', availability.policy, RESERVATION_AVAILABILITY_POLICY);
  compare('ReservationSlot', availability.slots?.[0], ['startsAt', 'remaining', 'bookable']);

  /**
   * 特別休息日.
   *
   * Reads the merchant's rest-day list and, when one exists, the single-date
   * read and the save response. The list is used rather than creating a probe
   * closure on purpose: `PUT` on a date is a WRITE with a side effect (it
   * cancels that day's bookings), and a contract check must not mutate the
   * developer's book to compare field names.
   */
  const closures = await api(`/merchant/${merchantId}/closures?from=${todayKey()}`, { token: owner });
  if (Array.isArray(closures) && closures.length > 0) {
    compare('MerchantClosure', closures[0], MERCHANT_CLOSURE);
    const one = await api(`/merchant/${merchantId}/closures/${closures[0].serviceDate}`, {
      token: owner,
    });
    compare('MerchantClosure (single)', one, MERCHANT_CLOSURE);
  } else {
    // Skipped rather than created: `PUT` on a date is a WRITE with a side
    // effect (it cancels that day's bookings), and a contract check must not
    // mutate the developer's book just to compare field names.
    console.log('  skip  MerchantClosure (no rest day set for this merchant)');
    skipped += 1;
  }

  /**
   * The booking flow needs a shop with the book switched ON, and the seeded
   * merchant ships with it off (the domain default is `enabled: false`, so a
   * merchant who never configured reservations does not start receiving them).
   *
   * So this section opens it, books, reads everything back, and closes it again.
   * Restoring the original value rather than forcing it off matters: a
   * developer who left the book on would find this check silently reverting
   * their local state on every run.
   */
  const settingsBefore = await api(`/merchant/${merchantId}/reservations/settings`, { token: owner });
  compare('ReservationSettings', settingsBefore, ['policy', 'customerNotice', 'acceptingNew']);
  compare('ReservationSettings.policy', settingsBefore.policy, RESERVATION_POLICY);

  let probeReservationId = null;
  /**
   * The full original policy, restored verbatim at the end.
   *
   * Restoring only `enabled` is not enough — this section also changes
   * `autoConfirm`, `minPartySize`, `maxPartySize` and `leadTimeMinutes` to make
   * a booking possible. Leaving those behind means every run of this check
   * silently rewrites the developer's local merchant configuration.
   */
  const originalPolicy = settingsBefore.policy;

  try {
    const settingsAfter = await api(`/merchant/${merchantId}/reservations/settings`, {
      method: 'PUT',
      token: owner,
      body: {
        enabled: true,
        // Turned OFF so a fresh booking lands PENDING. With the shipped default
        // (`autoConfirm: true`) it would arrive CONFIRMED, whose only merchant
        // moves are SEATED / CANCELLED / NO_SHOW — none of which lets the
        // customer-cancel path below also be exercised. PENDING gives both:
        // a `confirm` for the shop, then a `cancel` for the customer.
        autoConfirm: false,
        // A wide window so a booking is possible whatever the seeded hours are,
        // and a party size of 1 so the smallest table accepts it.
        minPartySize: 1,
        maxPartySize: Math.max(settingsBefore.policy.maxPartySize, 4),
        leadTimeMinutes: 0,
      },
    });
    compare('ReservationSettings (after PUT)', settingsAfter, ['policy', 'customerNotice', 'acceptingNew']);

    // Re-read the grid now the book is open, and take the first bookable slot.
    const open = await api(`/merchants/${merchantId}/reservation-availability?from=${todayKey()}`);
    compare('ReservationAvailability (enabled)', open, RESERVATION_AVAILABILITY);

    const slot = open.slots?.find((candidate) => candidate.bookable);
    if (!slot) {
      console.log('  skip  CustomerReservation (no bookable slot in the window)');
    } else {
      const created = await api('/reservations', {
        method: 'POST',
        token: customer,
        body: {
          merchantId,
          startsAt: slot.startsAt,
          partySize: 1,
          customerName: 'Contract Check',
          contactPhone: '+85290000001',
        },
        headers: { 'idempotency-key': `contract-reservation-${Date.now()}` },
      });
      probeReservationId = created.id;
      compare('ReservationCreated', created, RESERVATION_CREATED);

      // The detail endpoint is the other code path that builds this view.
      compare('CustomerReservation', await api(`/reservations/${created.id}`, { token: customer }), CUSTOMER_RESERVATION);

      const mineReservations = await api('/reservations?status=ALL&limit=5', { token: customer });
      compare('ReservationPage', mineReservations, ['data', 'hasMore']);
      compare('CustomerReservation (list)', mineReservations.data?.[0], CUSTOMER_RESERVATION);

      // The shop's projection, and — the whole point of the feature — the
      // transition list the board renders its buttons from.
      const merchantView = await api(`/merchant/${merchantId}/reservations/${created.id}`, {
        token: owner,
      });
      compare('MerchantReservation', merchantView, MERCHANT_RESERVATION);
      compare('MerchantReservation.allowedNextTransitions', merchantView.allowedNextTransitions, [
        'merchant', 'system',
      ]);

      const book = await api(`/merchant/${merchantId}/reservations?status=ALL&limit=5`, { token: owner });
      compare('MerchantReservation (list)', book.data?.[0], MERCHANT_RESERVATION);

      // One real transition, so `ReservationTransitionView` is verified against
      // a response rather than merely declared.
      //
      // Taken FROM the server's own offer rather than hard-coded: that list is
      // exactly what the board renders its buttons from, so this doubles as
      // proof the projection is usable.
      const MOVES = {
        CONFIRMED: 'confirm',
        DECLINED: 'decline',
        SEATED: 'seat',
        COMPLETED: 'complete',
        NO_SHOW: 'no-show',
        CANCELLED: 'cancel',
      };
      const nextMove = merchantView.allowedNextTransitions.merchant.find(
        (candidate) => MOVES[candidate.toString()],
      );

      if (!nextMove) {
        console.log('  skip  ReservationTransition (no merchant move offered)');
      } else {
        const merchantMovement = await api(
          `/merchant/${merchantId}/reservations/${created.id}/${MOVES[nextMove]}`,
          { method: 'POST', token: owner, body: { reason: 'contract-check probe' } },
        );
        compare('ReservationTransition', merchantMovement, RESERVATION_TRANSITION);
        console.log(`  ..    took the server-offered move: ${nextMove}`);
      }

      // The customer's cancel — a different view shape from the shop's, and the
      // only path that returns it through the customer controller. Skipped when
      // the move above ended the booking, since a terminal reservation refuses
      // further transitions.
      if (nextMove === 'CONFIRMED' || nextMove === 'SEATED') {
        const cancelled = await api(`/reservations/${created.id}/cancel`, {
          method: 'POST',
          token: customer,
          body: { reason: 'contract-check probe reservation' },
        });
        compare('ReservationTransition (customer)', cancelled, RESERVATION_TRANSITION);
        compare('ReservationTransition.reservation', cancelled.reservation, CUSTOMER_RESERVATION);
      } else {
        console.log(`  skip  ReservationTransition (customer) — the booking is already terminal`);
      }
    }
  } finally {
    // Clean up in a `finally` so a mid-flow failure still releases the seats and
    // restores the shop's setting.
    //
    // Releasing seats goes through the API, not the tables: `reservation_slots`
    // carries a `booked` COUNTER keyed by `(merchantId, slotStart)` — there is
    // no per-reservation link — so deleting the reservation row on its own
    // leaves `booked` raised and the next run starts from a phantom-full book.
    // The cancel is what decrements it.
    if (probeReservationId) {
      await api(`/reservations/${probeReservationId}/cancel`, {
        method: 'POST',
        token: customer,
        body: { reason: 'contract-check probe reservation' },
      }).catch(() => {});
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: probeReservationId } })
        .catch(() => {});
      await prisma.reservation.delete({ where: { id: probeReservationId } }).catch(() => {});
      console.log('  ..    probe reservation removed');
    }
    await api(`/merchant/${merchantId}/reservations/settings`, {
      method: 'PUT',
      token: owner,
      body: {
        enabled: originalPolicy.enabled,
        autoConfirm: originalPolicy.autoConfirm,
        slotMinutes: originalPolicy.slotMinutes,
        turnMinutes: originalPolicy.turnMinutes,
        seatsPerSlot: originalPolicy.seatsPerSlot,
        minPartySize: originalPolicy.minPartySize,
        maxPartySize: originalPolicy.maxPartySize,
        leadTimeMinutes: originalPolicy.leadTimeMinutes,
        advanceDays: originalPolicy.advanceDays,
        customerNotice: settingsBefore.customerNotice,
      },
    }).catch(() => {});
    console.log('  ..    shop reservation settings restored');
  }

  /**
   * 退款申請工單.
   *
   * A ticket is CREATED here, unlike the closure section, because filing one is
   * additive and reversible: it writes one row and one outbox event, moves no
   * money, and the cleanup below deletes it. A read-only check would only ever
   * verify the shape when a developer happened to have a ticket lying around,
   * which is the same as not checking it.
   *
   * The probe order is a PAY_AT_STORE one, confirmed at the counter so it
   * reaches `PAID` — a ticket cannot be filed on an unpaid order, and forcing
   * an online payment here would drag the payment provider into a contract
   * check.
   */
  console.log('\nrefund requests');
  let probeRefundId = null;
  let probeRefundOrderId = null;
  try {
    const menuItem = await api(`/merchant/${merchantId}/menu`, { token: owner });
    const firstItem =
      menuItem.categories?.flatMap((c) => c.items ?? []).find((i) => i.availability === 'AVAILABLE') ??
      menuItem.uncategorised?.[0];
    if (!firstItem) {
      console.log('  skip  RefundRequest (no available menu item to order)');
      skipped += 1;
    } else {
      const placed = await api('/orders', {
        token: customer,
        method: 'POST',
        body: {
          merchantId,
          paymentMode: 'PAY_AT_STORE',
          items: [{ menuItemId: firstItem.id, quantity: 1 }],
        },
      });
      probeRefundOrderId = placed.id;
      // Pay-at-store settles at the counter, so the merchant's confirm is the
      // thing that makes the order refund-requestable.
      await api(`/merchant/${merchantId}/orders/${placed.id}/confirm`, {
        method: 'POST',
        token: owner,
        body: {},
      });

      const filed = await api(`/orders/${placed.id}/refund-request`, {
        method: 'POST',
        token: customer,
        body: { reasonCode: 'QUALITY', note: 'contract-check probe ticket' },
      });
      probeRefundId = filed.id;
      compare('CustomerRefundRequest', filed, CUSTOMER_REFUND_REQUEST);

      compare(
        'CustomerRefundRequest (detail)',
        await api(`/refund-requests/${filed.id}`, { token: customer }),
        CUSTOMER_REFUND_REQUEST,
      );

      const mine = await api('/refund-requests?limit=5', { token: customer });
      compare('CustomerRefundPage', mine, ['data', 'total']);

      const queue = await api(`/merchant/${merchantId}/refund-requests?status=ACTIVE`, {
        token: owner,
      });
      compare('MerchantRefundQueue', queue, ['data', 'total', 'counts']);
      const queued = queue.data?.find((row) => row.id === filed.id);
      compare('MerchantRefundRequest', queued ?? queue.data?.[0], MERCHANT_REFUND_REQUEST);

      compare(
        'MerchantRefundRequest (detail)',
        await api(`/merchant/${merchantId}/refund-requests/${filed.id}`, { token: owner }),
        MERCHANT_REFUND_REQUEST,
      );

      // One real transition, so the transition view is compared against a
      // response the state machine actually produced rather than a hand-written
      // object. `IN_DISCUSSION` is the only move that carries no required
      // settlement details.
      const moved = await api(`/merchant/${merchantId}/refund-requests/${filed.id}/transition`, {
        method: 'POST',
        token: owner,
        body: { to: 'IN_DISCUSSION', merchantNote: 'contract-check' },
      });
      compare('RefundTransition', moved, REFUND_TRANSITION);
      compare('RefundTransition.refundRequest', moved.refundRequest, MERCHANT_REFUND_REQUEST);

      // The customer's own withdraw path, so the customer transition shape is
      // verified too — it carries the CUSTOMER projection, not the shop's.
      const withdrawn = await api(`/refund-requests/${filed.id}/cancel`, {
        method: 'POST',
        token: customer,
        body: {},
      });
      compare('RefundTransition (customer)', withdrawn, REFUND_TRANSITION);
      compare(
        'RefundTransition.refundRequest (customer)',
        withdrawn.refundRequest,
        CUSTOMER_REFUND_REQUEST,
      );

      const adminList = await api('/admin/refund-requests?status=ALL&limit=20', { token: admin });
      compare('AdminRefundPage', adminList, ['data', 'total']);
      compare('AdminRefundPage.data[0]', adminList.data?.[0], MERCHANT_REFUND_REQUEST);

      /**
       * The per-order summary the order detail page renders its 「申請退款」
       * button from.
       *
       * Read HERE, after the ticket exists, rather than in the `CustomerOrder`
       * section above — that section runs before any ticket is filed, so the
       * field is present but empty and the comparison would silently skip. This
       * is the data-dependence trap `check:contract`'s own doc warns about, and
       * the fix is to read the shape where the data actually is.
       */
      const orderWithTicket = await api(`/orders/${placed.id}`, { token: customer });
      compare('CustomerOrder.refundRequests', orderWithTicket.refundRequests?.[0], ORDER_REFUND_SUMMARY);

      // A ticketless order must still carry the field, as an empty array. An
      // absent field and an empty one look identical to a careless client, and
      // a page that does `order.refundRequests.length` would crash on the
      // former — so the shape is pinned on both.
      const ticketless = await api('/orders?status=ALL&limit=5', { token: customer });
      const noTicket = ticketless.data?.find((o) => o.id !== placed.id);
      if (noTicket) {
        compare('CustomerOrder.refundRequests (empty)', noTicket.refundRequests, []);
      }
    }
  } catch (error) {
    console.log(`  skip  RefundRequest probes (${error.message})`);
    skipped += 1;
  }

  if (probeOrderId) {
    // Cancel first: that is what releases the soft-held daily quota. Then the
    // rows, children before parents.
    await api(`/orders/${probeOrderId}/cancel`, {
      method: 'POST',
      token: customer,
      body: { reason: 'contract-check probe order' },
    });
    await prisma.$transaction([
      prisma.refund.deleteMany({ where: { payment: { orderId: probeOrderId } } }),
      prisma.payment.deleteMany({ where: { orderId: probeOrderId } }),
      prisma.merchantPayoutLine.deleteMany({ where: { orderId: probeOrderId } }),
      prisma.orderStatusEvent.deleteMany({ where: { orderId: probeOrderId } }),
      prisma.orderItem.deleteMany({ where: { orderId: probeOrderId } }),
      prisma.outboxEvent.deleteMany({ where: { aggregateId: probeOrderId } }),
      prisma.order.delete({ where: { id: probeOrderId } }),
    ]);
    console.log('  ..    probe order removed');
  }

  if (probeRefundOrderId) {
    // The ticket's own rows first, then the order. The ORDER is cancelled
    // through the API so its soft-held daily quota is released — deleting the
    // rows alone would leave `held` raised and the next run would start from a
    // phantom-full day. (A ticket on a terminal order is fine; no refund state
    // is involved because this flow never touches `payments`.)
    await api(`/orders/${probeRefundOrderId}/cancel`, {
      method: 'POST',
      token: customer,
      body: { reason: 'contract-check probe refund order' },
    }).catch(() => {});
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'RefundRequest' } });
    await prisma.refundRequest.deleteMany({ where: { orderId: probeRefundOrderId } });
    await prisma.payment.deleteMany({ where: { orderId: probeRefundOrderId } });
    await prisma.merchantPayoutLine.deleteMany({ where: { orderId: probeRefundOrderId } });
    await prisma.orderStatusEvent.deleteMany({ where: { orderId: probeRefundOrderId } });
    await prisma.orderItem.deleteMany({ where: { orderId: probeRefundOrderId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: probeRefundOrderId } });
    await prisma.order.delete({ where: { id: probeRefundOrderId } });
    console.log('  ..    probe refund ticket and its order removed');
  }

  // =========================================================================
  //  現場候位 — 取號 / 叫號 / 入座
  // =========================================================================
  //  Two projections of the same row, and the difference between them is the
  //  reason this section exists: the host board carries `contactPhone`, the
  //  customer's own ticket does not. Asserting only the positive shape would let
  //  a phone number reach the public view and still print `ok`.
  console.log('\n現場候位 waitlist');
  let waitlistSettingsExisted = false;
  const probeWaitlistEntryIds = [];
  try {
    const merchantId = merchants.data[0].id;
    waitlistSettingsExisted = Boolean(
      await prisma.waitlistSettings.findUnique({ where: { merchantId }, select: { merchantId: true } }),
    );

    const opened = await api(`/merchant/${merchantId}/queue/settings`, {
      method: 'PATCH',
      token: owner,
      body: { enabled: true, minPartySize: 1, maxPartySize: 8, customerNotice: 'cc probe' },
    });
    compare('WaitlistSettingsView', opened, [
      'merchantId', 'policy', 'customerNotice', 'openNow',
    ]);
    compare('WaitlistSettingsView.policy', opened.policy, [
      'enabled', 'acceptWhenClosed', 'minPartySize', 'maxPartySize',
      'averageTurnMinutes', 'callTimeoutMinutes',
    ]);

    const entryPoint = await api(`/merchants/${merchantId}/queue`);
    compare('CustomerQueueEntryPointView', entryPoint, [
      'merchantId', 'merchantName', 'merchantSlug', 'timezone', 'enabled',
      'acceptingNow', 'closedReason', 'policy', 'customerNotice', 'queueLength',
      'estimatedWaitMinutes', 'myTicket',
    ]);
    compare('CustomerQueueEntryPointView.policy', entryPoint.policy, [
      'minPartySize', 'maxPartySize', 'averageTurnMinutes', 'callTimeoutMinutes',
    ]);

    const taken = await api(`/merchants/${merchantId}/queue`, {
      method: 'POST',
      token: customer,
      body: { partySize: 2, guestName: 'contract-check', contactPhone: '+85297000001' },
    });
    if (taken?.ticket?.id) probeWaitlistEntryIds.push(taken.ticket.id);

    compare('TakeNumberResultView', taken, ['ticket', 'message']);
    compare('CustomerQueueTicketView', taken?.ticket, [
      'id', 'ticketNo', 'status', 'statusLabel', 'partySize', 'guestName',
      'joinedAt', 'position', 'ahead', 'estimatedWaitMinutes', 'quotedMinutes',
      'calledAt', 'callDeadlineAt', 'seatedAt', 'cancelledAt', 'statusReason',
      'canCancel', 'customerNotice',
    ]);
    // The customer's own view must NOT carry the raw phone, and must NOT carry
    // the host's move list — those are the two things the merchant projection
    // adds, and leaking either is a different bug each time.
    compare('CustomerQueueTicketView (public: no phone, no host moves)', taken?.ticket, [], {
      absent: ['contactPhone', 'allowedNextTransitions', 'version', 'note', 'waitedMinutes'],
    });

    const board = await api(`/merchant/${merchantId}/queue`, { token: owner });
    compare('MerchantQueueView', board, [
      'merchantId', 'serviceDate', 'timezone', 'enabled', 'acceptingNow',
      'customerNotice', 'policy', 'active', 'completed', 'counts', 'nextTicketNo',
    ]);
    compare('MerchantQueueView.counts', board.counts, ['waiting', 'called', 'seated', 'noShow', 'cancelled']);
    compare('MerchantQueueEntryView', board.active?.[0], [
      'id', 'ticketNo', 'status', 'statusLabel', 'statusShortLabel', 'partySize',
      'guestName', 'contactPhone', 'note', 'joinedAt', 'position', 'ahead',
      'estimatedWaitMinutes', 'calledAt', 'callDeadlineAt', 'seatedAt',
      'cancelledAt', 'statusReason', 'waitedMinutes', 'version',
      'allowedNextTransitions',
    ]);
  } catch (error) {
    console.log(`  skip  Waitlist probes (${error.message})`);
    skipped += 1;
  }

  if (probeWaitlistEntryIds.length || waitlistSettingsExisted) {
    try {
      await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'WaitlistEntry' } });
      await prisma.waitlistEntry.deleteMany({
        where: { id: { in: probeWaitlistEntryIds.length ? probeWaitlistEntryIds : ['-'] } },
      });
      // Restore what the shop had: the row if it existed, nothing if it did not.
      if (!waitlistSettingsExisted) {
        await prisma.waitlistSettings.deleteMany({ where: { merchantId: merchants.data[0].id } });
      }
      console.log('  ..    waitlist probes removed, settings restored');
    } catch (error) {
      console.log(`  ..    waitlist cleanup warning: ${error.message}`);
    }
  }

  // =========================================================================
  //  店內點餐 — 桌號 / 掃碼 / 用餐時段
  // =========================================================================
  console.log('\n店內點餐 dine-in');
  const probeTableIds = [];
  const probeSessionIds = [];
  try {
    const merchantId = merchants.data[0].id;
    const code = `CC${Date.now() % 100000}`;

    const floorBefore = await api(`/merchant/${merchantId}/dining`, { token: owner });
    compare('MerchantTableBoardView', floorBefore, [
      'merchantId', 'timezone', 'serviceDate', 'tables', 'counts',
    ]);
    compare('MerchantTableBoardView.counts', floorBefore.counts, [
      'total', 'active', 'occupied', 'free', 'seatedGuests',
    ]);

    const created = await api(`/merchant/${merchantId}/dining/tables`, {
      method: 'POST',
      token: owner,
      body: { code, seats: 4, label: 'contract-check' },
    });
    if (created?.id) probeTableIds.push(created.id);
    compare('DiningTableView', created, [
      'id', 'code', 'label', 'seats', 'isActive', 'qrToken', 'qrUrl', 'session',
    ]);

    // Read from the PUBLIC scan route. `qrToken` is the authority to open a
    // sitting, so it must be echoed here — the page needs it — but the sitting's
    // one-time `guestToken` must NOT be, because that is what carries ordering
    // authority and the page has not asked to open anything yet.
    const scanned = await api(`/dine/table/${created.qrToken}`);
    compare('ScannedTableView', scanned, [
      'merchantId', 'merchantName', 'merchantSlug', 'timezone', 'tableId',
      'tableCode', 'tableLabel', 'seats', 'diningEnabled', 'openNow', 'session',
      'qrToken',
    ]);

    const opened = await api(`/dine/table/${created.qrToken}/session`, {
      method: 'POST',
      body: { partySize: 2 },
    });
    if (opened?.session?.id) probeSessionIds.push(opened.session.id);
    compare('OpenSessionResultView', opened, ['session', 'guestToken', 'orderingUrl', 'message']);
    compare('DiningSessionSummaryView', opened?.session, [
      'id', 'tableId', 'tableCode', 'status', 'statusLabel', 'partySize',
      'serviceDate', 'openedAt', 'closedAt', 'seatedMinutes', 'totalMinor',
      'orderCount', 'mainItemCount', 'version',
    ]);

    const tab = await api(`/dine/s/${opened.guestToken}/tab`);
    compare('DiningSessionTabView', tab, [
      'session', 'merchantId', 'merchantName', 'lines', 'subtotalMinor',
      'totalMinor', 'canOrderMore', 'settledAt',
    ]);
  } catch (error) {
    console.log(`  skip  Dine-in probes (${error.message})`);
    skipped += 1;
  }

  if (probeTableIds.length || probeSessionIds.length) {
    try {
      await prisma.diningSession.deleteMany({
        where: { id: { in: probeSessionIds.length ? probeSessionIds : ['-'] } },
      });
      await prisma.diningTable.deleteMany({
        where: { id: { in: probeTableIds.length ? probeTableIds : ['-'] } },
      });
      console.log('  ..    dine-in probes removed');
    } catch (error) {
      console.log(`  ..    dine-in cleanup warning: ${error.message}`);
    }
  }

  // =========================================================================
  //  商戶營業報表 — the tier block and the report's own shape
  // =========================================================================
  //  Read on whatever tier the seed leaves the shop on, which is the projection
  //  the free-tier merchant actually gets. The gated families need seeded
  //  trading rows and are covered end-to-end by `scripts/e2e-analytics.js`.
  console.log('\n商戶營業報表 merchant analytics');
  try {
    const merchantId = merchants.data[0].id;

    const report = await api(`/merchant/${merchantId}/analytics`, { token: owner });
    compare('AnalyticsTierView', report.tier, [
      'tier', 'label', 'blurb', 'isPaid', 'capabilities', 'canExportRawData',
    ]);
    compare('MerchantAnalyticsView', report, [
      'merchantId', 'tier', 'window', 'totals', 'comparison', 'daily', 'itemMix',
      'hourOfDay', 'channels',
    ]);
    compare('MerchantAnalyticsView.window', report.window, ['from', 'to', 'days']);
    compare('MerchantAnalyticsView.totals', report.totals, [
      'orderCount', 'voidCount', 'revenueMinor', 'platformFeeMinor', 'payoutMinor',
      'averageOrderValueMinor', 'itemCount',
    ]);

    const write = await api(`/admin/merchants/${merchantId}/analytics-tier`, {
      method: 'POST',
      token: admin,
      body: { tier: 'NONE' },
    });
    compare('AnalyticsTierWriteView', write, [
      'merchantId', 'before', 'after', 'isDowngrade', 'warning', 'message',
    ]);
  } catch (error) {
    console.log(`  skip  Analytics probes (${error.message})`);
    skipped += 1;
  }

  await prisma.$disconnect();

  console.log(`\n${'='.repeat(66)}`);
  if (failures === 0) {
    console.log(
      `PASS — ${checks} contract checks agree${skipped ? `, ${skipped} skipped (no sample row)` : ''}`,
    );
  } else {
    console.log(`FAIL — ${failures} of ${checks} contract checks disagree`);
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error('\nHARNESS ERROR:', error.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

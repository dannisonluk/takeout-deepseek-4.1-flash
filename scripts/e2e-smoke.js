#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end smoke test
// ============================================================================
//  Drives a RUNNING API through a full self-pickup order lifecycle and checks
//  the database after every step. It is the only test that exercises the real
//  HTTP layer, the real DI graph, the real SQL and the real state machine
//  together — the 61 domain unit tests cover the rules, this covers the wiring.
//
//  Usage
//  -----
//    1. start the API:   node apps/api/dist/main.js
//    2. run:             node scripts/e2e-smoke.js
//
//  Assumes `prisma/seed.js` has been run. Exits non-zero on any failure.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const MERCHANT_SLUG = 'dim-sum-express';

// ---- env ------------------------------------------------------------------
// Parsed rather than loaded through a library so the script cannot accidentally
// pick up a different shell environment than the one the API was started with.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const env = loadEnv();
const JWT_SECRET = env.JWT_SECRET;
const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

const prisma = new PrismaClient();

// ---- tokens ---------------------------------------------------------------
const b64url = (input) => Buffer.from(input).toString('base64url');

function mintToken({ sub, role, merchantIds }) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub,
      role,
      ...(merchantIds ? { merchantIds } : {}),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Stripe's webhook scheme: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`.
 * Implemented here rather than via the SDK so the script proves the signature
 * contract the provider actually validates against.
 */
function stripeSignature(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

// ---- http -----------------------------------------------------------------
async function api(method, pathname, options = {}) {
  const { token, body, headers = {} } = options;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ---- tiny harness ---------------------------------------------------------
// `check` accepts sync and async callbacks. Async ones are collected and awaited
// before the summary, so a rejected promise can never be silently dropped.
//
// The catch: an async callback does NOT run at the point it is declared — it
// runs at the very end. So it must only assert things that are still true then.
// For a point-in-time fact (an event count that keeps growing, a status that
// keeps advancing), `await` the read inline and assert it in a SYNC callback.
let passed = 0;
const failures = [];
const pending = [];

function record(name, error) {
  if (error) {
    failures.push({ name, message: error.message });
    console.log(`  \u2717 ${name}\n      ${error.message}`);
  } else {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  }
}

function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (error) {
    record(name, error);
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => record(name), (error) => record(name, error)));
  } else {
    record(name, null);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** BigInt-safe JSON, for assertion messages that stringify raw SQL results. */
const fmt = (value) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v));

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET || !STRIPE_WEBHOOK_SECRET) {
    throw new Error('JWT_SECRET and STRIPE_WEBHOOK_SECRET must be set in .env');
  }

  // Fresh slate, so every assertion below can be exact ("== 1") instead of
  // defensive ("at least 1"). Only per-run artefacts are cleared — the seeded
  // merchant, menu, hours and users are left alone.
  //
  // `$executeRawUnsafe` with a constant string, no interpolation: TRUNCATE
  // cannot take bind parameters for table names.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE refunds, payments, merchant_payout_lines, merchant_payouts,
                   order_status_events, order_items, orders,
                   menu_item_daily_stock, outbox_events
    CASCADE
  `);

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, ownerId: true, timezone: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

  const items = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id },
    select: { id: true, name: true, priceMinor: true, isMainItem: true },
  });
  const byName = new Map(items.map((item) => [item.name, item]));
  const harGow = byName.get('晶瑩蝦餃');
  const siuMai = byName.get('蟹籽燒賣');
  const lemonTea = byName.get('凍檸茶');
  assert.ok(harGow && siuMai && lemonTea, 'seeded menu items missing');

  const owner = await prisma.user.findUnique({
    where: { phone: '+85290000002' },
    select: { id: true },
  });
  const customer = await prisma.user.findUnique({
    where: { phone: '+85290000001' },
    select: { id: true },
  });
  assert.ok(owner && customer, 'seeded users missing');

  const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
  const ownerToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });

  // =========================================================================
  section('1. Boot + auth');
  // =========================================================================
  // `/health` is excluded from the global `/v1` prefix in main.ts, so it is the
  // one route that must be addressed without it.
  const healthResponse = await fetch(`${BASE.replace(/\/v1$/, '')}/health`);
  const health = { status: healthResponse.status, body: await healthResponse.json() };
  check('GET /health -> 200 ok', () => {
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
  });

  const noAuth = await api('GET', '/orders');
  check('GET /orders without a token -> 401', () => {
    assert.equal(noAuth.status, 401);
  });

  const forged = await api('GET', '/orders', { token: 'aaa.bbb.ccc' });
  check('GET /orders with a malformed token -> 401', () => {
    assert.equal(forged.status, 401);
  });

  const crossMerchant = await api('GET', `/merchant/${merchant.id}/orders`, {
    token: customerToken,
  });
  check('customer hitting the kitchen board -> 403', () => {
    assert.equal(crossMerchant.status, 403);
  });

  // =========================================================================
  section('2. Place an order (即時製作)');
  // =========================================================================
  const placed = await api('POST', '/orders', {
    token: customerToken,
    body: {
      merchantId: merchant.id,
      items: [
        { menuItemId: harGow.id, quantity: 2 },
        { menuItemId: siuMai.id, quantity: 1 },
        { menuItemId: lemonTea.id, quantity: 1 },
      ],
      customerNote: '少甜，唔要蔥',
      contactPhone: '+85290000001',
    },
  });

  check('POST /orders -> 201', () => {
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
  });
  if (placed.status !== 201) {
    throw new Error(`cannot continue without an order: ${JSON.stringify(placed.body)}`);
  }

  const order = placed.body;
  const pricing = order.pricing;

  // 2x HK$48.00 (main) + 1x HK$38.00 (main) + 1x HK$18.00 (drink)
  //   subtotal      = 9600 + 3800 + 1800          = 15200
  //   mainItemCount = 3
  //   platformFee   = 3 x 350                     = 1050
  //   paymentFee    = round(15200 x 3.40%) + 235  = 517 + 235 = 752
  //   total         = 15200 + 0 (no service fee)  = 15200
  //   payout        = 15200 - 1050 - 752          = 13398
  check('platformFee = mainItemCount x HK$3.50', () => {
    assert.equal(pricing.mainItemCount, 3);
    assert.equal(pricing.platformFeeMinor, 1050);
    assert.equal(pricing.platformFeeMinor, pricing.mainItemCount * 350);
  });
  check('subtotal includes add-on items, which do not incur the fee', () => {
    assert.equal(pricing.subtotalMinor, 15200);
  });
  check('paymentProcessingFee = 3.40% + HK$2.35', () => {
    assert.equal(pricing.paymentProcessingFeeMinor, 752);
  });
  check('total = subtotal + customer service fee (MVP 0)', () => {
    assert.equal(pricing.customerServiceFeeMinor, 0);
    assert.equal(pricing.totalMinor, 15200);
  });
  check('merchantPayout = subtotal - platformFee - paymentFee', () => {
    assert.equal(pricing.merchantPayoutMinor, 13398);
    assert.equal(
      pricing.merchantPayoutMinor,
      pricing.subtotalMinor - pricing.platformFeeMinor - pricing.paymentProcessingFeeMinor,
    );
  });
  check('pickupCode and orderNo issued', () => {
    assert.match(order.pickupCode, /^[A-Z]-\d{2}$/);
    assert.match(order.orderNo, /^\d{8}-\d{6}$/);
  });
  check('immediate order has no scheduledPickupAt', () => {
    assert.equal(order.scheduledPickupAt, null);
  });

  const orderId = order.id;

  // ---- database state ------------------------------------------------------
  const dbOrder = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      subtotalMinor: true,
      platformFeeMinor: true,
      paymentFeeMinor: true,
      totalMinor: true,
      merchantPayoutMinor: true,
      mainItemCount: true,
      pricingSnapshot: true,
    },
  });

  check('order row persisted with the same money', () => {
    assert.equal(dbOrder.status, 'PENDING_PAYMENT');
    assert.equal(dbOrder.platformFeeMinor, 1050);
    assert.equal(dbOrder.totalMinor, 15200);
    assert.equal(dbOrder.merchantPayoutMinor, 13398);
  });
  check('pricingSnapshot frozen onto the row', () => {
    assert.equal(dbOrder.pricingSnapshot.platformFeeMinor, 1050);
    assert.equal(dbOrder.pricingSnapshot.merchantPayoutMinor, 13398);
  });
  check('3 order_items, isMainItem snapshotted', async () => {
    const rows = await prisma.orderItem.findMany({
      where: { orderId },
      select: { isMainItem: true, quantity: true },
    });
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.isMainItem).length, 2);
  });
  // Snapshot NOW, assert later. `check` defers its callback to the end of
  // the run, by which point this order is COMPLETED and the units have moved
  // from `held` to `sold` — so a deferred read would be asserting the
  // wrong moment. Same reasoning as `placedEvents` below.
  const stockAfterPlacement = await prisma.menuItemDailyStock.findMany({
    where: { merchantId: merchant.id },
    select: { menuItemId: true, held: true, sold: true },
  });
  check('daily quota soft-held, nothing sold yet', () => {
    const heldFor = (id) => stockAfterPlacement.find((row) => row.menuItemId === id)?.held ?? 0;
    assert.equal(heldFor(harGow.id), 2);
    assert.equal(heldFor(siuMai.id), 1);
    assert.equal(heldFor(lemonTea.id), 1);
    assert.ok(stockAfterPlacement.every((row) => row.sold === 0));
  });
  // Read HERE, not inside the check. `check` defers async callbacks until the
  // end of the run, and by then this order has six lifecycle events rather than
  // one — so an assertion about "how many events exist right now" has to
  // capture that state at the moment it is true. Anything that is true forever
  // (row counts, held quantities) can stay inside the callback.
  const placedEvents = await prisma.outboxEvent.findMany({
    where: { aggregateId: orderId },
    orderBy: { version: 'asc' },
  });
  check('one order.placed outbox event, version 1', () => {
    assert.equal(placedEvents.length, 1);
    assert.equal(placedEvents[0].eventType, 'order.placed');
    assert.equal(placedEvents[0].version, 1);
    assert.equal(placedEvents[0].status, 'PENDING');
  });

  // =========================================================================
  section('3. Scheduled-pickup validation (指定時間預訂取餐)');
  // =========================================================================
  const tooSoon = await api('POST', '/orders', {
    token: customerToken,
    body: {
      merchantId: merchant.id,
      items: [{ menuItemId: harGow.id, quantity: 1 }],
      scheduledPickupAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  check('pickup time inside the prep window -> 422', () => {
    assert.equal(tooSoon.status, 422, JSON.stringify(tooSoon.body));
  });

  const tooFar = await api('POST', '/orders', {
    token: customerToken,
    body: {
      merchantId: merchant.id,
      items: [{ menuItemId: harGow.id, quantity: 1 }],
      scheduledPickupAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    },
  });
  check('pickup time beyond 24h -> 422', () => {
    assert.equal(tooFar.status, 422, JSON.stringify(tooFar.body));
  });

  // =========================================================================
  section('4. State machine rejects illegal transitions');
  // =========================================================================
  const illegal = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/start-preparing`, {
    token: ownerToken,
  });
  check('PENDING_PAYMENT -> PREPARING -> 409 ILLEGAL_ORDER_TRANSITION', () => {
    assert.equal(illegal.status, 409, JSON.stringify(illegal.body));
    assert.equal(illegal.body.error.code, 'ILLEGAL_ORDER_TRANSITION');
  });

  // =========================================================================
  section('5. Payment intent + signed webhook -> PAID');
  // =========================================================================
  // The intent is opened through the real endpoint rather than by hand-writing
  // a `payments` row, so this also covers the checkout path a customer app
  // actually takes. With PAYMENT_LIVE_MODE=false no PSP is contacted and the
  // provider ref is a simulated one — which the webhook below still has to
  // match, so the lookup and the signature check are both genuinely exercised.
  const intent = await api('POST', `/orders/${orderId}/payment-intent`, {
    token: customerToken,
    body: {},
  });
  check('POST /orders/:id/payment-intent -> 200 with a provider ref', () => {
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    assert.ok(intent.body.providerRef, 'no providerRef');
    assert.equal(intent.body.amountMinor, 15200);
    assert.equal(intent.body.currency, 'HKD');
  });
  check('a non-live run says so instead of pretending the money moved', () => {
    assert.ok(
      intent.body.notice,
      'PAYMENT_LIVE_MODE=false must set a notice, or a client renders this as paid',
    );
  });

  const providerRef = intent.body.providerRef;

  const intentAgain = await api('POST', `/orders/${orderId}/payment-intent`, {
    token: customerToken,
    body: {},
  });
  check('calling it again returns the SAME intent (a reload cannot double-charge)', () => {
    assert.equal(intentAgain.status, 200, JSON.stringify(intentAgain.body));
    assert.equal(intentAgain.body.providerRef, providerRef);
  });

  const paymentRows = await prisma.payment.count({ where: { orderId } });
  check('exactly one payment row for the order', () => {
    assert.equal(paymentRows, 1);
  });

  const foreignIntent = await api('POST', `/orders/${orderId}/payment-intent`, {
    token: ownerToken,
    body: {},
  });
  check('another user asking for my order\'s intent -> 404, not a leak', () => {
    assert.equal(foreignIntent.status, 404, JSON.stringify(foreignIntent.body));
  });

  const event = {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: {
      object: { id: providerRef, object: 'payment_intent', amount: 15200, currency: 'hkd' },
    },
  };
  // The signature is computed over exactly the bytes `fetch` will send, so the
  // provider's raw-body check has something byte-identical to verify.
  const rawBody = JSON.stringify(event);

  const webhook = await api('POST', '/webhooks/payments/stripe', {
    body: event,
    headers: { 'stripe-signature': stripeSignature(rawBody, STRIPE_WEBHOOK_SECRET) },
  });

  check('signed webhook accepted -> handled', () => {
    assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
    assert.equal(webhook.body.handled, true, JSON.stringify(webhook.body));
  });

  const afterPaid = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, acceptDeadlineAt: true },
  });
  check('order advanced to PAID', () => {
    assert.equal(afterPaid.status, 'PAID');
  });
  check('accept-deadline timer scheduled as a side effect', () => {
    assert.ok(afterPaid.acceptDeadlineAt, 'acceptDeadlineAt should be set');
  });
  check('payment row marked CAPTURED', async () => {
    const payment = await prisma.payment.findFirst({ where: { providerRef } });
    assert.ok(payment, 'payment row missing');
    assert.equal(payment.status, 'CAPTURED');
  });

  const intentAfterPaid = await api('POST', `/orders/${orderId}/payment-intent`, {
    token: customerToken,
    body: {},
  });
  check('asking for an intent on a paid order -> 409 PAYMENT_NOT_REQUIRED', () => {
    assert.equal(intentAfterPaid.status, 409, JSON.stringify(intentAfterPaid.body));
    assert.equal(intentAfterPaid.body.error.code, 'PAYMENT_NOT_REQUIRED');
  });

  const replay = await api('POST', '/webhooks/payments/stripe', {
    body: event,
    headers: { 'stripe-signature': stripeSignature(rawBody, STRIPE_WEBHOOK_SECRET) },
  });
  check('replayed webhook is idempotent — duplicate, no double transition', () => {
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true, JSON.stringify(replay.body));
  });

  const afterReplay = await prisma.orderStatusEvent.count({ where: { orderId } });
  check('replay added no status event', () => {
    assert.equal(afterReplay, 2);
  });

  // =========================================================================
  section('6. Kitchen lifecycle 已接單 -> 製作中 -> 可取餐 -> 已完成');
  // =========================================================================
  const accept = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/accept`, {
    token: ownerToken,
  });
  check('accept -> 200 ACCEPTED', () => {
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    assert.equal(accept.body.toStatus, 'ACCEPTED');
  });
  check('allowedNextTransitions drives the merchant UI', () => {
    assert.deepEqual([...accept.body.allowedNextTransitions].sort(), ['CANCELLED', 'PREPARING']);
  });

  const preparing = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/start-preparing`, {
    token: ownerToken,
  });
  check('start-preparing -> PREPARING', () => {
    assert.equal(preparing.status, 200, JSON.stringify(preparing.body));
    assert.equal(preparing.body.toStatus, 'PREPARING');
  });

  const ready = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/mark-ready`, {
    token: ownerToken,
  });
  check('mark-ready -> READY_FOR_PICKUP', () => {
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.toStatus, 'READY_FOR_PICKUP');
    assert.ok(ready.body.sideEffects.includes('START_PICKUP_WINDOW_TIMER'));
  });

  const complete = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/complete`, {
    token: ownerToken,
  });
  check('complete -> COMPLETED', () => {
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.toStatus, 'COMPLETED');
  });
  check('RECORD_PAYOUT_LEDGER fired on completion', () => {
    assert.ok(complete.body.sideEffects.includes('RECORD_PAYOUT_LEDGER'));
  });

  const terminal = await api('POST', `/merchant/${merchant.id}/orders/${orderId}/accept`, {
    token: ownerToken,
  });
  check('transition out of a terminal state -> 409', () => {
    assert.equal(terminal.status, 409, JSON.stringify(terminal.body));
  });

  // =========================================================================
  section('7. Audit trail, outbox and settlement');
  // =========================================================================
  const statusEvents = await prisma.orderStatusEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { toStatus: true },
  });

  check('one status event per accepted transition (6 total)', () => {
    assert.equal(statusEvents.length, 6, JSON.stringify(statusEvents.map((e) => e.toStatus)));
  });
  check('audit trail reads as the expected lifecycle', () => {
    assert.deepEqual(
      statusEvents.map((e) => e.toStatus),
      ['PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED'],
    );
  });

  const outbox = await prisma.outboxEvent.findMany({
    where: { aggregateId: orderId },
    orderBy: { version: 'asc' },
    select: { eventType: true, version: true },
  });

  check('outbox holds one event per transition, versions 1..6', () => {
    assert.equal(outbox.length, 6, JSON.stringify(outbox));
    assert.deepEqual(
      outbox.map((row) => row.version),
      [1, 2, 3, 4, 5, 6],
    );
  });
  check('outbox event types match the lifecycle', () => {
    assert.deepEqual(
      outbox.map((row) => row.eventType),
      [
        'order.placed',
        'order.paid',
        'order.accepted',
        'order.preparing',
        'order.ready_for_pickup',
        'order.completed',
      ],
    );
  });
  check('outbox length == audit length (written in the same transaction)', () => {
    assert.equal(outbox.length, statusEvents.length);
  });

  const payoutLine = await prisma.merchantPayoutLine.findFirst({
    where: { orderId },
    include: { payout: true },
  });
  check('payout ledger line written for the completed order', () => {
    assert.ok(payoutLine, 'no merchant_payout_lines row');
    assert.equal(payoutLine.platformFeeMinor, 1050);
    assert.equal(payoutLine.paymentFeeMinor, 752);
    assert.equal(payoutLine.merchantPayoutMinor, 13398);
  });
  check('payout batch aggregates the order', () => {
    assert.equal(payoutLine.payout.orderCount, 1);
    assert.equal(payoutLine.payout.status, 'PENDING');
    assert.equal(Number(payoutLine.payout.netPayoutMinor), 13398);
  });

  const reconciliation = await prisma.$queryRaw`
    SELECT orders_platform_fee, payout_platform_fee, delta, unsettled_orders
      FROM v_daily_platform_fee_reconciliation
     WHERE "merchantId" = ${merchant.id}::uuid
  `;
  check('reconciliation view: order fee == payout fee, nothing unsettled', () => {
    // `SUM`/`COUNT` come back as BigInt, which `JSON.stringify` cannot serialise.
    const row = reconciliation.find((r) => Number(r.unsettled_orders) === 0);
    assert.ok(row, `no fully-settled row: ${fmt(reconciliation)}`);
    assert.equal(Number(row.delta), 0);
    assert.equal(Number(row.orders_platform_fee), Number(row.payout_platform_fee));
  });

  // Read here, assert later — the same deferred-callback trap as above.
  const stockAfterCompletion = await prisma.menuItemDailyStock.findMany({
    where: { merchantId: merchant.id },
    select: { menuItemId: true, held: true, sold: true },
  });
  check('completion converts held -> sold (the units are gone, not sellable again)', () => {
    const heldFor = (id) => stockAfterCompletion.find((row) => row.menuItemId === id)?.held ?? 0;
    const soldFor = (id) => stockAfterCompletion.find((row) => row.menuItemId === id)?.sold ?? 0;
    // This used to assert the units stayed in `held` forever, with a comment
    // explaining that `sold` was never credited. CONVERT_HOLD_TO_SOLD fixed
    // that, so the assertion is inverted on purpose: the regression to guard
    // against is now the OLD behaviour, not the new one.
    assert.equal(heldFor(harGow.id), 0);
    assert.equal(soldFor(harGow.id), 2);
    assert.equal(heldFor(siuMai.id), 0);
    assert.equal(soldFor(siuMai.id), 1);
    assert.equal(heldFor(lemonTea.id), 0);
    assert.equal(soldFor(lemonTea.id), 1);
  });

  await Promise.all(pending);
}

main()
  .then(() => {
    console.log(`\n${'='.repeat(66)}`);
    if (failures.length === 0) {
      console.log(`PASS — ${passed} checks`);
    } else {
      console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
      for (const failure of failures) console.log(`  \u2717 ${failure.name}: ${failure.message}`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(`\nFATAL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

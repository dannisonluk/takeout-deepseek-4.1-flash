#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 外賣自取：到店付款 → 店家確認收款 → 預計取餐時間
// ============================================================================
//  Covers the one flow that spans three contexts and therefore cannot be proven
//  by unit tests alone:
//
//    customer chooses 到店付款  ->  order waits in PENDING_PAYMENT
//    merchant confirms receipt  ->  a MANUAL payment row is written and the
//                                   order advances to PAID -> ACCEPTED
//    customer reopens the order ->  sees the promised pickup time and notice
//
//  It also pins the three refusals that make the feature safe:
//
//    - `POST /orders/:id/payment-intent` on a pay-at-store order -> 409
//      PAYMENT_NOT_REQUIRED. Without this the customer would be sent into a
//      card flow for money the shop is about to take in cash.
//    - `POST /merchant/:mid/orders/:id/confirm` on an ONLINE order -> 409
//      MANUAL_SETTLEMENT_NOT_ALLOWED. This is what stops 確認訂單 becoming a
//      universal "mark anything paid" button.
//    - `POST /merchant/:mid/orders/:id/cancel` on an ONLINE order -> 409, for
//      the same reason: the customer may be midway through 3-D Secure.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-pay-at-store.js
//
//  Shares the database with `e2e-smoke.js` and `e2e-admin.js`, and like them it
//  TRUNCATEs the per-run tables — so the three MUST NOT be run concurrently.
//  It cleans up after itself and exits non-zero on any failure.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const MERCHANT_SLUG = 'dim-sum-express';

const CUSTOMER_PHONE = '+85290000001';
const OWNER_PHONE = '+85290000002';

/** The promise the test asks for, in minutes. */
const PROMISE_MINUTES = 25;
const PROMISE_NOTE = '飲品已放雪櫃，到櫃檯報取餐碼即可';

// ---- env ------------------------------------------------------------------
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
// `check` is for synchronous assertions ONLY. A promise returned from it is not
// awaited, so an `async` callback that fails would be recorded as a pass — the
// quietest possible false green. Anything awaiting goes through `checkAsync`.
let passed = 0;
const failures = [];

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
    record(name, new Error('check() received an async callback — use checkAsync()'));
  } else {
    record(name, null);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    record(name, null);
  } catch (error) {
    record(name, error);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function expectError(response, status, code) {
  assert.equal(
    response.status,
    status,
    `expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
  if (code) {
    assert.equal(
      response.body?.error?.code,
      code,
      `expected code ${code}, got ${JSON.stringify(response.body)}`,
    );
  }
}

const minutesFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 60_000;

/** Total soft-held units for a menu item, across every service date. */
async function heldUnits(merchantId, menuItemId) {
  const row = await prisma.menuItemDailyStock.aggregate({
    where: { merchantId, menuItemId },
    _sum: { held: true },
  });
  return row._sum.held ?? 0;
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  // Only per-run artefacts. The seeded merchant, menu, hours and users stay.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE refunds, payments, merchant_payout_lines, merchant_payouts,
                   order_status_events, order_items, orders,
                   menu_item_daily_stock, outbox_events
    CASCADE
  `);

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, timezone: true, acceptsOrders: true, status: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);
  assert.ok(merchant.acceptsOrders, 'seeded merchant must be accepting orders');
  assert.equal(merchant.status, 'ACTIVE', 'seeded merchant must be ACTIVE');

  const items = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id, availability: 'AVAILABLE' },
    select: { id: true, name: true, priceMinor: true, isMainItem: true },
    orderBy: { sortOrder: 'asc' },
  });
  assert.ok(items.length >= 2, 'seeded menu needs at least two available items');

  // One main item and one add-on, so the platform fee is a known non-zero
  // number rather than accidentally zero on a menu of drinks.
  const main = items.find((item) => item.isMainItem) ?? items[0];
  const addOn = items.find((item) => !item.isMainItem) ?? items[1];
  const subtotal = main.priceMinor + addOn.priceMinor;

  const customer = await prisma.user.findUnique({
    where: { phone: CUSTOMER_PHONE },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { phone: OWNER_PHONE },
    select: { id: true },
  });
  assert.ok(customer && owner, 'seeded users missing');

  const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
  const ownerToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });

  const orderBody = (paymentMode, note) => ({
    merchantId: merchant.id,
    items: [
      { menuItemId: main.id, quantity: 1 },
      { menuItemId: addOn.id, quantity: 1 },
    ],
    paymentMode,
    ...(note ? { customerNote: note } : {}),
  });

  const place = (paymentMode, note, key = crypto.randomUUID()) =>
    api('POST', '/orders', {
      token: customerToken,
      body: orderBody(paymentMode, note),
      headers: { 'idempotency-key': key },
    });

  // =========================================================================
  section('1. 顧客選到店付款下單');
  // =========================================================================

  let payAtStore;
  await checkAsync('places a PAY_AT_STORE order', async () => {
    const response = await place('PAY_AT_STORE', '唔要餐具');
    expectError(response, 201);
    payAtStore = response.body;
  });

  check('starts in PENDING_PAYMENT, not PAID', () => {
    assert.equal(payAtStore.status, 'PENDING_PAYMENT');
  });

  check('echoes the payment mode back', () => {
    assert.equal(payAtStore.paymentMode, 'PAY_AT_STORE');
  });

  check('carries a notice that tells the customer to pay at the counter', () => {
    const notice = payAtStore.pickupNotice;
    assert.ok(notice, 'pickupNotice must not be null on a fresh order');
    // `info`, not `warn`: nothing has gone wrong, the customer is simply
    // waiting on somebody else. The tone is what the tracking page colours the
    // banner with, and amber here would read as "you have a problem".
    assert.equal(notice.tone, 'info');
    assert.match(notice.title, /等待店家確認/);
    // The notice is written by the API and rendered verbatim. If the wording
    // changes the assertion should move with it — but it must keep telling the
    // customer that the *shop* has to act, not them.
    assert.match(notice.message, /店家|商戶|店舖/);
    assert.match(notice.message, /付款/);
  });

  check('charges no payment processing fee — no PSP ever touches this order', () => {
    assert.equal(payAtStore.pricing.paymentProcessingFeeMinor, 0);
  });

  check('still charges the platform fee for the main item', () => {
    assert.equal(payAtStore.pricing.mainItemCount, 1);
    assert.equal(payAtStore.pricing.subtotalMinor, subtotal);
    assert.equal(payAtStore.pricing.platformFeeMinor, 350);
    assert.equal(payAtStore.pricing.merchantPayoutMinor, subtotal - 350);
  });

  check('issues a pickup code at placement, not at payment', () => {
    // Minted with the order so the customer can be told what to quote at the
    // counter before any money moves — which is precisely what a pay-at-store
    // order has to support.
    assert.match(String(payAtStore.pickupCode), /^[A-Z]-\d+$/);
  });

  // =========================================================================
  section('2. 線上付款入口對到店付款訂單關閉');
  // =========================================================================

  await checkAsync('POST /orders/:id/payment-intent -> 409 PAYMENT_NOT_REQUIRED', async () => {
    const response = await api('POST', `/orders/${payAtStore.id}/payment-intent`, {
      token: customerToken,
      body: {},
    });
    expectError(response, 409, 'PAYMENT_NOT_REQUIRED');
  });

  await checkAsync('POST /orders/:id/simulate-payment -> 409 as well', async () => {
    const response = await api('POST', `/orders/${payAtStore.id}/simulate-payment`, {
      token: customerToken,
    });
    // The dev-only settle button must be closed for the same reason: this order
    // is settled by a person at a counter, not by a rail.
    expectError(response, 409, 'PAYMENT_NOT_REQUIRED');
  });

  await checkAsync('no payment row was created', async () => {
    const count = await prisma.payment.count({ where: { orderId: payAtStore.id } });
    assert.equal(count, 0);
  });

  // =========================================================================
  section('3. 重播的 Idempotency-Key 由資料庫擋下，不靠 Redis');
  // =========================================================================

  // The interesting part is WHERE the refusal comes from. The controller's
  // Redis lock is only a fast path, and on this machine Redis is not running at
  // all — so if this suite passes, the 409 was produced by the UNIQUE index on
  // `orders.idempotencyKey` and not by the cache. Before that column existed, a
  // double-tapped checkout returned 500 and no order could be placed at all.
  const replayedKey = crypto.randomUUID();

  await checkAsync('first submission with the key succeeds', async () => {
    const response = await place('PAY_AT_STORE', undefined, replayedKey);
    expectError(response, 201);
  });

  await checkAsync('the key is persisted on the order row', async () => {
    const rows = await prisma.order.count({ where: { idempotencyKey: replayedKey } });
    assert.equal(rows, 1, 'the order must carry the key it was submitted with');
  });

  await checkAsync('replay -> 409 DUPLICATE_IDEMPOTENCY_KEY', async () => {
    const response = await place('PAY_AT_STORE', undefined, replayedKey);
    expectError(response, 409, 'DUPLICATE_IDEMPOTENCY_KEY');
  });

  await checkAsync('the replay created no second order', async () => {
    const rows = await prisma.order.count({ where: { idempotencyKey: replayedKey } });
    assert.equal(rows, 1);
  });

  await checkAsync('an order placed without a key is unaffected', async () => {
    const response = await api('POST', '/orders', {
      token: customerToken,
      body: orderBody('PAY_AT_STORE'),
    });
    expectError(response, 201);
    const order = await prisma.order.findUnique({
      where: { id: response.body.id },
      select: { idempotencyKey: true },
    });
    assert.equal(order.idempotencyKey, null, 'no header, no key — NULLs must not collide');
  });

  // =========================================================================
  section('4. 廚房板看到這張待收款訂單');
  // =========================================================================

  await checkAsync('appears on the ACTIVE board even though it is unpaid', async () => {
    const response = await api(
      'GET',
      `/merchant/${merchant.id}/orders?status=ACTIVE&limit=200`,
      { token: ownerToken },
    );
    expectError(response, 200);
    const found = response.body.data.find((row) => row.id === payAtStore.id);
    assert.ok(found, 'a pay-at-store order must not be invisible to the shop that must act on it');
    assert.equal(found.paymentMode, 'PAY_AT_STORE');
  });

  await checkAsync('the board carries the customer note and the money split', async () => {
    const response = await api('GET', `/merchant/${merchant.id}/orders/${payAtStore.id}`, {
      token: ownerToken,
    });
    expectError(response, 200);
    assert.equal(response.body.customerNote, '唔要餐具');
    assert.equal(response.body.totalMinor, subtotal);
    assert.equal(response.body.paymentFeeMinor, 0);
  });

  // =========================================================================
  section('5. 店家確認收款並提供預計取餐時間');
  // =========================================================================

  let confirmed;
  await checkAsync('POST /confirm settles and accepts in one call', async () => {
    const response = await api(
      'POST',
      `/merchant/${merchant.id}/orders/${payAtStore.id}/confirm`,
      {
        token: ownerToken,
        body: { readyInMinutes: PROMISE_MINUTES, note: PROMISE_NOTE },
      },
    );
    expectError(response, 200);
    confirmed = response.body;
  });

  check('reports that it also recorded the counter payment', () => {
    assert.equal(confirmed.settledOffline, true);
  });

  check('moved PENDING_PAYMENT -> PAID -> ACCEPTED', () => {
    assert.equal(confirmed.fromStatus, 'PAID');
    assert.equal(confirmed.toStatus, 'ACCEPTED');
  });

  check(`promises the food in about ${PROMISE_MINUTES} minutes`, () => {
    assert.ok(confirmed.estimatedReadyAt, 'estimatedReadyAt must be set');
    const delta = minutesFromNow(confirmed.estimatedReadyAt);
    assert.ok(
      Math.abs(delta - PROMISE_MINUTES) < 2,
      `expected ~${PROMISE_MINUTES} minutes out, got ${delta.toFixed(1)}`,
    );
    assert.equal(confirmed.readyInMinutes, PROMISE_MINUTES);
  });

  check('tells the board what it may do next', () => {
    assert.ok(confirmed.allowedNextTransitions.includes('PREPARING'));
  });

  await checkAsync('writes a MANUAL payment row with no processing fee', async () => {
    const payment = await prisma.payment.findFirst({ where: { orderId: payAtStore.id } });
    assert.ok(payment, 'a payment row must exist — the shop is holding the cash');
    assert.equal(payment.provider, 'MANUAL');
    assert.equal(payment.status, 'CAPTURED');
    assert.equal(payment.amountMinor, subtotal);
    assert.equal(payment.processingFeeMinor, 0);
    assert.ok(payment.capturedAt, 'capturedAt must be stamped');
  });

  await checkAsync('records the whole path in the audit trail', async () => {
    const events = await prisma.orderStatusEvent.findMany({
      where: { orderId: payAtStore.id },
      orderBy: { createdAt: 'asc' },
      select: { fromStatus: true, toStatus: true, actor: true },
    });
    // The head of the sequence is the creation row (`from === to`), written by
    // `place-order` because the trail has to have an origin.
    assert.deepEqual(
      events.map((event) => `${event.fromStatus}->${event.toStatus}`),
      ['PENDING_PAYMENT->PENDING_PAYMENT', 'PENDING_PAYMENT->PAID', 'PAID->ACCEPTED'],
    );
    assert.equal(events[0].actor, 'CUSTOMER');
    assert.ok(events.slice(1).every((event) => event.actor === 'MERCHANT'));
  });

  await checkAsync('restarts the accept clock when the money lands', async () => {
    const order = await prisma.order.findUnique({
      where: { id: payAtStore.id },
      select: { acceptDeadlineAt: true, acceptedAt: true, estimatedReadyAt: true },
    });
    assert.ok(order.acceptDeadlineAt, 'acceptDeadlineAt is written on -> PAID');
    assert.ok(order.acceptedAt, 'acceptedAt is written on -> ACCEPTED');
    assert.ok(order.estimatedReadyAt, 'the promise is persisted on the order');
  });

  await checkAsync('a replayed confirm does not double-transition', async () => {
    const response = await api(
      'POST',
      `/merchant/${merchant.id}/orders/${payAtStore.id}/confirm`,
      { token: ownerToken, body: { readyInMinutes: PROMISE_MINUTES } },
    );
    expectError(response, 409);
    const payments = await prisma.payment.count({ where: { orderId: payAtStore.id } });
    assert.equal(payments, 1, 'the deterministic idempotency key must hold');
  });

  // =========================================================================
  section('6. 顧客看到預計取餐時間與提示訊息');
  // =========================================================================

  let customerView;
  await checkAsync('GET /orders/:id exposes the promise', async () => {
    const response = await api('GET', `/orders/${payAtStore.id}`, { token: customerToken });
    expectError(response, 200);
    customerView = response.body;
  });

  check('shows the merchant name and slug, so the page can link back', () => {
    assert.equal(customerView.merchantName, merchant.name);
    assert.equal(customerView.merchantSlug, MERCHANT_SLUG);
  });

  check('carries estimatedReadyAt and readyInMinutes', () => {
    assert.ok(customerView.estimatedReadyAt);
    assert.equal(customerView.readyInMinutes, PROMISE_MINUTES);
  });

  check('carries the kitchen note verbatim', () => {
    assert.equal(customerView.merchantNote, PROMISE_NOTE);
  });

  check('the notice now reads as a pickup time, not a payment instruction', () => {
    const notice = customerView.pickupNotice;
    assert.ok(notice, 'pickupNotice must be set on an accepted order');
    assert.match(notice.message, /取餐/);
    assert.ok(
      !/尚未付款|請完成付款/.test(notice.message),
      `notice still reads as unpaid: ${notice.message}`,
    );
  });

  check('the commission split is NOT exposed to the customer', () => {
    assert.equal(customerView.platformFeeMinor, undefined);
    assert.equal(customerView.merchantPayoutMinor, undefined);
    assert.equal(customerView.paymentFeeMinor, undefined);
  });

  // =========================================================================
  section('7. 線上付款訂單不能被店家手動收款');
  // =========================================================================

  let online;
  await checkAsync('places an ONLINE order', async () => {
    const response = await place('ONLINE');
    expectError(response, 201);
    online = response.body;
  });

  check('is PENDING_PAYMENT with the online mode', () => {
    assert.equal(online.status, 'PENDING_PAYMENT');
    assert.equal(online.paymentMode, 'ONLINE');
  });

  check('the notice tells the customer to pay, not the shop', () => {
    assert.match(online.pickupNotice.message, /付款/);
  });

  await checkAsync('POST /confirm -> 409 MANUAL_SETTLEMENT_NOT_ALLOWED', async () => {
    const response = await api('POST', `/merchant/${merchant.id}/orders/${online.id}/confirm`, {
      token: ownerToken,
      body: { readyInMinutes: 20 },
    });
    expectError(response, 409, 'MANUAL_SETTLEMENT_NOT_ALLOWED');
  });

  await checkAsync('the refusal left no payment row and no status change behind', async () => {
    const payments = await prisma.payment.count({ where: { orderId: online.id } });
    assert.equal(payments, 0, 'the guard must be consulted before any write');
    const order = await prisma.order.findUnique({
      where: { id: online.id },
      select: { status: true },
    });
    assert.equal(order.status, 'PENDING_PAYMENT');
  });

  await checkAsync('POST /cancel on an ONLINE order -> 409 as well', async () => {
    const response = await api('POST', `/merchant/${merchant.id}/orders/${online.id}/cancel`, {
      token: ownerToken,
      body: { reason: '不做了' },
    });
    // The customer may be midway through 3-D Secure; cancelling under them
    // would make the capture webhook arrive at a terminal order.
    expectError(response, 409, 'MANUAL_SETTLEMENT_NOT_ALLOWED');
  });

  // =========================================================================
  section('8. 店家可以取消一張未收款的到店付款訂單');
  // =========================================================================

  let declined;
  // Absolute counts are useless here: earlier sections left their own orders
  // holding units, so a hard-coded number would only assert the order the
  // checks happen to run in. The delta is the actual rule.
  let heldBefore = 0;
  await checkAsync('places a second PAY_AT_STORE order', async () => {
    heldBefore = await heldUnits(merchant.id, main.id);
    const response = await place('PAY_AT_STORE');
    expectError(response, 201);
    declined = response.body;
  });

  await checkAsync('the order soft-holds one more unit of the main item', async () => {
    assert.equal(await heldUnits(merchant.id, main.id), heldBefore + 1);
  });

  await checkAsync('POST /cancel -> 200 CANCELLED', async () => {
    const response = await api('POST', `/merchant/${merchant.id}/orders/${declined.id}/cancel`, {
      token: ownerToken,
      body: { reason: '今日食材售罄' },
    });
    expectError(response, 200);
    assert.equal(response.body.toStatus, 'CANCELLED');
  });

  await checkAsync('the held units went back into the pool', async () => {
    assert.equal(
      await heldUnits(merchant.id, main.id),
      heldBefore,
      'a cancelled order must not keep holding quota',
    );
  });

  await checkAsync('no refund was attempted — there was nothing to refund', async () => {
    const refunds = await prisma.refund.count({ where: { payment: { orderId: declined.id } } });
    assert.equal(refunds, 0);
  });

  await checkAsync('the customer sees a cancellation notice', async () => {
    const response = await api('GET', `/orders/${declined.id}`, { token: customerToken });
    expectError(response, 200);
    assert.equal(response.body.status, 'CANCELLED');
    const notice = response.body.pickupNotice;
    assert.ok(notice, 'a cancelled order still needs a sentence');
    // `neutral`, not `danger`: the shop declined before any money moved, so the
    // customer has lost nothing but the order. Red would imply a loss.
    assert.equal(notice.tone, 'neutral');
    assert.match(notice.message, /取消/);
  });

  // =========================================================================
  section('9. 到店付款訂單完成後才會寫入結算分錄');
  // =========================================================================

  await checkAsync('accept -> preparing -> ready -> complete', async () => {
    for (const action of ['start-preparing', 'mark-ready', 'complete']) {
      const response = await api(
        'POST',
        `/merchant/${merchant.id}/orders/${payAtStore.id}/${action}`,
        { token: ownerToken },
      );
      expectError(response, 200);
    }
  });

  await checkAsync('the completed order wrote exactly one payout ledger line', async () => {
    const lines = await prisma.merchantPayoutLine.count({ where: { orderId: payAtStore.id } });
    assert.equal(lines, 1);
  });

  await checkAsync('the ledger agrees with the order row to the cent', async () => {
    const line = await prisma.merchantPayoutLine.findFirst({ where: { orderId: payAtStore.id } });
    const order = await prisma.order.findUnique({
      where: { id: payAtStore.id },
      select: { platformFeeMinor: true, merchantPayoutMinor: true, subtotalMinor: true },
    });
    assert.equal(line.platformFeeMinor, order.platformFeeMinor);
    assert.equal(line.merchantPayoutMinor, order.merchantPayoutMinor);
    assert.equal(line.subtotalMinor, order.subtotalMinor);
  });

  await checkAsync("completion converted this order's hold into sold", async () => {
    const totals = await prisma.menuItemDailyStock.aggregate({
      where: { merchantId: merchant.id, menuItemId: main.id },
      _sum: { held: true, sold: true },
    });
    // One unit of `main` was produced for the completed order and is gone from
    // the pool; the other orders this run created are still holding theirs.
    assert.equal(totals._sum.sold, 1, 'units that were produced are gone, not sellable again');
    assert.equal(totals._sum.held, heldBefore - 1);
  });

  // =========================================================================
  section('cleanup');
  // =========================================================================

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE refunds, payments, merchant_payout_lines, merchant_payouts,
                   order_status_events, order_items, orders,
                   menu_item_daily_stock, outbox_events
    CASCADE
  `);
  console.log('  per-run rows cleared; seeded merchant, menu and users left intact');

  console.log(`\n${'='.repeat(66)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks`);
  } else {
    console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.log(`  \u2717 ${failure.name}: ${failure.message}`);
  }
  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nHARNESS ERROR:', error.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

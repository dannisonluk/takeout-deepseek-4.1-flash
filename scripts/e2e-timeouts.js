#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  Timeout sweeper + refund reactor — end to end
// ============================================================================
//  Covers the two background loops that close the M1 gap:
//
//    OrderTimeoutSweeperService  — PENDING_PAYMENT / PAID / READY_FOR_PICKUP
//                                  past their deadline -> EXPIRED
//    OrderRefundReactorService   — the state machine's ISSUE_REFUND side
//                                  effect, which had no implementation
//
//  Usage
//  -----
//    1. start the API:   ORDER_BACKGROUND_JOBS=false node apps/api/dist/main.js
//    2. run:             node scripts/e2e-timeouts.js
//
//  `ORDER_BACKGROUND_JOBS=false` is not optional. Both loops are normally
//  scheduled, and a background pass firing between a backdate and the explicit
//  sweep would make the report assertions depend on where in the 30-second
//  cycle the test happened to land.
//
//  Two deliberate departures from `e2e-smoke.js`:
//
//   * **Checks run immediately, not deferred.** Smoke collects its assertions
//     into a `pending` array and awaits them at the end, which is how it once
//     read a shared table *after* another script had changed it. Nothing here
//     is asserted against a value that can move underneath it.
//   * **Deadlines are backdated with SQL rather than waited out.** The whole
//     point is to test a 15-minute timeout; sleeping 15 minutes is not a test.
//
//  Exits non-zero on any failure and leaves the database as it found it.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const HEALTH_URL = process.env.API_HEALTH ?? 'http://127.0.0.1:3000/health';
const MERCHANT_SLUG = 'dim-sum-express';

const prisma = new PrismaClient();

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
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ---- http -----------------------------------------------------------------
async function api(method, endpoint, { token, body } = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ---- harness --------------------------------------------------------------
let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n${title}`);
}

/** Immediate, awaited assertion. Never queued — see the header note. */
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${error.message.split('\n')[0]}`);
  }
}

function fmt(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v));
}

// ---- bookkeeping ----------------------------------------------------------
const created = {
  orderIds: [],
  /** `menu_item_daily_stock` rows as they were, so cleanup can restore them. */
  stockBefore: [],
  merchantId: null,
  acceptsOrdersBefore: null,
};

/** Push an order's clock backwards so the sweeper sees it as overdue. */
async function backdate(orderId, column, interval) {
  // Column names are camelCase and must be quoted — Prisma only snake_cases the
  // *table* name (`@@map`); a field without `@map` keeps its own spelling.
  const allowed = new Set(['createdAt', 'acceptDeadlineAt', 'readyAt']);
  if (!allowed.has(column)) throw new Error(`refusing to backdate unknown column ${column}`);
  await prisma.$executeRawUnsafe(
    `UPDATE orders SET "${column}" = now() - interval '${interval}' WHERE id = $1::uuid`,
    orderId,
  );
}

async function sweep() {
  const result = await api('POST', '/admin/ops/sweep', { token: adminToken });
  assert.equal(result.status, 200, `sweep -> ${result.status} ${fmt(result.body)}`);
  return result.body;
}

async function orderStatus(orderId) {
  const row = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return row?.status ?? null;
}

async function heldFor(menuItemId) {
  const row = await prisma.menuItemDailyStock.findFirst({
    where: { menuItemId },
    select: { held: true, sold: true },
  });
  return row ?? { held: 0, sold: 0 };
}

async function refundsFor(orderId) {
  return prisma.refund.findMany({
    where: { payment: { orderId } },
    select: { id: true, status: true, amountMinor: true, requestedBy: true, reason: true },
  });
}

/** Place an order for the given basket and register it for cleanup. */
async function placeOrder(basket, { token } = {}) {
  const response = await api('POST', '/orders', {
    token: token ?? customerToken,
    body: {
      merchantId: created.merchantId,
      items: basket,
      contactPhone: '+85290000001',
    },
  });
  assert.equal(response.status, 201, `POST /orders -> ${response.status} ${fmt(response.body)}`);
  created.orderIds.push(response.body.id);
  return response.body;
}

/** Drive a paid order all the way to READY_FOR_PICKUP. */
async function driveToReady(orderId) {
  const steps = [
    ['accept', 'ACCEPTED'],
    ['start-preparing', 'PREPARING'],
    ['mark-ready', 'READY_FOR_PICKUP'],
  ];
  for (const [action, expected] of steps) {
    const result = await api('POST', `/merchant/${created.merchantId}/orders/${orderId}/${action}`, {
      token: ownerToken,
    });
    assert.equal(
      result.status,
      200,
      `${action} -> ${result.status} ${fmt(result.body)}`,
    );
    assert.equal(result.body.toStatus, expected, `${action} landed on ${result.body.toStatus}`);
  }
}

async function pay(orderId) {
  const result = await api('POST', `/orders/${orderId}/simulate-payment`, { token: customerToken });
  assert.equal(result.status, 200, `simulate-payment -> ${result.status} ${fmt(result.body)}`);
}

let adminToken;
let ownerToken;
let customerToken;

// ---- cleanup --------------------------------------------------------------
async function cleanup() {
  console.log('\ncleanup');
  const step = async (label, fn) => {
    try {
      await fn();
      console.log(`  ${label}`);
    } catch (error) {
      console.log(`  ${label} — FAILED: ${String(error.message).split('\n')[0]}`);
    }
  };

  if (created.orderIds.length > 0) {
    await step(`${created.orderIds.length} order(s) and their ledger rows removed`, async () => {
      // Payout lines have no cascade from orders, so they go first.
      await prisma.merchantPayoutLine.deleteMany({ where: { orderId: { in: created.orderIds } } });
      // Payments and refunds cascade from the order.
      await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
      // Batches left with no lines are this run's leftovers.
      await prisma.$executeRaw`
        DELETE FROM merchant_payouts p
         WHERE NOT EXISTS (SELECT 1 FROM merchant_payout_lines l WHERE l."payoutId" = p.id)
      `;
    });
  }

  if (created.merchantId) {
    await step('daily stock rows restored', async () => {
      // The whole table for this merchant is this run's artefact — either the
      // rows the orders held against, or rows that did not exist before. `held`
      // is never credited back when an order is deleted, so leaving them would
      // inflate the next run.
      await prisma.menuItemDailyStock.deleteMany({ where: { merchantId: created.merchantId } });
      if (created.stockBefore.length > 0) {
        await prisma.menuItemDailyStock.createMany({ data: created.stockBefore });
      }
    });
  }

  if (created.merchantId && created.acceptsOrdersBefore !== null) {
    await step('merchant intake restored', async () => {
      await prisma.merchant.update({
        where: { id: created.merchantId },
        data: { acceptsOrders: created.acceptsOrdersBefore },
      });
    });
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const probe = await fetch(HEALTH_URL);
      if (probe.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, acceptsOrders: true, pickupWindowMinutes: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);
  created.merchantId = merchant.id;
  created.acceptsOrdersBefore = merchant.acceptsOrders;

  const items = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id },
    select: { id: true, name: true, priceMinor: true },
  });
  const byName = new Map(items.map((item) => [item.name, item]));
  const harGow = byName.get('晶瑩蝦餃');
  const siuMai = byName.get('蟹籽燒賣');
  assert.ok(harGow && siuMai, 'seeded menu items missing');

  const users = await prisma.user.findMany({
    where: { phone: { in: ['+85290000001', '+85290000002', '+85290000003'] } },
    select: { id: true, phone: true, role: true },
  });
  const byPhone = new Map(users.map((user) => [user.phone, user]));
  const customer = byPhone.get('+85290000001');
  const owner = byPhone.get('+85290000002');
  const admin = byPhone.get('+85290000003');
  assert.ok(customer && owner && admin, 'seeded users missing');

  customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
  // `MerchantScopeGuard` reads `merchantIds` off the TOKEN, not the database.
  // An owner token without it gets 403 on their own shop.
  ownerToken = mintToken({ sub: owner.id, role: 'MERCHANT_OWNER', merchantIds: [merchant.id] });
  adminToken = mintToken({ sub: admin.id, role: 'ADMIN' });

  // The kitchen must be open for the accept step in case C.
  const intake = await api('POST', `/merchant/${merchant.id}/intake`, {
    token: ownerToken,
    body: { accepting: true },
  });
  assert.equal(intake.status, 200, `open the kitchen -> ${intake.status} ${fmt(intake.body)}`);

  // Snapshot the stock table so cleanup can put it back exactly.
  created.stockBefore = await prisma.menuItemDailyStock.findMany({
    where: { merchantId: merchant.id },
  });

  // =========================================================================
  section('0. The sweep endpoint is admin-only');
  // =========================================================================
  const noToken = await api('POST', '/admin/ops/sweep');
  await check('without a token -> 401', () => {
    assert.equal(noToken.status, 401);
  });
  const asCustomer = await api('POST', '/admin/ops/sweep', { token: customerToken });
  await check('as a customer -> 403', () => {
    assert.equal(asCustomer.status, 403);
  });

  // =========================================================================
  section('A. PENDING_PAYMENT past the payment timeout -> EXPIRED');
  // =========================================================================
  const beforeA = await heldFor(harGow.id);
  const orderA = await placeOrder([{ menuItemId: harGow.id, quantity: 2 }]);

  await check('placing the order soft-holds the quota', async () => {
    const now = await heldFor(harGow.id);
    assert.equal(now.held, beforeA.held + 2, `held ${beforeA.held} -> ${now.held}`);
  });

  await check('still PENDING_PAYMENT before the sweep', async () => {
    assert.equal(await orderStatus(orderA.id), 'PENDING_PAYMENT');
  });

  await backdate(orderA.id, 'createdAt', '30 minutes');
  const reportA = await sweep();

  await check('sweep reports the expiry', () => {
    assert.ok(reportA.orders.expiredUnpaid >= 1, fmt(reportA.orders));
  });

  await check('order is now EXPIRED', async () => {
    assert.equal(await orderStatus(orderA.id), 'EXPIRED');
  });

  await check('the soft-held quota came back', async () => {
    const now = await heldFor(harGow.id);
    assert.equal(now.held, beforeA.held, `held ${beforeA.held} -> ${now.held}`);
  });

  await check('the expiry is on the status timeline with a reason', async () => {
    const event = await prisma.orderStatusEvent.findFirst({
      where: { orderId: orderA.id, toStatus: 'EXPIRED' },
      select: { actor: true, reason: true },
    });
    assert.ok(event, 'no EXPIRED status event');
    assert.equal(event.actor, 'SYSTEM');
    assert.equal(event.reason, 'payment window elapsed');
  });

  await check('an unpaid order has nothing to refund', async () => {
    assert.deepEqual(await refundsFor(orderA.id), []);
  });

  // =========================================================================
  section('B. PAID past acceptDeadlineAt -> EXPIRED + refund');
  // =========================================================================
  const beforeB = await heldFor(harGow.id);
  const orderB = await placeOrder([{ menuItemId: harGow.id, quantity: 1 }]);
  await pay(orderB.id);

  await check('payment moved it to PAID', async () => {
    assert.equal(await orderStatus(orderB.id), 'PAID');
  });

  await backdate(orderB.id, 'acceptDeadlineAt', '30 minutes');
  const reportB = await sweep();

  await check('sweep reports the unaccepted expiry', () => {
    assert.ok(reportB.orders.expiredUnaccepted >= 1, fmt(reportB.orders));
  });

  await check('order is now EXPIRED', async () => {
    assert.equal(await orderStatus(orderB.id), 'EXPIRED');
  });

  await check('quota released', async () => {
    const now = await heldFor(harGow.id);
    assert.equal(now.held, beforeB.held, `held ${beforeB.held} -> ${now.held}`);
  });

  // This is the assertion that would have failed before `RefundService`
  // existed: the state machine declared ISSUE_REFUND and nothing discharged it.
  await check('a refund row now exists (the ISSUE_REFUND side effect)', async () => {
    const refunds = await refundsFor(orderB.id);
    assert.equal(refunds.length, 1, `expected 1 refund, got ${fmt(refunds)}`);
    // Amounts live under `pricing` on the created-order view, not at the top level.
    assert.equal(refunds[0].amountMinor, orderB.pricing.totalMinor);
    // No human asked for this one — `requestedBy` is null by design.
    assert.equal(refunds[0].requestedBy, null);
  });

  await check('with live mode off it is recorded as PENDING, not claimed as settled', async () => {
    const [refund] = await refundsFor(orderB.id);
    assert.equal(refund.status, 'PENDING', `status was ${refund.status}`);
  });

  await check('the refund reactor is idempotent — a second sweep adds nothing', async () => {
    await sweep();
    await sweep();
    const refunds = await refundsFor(orderB.id);
    assert.equal(refunds.length, 1, `expected 1 refund, got ${refunds.length}`);
  });

  // =========================================================================
  section('C. READY_FOR_PICKUP no-show -> EXPIRED, merchant still paid');
  // =========================================================================
  const soldBeforeC = (await heldFor(harGow.id)).sold;
  const orderC = await placeOrder([
    { menuItemId: harGow.id, quantity: 1 },
    { menuItemId: siuMai.id, quantity: 1 },
  ]);
  await pay(orderC.id);
  await driveToReady(orderC.id);

  await check('the order reached READY_FOR_PICKUP', async () => {
    assert.equal(await orderStatus(orderC.id), 'READY_FOR_PICKUP');
  });

  await backdate(orderC.id, 'readyAt', `${merchant.pickupWindowMinutes + 10} minutes`);
  const reportC = await sweep();

  await check('sweep reports the no-show', () => {
    assert.ok(reportC.orders.expiredUncollected >= 1, fmt(reportC.orders));
  });

  await check('order is now EXPIRED', async () => {
    assert.equal(await orderStatus(orderC.id), 'EXPIRED');
  });

  // The distinction that matters: the food was cooked. Refunding a no-show
  // would hand out free meals.
  await check('a no-show is NOT refunded', async () => {
    const refunds = await refundsFor(orderC.id);
    assert.deepEqual(refunds, [], `unexpected refund: ${fmt(refunds)}`);
  });

  await check('the merchant is still paid — a payout ledger line exists', async () => {
    const line = await prisma.merchantPayoutLine.findFirst({
      where: { orderId: orderC.id },
      select: { platformFeeMinor: true, merchantPayoutMinor: true },
    });
    assert.ok(line, 'no payout ledger line for the no-show');
    assert.equal(line.merchantPayoutMinor, orderC.pricing.merchantPayoutMinor);
  });

  await check('the no-show quota is consumed, not returned to the pool', async () => {
    // The units were produced, so they move held -> sold rather than going back
    // into the pool. Putting them back would let the same dish be sold twice.
    const row = await heldFor(harGow.id);
    assert.equal(row.sold, soldBeforeC + 1, `sold ${soldBeforeC} -> ${row.sold}`);
  });

  // =========================================================================
  section('D. The sweeper does not touch orders that are still healthy');
  // =========================================================================
  const orderD = await placeOrder([{ menuItemId: siuMai.id, quantity: 1 }]);
  await pay(orderD.id);
  const reportD = await sweep();

  await check('a freshly paid order is left alone', async () => {
    assert.equal(await orderStatus(orderD.id), 'PAID');
  });

  await check('and it is not counted as expired', () => {
    assert.equal(reportD.orders.expiredUnpaid, 0);
    assert.equal(reportD.orders.expiredUnaccepted, 0);
  });

  await check('and it is not refunded', async () => {
    assert.deepEqual(await refundsFor(orderD.id), []);
  });

  // =========================================================================
  section('E. COMPLETED converts held -> sold (the sales figure)');
  // =========================================================================
  const beforeE = await heldFor(siuMai.id);
  const orderE = await placeOrder([{ menuItemId: siuMai.id, quantity: 2 }]);
  await pay(orderE.id);
  await driveToReady(orderE.id);

  await check('two units are held while the order is open', async () => {
    const now = await heldFor(siuMai.id);
    assert.equal(now.held, beforeE.held + 2, `held ${beforeE.held} -> ${now.held}`);
  });

  const completeE = await api(
    'POST',
    `/merchant/${created.merchantId}/orders/${orderE.id}/complete`,
    { token: ownerToken },
  );
  await check('the merchant can mark it collected', () => {
    assert.equal(completeE.status, 200, `complete -> ${completeE.status} ${fmt(completeE.body)}`);
  });

  await check('the held units became sold, not released', async () => {
    const now = await heldFor(siuMai.id);
    assert.equal(now.held, beforeE.held, `held ${beforeE.held} -> ${now.held}`);
    assert.equal(now.sold, beforeE.sold + 2, `sold ${beforeE.sold} -> ${now.sold}`);
  });

  await check('and the daily cap still adds up', async () => {
    const row = await prisma.menuItemDailyStock.findFirst({
      where: { menuItemId: siuMai.id },
      select: { quota: true, held: true, sold: true },
    });
    assert.ok(row, 'the stock row disappeared');
    assert.ok(
      row.sold + row.held <= row.quota,
      `sold ${row.sold} + held ${row.held} exceeds quota ${row.quota}`,
    );
  });

  await Promise.resolve();
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${'='.repeat(66)}`);
    if (failures.length === 0) {
      console.log(`PASS — ${passed} checks`);
    } else {
      console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
      for (const failure of failures) console.log(`  \u2717 ${failure.name}: ${failure.message}`);
      process.exitCode = 1;
    }
  })
  .catch(async (error) => {
    console.error(`\nFATAL: ${error.message}`);
    try {
      await cleanup();
    } catch {
      /* already reported */
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

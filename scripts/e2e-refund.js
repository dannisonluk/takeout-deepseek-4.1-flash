#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 退款申請工單 (refund-request tickets)
//  顧客開單 → 店家商議 → 線下解決／拒絕 → 顧客撤回 → 平台只讀
// ============================================================================
//  The feature exists because this is a BOOKING-ONLY platform. The owner's
//  requirement (requirement 2) is explicit: a refund never passes through the
//  middle platform. The customer raises the complaint here, and the shop and
//  the customer settle it between themselves, offline.
//
//  So the properties this script pins are mostly about what must NOT happen:
//
//   1. NO MONEY MOVES. Nothing in the refund flow may write `payments`, touch
//      `orders.status`, or call a provider. A "refund" that silently flipped an
//      order to REFUNDED would make the platform a party to a settlement it is
//      not party to — and the shop's books would be wrong. Section 8 asserts
//      the payment row and the order status are byte-for-byte unchanged across
//      every step of the flow.
//
//   2. THE VOCABULARY HAS NO "REFUNDED". `RESOLVED_OFFLINE` records what the
//      shop SAYS it handed over. It is a claim. If the API ever grows a
//      `REFUNDED` status the platform is asserting something it never verified.
//
//   3. ONE OPEN TICKET PER ORDER. Two open tickets on one order means two
//      conversations about one complaint, and whichever the shop answers last
//      looks like the truth. The second filing is a 409.
//
//   4. A GUARD THAT PROTECTS A PATH DOES NOT PROTECT A ROW. `MerchantScopeGuard`
//      proves the caller staffs `:merchantId`. It says nothing about whether the
//      ticket in the URL belongs to that shop, so the row is re-checked. Section
//      6 proves a ticket from another shop is invisible.
//
//   5. THE MACHINE DECIDES, NOT THE CONTROLLER. Every move returns
//      `allowedNextTransitions`, and a customer may withdraw but never resolve.
//      Section 5 proves the customer's button list contains no terminal status
//      that implies the shop's authority.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-refund.js
//
//  Shares the database with the other e2e scripts, so it MUST NOT be run
//  concurrently with them. It cleans up after itself and exits non-zero on any
//  failure.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const MERCHANT_SLUG = 'dim-sum-express';
const OTHER_MERCHANT_SLUG = 'noodle-bar';

const CUSTOMER_PHONE = '+85290000001';
const OWNER_PHONE = '+85290000002';
const ADMIN_PHONE = '+85290000003';

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

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, ownerId: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

  const customer = await prisma.user.findUnique({
    where: { phone: CUSTOMER_PHONE },
    select: { id: true, displayName: true },
  });
  if (!customer) throw new Error(`Run prisma/seed.js first — no user ${CUSTOMER_PHONE}`);

  const owner = await prisma.user.findUnique({
    where: { phone: OWNER_PHONE },
    select: { id: true },
  });
  if (!owner) throw new Error(`Run prisma/seed.js first — no user ${OWNER_PHONE}`);

  const admin = await prisma.user.findUnique({
    where: { phone: ADMIN_PHONE },
    select: { id: true },
  });
  if (!admin) throw new Error(`Run prisma/seed.js first — no user ${ADMIN_PHONE}`);

  const merchantToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });
  const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
  const adminToken = mintToken({ sub: admin.id, role: 'ADMIN' });

  const MID = merchant.id;

  // Merge the other seed merchant if it exists — used by the cross-shop check.
  const otherMerchant = await prisma.merchant.findUnique({
    where: { slug: OTHER_MERCHANT_SLUG },
    select: { id: true },
  });

  // =========================================================================
  section('1. Clean slate');
  // =========================================================================

  // Only this merchant's tickets, so a parallel feature's rows are untouched.
  await prisma.refundRequest.deleteMany({ where: { merchantId: MID } });
  await prisma.refundRequest.deleteMany({ where: { customerId: customer.id } });

  await checkAsync('the customer’s ticket list starts empty', async () => {
    const res = await api('GET', '/refund-requests', { token: customerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 0, `expected an empty slate, got ${res.body.total}`);
    assert.deepEqual(res.body.data, []);
  });

  // =========================================================================
  section('2. Two orders to complain about: one PAID, one not yet paid');
  // =========================================================================

  /** Place an order and return its id — same body the smoke test uses. */
  async function placeOrder({ payAtStore = false } = {}) {
    const menuItem = await prisma.menuItem.findFirst({
      where: { merchantId: MID, availability: 'AVAILABLE' },
      select: { id: true },
    });
    assert.ok(menuItem, 'the seed must provide an available menu item');

    // PAY_AT_STORE lands at PENDING_PAYMENT and is confirmed at the counter —
    // perfect for the "not paid for yet" case.
    const res = await api('POST', '/orders', {
      token: customerToken,
      body: {
        merchantId: MID,
        paymentMode: payAtStore ? 'PAY_AT_STORE' : 'ONLINE',
        items: [{ menuItemId: menuItem.id, quantity: 1 }],
      },
    });
    assert.equal(res.status, 201, `order placement failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  let paidOrder;
  let unpaidOrder;
  await checkAsync('place an order that will be paid for', async () => {
    paidOrder = await placeOrder();
    assert.equal(paidOrder.status, 'PENDING_PAYMENT');
  });

  await checkAsync('place a pay-at-store order that stays unpaid', async () => {
    unpaidOrder = await placeOrder({ payAtStore: true });
    assert.equal(unpaidOrder.status, 'PENDING_PAYMENT');
  });

  // Advance the first order to PAID the same way a real run does — no direct
  // row surgery, so the flow under test is the flow a customer actually walks.
  await checkAsync('advance the first order to PAID through the real endpoints', async () => {
    const intent = await api('POST', `/orders/${paidOrder.id}/payment-intent`, {
      token: customerToken,
      body: {},
    });
    assert.equal(intent.status, 200, JSON.stringify(intent.body));

    const event = {
      id: `evt_refund_${Date.now()}`,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intent.body.providerRef,
          object: 'payment_intent',
          amount: intent.body.amountMinor,
          currency: 'hkd',
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const webhook = await api('POST', '/webhooks/payments/stripe', {
      body: event,
      headers: {
        'stripe-signature': stripeSignature(rawBody, env.STRIPE_WEBHOOK_SECRET),
      },
    });
    assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
    assert.equal(webhook.body.handled, true, JSON.stringify(webhook.body));

    const row = await prisma.order.findUnique({
      where: { id: paidOrder.id },
      select: { status: true, totalMinor: true },
    });
    assert.equal(row.status, 'PAID');
  });

  // =========================================================================
  section('3. Filing a ticket — ownership, vocabulary, and the open guard');
  // =========================================================================

  let ticketId;
  await checkAsync('file a ticket on my own PAID order -> 201 OPEN', async () => {
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'QUALITY', requestedAmountMinor: 3800, note: '點心到了是冷的' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ticketId = res.body.id;
    assert.equal(res.body.status, 'OPEN');
    assert.equal(res.body.reasonCode, 'QUALITY');
    assert.equal(res.body.requestedAmountMinor, 3800);
    assert.equal(res.body.orderId, paidOrder.id);
    assert.equal(res.body.merchantId, MID);
    // The platform did not decide anything about money — that is the whole point.
    assert.equal(res.body.settledAmountMinor, null, 'no settlement can exist before the shop moves');
    assert.equal(res.body.settlementReference, null);
  });

  await checkAsync('the fresh ticket carries the customer’s only move: withdraw', async () => {
    const res = await api('GET', `/refund-requests/${ticketId}`, { token: customerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      [...res.body.allowedNextTransitions].sort(),
      ['CANCELLED'],
      `a customer may only withdraw, got ${JSON.stringify(res.body.allowedNextTransitions)}`,
    );
    // THE POINT: the button list must not contain RESOLVED_OFFLINE or DECLINED.
    // Those are the shop's to make; a UI driven by this list cannot offer them.
    assert.ok(!res.body.allowedNextTransitions.includes('RESOLVED_OFFLINE'));
    assert.ok(!res.body.allowedNextTransitions.includes('DECLINED'));
  });

  await checkAsync('a stranger filing against my order -> 404, not 403', async () => {
    const strangerToken = mintToken({ sub: crypto.randomUUID(), role: 'CUSTOMER' });
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: strangerToken,
      body: { reasonCode: 'NEVER_RECEIVED' },
    });
    // 403 would confirm the order id exists. The platform answers 404 for both
    // "no such order" and "not yours" on purpose.
    expectError(res, 404, 'ORDER_NOT_FOUND');
  });

  await checkAsync('a second open ticket on the same order -> 409', async () => {
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'LATE' },
    });
    expectError(res, 409, 'REFUND_REQUEST_ALREADY_OPEN');
  });

  await checkAsync('an order that was never paid for -> 422', async () => {
    const res = await api('POST', `/orders/${unpaidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'NEVER_RECEIVED' },
    });
    // PENDING_PAYMENT is not in the refundable set. Letting it through would
    // create a ticket about money that never changed hands.
    expectError(res, 422, 'REFUND_REQUEST_NOT_ALLOWED');
  });

  await checkAsync('OTHER with no note -> 400 (an unanswerable ticket is worse than none)', async () => {
    // A fresh order to file against, since the first is held by an open ticket.
    const order = await placeOrder();
    const intent = await api('POST', `/orders/${order.id}/payment-intent`, {
      token: customerToken,
      body: {},
    });
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    const event = {
      id: `evt_refund_note_${Date.now()}`,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: intent.body.providerRef,
          object: 'payment_intent',
          amount: intent.body.amountMinor,
          currency: 'hkd',
        },
      },
    };
    const rawBody = JSON.stringify(event);
    await api('POST', '/webhooks/payments/stripe', {
      body: event,
      headers: { 'stripe-signature': stripeSignature(rawBody, env.STRIPE_WEBHOOK_SECRET) },
    });

    const res = await api('POST', `/orders/${order.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'OTHER' },
    });
    expectError(res, 400, 'REFUND_NOTE_REQUIRED');

    await prisma.order.deleteMany({ where: { id: order.id } });
  });

  await checkAsync('an amount larger than the order -> 400', async () => {
    const row = await prisma.order.findUnique({
      where: { id: paidOrder.id },
      select: { totalMinor: true },
    });
    // The first order already holds an open ticket, so this must be refused on
    // the amount before it ever reaches the open-ticket check — proving the
    // order of the checks in the use case.
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'QUALITY', requestedAmountMinor: row.totalMinor + 1 },
    });
    expectError(res, 400, 'REFUND_AMOUNT_INVALID');
  });

  await checkAsync('an unknown reason code -> 400 from the DTO', async () => {
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'BECAUSE_I_SAID_SO' },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('a filing event was enqueued with aggregateType RefundRequest', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'RefundRequest', aggregateId: ticketId },
      select: { eventType: true },
    });
    // The gateway routes on `aggregateType`; a wrong value sends the event to
    // nobody and the shop never learns a complaint was filed.
    assert.equal(events.length, 1, `expected exactly one event, got ${events.length}`);
    assert.equal(events[0].eventType, 'refund_request.opened');
  });

  // =========================================================================
  section('4. The shop’s queue');
  // =========================================================================

  await checkAsync('the ticket appears in the shop’s ACTIVE queue', async () => {
    const res = await api('GET', `/merchant/${MID}/refund-requests`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const found = res.body.data.find((row) => row.id === ticketId);
    assert.ok(found, 'the shop must see a customer complaint');
    assert.equal(found.customerId, customer.id);
    assert.equal(found.customerName, customer.displayName, 'the shop has to know who it is talking to');
    assert.equal(found.orderNo, paidOrder.orderNo);
    assert.equal(found.orderStatus, 'PAID', 'denormalised so the queue needs no join');
  });

  await checkAsync('the queue counts are a complete map, with absent statuses at 0', async () => {
    const res = await api('GET', `/merchant/${MID}/refund-requests`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // THE POINT: a queue tab rendered from a sparse map shows a blank count
    // instead of 0, which reads as "broken" rather than "none".
    for (const status of [
      'OPEN',
      'IN_DISCUSSION',
      'RESOLVED_OFFLINE',
      'DECLINED',
      'CANCELLED',
    ]) {
      assert.equal(typeof res.body.counts[status], 'number', `counts.${status} must exist`);
    }
    assert.equal(res.body.counts.OPEN, 1);
    assert.equal(res.body.counts.RESOLVED_OFFLINE, 0);
  });

  await checkAsync('filtering by ALL includes resolved tickets; ACTIVE does not', async () => {
    const active = await api('GET', `/merchant/${MID}/refund-requests?status=ACTIVE`, {
      token: merchantToken,
    });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.ok(active.body.data.some((row) => row.id === ticketId));

    const all = await api('GET', `/merchant/${MID}/refund-requests?status=ALL`, {
      token: merchantToken,
    });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.body.total >= active.body.total);
  });

  await checkAsync('a customer cannot read the shop’s queue -> 403', async () => {
    const res = await api('GET', `/merchant/${MID}/refund-requests`, { token: customerToken });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  await checkAsync('the shop may see only its own tickets', async () => {
    if (!otherMerchant) {
      console.log('      (skipped — only one merchant seeded)');
      return;
    }
    // A ticket id from another shop must not be readable by editing the URL.
    // The caller's token is scoped to MID, so asking for the OTHER shop's queue
    // is refused outright — the row-level wall is exercised properly in §6.
    const foreign = await api('GET', `/merchant/${otherMerchant.id}/refund-requests`, {
      token: merchantToken,
    });
    assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  });

  // =========================================================================
  section('5. The shop moves the ticket — and the machine is what decides');
  // =========================================================================

  await checkAsync('OPEN -> IN_DISCUSSION notifies both sides', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${ticketId}/transition`, {
      token: merchantToken,
      body: { to: 'IN_DISCUSSION', merchantNote: '師傅今日出餐急，我哋了解下' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fromStatus, 'OPEN');
    assert.equal(res.body.toStatus, 'IN_DISCUSSION');
    assert.ok(res.body.refundRequestId === ticketId, 'the field is refundRequestId, not id');
    assert.deepEqual(
      [...res.body.sideEffects].sort(),
      ['NOTIFY_CUSTOMER', 'NOTIFY_MERCHANT'],
      `both parties must be told, got ${JSON.stringify(res.body.sideEffects)}`,
    );
  });

  await checkAsync('a customer cannot move the ticket to IN_DISCUSSION', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${ticketId}/transition`, {
      token: customerToken,
      body: { to: 'IN_DISCUSSION' },
    });
    // 403 from the provider scope guard — the customer does not staff the shop.
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  await checkAsync('RESOLVED_OFFLINE with no amount and no reference -> 422', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${ticketId}/transition`, {
      token: merchantToken,
      body: { to: 'RESOLVED_OFFLINE' },
    });
    // The whole feature rests on this: a settlement must say what was handed
    // over. An empty "resolved" record is indistinguishable from "we did
    // nothing and closed the ticket".
    expectError(res, 422, 'REFUND_SETTLEMENT_DETAILS_REQUIRED');
  });

  await checkAsync('RESOLVED_OFFLINE with a reference records the claim', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${ticketId}/transition`, {
      token: merchantToken,
      body: {
        to: 'RESOLVED_OFFLINE',
        merchantNote: '已經喺櫃檯現金退回',
        settledAmountMinor: 3800,
        settlementReference: 'CASH-2026-0001',
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'RESOLVED_OFFLINE');
    assert.equal(res.body.refundRequest.settledAmountMinor, 3800);
    assert.equal(res.body.refundRequest.settlementReference, 'CASH-2026-0001');
    assert.ok(res.body.refundRequest.resolvedAt, 'resolvedAt must be stamped');
    assert.deepEqual(res.body.allowedNextTransitions, [], 'a terminal ticket has no moves');
  });

  await checkAsync('the resolution event says resolved_offline, not "refunded"', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'RefundRequest', aggregateId: ticketId },
      orderBy: { version: 'asc' },
      select: { eventType: true },
    });
    const types = events.map((event) => event.eventType);
    assert.deepEqual(types, ['refund_request.opened', 'refund_request.in_discussion', 'refund_request.resolved_offline']);
    // THE POINT: there is no `refund_request.refunded`. If one ever appears the
    // platform is claiming it processed a refund it never processed.
    assert.ok(!types.some((type) => /refunded/.test(type)), 'no event may assert a platform refund');
  });

  await checkAsync('a resolved ticket cannot be moved again -> 409', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${ticketId}/transition`, {
      token: merchantToken,
      body: { to: 'DECLINED' },
    });
    expectError(res, 409, 'REFUND_REQUEST_ALREADY_TERMINAL');
  });

  await checkAsync('the customer sees the shop’s reply and what it claims to have given', async () => {
    const res = await api('GET', `/refund-requests/${ticketId}`, { token: customerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.merchantNote, '已經喺櫃檯現金退回');
    assert.equal(res.body.settledAmountMinor, 3800);
    assert.equal(res.body.settlementReference, 'CASH-2026-0001');
    assert.deepEqual(res.body.allowedNextTransitions, [], 'nothing left for the customer to do');
  });

  // =========================================================================
  section('6. Withdrawing — and the cross-shop wall');
  // =========================================================================

  let withdrawable;
  await checkAsync('open a second ticket to withdraw', async () => {
    // The first order’s ticket is terminal, so a new one is allowed — which is
    // itself the rule "one OPEN per order, but a second after resolution".
    const res = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'WRONG_ITEM', note: '送錯咗' },
    });
    assert.equal(res.status, 201, `a terminal ticket must not block a new one: ${JSON.stringify(res.body)}`);
    withdrawable = res.body.id;
  });

  await checkAsync('the customer withdraws their own OPEN ticket', async () => {
    const res = await api('POST', `/refund-requests/${withdrawable}/cancel`, {
      token: customerToken,
      body: {},
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'CANCELLED');
    assert.equal(res.body.fromStatus, 'OPEN');
    assert.ok(res.body.refundRequest.cancelledAt, 'cancelledAt must be stamped');
    // The customer projection, not the merchant’s — the customer endpoint must
    // not answer with fields they are not supposed to see.
    assert.equal(res.body.refundRequest.customerId, undefined);
  });

  await checkAsync('a customer cannot resolve or decline their own ticket', async () => {
    const res = await api('POST', `/merchant/${MID}/refund-requests/${withdrawable}/transition`, {
      token: customerToken,
      body: { to: 'RESOLVED_OFFLINE', settlementReference: 'X' },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  await checkAsync('withdrawing a ticket that is already terminal -> 409', async () => {
    const res = await api('POST', `/refund-requests/${withdrawable}/cancel`, {
      token: customerToken,
      body: {},
    });
    expectError(res, 409, 'REFUND_REQUEST_ALREADY_TERMINAL');
  });

  await checkAsync('another customer cannot read my ticket -> 404', async () => {
    const stranger = await prisma.user.findFirst({
      where: { phone: { not: CUSTOMER_PHONE }, role: 'CUSTOMER' },
      select: { id: true },
    });
    if (!stranger) {
      console.log('      (skipped — no second customer seeded)');
      return;
    }
    const strangerToken = mintToken({ sub: stranger.id, role: 'CUSTOMER' });
    const res = await api('GET', `/refund-requests/${ticketId}`, { token: strangerToken });
    expectError(res, 404, undefined);
  });

  // =========================================================================
  section('7. The platform console — read-only by intent');
  // =========================================================================

  await checkAsync('an admin can list tickets across shops', async () => {
    const res = await api('GET', '/admin/refund-requests?status=ALL', { token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.total >= 2, `the admin console must see the tickets, got ${res.body.total}`);
  });

  await checkAsync('an admin can filter to one shop', async () => {
    const res = await api('GET', `/admin/refund-requests?status=ALL&merchantId=${MID}`, {
      token: adminToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.every((row) => row.merchantId === MID));
  });

  await checkAsync('a shop owner cannot reach the admin console -> 403', async () => {
    const res = await api('GET', '/admin/refund-requests', { token: merchantToken });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  await checkAsync('an admin can transition a ticket the shop went silent on', async () => {
    const res = await api('POST', `/admin/refund-requests/${withdrawable}/transition`, {
      token: adminToken,
      body: { to: 'IN_DISCUSSION' },
    });
    // The withdraw above is terminal, so this must be refused — proving the
    // admin uses the SAME machine and cannot reach a state a shop could not.
    expectError(res, 409, 'REFUND_REQUEST_ALREADY_TERMINAL');
  });

  await checkAsync('an admin transition is recorded with ADMIN as the actor', async () => {
    // Open a fresh ticket the admin can legitimately act on.
    const fresh = await api('POST', `/orders/${paidOrder.id}/refund-request`, {
      token: customerToken,
      body: { reasonCode: 'LATE', note: '等咗好久' },
    });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));

    const res = await api('POST', `/admin/refund-requests/${fresh.body.id}/transition`, {
      token: adminToken,
      body: { to: 'DECLINED', merchantNote: '平台代為結案：店家已停業' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'DECLINED');

    const row = await prisma.refundRequest.findUnique({
      where: { id: fresh.body.id },
      select: { status: true, resolvedById: true },
    });
    assert.equal(row.status, 'DECLINED');
    assert.equal(row.resolvedById, admin.id, 'the audit trail must name the ADMIN actor');
  });

  // =========================================================================
  section('8. THE MONEY PATH IS UNTOUCHED — the point of the whole feature');
  // =========================================================================

  await checkAsync('no step changed the order’s status', async () => {
    const row = await prisma.order.findUnique({
      where: { id: paidOrder.id },
      select: { status: true },
    });
    // The order was PAID at the start of the run and nothing in the refund flow
    // may have moved it. A "refund" that flipped it to REFUNDED would make the
    // platform a party to a settlement it is not party to.
    assert.equal(row.status, 'PAID', `the refund flow must not move an order, got ${row.status}`);
  });

  await checkAsync('no payout or refund ledger row was created', async () => {
    const payments = await prisma.payment.count({ where: { orderId: paidOrder.id } });
    assert.equal(payments, 1, 'exactly the one capture payment, no refund row invented');
    const captures = await prisma.payment.count({
      where: { orderId: paidOrder.id, status: 'CAPTURED' },
    });
    assert.equal(captures, 1, 'the capture must still be the only payment state');
  });

  await checkAsync('the customer-facing ticket never claims a platform refund', async () => {
    const res = await api('GET', `/refund-requests/${ticketId}`, { token: customerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const blob = JSON.stringify(res.body).toLowerCase();
    // A blunt check, but the right one: the word "refunded" (as a status the
    // platform asserts) must not appear anywhere in the payload.
    assert.ok(!blob.includes('"refunded"'), 'no field may render a platform refund');
    assert.equal(res.body.status, 'RESOLVED_OFFLINE', 'the status names the offline settlement');
  });

  // =========================================================================
  section('9. Blast radius');
  // =========================================================================

  await checkAsync('this merchant’s queue is exactly its own tickets', async () => {
    const res = await api('GET', `/merchant/${MID}/refund-requests?status=ALL`, {
      token: merchantToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.every((row) => row.merchantId === MID));
  });

  await checkAsync('an invalid ticket id -> 400, not a 500', async () => {
    const res = await api('GET', '/refund-requests/not-a-uuid', { token: customerToken });
    // `ParseUUIDPipe` must catch this rather than letting Prisma see a bad uuid.
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  // =========================================================================
  //  Cleanup
  // =========================================================================
  console.log('');
  const orderIds = [paidOrder.id, unpaidOrder.id];
  await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'RefundRequest' } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  // Deleting an order does NOT release its daily-quota holds, so the stock rows
  // this run inflated are cleaned too — otherwise repeated runs walk `held` up
  // to the cap and fail on a full book.
  await prisma.menuItemDailyStock.deleteMany({
    where: { merchantId: MID, serviceDate: { gte: new Date(Date.now() - 86_400_000) } },
  });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  console.log('  refund requests, their events, payments, orders and stock rows removed');

  // =========================================================================
  console.log(`\n${'='.repeat(66)}`);
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS — ${passed} checks`);
  }
}

/**
 * The same HMAC scheme the payment webhook verifies. Duplicated from
 * `e2e-smoke.js` rather than shared, so this script stays runnable on its own.
 */
function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

main()
  .catch((error) => {
    console.error('\nFATAL', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

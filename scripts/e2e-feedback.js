#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — cancellation policy, customer reviews, config history
// ============================================================================
//  Three features that all share one property: each of them moves money or
//  reputation on a rule that is easy to get subtly wrong, and none of them is
//  visible in a build.
//
//    A. CancellationPolicyEngine  — the refund decided at cancel time, the
//                                   customer-facing quote, and the refund
//                                   reactor honouring a 0% decision
//    B. Reviews                   — eligibility, one-per-order, the merchant
//                                   rating recompute, moderation, withdrawal
//    C. PlatformConfig history    — every write recorded, rollback restores
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   ORDER_BACKGROUND_JOBS=false node apps/api/dist/main.js
//    3. run:             node scripts/e2e-feedback.js
//
//  `ORDER_BACKGROUND_JOBS=false` matters for section A: the refund reactor is
//  normally scheduled, and a background pass firing between the cancel and the
//  assertion would settle the refund before the test could observe that the
//  decision was *not* to refund.
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

const SEEDED_SLUG = 'dim-sum-express';
const CUSTOMER_PHONE = '+85290000001';
const OWNER_PHONE = '+85290000002';
const ADMIN_PHONE = '+85290000003';

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
const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;

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
  try {
    fn();
    record(name, null);
  } catch (error) {
    record(name, error);
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
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`);
  if (code) {
    assert.equal(response.body?.error?.code, code, `expected code ${code}, got ${JSON.stringify(response.body)}`);
  }
}

// ---- bookkeeping ----------------------------------------------------------
const created = {
  orderIds: [],
  reviewIds: [],
  configBefore: null,
  /**
   * History rows this run appended.
   *
   * Collected from the `GET .../history` responses rather than filtered by key
   * or by author: `history1` returns exactly the rows this run created (the
   * seeded value lives in `platform_config`, not in the history table), and each
   * later read is a superset. Deleting by author would take a real operator's
   * earlier entries with it.
   */
  configHistoryIds: new Set(),
};

async function step(label, fn) {
  try {
    await fn();
    console.log(`  ${label}`);
  } catch (error) {
    console.log(`  ${label} — FAILED: ${String(error.message).split('\n')[0]}`);
  }
}

async function cleanup() {
  console.log('\ncleanup');

  if (created.configBefore) {
    await step('platform_config restored', async () => {
      const adminToken = mintToken({ sub: created.adminId, role: 'ADMIN' });
      for (const entry of created.configBefore) {
        if (entry.hasOverride) {
          await api('PUT', `/admin/config/${entry.key}`, {
            token: adminToken,
            body: { value: entry.value },
          });
        } else {
          await api('DELETE', `/admin/config/${entry.key}`, { token: adminToken });
        }
      }
    });
  }

  if (created.orderIds.length > 0) {
    const ids = created.orderIds;
    await step(`${ids.length} order(s), reviews and ledger rows removed`, async () => {
      await prisma.$transaction([
        prisma.review.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.refund.deleteMany({ where: { payment: { orderId: { in: ids } } } }),
        prisma.payment.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.merchantPayoutLine.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.order.deleteMany({ where: { id: { in: ids } } }),
      ]);
      await prisma.merchantPayout.deleteMany({ where: { lines: { none: {} } } });
    });
  }

  // Deleting an order does not return `held` quota, so the stock rows this run
  // created would accumulate on every repeat run until orders started failing.
  if (created.merchantId) {
    await step('daily stock rows cleared', async () => {
      await prisma.menuItemDailyStock.deleteMany({ where: { merchantId: created.merchantId } });
    });
  }

  // The recompute is authoritative, but a run that failed midway can leave the
  // seeded merchant's cached rating disagreeing with its reviews. Recompute it
  // from scratch so a repeated run starts from a known state.
  if (created.merchantId) {
    await step('merchant rating recomputed from the review table', async () => {
      await prisma.$executeRaw`
        UPDATE merchants m
           SET "ratingAvg"   = sub.avg,
               "ratingCount" = sub.cnt,
               "updatedAt"   = now()
          FROM (
            SELECT ROUND(AVG(rating)::numeric, 2) AS avg, COUNT(*)::int AS cnt
              FROM reviews
             WHERE "merchantId" = ${created.merchantId}::uuid
               AND "hiddenAt" IS NULL
          ) sub
         WHERE m.id = ${created.merchantId}::uuid
      `;
    });
  }

  if (created.configHistoryIds.size > 0) {
    await step(`${created.configHistoryIds.size} config history row(s) removed`, async () => {
      await prisma.platformConfigHistory.deleteMany({
        where: { id: { in: [...created.configHistoryIds] } },
      });
    });
  }
}

// ---- order helpers --------------------------------------------------------

/** Place an order through the real endpoint. */
async function placeOrder(customerToken, merchantId, menuItemId, quantity = 1) {
  const response = await api('POST', '/orders', {
    token: customerToken,
    body: { merchantId, items: [{ menuItemId, quantity }] },
  });
  assert.equal(response.status, 201, `place failed: ${JSON.stringify(response.body)}`);
  created.orderIds.push(response.body.id);
  return response.body;
}

/** Open an intent and settle it with a signed webhook — the real checkout path. */
async function payOrder(customerToken, orderId) {
  const intent = await api('POST', `/orders/${orderId}/payment-intent`, {
    token: customerToken,
    body: {},
  });
  assert.equal(intent.status, 200, `intent failed: ${JSON.stringify(intent.body)}`);

  const event = {
    id: `evt_feedback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
  const webhook = await api('POST', '/webhooks/payments/stripe', {
    body: event,
    headers: { 'stripe-signature': stripeSignature(JSON.stringify(event), STRIPE_WEBHOOK_SECRET) },
  });
  assert.equal(webhook.status, 200, `webhook failed: ${JSON.stringify(webhook.body)}`);
  assert.equal(webhook.body.handled, true, `webhook not handled: ${JSON.stringify(webhook.body)}`);
  return intent.body.providerRef;
}

/** Merchant-side transition helper. Returns the raw response. */
function merchantAction(ownerToken, merchantId, orderId, action) {
  return api('POST', `/merchant/${merchantId}/orders/${orderId}/${action}`, { token: ownerToken });
}

async function assertMerchantAction(ownerToken, merchantId, orderId, action) {
  const response = await merchantAction(ownerToken, merchantId, orderId, action);
  assert.equal(response.status, 200, `${action} failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

/** Walk an order all the way to COMPLETED through the merchant endpoints. */
async function completeOrder(ownerToken, merchantId, orderId) {
  await assertMerchantAction(ownerToken, merchantId, orderId, 'accept');
  await assertMerchantAction(ownerToken, merchantId, orderId, 'start-preparing');
  await assertMerchantAction(ownerToken, merchantId, orderId, 'mark-ready');
  await assertMerchantAction(ownerToken, merchantId, orderId, 'complete');
}

// ---- main -----------------------------------------------------------------
async function main() {
  console.log('='.repeat(66));
  console.log('Cancellation policy, reviews and config history — end to end');
  console.log('='.repeat(66));

  const merchant = await prisma.merchant.findUnique({ where: { slug: SEEDED_SLUG } });
  if (!merchant) throw new Error(`Seeded merchant ${SEEDED_SLUG} not found — run \`npm run db:seed\``);
  created.merchantId = merchant.id;

  const [customer, owner, admin] = await Promise.all([
    prisma.user.findUnique({ where: { phone: CUSTOMER_PHONE } }),
    prisma.user.findUnique({ where: { phone: OWNER_PHONE } }),
    prisma.user.findUnique({ where: { phone: ADMIN_PHONE } }),
  ]);
  if (!customer || !owner || !admin) throw new Error('Seeded users not found — run `npm run db:seed`');
  created.adminId = admin.id;

  const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
  const ownerToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });
  const adminToken = mintToken({ sub: admin.id, role: 'ADMIN' });

  const items = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id, availability: 'AVAILABLE', isMainItem: true },
    orderBy: { priceMinor: 'asc' },
    take: 2,
  });
  if (items.length < 2) throw new Error('Seeded merchant needs at least two main items');
  const [cheapItem] = items;

  const baselineRating = {
    avg: merchant.ratingAvg === null ? null : Number(merchant.ratingAvg),
    count: merchant.ratingCount,
  };

  // =========================================================================
  section('A. Cancellation policy — quote, decision, and no refund at 0%');
  // =========================================================================

  // ---- A1. The quote endpoint, before anything is paid ---------------------
  const pending = await placeOrder(customerToken, merchant.id, cheapItem.id);

  const quoteUnpaid = await api('GET', `/orders/${pending.id}/cancellation-quote`, {
    token: customerToken,
  });
  check('quote on an unpaid order: cancellable, nothing to refund', () => {
    assert.equal(quoteUnpaid.status, 200, JSON.stringify(quoteUnpaid.body));
    assert.equal(quoteUnpaid.body.cancellable, true);
    assert.equal(quoteUnpaid.body.refundMinor, null, 'nothing was captured, so there is no refund');
    assert.equal(quoteUnpaid.body.tier, null);
  });

  await checkAsync('another customer asking for my quote -> 404, not a leak', async () => {
    const response = await api('GET', `/orders/${pending.id}/cancellation-quote`, {
      token: ownerToken,
    });
    assert.equal(response.status, 404, JSON.stringify(response.body));
  });

  // ---- A2. Inside the grace window: full refund ---------------------------
  const paidOrder = await placeOrder(customerToken, merchant.id, cheapItem.id);
  await payOrder(customerToken, paidOrder.id);
  await assertMerchantAction(ownerToken, merchant.id, paidOrder.id, 'accept');

  const quoteGrace = await api('GET', `/orders/${paidOrder.id}/cancellation-quote`, {
    token: customerToken,
  });
  check('quote inside the grace window: 100% back, tier FREE', () => {
    assert.equal(quoteGrace.status, 200, JSON.stringify(quoteGrace.body));
    assert.equal(quoteGrace.body.cancellable, true);
    assert.equal(quoteGrace.body.tier, 'FREE', JSON.stringify(quoteGrace.body));
    assert.equal(quoteGrace.body.refundBps, 10_000);
    assert.equal(quoteGrace.body.refundMinor, paidOrder.pricing.totalMinor);
    assert.equal(quoteGrace.body.retainedMinor, 0);
  });

  // ---- A3. Past the grace window: nothing back ----------------------------
  // Backdating `acceptedAt` is the only honest way to test a two-minute window.
  await prisma.order.update({
    where: { id: paidOrder.id },
    data: { acceptedAt: new Date(Date.now() - 30 * 60_000) },
  });

  const quoteLate = await api('GET', `/orders/${paidOrder.id}/cancellation-quote`, {
    token: customerToken,
  });
  check('quote past the grace window: 0% back, tier LATE', () => {
    assert.equal(quoteLate.status, 200, JSON.stringify(quoteLate.body));
    assert.equal(quoteLate.body.cancellable, true, 'the state machine still allows it');
    assert.equal(quoteLate.body.tier, 'LATE');
    assert.equal(quoteLate.body.refundBps, 0);
    assert.equal(quoteLate.body.refundMinor, 0);
    assert.equal(quoteLate.body.retainedMinor, paidOrder.pricing.totalMinor);
    assert.ok(quoteLate.body.reason.length > 10, 'the customer must be told why');
  });

  const cancelLate = await api('POST', `/orders/${paidOrder.id}/cancel`, {
    token: customerToken,
    body: { reason: 'changed my mind' },
  });
  check('cancelling past the grace window records a 0 refund decision', () => {
    assert.equal(cancelLate.status, 200, JSON.stringify(cancelLate.body));
    assert.equal(cancelLate.body.toStatus, 'CANCELLED');
    assert.equal(cancelLate.body.refundDueMinor, 0, 'the policy decided zero');
    assert.equal(cancelLate.body.cancellationTier, 'LATE');
  });

  const lateRow = await prisma.order.findUnique({
    where: { id: paidOrder.id },
    select: { status: true, refundDueMinor: true, cancellationTier: true },
  });
  check('the decision is persisted on the order, in the same UPDATE as the status', () => {
    assert.equal(lateRow.status, 'CANCELLED');
    assert.equal(lateRow.refundDueMinor, 0);
    assert.equal(lateRow.cancellationTier, 'LATE');
  });

  const lateRefunds = await prisma.refund.count({
    where: { payment: { orderId: paidOrder.id } },
  });
  check('no refund row was written for a 0 decision', () => {
    assert.equal(lateRefunds, 0);
  });

  // The refund reactor is the thing that would get this wrong if it ignored
  // `refundDueMinor` and fell back to "refund everything refundable".
  const sweep = await api('POST', '/admin/ops/sweep', { token: adminToken });
  check('the refund reactor leaves a 0 decision alone', () => {
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    assert.equal(sweep.body.refunds.considered, 0, JSON.stringify(sweep.body.refunds));
  });

  const stillNoRefund = await prisma.refund.count({
    where: { payment: { orderId: paidOrder.id } },
  });
  check('still no refund row after a reactor pass', () => {
    assert.equal(stillNoRefund, 0);
  });

  // ---- A4. A merchant cancelling is always 100% ---------------------------
  const merchantCancel = await placeOrder(customerToken, merchant.id, cheapItem.id);
  await payOrder(customerToken, merchantCancel.id);
  await assertMerchantAction(ownerToken, merchant.id, merchantCancel.id, 'accept');
  // Past the grace window on purpose: the merchant's fault must not depend on
  // how long they took, or a slow merchant could keep the customer's money.
  await prisma.order.update({
    where: { id: merchantCancel.id },
    data: { acceptedAt: new Date(Date.now() - 30 * 60_000) },
  });

  const cancelByMerchant = await merchantAction(
    ownerToken,
    merchant.id,
    merchantCancel.id,
    'cancel',
  );
  check('a merchant cancelling after accepting always refunds in full', () => {
    assert.equal(cancelByMerchant.status, 200, JSON.stringify(cancelByMerchant.body));
    assert.equal(cancelByMerchant.body.toStatus, 'CANCELLED');
    assert.equal(cancelByMerchant.body.refundDueMinor, merchantCancel.pricing.totalMinor);
    assert.equal(cancelByMerchant.body.cancellationTier, 'MERCHANT_FAULT');
  });

  // `REJECTED` is a separate edge, only reachable before the merchant accepted.
  const rejected = await placeOrder(customerToken, merchant.id, cheapItem.id);
  await payOrder(customerToken, rejected.id);
  const rejectResponse = await merchantAction(ownerToken, merchant.id, rejected.id, 'reject');
  check('a merchant rejecting before accepting is also a full refund', () => {
    assert.equal(rejectResponse.status, 200, JSON.stringify(rejectResponse.body));
    assert.equal(rejectResponse.body.toStatus, 'REJECTED');
    assert.equal(rejectResponse.body.refundDueMinor, rejected.pricing.totalMinor);
    assert.equal(rejectResponse.body.cancellationTier, 'MERCHANT_FAULT');
  });

  const lateCancelResponse = await merchantAction(ownerToken, merchant.id, merchantCancel.id, 'cancel');
  check('cancelling an already-cancelled order -> 409, not a second refund', () => {
    assert.equal(lateCancelResponse.status, 409, JSON.stringify(lateCancelResponse.body));
  });

  await checkAsync('the reactor issues both refunds, in full', async () => {
    const response = await api('POST', '/admin/ops/sweep', { token: adminToken });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.refunds.considered, 2, JSON.stringify(response.body.refunds));

    for (const order of [merchantCancel, rejected]) {
      const refund = await prisma.refund.findFirst({
        where: { payment: { orderId: order.id } },
        select: { amountMinor: true, status: true, requestedBy: true },
      });
      assert.ok(refund, `no refund row written for ${order.id}`);
      assert.equal(refund.amountMinor, order.pricing.totalMinor);
      assert.equal(refund.requestedBy, null, 'an automatic refund has no human requester');
      // PAYMENT_LIVE_MODE=false: recorded, not settled.
      assert.equal(refund.status, 'PENDING');
    }
  });

  // =========================================================================
  section('B. Customer reviews');
  // =========================================================================

  const reviewOrder = await placeOrder(customerToken, merchant.id, cheapItem.id);
  await payOrder(customerToken, reviewOrder.id);

  const tooEarly = await api('GET', `/orders/${reviewOrder.id}/review/eligibility`, {
    token: customerToken,
  });
  check('an uncollected order is not reviewable, and says why', () => {
    assert.equal(tooEarly.status, 200, JSON.stringify(tooEarly.body));
    assert.equal(tooEarly.body.canReview, false);
    assert.ok(tooEarly.body.reason.length > 5, 'a bare false is not an answer');
  });

  const blocked = await api('POST', `/orders/${reviewOrder.id}/review`, {
    token: customerToken,
    body: { rating: 5 },
  });
  check('rating an uncollected order -> 422 ORDER_NOT_REVIEWABLE', () => {
    expectError(blocked, 422, 'ORDER_NOT_REVIEWABLE');
  });

  await completeOrder(ownerToken, merchant.id, reviewOrder.id);

  const eligible = await api('GET', `/orders/${reviewOrder.id}/review/eligibility`, {
    token: customerToken,
  });
  check('a completed order is reviewable, with a deadline', () => {
    assert.equal(eligible.status, 200, JSON.stringify(eligible.body));
    assert.equal(eligible.body.canReview, true, JSON.stringify(eligible.body));
    assert.equal(eligible.body.existingReviewId, null);
    assert.ok(eligible.body.reviewDeadline, 'the window must be stated');
  });

  const badRating = await api('POST', `/orders/${reviewOrder.id}/review`, {
    token: customerToken,
    body: { rating: 6 },
  });
  check('rating 6 -> 400, refused by validation before any business rule', () => {
    assert.equal(badRating.status, 400, JSON.stringify(badRating.body));
  });

  const badTag = await api('POST', `/orders/${reviewOrder.id}/review`, {
    token: customerToken,
    body: { rating: 5, tags: ['DELICIOUS'] },
  });
  check('a tag outside the fixed vocabulary -> 400', () => {
    assert.equal(badTag.status, 400, JSON.stringify(badTag.body));
  });

  const created5 = await api('POST', `/orders/${reviewOrder.id}/review`, {
    token: customerToken,
    body: { rating: 5, comment: '  蝦餃皮薄餡靚  ', tags: ['TASTE', 'TASTE', 'VALUE'] },
  });
  check('a review is created, its comment trimmed and its tags de-duplicated', () => {
    assert.equal(created5.status, 201, JSON.stringify(created5.body));
    assert.equal(created5.body.rating, 5);
    assert.equal(created5.body.comment, '蝦餃皮薄餡靚');
    assert.deepEqual(created5.body.tags, ['TASTE', 'VALUE'], JSON.stringify(created5.body.tags));
    assert.equal(created5.body.merchantName, merchant.name);
    created.reviewIds.push(created5.body.id);
  });

  check('the public projection never carries the reviewer’s full name', () => {
    const name = created5.body.authorName;
    assert.ok(name.length > 0, 'no author name at all');
    assert.ok(name !== customer.displayName, `leaked the full display name: ${name}`);
    assert.ok(name.includes('＊') || name.length <= 1, `not masked: ${name}`);
  });

  const afterCreate = await prisma.merchant.findUnique({
    where: { id: merchant.id },
    select: { ratingAvg: true, ratingCount: true },
  });
  check('the merchant’s cached rating was recomputed, not incremented', () => {
    assert.equal(afterCreate.ratingCount, baselineRating.count + 1);
    assert.equal(Number(afterCreate.ratingAvg), 5);
  });

  const duplicate = await api('POST', `/orders/${reviewOrder.id}/review`, {
    token: customerToken,
    body: { rating: 1 },
  });
  check('rating the same order twice -> 409 REVIEW_ALREADY_EXISTS', () => {
    expectError(duplicate, 409, 'REVIEW_ALREADY_EXISTS');
  });

  const foreignEdit = await api('PUT', `/reviews/${created5.body.id}`, {
    token: ownerToken,
    body: { rating: 1 },
  });
  check('editing somebody else’s review -> 403 REVIEW_NOT_OWNED', () => {
    expectError(foreignEdit, 403, 'REVIEW_NOT_OWNED');
  });

  const edited = await api('PUT', `/reviews/${created5.body.id}`, {
    token: customerToken,
    body: { rating: 3, comment: '  ' },
  });
  check('an edit is allowed after the window closes, and a blank comment clears it', () => {
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rating, 3);
    assert.equal(edited.body.comment, null, 'whitespace is not a comment');
  });

  const afterEdit = await prisma.merchant.findUnique({
    where: { id: merchant.id },
    select: { ratingAvg: true },
  });
  check('changing the rating moves the cached average', () => {
    assert.equal(Number(afterEdit.ratingAvg), 3);
  });

  // ---- public list --------------------------------------------------------
  const publicList = await api('GET', `/merchants/${merchant.id}/reviews`);
  check('the public review list is readable without a token, with a summary', () => {
    assert.equal(publicList.status, 200, JSON.stringify(publicList.body));
    assert.equal(publicList.body.data.length, 1);
    assert.equal(publicList.body.summary.count, 1);
    assert.equal(publicList.body.summary.average, 3);
    assert.deepEqual(publicList.body.summary.distribution, [0, 0, 1, 0, 0]);
    assert.equal(publicList.body.summary.positiveShareBps, 0);
    assert.equal(publicList.body.hasMore, false);
  });

  const badCursor = await api('GET', `/merchants/${merchant.id}/reviews?limit=999`);
  check('an oversized ?limit is clamped rather than honoured', () => {
    assert.equal(badCursor.status, 200, JSON.stringify(badCursor.body));
    assert.ok(badCursor.body.data.length <= 50);
  });

  // ---- merchant reply ----------------------------------------------------
  const reply = await api('POST', `/merchant/${merchant.id}/reviews/${created5.body.id}/reply`, {
    token: ownerToken,
    body: { reply: '  多謝支持，下次見！  ' },
  });
  check('the merchant can reply, and the reply is trimmed', () => {
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.merchantReply, '多謝支持，下次見！');
    assert.ok(reply.body.merchantRepliedAt, 'the reply timestamp must be stamped');
  });

  const emptyReply = await api('POST', `/merchant/${merchant.id}/reviews/${created5.body.id}/reply`, {
    token: ownerToken,
    body: { reply: '   ' },
  });
  check('an empty reply -> 403 REVIEW_REPLY_NOT_ALLOWED', () => {
    expectError(emptyReply, 403, 'REVIEW_REPLY_NOT_ALLOWED');
  });

  const foreignMerchant = await api('GET', `/merchant/${merchant.id}/reviews`, {
    token: customerToken,
  });
  check('a customer cannot read the merchant console list -> 403', () => {
    assert.equal(foreignMerchant.status, 403, JSON.stringify(foreignMerchant.body));
  });

  // ---- moderation --------------------------------------------------------
  const hide = await api('POST', `/admin/reviews/${created5.body.id}/hide`, {
    token: adminToken,
    body: { reason: '包含個人資料' },
  });
  check('an operator can hide a review', () => {
    assert.equal(hide.status, 200, JSON.stringify(hide.body));
    assert.ok(hide.body.hiddenAt, 'hiddenAt must be stamped');
    assert.equal(hide.body.hiddenReason, '包含個人資料');
  });

  const afterHide = await prisma.merchant.findUnique({
    where: { id: merchant.id },
    select: { ratingAvg: true, ratingCount: true },
  });
  check('a hidden review stops counting towards the rating', () => {
    assert.equal(afterHide.ratingCount, baselineRating.count, 'it must be excluded, not just hidden');
    assert.equal(
      afterHide.ratingAvg === null ? null : Number(afterHide.ratingAvg),
      baselineRating.avg,
    );
  });

  const hiddenFromPublic = await api('GET', `/merchants/${merchant.id}/reviews`);
  check('a hidden review is gone from the public list', () => {
    assert.equal(hiddenFromPublic.body.data.length, 0);
    assert.equal(hiddenFromPublic.body.summary.count, 0);
    assert.equal(hiddenFromPublic.body.summary.average, null, 'null, never 0');
  });

  const merchantSeesHidden = await api(
    'GET',
    `/merchant/${merchant.id}/reviews?visibility=HIDDEN`,
    { token: ownerToken },
  );
  check('the merchant can still see it was hidden, and why', () => {
    assert.equal(merchantSeesHidden.status, 200, JSON.stringify(merchantSeesHidden.body));
    assert.equal(merchantSeesHidden.body.data.length, 1);
    assert.equal(merchantSeesHidden.body.data[0].hiddenReason, '包含個人資料');
  });

  const editWhileHidden = await api('PUT', `/reviews/${created5.body.id}`, {
    token: customerToken,
    body: { rating: 5 },
  });
  check('the author cannot rewrite a review under moderation -> 403', () => {
    expectError(editWhileHidden, 403, 'REVIEW_REPLY_NOT_ALLOWED');
  });

  const unhide = await api('POST', `/admin/reviews/${created5.body.id}/unhide`, {
    token: adminToken,
  });
  check('an operator can reverse a hide', () => {
    assert.equal(unhide.status, 200, JSON.stringify(unhide.body));
    assert.equal(unhide.body.hiddenAt, null);
  });

  const afterUnhide = await prisma.merchant.findUnique({
    where: { id: merchant.id },
    select: { ratingAvg: true, ratingCount: true },
  });
  check('unhiding puts the review back into the rating', () => {
    assert.equal(afterUnhide.ratingCount, baselineRating.count + 1);
    assert.equal(Number(afterUnhide.ratingAvg), 3);
  });

  const queue = await api('GET', '/admin/reviews?visibility=ALL', { token: adminToken });
  check('the moderation queue defaults to showing everything, and carries identity', () => {
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const row = queue.body.data.find((entry) => entry.id === created5.body.id);
    assert.ok(row, 'the review is missing from the queue');
    assert.equal(row.customerId, customer.id);
    assert.ok(row.merchantName, 'an operator needs to know which shop');
  });

  const nonAdmin = await api('GET', '/admin/reviews', { token: customerToken });
  check('a customer cannot read the moderation queue -> 403', () => {
    assert.equal(nonAdmin.status, 403, JSON.stringify(nonAdmin.body));
  });

  // ---- withdrawal --------------------------------------------------------
  const mine = await api('GET', '/me/reviews', { token: customerToken });
  check('the author can list their own reviews', () => {
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.ok(mine.body.data.some((entry) => entry.id === created5.body.id));
  });

  const withdrawn = await api('DELETE', `/reviews/${created5.body.id}`, {
    token: customerToken,
  });
  check('the author can withdraw their review -> 204', () => {
    assert.equal(withdrawn.status, 204, JSON.stringify(withdrawn.body));
  });

  const afterWithdraw = await prisma.merchant.findUnique({
    where: { id: merchant.id },
    select: { ratingAvg: true, ratingCount: true },
  });
  check('withdrawing a review removes it from the rating, with no residue', () => {
    assert.equal(afterWithdraw.ratingCount, baselineRating.count);
    assert.equal(
      afterWithdraw.ratingAvg === null ? null : Number(afterWithdraw.ratingAvg),
      baselineRating.avg,
      'a withdrawn one-star review must not keep dragging the average down',
    );
  });

  const gone = await prisma.review.findUnique({ where: { id: created5.body.id } });
  check('withdrawal is a hard delete — the row is gone', () => {
    assert.equal(gone, null);
  });

  // =========================================================================
  section('C. platform_config history and rollback');
  // =========================================================================

  // A real registry key, so the whole resolution path is exercised.
  const KEY = 'cancellation.refund_bps_late';
  const configNow = await api('GET', '/admin/config', { token: adminToken });
  const keyRow = (configNow.body ?? []).find((row) => row.key === KEY);
  check('the cancellation keys appear on the config screen', () => {
    assert.ok(keyRow, `${KEY} is missing from the registry`);
    assert.equal(keyRow.namespace, 'cancellation');
    assert.equal(keyRow.isPricingKey, false);
    assert.equal(keyRow.fallback, 0);
    assert.equal(keyRow.effectiveValue, 0, 'read off the live policy');
  });

  created.configBefore = (configNow.body ?? [])
    .filter((row) => row.key.startsWith('cancellation.'))
    .map((row) => ({ key: row.key, value: row.value, hasOverride: row.hasOverride }));

  const before = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  check('the history endpoint answers, and starts from a known length', () => {
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.ok(Array.isArray(before.body));
  });

  /**
   * A baseline rather than a clean slate.
   *
   * A previous run that failed midway can leave rows behind, so the assertions
   * below are all relative to how long the trail already was. Clearing it would
   * make the test green at the cost of deleting a real operator's history from
   * the developer's database — a test is not allowed to do that.
   *
   * Every read returns newest-first, so the first `n` rows after the n-th write
   * are always the ones this run created.
   */
  const baseline = before.body.length;
  const trackNewHistory = (response, count) => {
    for (const row of response.body.slice(0, count)) created.configHistoryIds.add(row.id);
  };

  const unknownKey = await api('PUT', '/admin/config/e2e.not_a_key', {
    token: adminToken,
    body: { value: 1 },
  });
  check('writing an unknown key -> 422, and nothing is stored', () => {
    expectError(unknownKey, 422, 'PLATFORM_CONFIG_INVALID');
  });

  const outOfRange = await api('PUT', `/admin/config/${KEY}`, {
    token: adminToken,
    body: { value: 10_001 },
  });
  check('a refund ratio above 100% -> 422', () => {
    expectError(outOfRange, 422, 'PLATFORM_CONFIG_INVALID');
  });

  const fractional = await api('PUT', `/admin/config/${KEY}`, {
    token: adminToken,
    body: { value: 0.5 },
  });
  check('a fractional ratio -> 422, because basis points are integers', () => {
    expectError(fractional, 422, 'PLATFORM_CONFIG_INVALID');
  });

  const afterRejections = await api('GET', `/admin/config/${KEY}/history`, {
    token: adminToken,
  });
  check('a refused write leaves no trace in the history', () => {
    assert.equal(afterRejections.body.length, baseline, 'validation failures must not be recorded');
  });

  // `post-init.sql` seeds this key, so there IS a row before we touch it. Every
  // expectation below is relative to that seeded value rather than to `null` —
  // which is the point: "roll back to the previous value" has to mean the value
  // that was actually there, not "delete everything".
  const seededValue = keyRow.hasOverride ? keyRow.value : null;

  const write1 = await api('PUT', `/admin/config/${KEY}`, {
    token: adminToken,
    body: { value: 5_000 },
  });
  check('a write is accepted and the live policy moves with it', () => {
    assert.equal(write1.status, 200, JSON.stringify(write1.body));
    assert.equal(write1.body.value, 5_000);
    assert.equal(write1.body.effectiveValue, 5_000, 'the engine must see it without a restart');
  });

  const history1 = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  trackNewHistory(history1, 1);
  check('the write is recorded, with the value it replaced', () => {
    assert.equal(history1.status, 200, JSON.stringify(history1.body));
    assert.equal(history1.body.length, baseline + 1, JSON.stringify(history1.body));
    assert.equal(history1.body[0].action, 'UPSERT');
    assert.equal(history1.body[0].newValue, 5_000);
    assert.equal(history1.body[0].previousValue, seededValue);
    assert.equal(history1.body[0].changedById, admin.id);
  });

  // The policy must actually use the new number, or the history is decoration.
  const lateOrder = await placeOrder(customerToken, merchant.id, cheapItem.id);
  await payOrder(customerToken, lateOrder.id);
  await assertMerchantAction(ownerToken, merchant.id, lateOrder.id, 'accept');
  await prisma.order.update({
    where: { id: lateOrder.id },
    data: { acceptedAt: new Date(Date.now() - 30 * 60_000) },
  });
  const quoteAt50 = await api('GET', `/orders/${lateOrder.id}/cancellation-quote`, {
    token: customerToken,
  });
  check('a live policy change is reflected in the very next quote', () => {
    assert.equal(quoteAt50.status, 200, JSON.stringify(quoteAt50.body));
    assert.equal(quoteAt50.body.refundBps, 5_000, 'the reload did not reach the engine');
    assert.equal(quoteAt50.body.refundMinor, Math.round(lateOrder.pricing.totalMinor / 2));
  });

  const write2 = await api('PUT', `/admin/config/${KEY}`, {
    token: adminToken,
    body: { value: 2_500 },
  });
  check('a second write is accepted', () => {
    assert.equal(write2.status, 200, JSON.stringify(write2.body));
    assert.equal(write2.body.effectiveValue, 2_500);
  });

  const history2 = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  trackNewHistory(history2, 2);
  check('history is append-only and newest-first', () => {
    assert.equal(history2.body.length, baseline + 2, JSON.stringify(history2.body));
    assert.equal(history2.body[0].newValue, 2_500);
    assert.equal(history2.body[0].previousValue, 5_000);
    assert.equal(history2.body[1].newValue, 5_000);
    assert.equal(history2.body[1].previousValue, seededValue);
  });

  // Roll back the *second* write, whose `previousValue` is 5000 — the
  // unambiguous "put it back the way it was" case.
  const secondWriteHistoryId = history2.body[0].id;
  const rollback = await api('POST', `/admin/config/${KEY}/rollback/${secondWriteHistoryId}`, {
    token: adminToken,
  });
  check('rolling back restores the value that row recorded as previous', () => {
    assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
    assert.equal(rollback.body.value, 5_000, JSON.stringify(rollback.body));
    assert.equal(rollback.body.effectiveValue, 5_000);
  });

  const history3 = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  trackNewHistory(history3, 3);
  check('the rollback is itself recorded — the trail keeps its holes filled', () => {
    assert.equal(history3.body.length, baseline + 3, JSON.stringify(history3.body));
    assert.equal(history3.body[0].action, 'ROLLBACK');
    assert.equal(history3.body[0].newValue, 5_000);
    assert.equal(history3.body[0].previousValue, 2_500);
  });

  const badHistory = await api(
    'POST',
    `/admin/config/${KEY}/rollback/00000000-0000-4000-8000-000000000000`,
    { token: adminToken },
  );
  check('rolling back to a history row that does not exist -> 404', () => {
    assert.equal(badHistory.status, 404, JSON.stringify(badHistory.body));
  });

  const crossKey = await api('POST', `/admin/config/pricing.payment_fee_rate_bps/rollback/${secondWriteHistoryId}`, {
    token: adminToken,
  });
  check('a history id from another key -> 404, not a cross-key write', () => {
    assert.equal(crossKey.status, 404, JSON.stringify(crossKey.body));
  });

  const removed = await api('DELETE', `/admin/config/${KEY}`, { token: adminToken });
  check('removing the override reverts to the environment default', () => {
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.hasOverride, false);
    assert.equal(removed.body.value, null);
    assert.equal(removed.body.effectiveValue, 0);
  });

  const history4 = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  trackNewHistory(history4, 4);
  check('the removal is recorded with a null new value', () => {
    assert.equal(history4.body.length, baseline + 4, JSON.stringify(history4.body));
    assert.equal(history4.body[0].action, 'DELETE');
    assert.equal(history4.body[0].newValue, null);
    assert.equal(history4.body[0].previousValue, 5_000);
  });

  const rollbackToRestore = await api(
    'POST',
    `/admin/config/${KEY}/rollback/${history4.body[0].id}`,
    { token: adminToken },
  );
  check('rolling back a removal brings the override back', () => {
    assert.equal(rollbackToRestore.status, 200, JSON.stringify(rollbackToRestore.body));
    assert.equal(rollbackToRestore.body.value, 5_000);
    assert.equal(rollbackToRestore.body.effectiveValue, 5_000);
  });

  const finalHistory = await api('GET', `/admin/config/${KEY}/history`, { token: adminToken });
  trackNewHistory(finalHistory, 5);
  check('the trail grew by exactly the five writes this section made', () => {
    assert.equal(finalHistory.body.length, baseline + 5, JSON.stringify(finalHistory.body));
  });

  const nonAdminConfig = await api('GET', `/admin/config/${KEY}/history`, {
    token: ownerToken,
  });
  check('a merchant cannot read the config history -> 403', () => {
    assert.equal(nonAdminConfig.status, 403, JSON.stringify(nonAdminConfig.body));
  });

  // =========================================================================
  section('D. The two policies agree with each other');
  // =========================================================================
  const cancellationPolicyView = await api('GET', '/admin/config/cancellation', {
    token: adminToken,
  });
  check('the live cancellation policy is readable and complete', () => {
    assert.equal(cancellationPolicyView.status, 200, JSON.stringify(cancellationPolicyView.body));
    assert.equal(cancellationPolicyView.body.graceMinutes, 2);
    for (const tier of ['FREE', 'LATE', 'NON_REFUNDABLE', 'MERCHANT_FAULT', 'PLATFORM_FAULT', 'GOODWILL']) {
      assert.equal(
        typeof cancellationPolicyView.body.refundBps[tier],
        'number',
        `${tier} is missing`,
      );
    }
  });

  const pricingView = await api('GET', '/admin/config/pricing', { token: adminToken });
  check('the pricing policy is unaffected by the cancellation keys', () => {
    assert.equal(pricingView.status, 200, JSON.stringify(pricingView.body));
    assert.equal(pricingView.body.platformFee.feePerMainItemMinor, 350);
  });
}

// ---- run ------------------------------------------------------------------
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
    } catch (cleanupError) {
      console.error(`  cleanup also failed: ${cleanupError.message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

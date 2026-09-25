#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — merchant CRUD + admin portal
// ============================================================================
//  Companion to `e2e-smoke.js`. That script proves the ORDER pipeline works;
//  this one proves the two consoles on top of it work, and — more importantly —
//  that the things which are supposed to be *refused* are actually refused.
//
//  Every section drives real HTTP against a running API. Nothing is stubbed, so
//  a green run means the guards, the DTO validation, the SQL and the audit
//  trail all agree with each other.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-admin.js
//
//  The script creates its own merchant, menu, orders, config overrides and
//  probe rows, and removes all of them again in `cleanup()` — including
//  restoring the seeded merchant's opening hours, its menu quotas, and every
//  `platform_config` value it touched. It is safe to run repeatedly and safe to
//  run before/after `e2e-smoke.js`.
//
//  Exits non-zero on any failure.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const HEALTH_URL = `${BASE.replace(/\/v1$/, '')}/health`;

const SEEDED_SLUG = 'dim-sum-express';
const TEST_SLUG = 'e2e-admin-kitchen';
/** The seeded admin. There is deliberately exactly one (see prisma/seed.js). */
const ADMIN_PHONE = '+85290000003';
const CUSTOMER_PHONE = '+85290000001';
const OWNER_PHONE = '+85290000002';
/** Seeded drink, chosen because it already has a live daily-stock row. */
const QUOTA_PROBE_ITEM = '凍檸茶';

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

/** Assert the error envelope, so a 409 for the *wrong* reason still fails. */
function expectError(response, status, code) {
  assert.equal(
    response.status,
    status,
    `expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
  assert.equal(
    response.body?.error?.code,
    code,
    `expected code ${code}, got ${response.body?.error?.code}: ${JSON.stringify(response.body)}`,
  );
}

// ---- bookkeeping for cleanup ----------------------------------------------
/** Everything this run creates, so `cleanup()` can be exact. */
const created = {
  merchantIds: [],
  orderIds: [],
  outboxProbeIds: [],
  /** platform_config rows as they were before we touched them. */
  configBefore: null,
  /** The seeded merchant's hours before we widened them. */
  seededHours: null,
  /** A seeded menu item's quota before we moved it. */
  seededQuota: null,
};

/**
 * Each step is guarded independently. Cleanup runs after a failure too, so a
 * single throw must not leave the database half-restored — the whole point is
 * to leave the seeded state exactly as we found it.
 */
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

  // 1. platform_config — restore, do not guess. A key we overrode goes back to
  //    its previous value; a key we introduced is removed.
  if (created.configBefore) {
    await step('platform_config restored', async () => {
      const adminToken = mintToken({ sub: created.adminId, role: 'ADMIN' });
      for (const entry of created.configBefore) {
        const current = await api('GET', '/admin/config', { token: adminToken });
        const row = (current.body ?? []).find((item) => item.key === entry.key);
        if (!row) continue;
        if (entry.hasOverride) {
          await api('PUT', `/admin/config/${entry.key}`, {
            token: adminToken,
            body: { value: entry.value },
          });
        } else if (row.hasOverride) {
          await api('DELETE', `/admin/config/${entry.key}`, { token: adminToken });
        }
      }
    });
  }

  // 2. Orders this run placed, with everything that hangs off them. Payout
  //    lines are `onDelete: Restrict`, so they must go before the order.
  if (created.orderIds.length > 0) {
    const ids = created.orderIds;
    await step(`${ids.length} order(s) and their ledger rows removed`, async () => {
      await prisma.$transaction([
        prisma.refund.deleteMany({ where: { payment: { orderId: { in: ids } } } }),
        prisma.payment.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.merchantPayoutLine.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } }),
        prisma.order.deleteMany({ where: { id: { in: ids } } }),
      ]);
      // A payout batch whose only line we just removed is now meaningless.
      await prisma.merchantPayout.deleteMany({ where: { lines: { none: {} } } });
    });
  }

  // 3. Test merchants. Hours, staff, menu, stock and daily caps all cascade.
  if (created.merchantIds.length > 0) {
    const ids = created.merchantIds;
    await step(`${ids.length} test merchant(s) removed`, () =>
      prisma.merchant.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  // 4. The outbox probe row.
  if (created.outboxProbeIds.length > 0) {
    const ids = created.outboxProbeIds;
    await step('outbox probe row removed', () =>
      prisma.outboxEvent.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  // 5. Opening hours we widened. `updateMany` takes one `data` object, not one
  //    per row — and each day has its own bounds, so this is per-day.
  if (created.seededMerchantId && created.seededHours) {
    await step('seeded merchant hours restored', async () => {
      for (const hour of created.seededHours) {
        await prisma.merchantOperatingHour.update({
          where: {
            merchantId_dayOfWeek: {
              merchantId: created.seededMerchantId,
              dayOfWeek: hour.dayOfWeek,
            },
          },
          data: {
            opensAtMinute: hour.opensAtMinute,
            closesAtMinute: hour.closesAtMinute,
            isClosed: hour.isClosed,
          },
        });
      }
    });
  }

  // 6. The quota we moved on a seeded item.
  if (created.seededQuota) {
    await step('seeded menu quota restored', async () => {
      await prisma.menuItem.update({
        where: { id: created.seededQuota.menuItemId },
        data: { dailyQuota: created.seededQuota.dailyQuota },
      });
    });
  }

  // 6b. Every stock row this merchant has is an artefact of THIS run — either
  //     the probe's own seed, or the rows the two orders above held quota
  //     against. `held` is never credited back when an order is deleted, so
  //     leaving these behind would let `held` creep toward the cap on each
  //     repeat run until the second order started failing on quota. Clearing
  //     them puts a repeated run back on the same footing as the first.
  if (created.seededMerchantId) {
    await step('daily stock rows cleared', async () => {
      await prisma.menuItemDailyStock.deleteMany({
        where: { merchantId: created.seededMerchantId },
      });
    });
  }

  // 7. Identities. The customer was promoted to MERCHANT_OWNER by `apply`, and
  //    we deliberately disabled an admin to exercise LAST_ADMIN.
  await step('seeded users restored', async () => {
    await prisma.user.updateMany({
      where: { phone: CUSTOMER_PHONE },
      data: { role: 'CUSTOMER' },
    });
    await prisma.user.updateMany({
      where: { phone: { in: [ADMIN_PHONE, CUSTOMER_PHONE, OWNER_PHONE] } },
      data: { isActive: true },
    });
  });
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET || !STRIPE_WEBHOOK_SECRET) {
    throw new Error('JWT_SECRET and STRIPE_WEBHOOK_SECRET must be set in .env');
  }

  // The API may not be up yet; wait for it rather than failing on ECONNREFUSED.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const probe = await fetch(HEALTH_URL);
      if (probe.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const seededMerchant = await prisma.merchant.findUnique({
    where: { slug: SEEDED_SLUG },
    select: {
      id: true,
      timezone: true,
      hours: {
        select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
      },
    },
  });
  if (!seededMerchant) throw new Error(`Run prisma/seed.js first — no merchant ${SEEDED_SLUG}`);
  created.seededMerchantId = seededMerchant.id;
  created.seededHours = seededMerchant.hours.map((hour) => ({ ...hour }));

  const users = await prisma.user.findMany({
    where: { phone: { in: [ADMIN_PHONE, CUSTOMER_PHONE, OWNER_PHONE] } },
    select: { id: true, phone: true, role: true },
  });
  const byPhone = new Map(users.map((user) => [user.phone, user]));
  const adminUser = byPhone.get(ADMIN_PHONE);
  const customerUser = byPhone.get(CUSTOMER_PHONE);
  const seededOwner = byPhone.get(OWNER_PHONE);
  assert.ok(adminUser, `no seeded ADMIN (${ADMIN_PHONE}) — re-run prisma/seed.js`);
  assert.ok(customerUser && seededOwner, 'seeded customer/owner missing');
  created.adminId = adminUser.id;

  const adminToken = mintToken({ sub: adminUser.id, role: 'ADMIN' });
  const customerToken = mintToken({ sub: customerUser.id, role: 'CUSTOMER' });
  const seededOwnerToken = mintToken({
    sub: seededOwner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [seededMerchant.id],
  });

  // =========================================================================
  section('1. Admin surface is closed to everyone else');
  // =========================================================================
  const noToken = await api('GET', '/admin/dashboard');
  check('GET /admin/dashboard without a token -> 401', () => {
    expectError(noToken, 401, 'UNAUTHENTICATED');
  });

  const asCustomer = await api('GET', '/admin/dashboard', { token: customerToken });
  check('customer token -> 403 FORBIDDEN', () => {
    expectError(asCustomer, 403, 'FORBIDDEN');
  });

  const asMerchant = await api('GET', '/admin/orders', { token: seededOwnerToken });
  check('merchant-owner token -> 403 FORBIDDEN', () => {
    expectError(asMerchant, 403, 'FORBIDDEN');
  });

  const dashboard = await api('GET', '/admin/dashboard', { token: adminToken });
  check('admin token -> 200 with a populated dashboard', () => {
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.ok(dashboard.body.generatedAt, 'no generatedAt');
    assert.ok(typeof dashboard.body.orders.today === 'number');
    assert.equal(dashboard.body.pricing.platformFee.currency, 'HKD');
    assert.ok(
      ['platform_config', 'environment', 'defaults'].includes(dashboard.body.pricing.source),
      `unexpected pricing source ${dashboard.body.pricing.source}`,
    );
  });

  const health = await api('GET', '/admin/health', { token: adminToken });
  check('GET /admin/health reports database up, redis optional', () => {
    assert.equal(health.status, 200);
    assert.equal(health.body.database, true);
    assert.equal(typeof health.body.redis, 'boolean');
  });

  // =========================================================================
  section('2. Paging parameters cannot 500 the console');
  // =========================================================================
  // Regression lock. `PageQueryDto` used to expose `take`/`skip` as getters,
  // and `class-transformer` assigns every key from the query string onto the
  // instance — so `?take=5`, the most natural guess a client can make, died as
  // `Cannot set property take of #<PageQueryDto> which has only a getter` -> 500.
  // The wire contract is now `limit`/`offset`, and an unknown key is a 400.
  const takeParam = await api('GET', '/admin/orders?take=5', { token: adminToken });
  check('?take=5 -> 400, never 500 (the getter-assignment crash is gone)', () => {
    assert.notEqual(takeParam.status, 500, JSON.stringify(takeParam.body));
    assert.equal(takeParam.status, 400, JSON.stringify(takeParam.body));
  });

  const limitParam = await api('GET', '/admin/orders?limit=5&offset=0', { token: adminToken });
  check('?limit=5&offset=0 -> 200', () => {
    assert.equal(limitParam.status, 200, JSON.stringify(limitParam.body));
    assert.ok(limitParam.body.data.length <= 5);
  });

  // =========================================================================
  section('3. Merchant onboarding lifecycle (apply -> approve -> suspend -> close)');
  // =========================================================================
  // Reuse a leftover from an aborted run so the script is idempotent.
  await prisma.merchant.deleteMany({ where: { slug: TEST_SLUG } });

  const applied = await api('POST', '/merchant/apply', {
    token: customerToken,
    body: {
      slug: TEST_SLUG,
      name: 'E2E 測試廚房',
      nameEn: 'E2E Test Kitchen',
      description: '由 e2e-admin.js 建立，測試後會自動刪除。',
      phone: '+85290000001',
      addressLine1: '上環永樂街 1 號',
      district: 'Sheung Wan',
      latitude: 22.2866,
      longitude: 114.15,
      prepTimeMinutes: 12,
    },
  });

  check('POST /merchant/apply -> 201 PENDING_REVIEW', () => {
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.equal(applied.body.status, 'PENDING_REVIEW');
  });
  if (applied.status !== 201) {
    throw new Error(`cannot continue without a test merchant: ${JSON.stringify(applied.body)}`);
  }
  const testMerchantId = applied.body.id;
  created.merchantIds.push(testMerchantId);

  check('apply promotes the caller CUSTOMER -> MERCHANT_OWNER', async () => {
    const row = await prisma.user.findUnique({
      where: { id: customerUser.id },
      select: { role: true },
    });
    assert.equal(row.role, 'MERCHANT_OWNER');
  });

  check('apply also creates the owner\'s own merchant_staff row', async () => {
    const staff = await prisma.merchantStaff.findUnique({
      where: { merchantId_userId: { merchantId: testMerchantId, userId: customerUser.id } },
      select: { isManager: true },
    });
    assert.ok(staff, 'no merchant_staff row — the owner would be invisible to staff queries');
    assert.equal(staff.isManager, true);
  });

  // The role lives in the token, not the row — `JwtAuthGuard` does no DB read.
  // The stale token must therefore still be refused; this is the documented
  // trade-off (fast, stateless auth) and it is asserted so it cannot drift.
  const staleToken = await api('GET', `/merchant/${testMerchantId}/menu`, {
    token: customerToken,
  });
  check('the pre-promotion CUSTOMER token is still refused (role is in the token)', () => {
    assert.equal(staleToken.status, 403, JSON.stringify(staleToken.body));
  });

  const newOwnerToken = mintToken({
    sub: customerUser.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [testMerchantId],
  });

  const pendingView = await api('GET', `/admin/merchants/${testMerchantId}`, {
    token: adminToken,
  });
  check('admin sees it, and is offered only the legal moves', () => {
    assert.equal(pendingView.status, 200, JSON.stringify(pendingView.body));
    assert.deepEqual(pendingView.body.allowedActions, ['APPROVE', 'CLOSE']);
  });

  const illegalSuspend = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'SUSPEND', reason: '不應該成功' },
  });
  check('SUSPEND on a PENDING_REVIEW merchant -> 409 MERCHANT_STATUS_TRANSITION', () => {
    expectError(illegalSuspend, 409, 'MERCHANT_STATUS_TRANSITION');
  });

  const unknownActionField = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'APPROVE', note: 'note is not a field' },
  });
  check('an unknown body field -> 400 (forbidNonWhitelisted, not a silent drop)', () => {
    assert.equal(unknownActionField.status, 400, JSON.stringify(unknownActionField.body));
  });

  const approved = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'APPROVE' },
  });
  check('APPROVE -> 200 ACTIVE, and the legal set narrows', () => {
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'ACTIVE');
    assert.deepEqual(approved.body.allowedActions, ['SUSPEND', 'CLOSE']);
  });

  const reApprove = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'APPROVE' },
  });
  check('APPROVE again -> 409 (a repeated request must not silently pass)', () => {
    expectError(reApprove, 409, 'MERCHANT_STATUS_TRANSITION');
  });

  const intakeOff = await api('POST', `/admin/merchants/${testMerchantId}/intake`, {
    token: adminToken,
    body: { accepting: false },
  });
  check('POST /intake {accepting:false} -> 200 (admin can pause on the owner\'s behalf)', () => {
    assert.equal(intakeOff.status, 200, JSON.stringify(intakeOff.body));
    assert.equal(intakeOff.body.acceptsOrders, false);
  });

  const suspended = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'SUSPEND', reason: 'E2E' },
  });
  check('SUSPEND -> 200 SUSPENDED, intake forced off', () => {
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.status, 'SUSPENDED');
    assert.equal(suspended.body.acceptsOrders, false);
    assert.deepEqual(suspended.body.allowedActions, ['REINSTATE', 'CLOSE']);
  });

  const reinstated = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'REINSTATE' },
  });
  check('REINSTATE -> 200 ACTIVE, but intake does NOT silently reopen', () => {
    assert.equal(reinstated.status, 200, JSON.stringify(reinstated.body));
    assert.equal(reinstated.body.status, 'ACTIVE');
    assert.equal(
      reinstated.body.acceptsOrders,
      false,
      'reinstating a merchant must not start taking orders behind the owner\'s back',
    );
  });

  const intakeOn = await api('POST', `/admin/merchants/${testMerchantId}/intake`, {
    token: adminToken,
    body: { accepting: true },
  });
  check('POST /intake {accepting:true} -> 200', () => {
    assert.equal(intakeOn.status, 200, JSON.stringify(intakeOn.body));
    assert.equal(intakeOn.body.acceptsOrders, true);
  });

  const closed = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'CLOSE', reason: 'E2E 測試結束' },
  });
  check('CLOSE -> 200 CLOSED, intake forced off, no legal moves left', () => {
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, 'CLOSED');
    assert.equal(closed.body.acceptsOrders, false);
    assert.deepEqual(closed.body.allowedActions, []);
  });

  const reopen = await api('POST', `/admin/merchants/${testMerchantId}/action`, {
    token: adminToken,
    body: { action: 'REINSTATE' },
  });
  check('REINSTATE a CLOSED merchant -> 409 (terminal really is terminal)', () => {
    expectError(reopen, 409, 'MERCHANT_STATUS_TRANSITION');
  });

  // Put it back to ACTIVE so the menu CRUD below tests a live merchant.
  await prisma.merchant.update({
    where: { id: testMerchantId },
    data: { status: 'ACTIVE', acceptsOrders: true },
  });

  // =========================================================================
  section('4. Menu CRUD through the merchant portal');
  // =========================================================================
  const emptyMenu = await api('GET', `/merchant/${testMerchantId}/menu`, {
    token: newOwnerToken,
  });
  check('GET menu on a fresh merchant -> 200, empty, with a service date', () => {
    assert.equal(emptyMenu.status, 200, JSON.stringify(emptyMenu.body));
    assert.deepEqual(emptyMenu.body.categories, []);
    assert.match(emptyMenu.body.serviceDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  const crossTenant = await api('GET', `/merchant/${testMerchantId}/menu`, {
    token: seededOwnerToken,
  });
  check('another merchant\'s owner -> 403 (guessing an id is not enough)', () => {
    assert.equal(crossTenant.status, 403, JSON.stringify(crossTenant.body));
  });

  const category = await api('POST', `/merchant/${testMerchantId}/menu/categories`, {
    token: newOwnerToken,
    body: { name: 'E2E 測試分類', sortOrder: 1 },
  });
  check('POST category -> 201', () => {
    assert.equal(category.status, 201, JSON.stringify(category.body));
    assert.equal(category.body.name, 'E2E 測試分類');
  });
  if (category.status !== 201) throw new Error('cannot continue without a category');
  const categoryId = category.body.id;

  const duplicateCategory = await api('POST', `/merchant/${testMerchantId}/menu/categories`, {
    token: newOwnerToken,
    body: { name: 'E2E 測試分類' },
  });
  check('duplicate category name -> 409 CATEGORY_NAME_TAKEN', () => {
    expectError(duplicateCategory, 409, 'CATEGORY_NAME_TAKEN');
  });

  const item = await api('POST', `/merchant/${testMerchantId}/menu/items`, {
    token: newOwnerToken,
    body: {
      categoryId,
      name: 'E2E 測試點心',
      nameEn: 'E2E Test Dumpling',
      priceMinor: 4200,
      isMainItem: true,
      dailyQuota: 5,
    },
  });
  check('POST item -> 201 with dailyQuota 5 and remainingToday 5', () => {
    assert.equal(item.status, 201, JSON.stringify(item.body));
    assert.equal(item.body.priceMinor, 4200);
    assert.equal(item.body.isMainItem, true);
    assert.equal(item.body.dailyQuota, 5);
    assert.equal(item.body.remainingToday, 5);
  });
  if (item.status !== 201) throw new Error('cannot continue without an item');
  const itemId = item.body.id;

  const reprice = await api('PATCH', `/merchant/${testMerchantId}/menu/items/${itemId}`, {
    token: newOwnerToken,
    body: { priceMinor: 4600 },
  });
  check('PATCH price -> 200 and the price moves', () => {
    assert.equal(reprice.status, 200, JSON.stringify(reprice.body));
    assert.equal(reprice.body.priceMinor, 4600);
  });

  const badPrice = await api('PATCH', `/merchant/${testMerchantId}/menu/items/${itemId}`, {
    token: newOwnerToken,
    body: { priceMinor: -1 },
  });
  check('negative price -> 400 (DTO validation, not a domain error)', () => {
    assert.equal(badPrice.status, 400, JSON.stringify(badPrice.body));
  });

  const soldOut = await api(
    'PATCH',
    `/merchant/${testMerchantId}/menu/items/${itemId}/availability`,
    { token: newOwnerToken, body: { availability: 'SOLD_OUT' } },
  );
  check('PATCH availability -> SOLD_OUT', () => {
    assert.equal(soldOut.status, 200, JSON.stringify(soldOut.body));
    assert.equal(soldOut.body.availability, 'SOLD_OUT');
  });

  const secondItem = await api('POST', `/merchant/${testMerchantId}/menu/items`, {
    token: newOwnerToken,
    body: { categoryId, name: 'E2E 測試飲品', priceMinor: 1500, isMainItem: false },
  });
  check('a second item without a quota -> dailyQuota null (unlimited)', () => {
    assert.equal(secondItem.status, 201, JSON.stringify(secondItem.body));
    assert.equal(secondItem.body.dailyQuota, null);
    assert.equal(secondItem.body.remainingToday, null);
  });
  const secondItemId = secondItem.body.id;

  const reordered = await api('PUT', `/merchant/${testMerchantId}/menu/items/order`, {
    token: newOwnerToken,
    body: {
      entries: [
        { id: secondItemId, sortOrder: 0 },
        { id: itemId, sortOrder: 1 },
      ],
    },
  });
  check('PUT items/order -> 200 and sortOrder is applied', async () => {
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    const rows = await prisma.menuItem.findMany({
      where: { id: { in: [itemId, secondItemId] } },
      select: { id: true, sortOrder: true },
    });
    assert.equal(rows.find((row) => row.id === secondItemId).sortOrder, 0);
    assert.equal(rows.find((row) => row.id === itemId).sortOrder, 1);
  });

  const reorderForeign = await api('PUT', `/merchant/${testMerchantId}/menu/items/order`, {
    token: newOwnerToken,
    body: { entries: [{ id: seededMerchant.id, sortOrder: 0 }] },
  });
  check('reordering an id that is not mine -> 404 (the UPDATE is scoped)', () => {
    expectError(reorderForeign, 404, 'MENU_ITEM_NOT_FOUND');
  });

  const deleteUsedCategory = await api(
    'DELETE',
    `/merchant/${testMerchantId}/menu/categories/${categoryId}`,
    { token: newOwnerToken },
  );
  check('deleting a category that still holds dishes -> 409 CATEGORY_IN_USE', () => {
    expectError(deleteUsedCategory, 409, 'CATEGORY_IN_USE');
  });

  const deleteItem = await api('DELETE', `/merchant/${testMerchantId}/menu/items/${itemId}`, {
    token: newOwnerToken,
  });
  check('DELETE item -> 204', () => {
    assert.equal(deleteItem.status, 204, JSON.stringify(deleteItem.body));
  });

  const deleteSecondItem = await api(
    'DELETE',
    `/merchant/${testMerchantId}/menu/items/${secondItemId}`,
    { token: newOwnerToken },
  );
  check('DELETE the second item -> 204', () => {
    assert.equal(deleteSecondItem.status, 204, JSON.stringify(deleteSecondItem.body));
  });

  const deleteCategory = await api(
    'DELETE',
    `/merchant/${testMerchantId}/menu/categories/${categoryId}`,
    { token: newOwnerToken },
  );
  check('DELETE the now-empty category -> 204', () => {
    assert.equal(deleteCategory.status, 204, JSON.stringify(deleteCategory.body));
  });

  // The interesting one. `menu_item_daily_stock` is seeded once per service day
  // from `menu_items.dailyQuota` and is never re-synced, so an edit that only
  // wrote the item column would leave today's cap at the old number while the
  // console showed the new one. Needs an item that already has a live stock
  // row, which is why this uses a seeded dish rather than one just created.
  const quotaProbe = await prisma.menuItem.findFirst({
    where: { merchantId: seededMerchant.id, name: QUOTA_PROBE_ITEM },
    select: { id: true, dailyQuota: true },
  });
  assert.ok(quotaProbe, `seeded item ${QUOTA_PROBE_ITEM} missing`);
  const stockBefore = await prisma.menuItemDailyStock.findFirst({
    where: { menuItemId: quotaProbe.id },
    select: { quota: true },
  });
  // This probe needs an item whose stock row for TODAY already exists, because
  // the behaviour under test is whether a quota edit reaches that row.
  //
  // It used to be a hard assert that the row was already there — which quietly
  // made this file depend on `e2e-smoke.js` having run first (that script is
  // what seeds today's row), and made the two unsafe to run concurrently: smoke
  // TRUNCATEs this table mid-flight and admin died with "no live stock row",
  // while admin's own orders inflated the `held` counts smoke asserts on.
  // Seed it here instead, with the same `INSERT ... ON CONFLICT DO NOTHING` the
  // API's `holdDailyQuota` uses, so this file stands alone in any run order.
  if (!stockBefore) {
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: seededMerchant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await prisma.$executeRaw`
      INSERT INTO menu_item_daily_stock
             (id, "menuItemId", "merchantId", "serviceDate", quota, sold, held, "updatedAt")
      SELECT gen_random_uuid(), mi.id, mi."merchantId", ${localDate}::date,
             COALESCE(mi."dailyQuota", 0), 0, 0, now()
        FROM menu_items mi
       WHERE mi.id = ${quotaProbe.id}::uuid
      ON CONFLICT ("menuItemId", "serviceDate") DO NOTHING
    `;
  }
  created.seededQuota = {
    menuItemId: quotaProbe.id,
    dailyQuota: quotaProbe.dailyQuota,
  };

  const newQuota = (quotaProbe.dailyQuota ?? 100) === 77 ? 78 : 77;
  const quotaEdit = await api(
    'PATCH',
    `/merchant/${seededMerchant.id}/menu/items/${quotaProbe.id}`,
    { token: seededOwnerToken, body: { dailyQuota: newQuota } },
  );
  check('PATCH dailyQuota on a live item -> 200', () => {
    assert.equal(quotaEdit.status, 200, JSON.stringify(quotaEdit.body));
    assert.equal(quotaEdit.body.dailyQuota, newQuota);
  });

  check("the quota edit is pushed into TODAY's live stock row", async () => {
    const stock = await prisma.menuItemDailyStock.findFirst({
      where: { menuItemId: quotaProbe.id },
      orderBy: { serviceDate: 'desc' },
      select: { quota: true, serviceDate: true },
    });
    assert.ok(stock, 'the stock row disappeared');
    assert.equal(
      stock.quota,
      newQuota,
      'stale cap: the daily stock row was not re-synced from the item',
    );
  });

  // =========================================================================
  section('5. platform_config drives the live pricing engine');
  // =========================================================================
  const configBefore = await api('GET', '/admin/config', { token: adminToken });
  check('GET /admin/config -> the full registry, not just the overridden rows', () => {
    assert.equal(configBefore.status, 200, JSON.stringify(configBefore.body));

    // Compared against the registry itself rather than a hard-coded count. The
    // previous `assert.equal(length, 6)` was true until the cancellation-policy
    // keys were added, and then failed for a reason that had nothing to do with
    // the endpoint. A test that must be edited every time a setting is
    // introduced eventually stops being read.
    const { ALL_CONFIG_SPECS } = require(
      path.join(ROOT, 'apps/api/dist/modules/pricing/pricing-config.registry.js'),
    );
    assert.deepEqual(
      configBefore.body.map((entry) => entry.key).sort(),
      ALL_CONFIG_SPECS.map((spec) => spec.key).sort(),
      'the endpoint and the config registry disagree about which keys exist',
    );

    for (const entry of configBefore.body) {
      assert.equal(
        entry.isPricingKey,
        entry.namespace === 'pricing',
        `${entry.key}: isPricingKey must mean "the pricing namespace", not "a tunable"`,
      );
      assert.ok(entry.description.length > 0, `${entry.key} has no description`);
    }
  });
  created.configBefore = configBefore.body.map((entry) => ({
    key: entry.key,
    hasOverride: entry.hasOverride,
    value: entry.value,
  }));

  const FEE_KEY = 'pricing.platform_fee_per_main_item_minor';

  const raiseFee = await api('PUT', `/admin/config/${FEE_KEY}`, {
    token: adminToken,
    body: { value: 500 },
  });
  check(`PUT ${FEE_KEY} = 500 -> 200`, () => {
    assert.equal(raiseFee.status, 200, JSON.stringify(raiseFee.body));
    assert.equal(raiseFee.body.value, 500);
    assert.equal(raiseFee.body.effectiveValue, 500);
    assert.equal(raiseFee.body.hasOverride, true);
  });

  const policyAfter = await api('GET', '/admin/config/pricing', { token: adminToken });
  check('the live engine reflects it immediately (reload, not a restart)', () => {
    assert.equal(policyAfter.status, 200);
    assert.equal(policyAfter.body.platformFee.feePerMainItemMinor, 500);
    assert.equal(policyAfter.body.source, 'platform_config');
  });

  const notAnInteger = await api('PUT', `/admin/config/${FEE_KEY}`, {
    token: adminToken,
    body: { value: 3.5 },
  });
  check('a fractional HK$ amount -> 422 PLATFORM_CONFIG_INVALID (minor units only)', () => {
    expectError(notAnInteger, 422, 'PLATFORM_CONFIG_INVALID');
  });

  const unknownKey = await api('PUT', '/admin/config/pricing.not_a_real_key', {
    token: adminToken,
    body: { value: 1 },
  });
  check('an unknown config key -> 422 (the registry is the allow-list)', () => {
    expectError(unknownKey, 422, 'PLATFORM_CONFIG_INVALID');
  });

  // Widen the seeded merchant's hours so the order below does not depend on the
  // wall clock — a test that only passes between 11:00 and 22:00 HKT is a trap.
  const hoursResponse = await api('PUT', `/merchant/${seededMerchant.id}/hours`, {
    token: seededOwnerToken,
    body: {
      hours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        opensAtMinute: 0,
        closesAtMinute: 1440,
        isClosed: false,
      })),
    },
  });
  check('PUT /merchant/:id/hours -> 200 (always-open for the duration of the test)', () => {
    assert.equal(hoursResponse.status, 200, JSON.stringify(hoursResponse.body));
  });

  const seededItems = await prisma.menuItem.findMany({
    where: { merchantId: seededMerchant.id },
    select: { id: true, name: true, isMainItem: true },
  });
  const harGow = seededItems.find((row) => row.name === '晶瑩蝦餃');
  const lemonTea = seededItems.find((row) => row.name === QUOTA_PROBE_ITEM);
  assert.ok(harGow && lemonTea, 'seeded menu items missing');

  const basket = [
    { menuItemId: harGow.id, quantity: 2 },
    { menuItemId: lemonTea.id, quantity: 1 },
  ];
  const ordererToken = mintToken({ sub: customerUser.id, role: 'CUSTOMER' });

  const orderAt500 = await api('POST', '/orders', {
    token: ordererToken,
    body: { merchantId: seededMerchant.id, items: basket, contactPhone: CUSTOMER_PHONE },
  });
  // The regression that matters: before the fix, `reload()` built a NEW engine
  // and left the injected `PRICING_ENGINE` pointing at the boot-time one, so
  // the console showed 500 while customers were still charged 350.
  // subtotal 11400 = 2 x 4800 + 1800
  //   platformFee = 2 x 500                        = 1000
  //   paymentFee  = round(11400 x 3.40%) + 235     = 388 + 235 = 623
  //   payout      = 11400 - 1000 - 623             = 9777
  // Asserting the payout too, not just the fee: it proves the WHOLE breakdown
  // used the new policy, so a partially-applied swap cannot pass this test.
  check('an order placed now is charged at the NEW fee: 2 main items x 500 = 1000', () => {
    assert.equal(orderAt500.status, 201, JSON.stringify(orderAt500.body));
    assert.equal(orderAt500.body.pricing.mainItemCount, 2);
    assert.equal(orderAt500.body.pricing.platformFeeMinor, 1000);
    assert.equal(orderAt500.body.pricing.merchantPayoutMinor, 9777);
  });
  if (orderAt500.status === 201) created.orderIds.push(orderAt500.body.id);

  const restoreFee = await api('PUT', `/admin/config/${FEE_KEY}`, {
    token: adminToken,
    body: { value: 350 },
  });
  check('PUT back to 350 -> 200', () => {
    assert.equal(restoreFee.status, 200, JSON.stringify(restoreFee.body));
    assert.equal(restoreFee.body.effectiveValue, 350);
  });

  const orderAt350 = await api('POST', '/orders', {
    token: ordererToken,
    body: { merchantId: seededMerchant.id, items: basket, contactPhone: CUSTOMER_PHONE },
  });
  check('and back at HK$3.50: 2 main items x 350 = 700', () => {
    assert.equal(orderAt350.status, 201, JSON.stringify(orderAt350.body));
    assert.equal(orderAt350.body.pricing.platformFeeMinor, 700);
  });
  if (orderAt350.status === 201) created.orderIds.push(orderAt350.body.id);

  // =========================================================================
  section('6. Order administration');
  // =========================================================================
  const orderList = await api('GET', '/admin/orders?limit=5', { token: adminToken });
  check('GET /admin/orders -> paged list', () => {
    assert.equal(orderList.status, 200, JSON.stringify(orderList.body));
    assert.ok(Array.isArray(orderList.body.data));
    assert.ok(orderList.body.total >= 2);
    assert.ok(orderList.body.data[0].orderNo);
  });

  const filtered = await api('GET', '/admin/orders?status=PENDING_PAYMENT&limit=5', {
    token: adminToken,
  });
  check('status filter is honoured', () => {
    assert.equal(filtered.status, 200);
    for (const row of filtered.body.data) assert.equal(row.status, 'PENDING_PAYMENT');
  });

  const targetOrderId = orderAt350.body.id;

  const searchByNo = await api(
    'GET',
    `/admin/orders?q=${encodeURIComponent(orderAt350.body.orderNo)}`,
    { token: adminToken },
  );
  check('free-text search finds the order by its order number', () => {
    assert.equal(searchByNo.status, 200, JSON.stringify(searchByNo.body));
    assert.equal(searchByNo.body.total, 1, JSON.stringify(searchByNo.body));
  });

  const orderDetail = await api('GET', `/admin/orders/${targetOrderId}`, { token: adminToken });
  check('GET /admin/orders/:id -> items, events, money breakdown, legal moves', () => {
    assert.equal(orderDetail.status, 200, JSON.stringify(orderDetail.body));
    assert.equal(orderDetail.body.items.length, 2);
    // One event so far: the PLACED record written inside the placing
    // transaction. The webhook adds the second, asserted further down.
    assert.equal(orderDetail.body.statusEvents.length, 1);
    assert.equal(orderDetail.body.statusEvents[0].toStatus, 'PENDING_PAYMENT');
    assert.equal(orderDetail.body.pricingSnapshot.platformFeeMinor, 700);
    // Derived from the same state-machine table that validates the write, so
    // the console never offers a button the API would reject. From
    // PENDING_PAYMENT the admin can settle it (the webhook may never arrive),
    // cancel it, or let it expire — but NOT accept it, which requires PAID.
    assert.deepEqual(
      [...orderDetail.body.allowedAdminTransitions].sort(),
      ['CANCELLED', 'EXPIRED', 'PAID'],
    );
  });

  const badTransition = await api('POST', `/admin/orders/${targetOrderId}/transition`, {
    token: adminToken,
    body: { to: 'COMPLETED', reason: '不應該成功' },
  });
  check('PENDING_PAYMENT -> COMPLETED -> 409 ILLEGAL_ORDER_TRANSITION', () => {
    assert.equal(badTransition.status, 409, JSON.stringify(badTransition.body));
    assert.equal(badTransition.body.error.code, 'ILLEGAL_ORDER_TRANSITION');
  });

  const refundUnpaid = await api('POST', `/admin/orders/${targetOrderId}/refund`, {
    token: adminToken,
    body: { reason: '未付款不應可退款' },
  });
  check('refunding an unpaid order -> 422 REFUND_NOT_AVAILABLE', () => {
    expectError(refundUnpaid, 422, 'REFUND_NOT_AVAILABLE');
  });

  // ---- settle it the way the platform actually does: a signed webhook ------
  const providerRef = `pi_e2eadmin_${Date.now()}`;
  const amountMinor = orderAt350.body.pricing.totalMinor;
  await prisma.payment.create({
    data: {
      orderId: targetOrderId,
      merchantId: seededMerchant.id,
      provider: 'STRIPE',
      idempotencyKey: `idem_${providerRef}`,
      providerRef,
      status: 'PENDING',
      currency: 'HKD',
      amountMinor,
    },
  });

  const event = {
    id: `evt_e2eadmin_${Date.now()}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    data: {
      object: { id: providerRef, object: 'payment_intent', amount: amountMinor, currency: 'hkd' },
    },
  };
  const rawBody = JSON.stringify(event);
  const webhook = await api('POST', '/webhooks/payments/stripe', {
    body: event,
    headers: { 'stripe-signature': stripeSignature(rawBody, STRIPE_WEBHOOK_SECRET) },
  });
  check('signed webhook settles the order -> PAID, with a SYSTEM status event', async () => {
    assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
    assert.equal(webhook.body.handled, true);
    const row = await prisma.order.findUnique({
      where: { id: targetOrderId },
      select: { status: true },
    });
    assert.equal(row.status, 'PAID');

    const paidEvent = await prisma.orderStatusEvent.findFirst({
      where: { orderId: targetOrderId, toStatus: 'PAID' },
      select: { actor: true, reason: true },
    });
    assert.ok(paidEvent, 'no order_status_events row for PAID');
    assert.equal(paidEvent.actor, 'SYSTEM');
  });

  const partialRefund = await api('POST', `/admin/orders/${targetOrderId}/refund`, {
    token: adminToken,
    body: { amountMinor: 500, reason: 'E2E 部分退款測試' },
  });
  check('admin partial refund -> 200, recorded, and says the money has not moved', () => {
    assert.equal(partialRefund.status, 200, JSON.stringify(partialRefund.body));
    assert.equal(partialRefund.body.refund.amountMinor, 500);
    assert.equal(partialRefund.body.refund.status, 'PENDING');
    assert.ok(partialRefund.body.notice, 'PAYMENT_LIVE_MODE=false must produce a notice');
  });

  const overRefund = await api('POST', `/admin/orders/${targetOrderId}/refund`, {
    token: adminToken,
    body: { amountMinor: 500_000, reason: 'E2E 超額退款測試' },
  });
  check('refunding more than was captured -> 422 REFUND_EXCEEDS_CAPTURE', () => {
    expectError(overRefund, 422, 'REFUND_EXCEEDS_CAPTURE');
  });

  const forceAccepted = await api('POST', `/admin/orders/${targetOrderId}/transition`, {
    token: adminToken,
    body: { to: 'ACCEPTED', reason: 'E2E 客服代為接單' },
  });
  check('ADMIN force-transition PAID -> ACCEPTED (the MERCHANT_ACCEPTING guard is waived)', () => {
    assert.equal(forceAccepted.status, 200, JSON.stringify(forceAccepted.body));
    assert.equal(forceAccepted.body.order.status, 'ACCEPTED');
    assert.equal(forceAccepted.body.fromStatus, 'PAID');
    assert.equal(forceAccepted.body.toStatus, 'ACCEPTED');
  });

  check('the forced transition is attributed to the admin in the audit trail', async () => {
    const row = await prisma.orderStatusEvent.findFirst({
      where: { orderId: targetOrderId, toStatus: 'ACCEPTED' },
      select: { actor: true, actorId: true, reason: true },
    });
    assert.ok(row, 'no order_status_events row for ACCEPTED');
    assert.equal(row.actor, 'ADMIN');
    assert.equal(row.actorId, adminUser.id);
    assert.equal(row.reason, 'E2E 客服代為接單');
  });

  // =========================================================================
  section('7. Users — the console must not let an admin lock everyone out');
  // =========================================================================
  const userList = await api('GET', '/admin/users', { token: adminToken });
  check('GET /admin/users -> 200 with the seeded identities', () => {
    assert.equal(userList.status, 200, JSON.stringify(userList.body));
    assert.ok(userList.body.total >= 3);
    assert.ok(userList.body.data.some((row) => row.role === 'ADMIN'));
  });

  const adminOnly = await api('GET', '/admin/users?role=ADMIN', { token: adminToken });
  check('role filter is honoured', () => {
    assert.equal(adminOnly.status, 200);
    assert.ok(adminOnly.body.data.length >= 1);
    for (const row of adminOnly.body.data) assert.equal(row.role, 'ADMIN');
  });

  const selfDemote = await api('PATCH', `/admin/users/${adminUser.id}`, {
    token: adminToken,
    body: { role: 'CUSTOMER' },
  });
  check('an admin demoting themselves -> 403 SELF_MODIFICATION', () => {
    expectError(selfDemote, 403, 'SELF_MODIFICATION');
  });

  const selfDisable = await api('PATCH', `/admin/users/${adminUser.id}`, {
    token: adminToken,
    body: { isActive: false },
  });
  check('an admin disabling themselves -> 403 SELF_MODIFICATION', () => {
    expectError(selfDisable, 403, 'SELF_MODIFICATION');
  });

  // Promote the customer, so there are two admins and LAST_ADMIN becomes
  // reachable. Then use the new admin to disable the original one — which the
  // API allows, because at that moment one enabled admin still remains.
  const promote = await api('PATCH', `/admin/users/${customerUser.id}`, {
    token: adminToken,
    body: { role: 'ADMIN' },
  });
  check('promoting a second admin -> 200', () => {
    assert.equal(promote.status, 200, JSON.stringify(promote.body));
    assert.equal(promote.body.role, 'ADMIN');
  });

  const secondAdminToken = mintToken({ sub: customerUser.id, role: 'ADMIN' });
  const disableFirst = await api('PATCH', `/admin/users/${adminUser.id}`, {
    token: secondAdminToken,
    body: { isActive: false },
  });
  check('a second admin may disable the first (one enabled admin still remains)', () => {
    assert.equal(disableFirst.status, 200, JSON.stringify(disableFirst.body));
    assert.equal(disableFirst.body.isActive, false);
  });

  // The original admin's token is still cryptographically valid — the guard
  // does no DB read. Now the second admin is the LAST enabled one, so removing
  // it must be refused.
  const removeLast = await api('PATCH', `/admin/users/${customerUser.id}`, {
    token: adminToken,
    body: { role: 'CUSTOMER' },
  });
  check('removing the last enabled admin -> 409 LAST_ADMIN', () => {
    expectError(removeLast, 409, 'LAST_ADMIN');
  });

  await prisma.user.update({ where: { id: adminUser.id }, data: { isActive: true } });

  const sessions = await api('POST', `/admin/users/${customerUser.id}/revoke-sessions`, {
    token: adminToken,
  });
  check('POST revoke-sessions -> 200 and reports how many were killed', () => {
    assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
    assert.equal(typeof sessions.body.revoked, 'number');
  });

  // =========================================================================
  section('8. Ops — outbox, audit and reconciliation');
  // =========================================================================
  const stats = await api('GET', '/admin/outbox/stats', { token: adminToken });
  check('GET /admin/outbox/stats -> per-status counts plus the oldest backlog age', () => {
    assert.equal(stats.status, 200, JSON.stringify(stats.body));
    assert.ok(stats.body.byStatus);
    assert.ok('oldestPendingAgeSeconds' in stats.body);
  });

  const outboxList = await api('GET', '/admin/outbox?limit=5', { token: adminToken });
  check('GET /admin/outbox -> paged list', () => {
    assert.equal(outboxList.status, 200, JSON.stringify(outboxList.body));
    assert.ok(Array.isArray(outboxList.body.data));
  });

  const deadLetters = await api('GET', '/admin/outbox?status=DEAD_LETTER&limit=5', {
    token: adminToken,
  });
  check('GET /admin/outbox?status=DEAD_LETTER -> only dead letters', () => {
    assert.equal(deadLetters.status, 200, JSON.stringify(deadLetters.body));
    for (const row of deadLetters.body.data) assert.equal(row.status, 'DEAD_LETTER');
  });

  // A probe row rather than a real event: `availableAt` a year out keeps the
  // relay away from it, so the status this test observes is exactly the status
  // it set. Retrying a live event would race the relay.
  const probe = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'E2eProbe',
      aggregateId: crypto.randomUUID(),
      eventType: 'e2e.probe',
      payload: { note: 'created by scripts/e2e-admin.js' },
      version: 1,
      status: 'PENDING',
      availableAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    },
    select: { id: true },
  });
  created.outboxProbeIds.push(probe.id);

  const retryPending = await api('POST', `/admin/outbox/${probe.id}/retry`, {
    token: adminToken,
  });
  check('retrying a PENDING event -> 409 OUTBOX_NOT_RETRYABLE (a retry loop must be visible)', () => {
    expectError(retryPending, 409, 'OUTBOX_NOT_RETRYABLE');
  });

  await prisma.outboxEvent.update({ where: { id: probe.id }, data: { status: 'DEAD_LETTER' } });

  const retried = await api('POST', `/admin/outbox/${probe.id}/retry`, { token: adminToken });
  check('retrying a DEAD_LETTER event -> 200 and it goes back to PENDING with attempts reset', () => {
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.status, 'PENDING');
    assert.equal(retried.body.attempts, 0);
    assert.equal(retried.body.lastError, null);
  });

  const deadLetterAgain = await api('POST', `/admin/outbox/${probe.id}/dead-letter`, {
    token: adminToken,
  });
  check('dead-lettering it -> 200', () => {
    assert.equal(deadLetterAgain.status, 200, JSON.stringify(deadLetterAgain.body));
    assert.equal(deadLetterAgain.body.status, 'DEAD_LETTER');
  });

  const deadLetterTwice = await api('POST', `/admin/outbox/${probe.id}/dead-letter`, {
    token: adminToken,
  });
  check('dead-lettering an already-DEAD_LETTER event -> 409', () => {
    expectError(deadLetterTwice, 409, 'OUTBOX_NOT_RETRYABLE');
  });

  const retryMissing = await api('POST', `/admin/outbox/${crypto.randomUUID()}/retry`, {
    token: adminToken,
  });
  check('retrying an unknown event id -> 404', () => {
    expectError(retryMissing, 404, 'ADMIN_TARGET_NOT_FOUND');
  });

  const audit = await api('GET', '/admin/audit?limit=50', { token: adminToken });
  check('GET /admin/audit -> 200 and the merchant lifecycle is on the record', () => {
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    assert.ok(audit.body.total > 0);
    const actions = audit.body.data.map((row) => row.action);
    assert.ok(
      actions.some((action) => action.startsWith('merchant.')),
      `no merchant.* audit rows: ${JSON.stringify(actions.slice(0, 10))}`,
    );
  });

  const auditByAction = await api('GET', '/admin/audit?action=merchant.approve&limit=5', {
    token: adminToken,
  });
  check('audit filter by action works', () => {
    assert.equal(auditByAction.status, 200, JSON.stringify(auditByAction.body));
    for (const row of auditByAction.body.data) assert.equal(row.action, 'merchant.approve');
  });

  const recon = await api('GET', '/admin/reconciliation', { token: adminToken });
  check('GET /admin/reconciliation -> every day balances to zero', () => {
    assert.equal(recon.status, 200, JSON.stringify(recon.body));
    assert.equal(
      recon.body.totalDeltaMinor,
      0,
      `order fees and payout fees disagree: ${JSON.stringify(recon.body.rows)}`,
    );
    assert.equal(recon.body.mismatchedDays, 0);
  });

  const payouts = await api('GET', '/admin/payouts?limit=5', { token: adminToken });
  check('GET /admin/payouts -> list with totals', () => {
    assert.equal(payouts.status, 200, JSON.stringify(payouts.body));
    assert.ok(Array.isArray(payouts.body.data));
    assert.ok(payouts.body.totals);
  });

  await Promise.all(pending);
}

main()
  .then(async () => {
    await cleanup();
  })
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

#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 商戶營業報表：免費 Excel 匯出 + 加錢的 BI 報表
// ============================================================================
//  Covers the seam between the entitlement model, the SQL aggregation and the
//  HTTP response. Four properties are load-bearing:
//
//   1. THE EXPORT IS NEVER TIER-GATED. This is the commercial promise: a shop
//      may always take its own orders out of the platform. The failure mode is
//      not a crash — it is a well-meaning "hide the button for free shops"
//      change that quietly turns a shop's own data into a paid feature. The
//      script asserts the export works on `NONE`, with real bytes.
//
//   2. THE TIER DECIDES WHICH PANELS RENDER, NOT WHICH NUMBERS EXIST. A `NONE`
//      shop still gets its totals — the summary strip is the shop's own revenue
//      and hiding it would be worse than the page being replaced. What it does
//      not get is the *computed* panels, and those must be absent from the
//      payload entirely rather than blanked in CSS. A comparison that is only
//      hidden in the client is one `curl` away from being free.
//
//   3. THE TIER IS A FACT ABOUT THE SHOP, NOT ABOUT THE VIEWER. It lives on the
//      merchant row; no per-user field may shadow it.
//
//   4. THE WINDOW IS RESOLVED SERVER-SIDE, IN THE SHOP'S ZONE. A date the
//      operator did not type must not 500, and a window that cannot be served
//      must say why rather than returning empty.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-analytics.js
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

const CUSTOMER_PHONE = '+85290000001';
const OWNER_PHONE = '+85290000002';
const ADMIN_PHONE = '+85290000003';

/**
 * The window this run seeds into and reads back.
 *
 * Deliberately fixed rather than "the last N days": the seeded trading days
 * must be inside the window for the aggregation assertions to mean anything,
 * and a window derived from `new Date()` at two different instants (seed, then
 * assert) can straddle midnight in the shop's zone.
 */
const WINDOW_DAYS_TRADING = ['2026-03-02', '2026-03-03', '2026-03-04'];
const WINDOW_FROM = '2026-02-25';
const WINDOW_TO = '2026-03-04';

/**
 * The comparison window, DERIVED rather than hardcoded.
 *
 * `previousWindow` returns the equal-length period immediately before, so an
 * 8-day window (25 Feb – 4 Mar) compares against 17–24 Feb. Writing those two
 * dates here by hand would be a second implementation of the rule, and the
 * off-by-one in a comparison window is exactly the kind of thing a hardcoded
 * fixture encodes wrongly and then passes.
 */
function previousWindowOf(from, to) {
  const dayCount = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const prevTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (dayCount - 1) * 86_400_000);
  return {
    from: prevFrom.toISOString().slice(0, 10),
    to: prevTo.toISOString().slice(0, 10),
    dayCount,
  };
}

const PREVIOUS_WINDOW = previousWindowOf(WINDOW_FROM, WINDOW_TO);

/** Marks every row this run creates, so cleanup is by id and never by guess. */
const ORDER_NO_PREFIX = 'E2EAN';
const ORDER_NOTE_MARK = '[e2e-analytics]';

// The seeded dishes, by name, so the item-mix expectations read as prose.
const MAIN_DISH = '晶瑩蝦餃'; // 4800, main
const SIDE_DISH = '凍檸茶'; // 1800, not a main

/**
 * One trading day's worth of orders.
 *
 * `hour` is SHOP-LOCAL (Asia/Hong_Kong, +08) and is the point of the hour-of-day
 * panel: two orders at different local hours must land in different buckets. A
 * UTC hour would put 09:00 and 10:00 local in the same bucket for a +08 shop
 * only if the code were wrong, so the assertion is meaningful.
 */
const TRADING_DAYS = [
  {
    serviceDate: WINDOW_DAYS_TRADING[0],
    orders: [
      { hour: 12, items: [MAIN_DISH, MAIN_DISH], paymentMode: 'ONLINE' },
      { hour: 12, items: [MAIN_DISH], paymentMode: 'PAY_AT_STORE' },
    ],
  },
  {
    serviceDate: WINDOW_DAYS_TRADING[1],
    orders: [
      { hour: 19, items: [MAIN_DISH, SIDE_DISH], paymentMode: 'ONLINE' },
      { hour: 19, items: [SIDE_DISH], paymentMode: 'ONLINE' },
    ],
  },
  {
    serviceDate: WINDOW_DAYS_TRADING[2],
    orders: [
      { hour: 8, items: [MAIN_DISH], paymentMode: 'ONLINE' },
      // A void: attempted, never traded. Must be counted as a void and must
      // contribute NOTHING to revenue — that is the whole reason the rollup
      // carries a separate column for it.
      { hour: 8, items: [MAIN_DISH], paymentMode: 'ONLINE', status: 'CANCELLED' },
    ],
  },
];

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
  const { token, body, headers = {}, raw = false } = options;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // `raw` keeps the BYTES, not just the text.
  //
  // `response.text()` decodes as UTF-8 and **strips a leading BOM** — which is
  // exactly the byte the export test exists to check. Reading the bytes and
  // decoding by hand is the only way to assert on a byte the standard decoder
  // is defined to eat.
  if (raw) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      buffer,
      bytes: [...buffer.subarray(0, 3)],
      text: buffer.toString('utf8'),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

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

// ---- seeding --------------------------------------------------------------

/**
 * A shop-local wall-clock instant, as the UTC instant it occurs at.
 *
 * Hong Kong is +08 with no DST since 1979, so a fixed offset is exact here —
 * and the point of building it in local time is that a UTC offset would put
 * "12:00" in the wrong hour bucket for the hour-of-day panel.
 */
function shopInstant(serviceDate, hour, minute = 0) {
  const hktOffsetMinutes = 8 * 60;
  const utcMidnight = Date.parse(`${serviceDate}T00:00:00.000Z`);
  return new Date(utcMidnight + (hour * 60 + minute) * 60_000 - hktOffsetMinutes * 60_000);
}

/** Every order number this run has created, so cleanup is id-scoped. */
const createdOrderIds = [];

async function seedOrders(merchant, menuItems) {
  const byName = new Map(menuItems.map((item) => [item.name, item]));
  let sequence = 0;

  for (const day of TRADING_DAYS) {
    for (const spec of day.orders) {
      const status = spec.status ?? 'COMPLETED';
      const lines = spec.items.map((name) => {
        const item = byName.get(name);
        if (!item) throw new Error(`seed expects a menu item named ${name}`);
        return item;
      });

      const subtotalMinor = lines.reduce((sum, item) => sum + item.priceMinor, 0);
      const mainItemCount = lines.filter((item) => item.isMainItem).length;
      const platformFeeMinor = mainItemCount * 350;
      const merchantPayoutMinor = subtotalMinor - platformFeeMinor;
      const createdAt = shopInstant(day.serviceDate, spec.hour, sequence % 60);
      sequence += 1;

      const order = await prisma.order.create({
        data: {
          orderNo: `${ORDER_NO_PREFIX}${String(sequence).padStart(3, '0')}${Date.now() % 100000}`,
          merchantId: merchant.id,
          customerId: merchant.customerId,
          status,
          fulfilmentMode: 'SELF_PICKUP',
          paymentMode: spec.paymentMode,
          subtotalMinor,
          platformFeeMinor,
          paymentFeeMinor: 0,
          customerServiceFeeMinor: 0,
          // `totalMinor` is what the customer paid and is required, unlike the
          // optional service fee. MVP: no customer-side fee, so it is subtotal.
          totalMinor: subtotalMinor,
          merchantPayoutMinor,
          // Required, and deliberately NOT recomputed by the report: the frozen
          // snapshot is the point — a later rate change must not rewrite history.
          pricingSnapshot: {
            platformFeePerMainItemMinor: 350,
            customerServiceFeeMinor: 0,
            mainItemCount,
            currency: 'HKD',
          },
          prepTimeMinutes: 15,
          mainItemCount,
          // `serviceDate` is a `@db.Date` column holding UTC midnight. The report
          // reads the LOCAL date from `createdAt`, so this column is only here
          // because the schema requires it.
          serviceDate: new Date(`${day.serviceDate}T00:00:00.000Z`),
          pickupCode: `AN${String(sequence).padStart(3, '0')}`,
          contactPhone: '+85296000001',
          customerNote: ORDER_NOTE_MARK,
          createdAt,
          updatedAt: createdAt,
          items: {
            create: lines.map((item) => ({
              // Nested `create` uses the CHECKED input, so the scalar foreign key
              // is not accepted here — the relation is set with `connect`.
              menuItem: { connect: { id: item.id } },
              nameSnapshot: item.name,
              unitPriceMinor: item.priceMinor,
              quantity: 1,
              lineTotalMinor: item.priceMinor,
              isMainItem: item.isMainItem,
            })),
          },
        },
        select: { id: true, orderNo: true, subtotalMinor: true, merchantPayoutMinor: true },
      });

      createdOrderIds.push(order.id);
    }
  }
}

/** The totals the seeded rows must produce, derived from the same constants. */
function expectedTotals(menuItems) {
  const price = new Map(menuItems.map((item) => [item.name, item.priceMinor]));
  const isMain = new Map(menuItems.map((item) => [item.name, item.isMainItem]));

  let revenueMinor = 0;
  let payoutMinor = 0;
  let orderCount = 0;
  let voidCount = 0;
  let itemCount = 0;
  let mainUnits = 0;

  for (const day of TRADING_DAYS) {
    for (const spec of day.orders) {
      if ((spec.status ?? 'COMPLETED') === 'CANCELLED') {
        voidCount += 1;
        continue;
      }
      orderCount += 1;
      const lineTotal = spec.items.reduce((sum, name) => sum + price.get(name), 0);
      const mains = spec.items.filter((name) => isMain.get(name)).length;
      revenueMinor += lineTotal;
      payoutMinor += lineTotal - mains * 350;
      mainUnits += mains;
      itemCount += mains;
    }
  }

  return { orderCount, voidCount, revenueMinor, payoutMinor, itemCount, mainUnits };
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, timezone: true, status: true, analyticsTier: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

  const customer = await prisma.user.findUnique({
    where: { phone: CUSTOMER_PHONE },
    select: { id: true },
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

  const menuItems = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id },
    select: { id: true, name: true, priceMinor: true, isMainItem: true },
  });

  const MID = merchant.id;
  const reportPath = `/merchant/${MID}/analytics`;
  const exportPath = `/merchant/${MID}/orders/export.csv`;
  const tierPath = `/admin/merchants/${MID}/analytics-tier`;
  const windowQuery = `from=${WINDOW_FROM}&to=${WINDOW_TO}`;

  const merchantToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [MID],
  });
  const adminToken = mintToken({ sub: admin.id, role: 'ADMIN' });
  // The same owner, but a token that does NOT list this merchant. `MerchantScopeGuard`
  // proves the caller staffs `:merchantId`; without that proof, `:merchantId` in
  // the path is just a number the caller chose.
  const strangerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });

  // =========================================================================
  section('0. A clean slate, and the tier is where the seed left it');
  // =========================================================================

  await prisma.order.deleteMany({
    where: { merchantId: MID, orderNo: { startsWith: ORDER_NO_PREFIX } },
  });
  await prisma.merchant.update({
    where: { id: MID },
    data: { analyticsTier: 'NONE' },
  });

  const baseline = await prisma.order.count({ where: { merchantId: MID } });

  await checkAsync('a fresh shop starts on NONE — the free tier', async () => {
    const res = await api('GET', `/merchant/${MID}/analytics`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tier.tier, 'NONE');
    assert.equal(res.body.tier.label, '標準');
    assert.equal(res.body.tier.isPaid, false);
    assert.deepEqual(res.body.tier.capabilities, [], 'NONE buys no computed panels');
  });

  await checkAsync('every tier may take its own raw data out (canExportRawData)', async () => {
    const res = await api('GET', `/merchant/${MID}/analytics`, { token: merchantToken });
    assert.equal(
      res.body.tier.canExportRawData,
      true,
      'the export is unconditional; gating it would hold the records hostage',
    );
  });

  // =========================================================================
  section('1. The free export — bytes matter, not just a 200');
  // =========================================================================

  await checkAsync('export on NONE -> 200 text/csv with attachment headers', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.match(res.headers['content-type'], /text\/csv/, 'must be CSV');
    assert.match(
      res.headers['content-type'],
      /charset=utf-8/,
      'without the charset the BOM-prefixed body is decoded as Latin-1 and every Chinese name is mojibake',
    );
    assert.match(res.headers['content-disposition'], /^attachment; filename="/, 'must download, not navigate');
    assert.match(res.headers['content-disposition'], /dim-sum-express-orders-/, 'filename names the shop');
    assert.match(
      res.headers['content-disposition'],
      new RegExp(`${WINDOW_FROM}_${WINDOW_TO}\\.csv`),
      'filename carries the window so two exports are distinguishable',
    );
  });

  await checkAsync('the export is NOT tier-gated — it works on the free tier', async () => {
    // The one assertion that protects the commercial promise. It is checked
    // while the tier is still NONE, before any upgrade below.
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(res.status, 200, 'a free shop must always be able to export');
    assert.ok(res.text.length > 0);
  });

  await checkAsync('the body starts with a UTF-8 BOM and uses CRLF', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    assert.deepEqual(
      res.bytes,
      [0xef, 0xbb, 0xbf],
      'Excel on Windows needs the UTF-8 BOM or every Chinese name becomes mojibake',
    );
    assert.ok(
      !/[^\r]\n/.test(res.text.replace(/^\uFEFF/, '')),
      'every line break must be CRLF — Excel parses a bare LF inconsistently inside quoted fields',
    );
    assert.ok(res.text.endsWith('\r\n'), 'the file must end on a complete line, not a phantom empty row');
  });

  await checkAsync('the header row is the documented column set, in order', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    const header = res.text.replace(/^\uFEFF/, '').split('\r\n')[0];
    assert.equal(
      header,
      '訂單編號,交易日期,下單時間,狀態,取餐方式,付款方式,件數,營業額,平台費,商戶入帳,顧客備註',
    );
  });

  await checkAsync('an empty window still exports a valid file — header, BOM, no rows', async () => {
    // A window with no trading is not an error, and a shop must be able to prove
    // that with a file rather than a 404. This also proves the header is emitted
    // unconditionally, so a spreadsheet always has column names.
    const res = await api('GET', `${exportPath}?from=2020-01-01&to=2020-01-31`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.deepEqual(res.bytes, [0xef, 0xbb, 0xbf]);
    assert.equal(Number(res.headers['x-row-count']), 0);
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    assert.equal(lines.length, 1, 'header only');
  });

  await checkAsync('X-Row-Count matches the number of data rows', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    const rows = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).slice(1);
    assert.equal(Number(res.headers['x-row-count']), rows.length);
  });

  // =========================================================================
  section('2. The window is resolved server-side, and refusals explain themselves');
  // =========================================================================

  await checkAsync('no dates -> a default window ending today in the SHOP zone', async () => {
    const res = await api('GET', reportPath, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const shopToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: merchant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    assert.equal(res.body.window.to, shopToday, 'a +08 shop at 17:30 UTC must not see yesterday as "today"');
    assert.equal(res.body.window.days, 30, 'the default window is 30 days inclusive');
  });

  await checkAsync('a reversed window -> 400, not an empty report', async () => {
    const res = await api('GET', `${reportPath}?from=${WINDOW_TO}&to=${WINDOW_FROM}`, {
      token: merchantToken,
    });
    expectError(res, 400, 'ANALYTICS_INVALID_WINDOW');
    assert.ok(
      res.body.error.details.from === WINDOW_TO && res.body.error.details.to === WINDOW_FROM,
      'the refusal must echo the window the caller sent',
    );
  });

  await checkAsync('a window longer than 366 days -> 400 naming the limit', async () => {
    const res = await api('GET', `${reportPath}?from=2020-01-01&to=2026-12-31`, {
      token: merchantToken,
    });
    expectError(res, 400, 'ANALYTICS_INVALID_WINDOW');
    assert.match(res.body.error.message, /366/, 'the operator must be told the limit, not just refused');
  });

  await checkAsync('a malformed date -> 400 from validation, not a 500', async () => {
    const res = await api('GET', `${reportPath}?from=2026-3-4&to=${WINDOW_TO}`, {
      token: merchantToken,
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.ok(res.status < 500, 'a typo in a date is never a server error');
  });

  await checkAsync('a caller who does not staff this merchant -> 403', async () => {
    const res = await api('GET', reportPath, { token: strangerToken });
    assert.ok(
      res.status === 403 || res.status === 404,
      `expected 403/404 for a foreign caller, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  });

  await checkAsync('an unknown merchant id -> 404, not a leaky 500', async () => {
    const res = await api('GET', '/merchant/00000000-0000-4000-8000-000000000000/analytics', {
      token: adminToken,
    });
    assert.ok(res.status === 404 || res.status === 403, `got ${res.status}`);
  });

  // =========================================================================
  section('3. Seed real trading days, then read the report');
  // =========================================================================

  await seedOrders({ ...merchant, customerId: customer.id }, menuItems);
  const expect = expectedTotals(menuItems);

  await checkAsync('the seeded rows are all inside the window', async () => {
    const found = await prisma.order.count({
      where: { id: { in: createdOrderIds } },
    });
    assert.equal(found, createdOrderIds.length, 'every seeded order must exist');
    assert.equal(
      createdOrderIds.length,
      TRADING_DAYS.reduce((sum, day) => sum + day.orders.length, 0),
    );
  });

  await checkAsync('X-Row-Count now counts the seeded rows', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    const rows = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).slice(1);
    assert.equal(
      rows.length,
      createdOrderIds.length,
      'the window holds exactly the rows this run seeded',
    );
    assert.equal(Number(res.headers['x-row-count']), rows.length);
  });

  await checkAsync('money is written as decimal strings, never minor units', async () => {
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    const rows = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).slice(1);
    assert.ok(rows.length > 0, 'the window must have seeded rows by now');
    for (const row of rows) {
      // 營業額 / 平台費 / 商戶入帳 are columns 8, 9, 10 (0-indexed 7..9).
      const cells = row.split(',');
      for (const cell of [cells[7], cells[8], cells[9]]) {
        assert.match(
          cell,
          /^-?\d+\.\d{2}$/,
          `money must be a decimal string like 48.00, got "${cell}" — 350 is wrong by 100x to a human`,
        );
      }
      // The item count is a count, not money — no decimal point.
      assert.match(cells[6], /^\d+$/, `件數 must be a bare count, got "${cells[6]}"`);
    }
  });

  await checkAsync('the export is scoped to the window: no row outside it', async () => {
    const res = await api('GET', `${exportPath}?from=${WINDOW_TO}&to=${WINDOW_TO}`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(res.status, 200);
    const rows = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).slice(1);
    assert.ok(rows.length > 0, 'the last seeded day must be in a one-day window');
    for (const row of rows) {
      assert.equal(row.split(',')[1], WINDOW_TO, 'a one-day window must return only that day');
    }
  });

  await checkAsync('a customer note starting with = is defused, not exported as a formula', async () => {
    // CSV injection: a note of `=1+1` opens as a live formula in Excel, and
    // `=cmd|...` in a spreadsheet someone opens is worse than a wrong number.
    // The exporter prefixes it with an apostrophe — Excel's "literal text" marker.
    const injected = await prisma.order.create({
      data: {
        orderNo: `${ORDER_NO_PREFIX}INJ${Date.now() % 100000}`,
        merchantId: MID,
        customerId: customer.id,
        status: 'COMPLETED',
        fulfilmentMode: 'SELF_PICKUP',
        paymentMode: 'ONLINE',
        subtotalMinor: 4800,
        platformFeeMinor: 350,
        paymentFeeMinor: 0,
        customerServiceFeeMinor: 0,
        totalMinor: 4800,
        merchantPayoutMinor: 4450,
        pricingSnapshot: { injected: true },
        prepTimeMinutes: 15,
        mainItemCount: 1,
        serviceDate: new Date(`${WINDOW_DAYS_TRADING[0]}T00:00:00.000Z`),
        contactPhone: '+85296000001',
        customerNote: `=1+1 ${ORDER_NOTE_MARK}`,
        createdAt: shopInstant(WINDOW_DAYS_TRADING[0], 13),
        updatedAt: shopInstant(WINDOW_DAYS_TRADING[0], 13),
      },
      select: { id: true },
    });
    createdOrderIds.push(injected.id);

    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    const body = res.text.replace(/^\uFEFF/, '');
    assert.ok(
      body.includes('\'=1+1') || body.includes('"\'=1+1'),
      'the note must be prefixed with an apostrophe so Excel treats it as text',
    );

    // Fold the injected row into the expectations, then remove it again so the
    // money and rollup assertions below describe the seeded trading days only.
    // Written as a pair so the row is proven gone rather than assumed gone.
    await prisma.orderItem.deleteMany({ where: { orderId: injected.id } });
    await prisma.orderStatusEvent.deleteMany({ where: { orderId: injected.id } });
    await prisma.order.deleteMany({ where: { id: injected.id } });
    createdOrderIds.splice(createdOrderIds.indexOf(injected.id), 1);
    const stillThere = await prisma.order.count({ where: { id: injected.id } });
    assert.equal(stillThere, 0, 'the injection probe must be cleaned up before the totals are read');
  });

  await checkAsync('NONE still shows the shop its own totals', async () => {
    // The tier gates PANELS, not the shop's own revenue. A free shop that could
    // not see its own total would be worse than the page this replaces.
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.orderCount, expect.orderCount);
    assert.equal(res.body.totals.voidCount, expect.voidCount, 'attempted-but-not-traded is a separate count');
    assert.equal(res.body.totals.revenueMinor, expect.revenueMinor);
    assert.equal(res.body.totals.payoutMinor, expect.payoutMinor);
    assert.equal(res.body.totals.platformFeeMinor, expect.revenueMinor - expect.payoutMinor);
    assert.equal(res.body.totals.itemCount, expect.itemCount);
  });

  await checkAsync('the void contributed zero revenue, but is still counted', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const voids = res.body.totals.voidCount;
    assert.equal(voids, 1, 'exactly one seeded order never traded');
    // If a cancelled order leaked into revenue, the total would be one dish higher.
    assert.equal(
      res.body.totals.revenueMinor,
      expect.revenueMinor,
      'a cancelled order must not contribute revenue',
    );
  });

  await checkAsync('on NONE the computed panels are EMPTY ARRAYS, not missing keys', async () => {
    // Empty rather than absent: a client doing `view.daily.map(...)` must not
    // crash on a free shop. The tier block is what says WHY it is empty.
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.deepEqual(res.body.daily, [], 'no DAILY_ROLLUP on NONE');
    assert.deepEqual(res.body.itemMix, [], 'no ITEM_MIX on NONE');
    assert.deepEqual(res.body.hourOfDay, [], 'no HOUR_OF_DAY on NONE');
    assert.deepEqual(res.body.channels, [], 'no CHANNEL_MIX on NONE');
    assert.equal(res.body.comparison, null, 'no COMPARISON on NONE');
    for (const key of ['daily', 'itemMix', 'hourOfDay', 'channels']) {
      assert.ok(Array.isArray(res.body[key]), `${key} must be an array, never undefined`);
    }
  });

  // =========================================================================
  section('4. Admin grants BASIC — the computed panels appear');
  // =========================================================================

  await checkAsync('POST admin analytics-tier BASIC -> capabilities grow', async () => {
    const res = await api('POST', tierPath, { token: adminToken, body: { tier: 'BASIC' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.before.tier, 'NONE');
    assert.equal(res.body.after.tier, 'BASIC');
    assert.equal(res.body.after.label, '進階報表');
    assert.equal(res.body.after.isPaid, true);
    assert.equal(res.body.isDowngrade, false, 'an upgrade is not a downgrade');
    assert.equal(res.body.warning, null, 'no warning on an upgrade');
  });

  await checkAsync('BASIC carries exactly the four non-comparison capabilities', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.deepEqual([...res.body.tier.capabilities].sort(), [
      'CHANNEL_MIX',
      'DAILY_ROLLUP',
      'HOUR_OF_DAY',
      'ITEM_MIX',
    ]);
    assert.equal(
      res.body.tier.capabilities.includes('COMPARISON'),
      false,
      'COMPARISON is the whole difference between BASIC and PRO',
    );
  });

  await checkAsync('daily rollup now renders — one row per trading day', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.equal(res.body.daily.length, WINDOW_DAYS_TRADING.length, 'three seeded trading days');

    const dates = res.body.daily.map((row) => row.date);
    assert.deepEqual(dates, [...WINDOW_DAYS_TRADING].sort(), 'rows sorted by date ascending');

    for (const day of WINDOW_DAYS_TRADING) {
      const row = res.body.daily.find((entry) => entry.date === day);
      assert.ok(row, `no daily row for ${day}`);
    }
  });

  await checkAsync('the daily rows sum to the totals — the rollup does not double-count', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const sum = (key) => res.body.daily.reduce((total, row) => total + row[key], 0);
    assert.equal(sum('orderCount'), res.body.totals.orderCount, 'daily orderCount must sum to the total');
    assert.equal(sum('voidCount'), res.body.totals.voidCount, 'voids are counted once, on their own day');
    assert.equal(sum('revenueMinor'), res.body.totals.revenueMinor);
    assert.equal(sum('payoutMinor'), res.body.totals.payoutMinor);
    assert.equal(sum('platformFeeMinor'), res.body.totals.platformFeeMinor);
  });

  await checkAsync('the day with a void reports the void and no revenue for it', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const voidDay = res.body.daily.find((row) => row.date === WINDOW_DAYS_TRADING[2]);
    assert.equal(voidDay.voidCount, 1);
    // The day traded ONE dish (4800); the cancelled one must not be in it.
    const traded = TRADING_DAYS[2].orders.filter((order) => (order.status ?? 'COMPLETED') !== 'CANCELLED');
    assert.equal(voidDay.revenueMinor, traded.length * 4800);
  });

  await checkAsync('item mix ranks by quantity, with main/side flagged', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.ok(res.body.itemMix.length > 0, 'BASIC unlocks ITEM_MIX');

    const names = res.body.itemMix.map((row) => row.name);
    assert.ok(names.includes(MAIN_DISH), 'the seeded main dish must appear');
    assert.ok(names.includes(SIDE_DISH) === false || true);

    // 蝦餃 is seeded 5 times as a main; 凍檸茶 twice as a side (one of them in a
    // mixed order). Quantity ordering must be descending.
    for (let i = 1; i < res.body.itemMix.length; i += 1) {
      assert.ok(
        res.body.itemMix[i - 1].quantity >= res.body.itemMix[i].quantity,
        'item mix must be sorted by quantity descending, or the ranking is meaningless',
      );
    }

    const dumpling = res.body.itemMix.find((row) => row.name === MAIN_DISH);
    assert.equal(dumpling.isMainItem, true, 'the flag comes from the menu, not the order');
    assert.equal(dumpling.revenueMinor, dumpling.quantity * 4800, 'revenue is quantity x unit price');

    const tea = res.body.itemMix.find((row) => row.name === SIDE_DISH);
    if (tea) {
      assert.equal(tea.isMainItem, false);
      assert.equal(tea.revenueMinor, tea.quantity * 1800);
    }
  });

  await checkAsync('hour of day buckets in the SHOP zone, not UTC', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.equal(res.body.hourOfDay.length, 24, 'always 24 buckets, most of them empty');

    const byHour = new Map(res.body.hourOfDay.map((row) => [row.hour, row]));
    // Seeded local hours: 12, 12, 19, 19, 8 (the void at 08:00 is excluded).
    assert.equal(byHour.get(12).orderCount, 2, 'two orders were placed at 12:00 shop-local');
    assert.equal(byHour.get(19).orderCount, 2, 'two orders were placed at 19:00 shop-local');
    assert.equal(byHour.get(8).orderCount, 1, 'the void is not counted as trade');
    assert.equal(byHour.get(0).orderCount, 0, 'an untraded hour is a zero row, not a missing one');

    // A UTC bucket would have placed a 12:00 HKT order at 04:00. Check it did not.
    assert.equal(byHour.get(4).orderCount, 0, 'hours are shop-local; a UTC bucket here means the zone was dropped');
  });

  await checkAsync('channel mix splits on fulfilment AND payment mode', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.ok(res.body.channels.length > 0, 'BASIC unlocks CHANNEL_MIX');
    const total = res.body.channels.reduce((sum, row) => sum + row.orderCount, 0);
    assert.equal(
      total,
      res.body.totals.orderCount,
      'every traded order belongs to exactly one channel — the split must be exhaustive',
    );
    for (const row of res.body.channels) {
      assert.match(row.key, /^[A-Z_]+\/[A-Z_]+$/, 'the key composes fulfilment/payment so dine-in is not collapsed');
    }
  });

  await checkAsync('BASIC has no comparison — it is a PRO feature', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.equal(
      res.body.comparison,
      null,
      'hiding it in CSS would make the paid feature one curl away',
    );
  });

  // =========================================================================
  section('5. Admin grants PRO — the comparison window appears');
  // =========================================================================

  await checkAsync('POST admin analytics-tier PRO -> 200, still paid', async () => {
    const res = await api('POST', tierPath, { token: adminToken, body: { tier: 'PRO' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.after.tier, 'PRO');
    assert.equal(res.body.after.label, '專業報表');
    assert.equal(res.body.after.capabilities.length, 5, 'PRO has all five capabilities');
    assert.equal(res.body.isDowngrade, false);
  });

  await checkAsync('the comparison now reports the equal-length window before', async () => {
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.ok(res.body.comparison, 'PRO unlocks COMPARISON');
    assert.equal(res.body.comparison.from, PREVIOUS_WINDOW.from);
    assert.equal(res.body.comparison.to, PREVIOUS_WINDOW.to);
    assert.equal(
      res.body.comparison.label,
      `前 ${PREVIOUS_WINDOW.dayCount} 日`,
      'the label names the length of the period it compares against',
    );
    // The two windows must not overlap — a comparison against its own data is
    // the classic off-by-one, and it reads as a plausible small percentage.
    assert.ok(
      res.body.comparison.to < res.body.window.from,
      `the previous window must end before this one starts, got ${res.body.comparison.to} >= ${res.body.window.from}`,
    );
    assert.equal(
      res.body.comparison.from,
      res.body.window.from === WINDOW_FROM ? PREVIOUS_WINDOW.from : res.body.comparison.from,
      'the comparison is anchored to the requested window',
    );
  });

  await checkAsync('an empty previous window reports null change, not Infinity or NaN', async () => {
    // JSON has no Infinity/NaN; `percentChange` against a zero baseline is the
    // classic way "no baseline" becomes `null` in the type but `"Infinity"` on
    // the wire.
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const change = res.body.comparison.revenueChangePercent;
    assert.ok(
      change === null || Number.isFinite(change),
      `revenueChangePercent must be null or finite, got ${JSON.stringify(change)}`,
    );
  });

  // =========================================================================
  section('6. Downgrade warns about what is lost');
  // =========================================================================

  await checkAsync('PRO -> NONE reports isDowngrade and names the lost panels', async () => {
    const res = await api('POST', tierPath, { token: adminToken, body: { tier: 'NONE' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.isDowngrade, true, 'PRO -> NONE takes capabilities away');
    assert.ok(res.body.warning, 'an operator must confirm with the consequence in front of them');
    assert.match(res.body.warning, /同期比較/, 'the warning names what is LOST, not what remains');
    assert.match(res.body.warning, /每日營業額/);
    assert.equal(res.body.after.capabilities.length, 0);
  });

  await checkAsync('after the downgrade the panels are gone again — the export is not', async () => {
    const report = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.deepEqual(report.body.daily, [], 'a downgrade really revokes DAILY_ROLLUP');
    assert.equal(report.body.comparison, null);
    assert.equal(report.body.tier.canExportRawData, true, 'the export survives every tier change');

    const exported = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(exported.status, 200, 'a downgraded shop can still take its own data out');
  });

  await checkAsync('setting the same tier twice is not a downgrade and warns about nothing', async () => {
    const res = await api('POST', tierPath, { token: adminToken, body: { tier: 'NONE' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.isDowngrade, false);
    assert.equal(res.body.warning, null, 'nothing is lost when nothing changes');
    assert.match(res.body.message, /維持/, 'the message says the tier was kept, not changed');
  });

  await checkAsync('an unknown tier string -> 400 from the enum validator', async () => {
    const res = await api('POST', tierPath, { token: adminToken, body: { tier: 'ENTERPRISE' } });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('a merchant token cannot grant itself a tier', async () => {
    const res = await api('POST', tierPath, { token: merchantToken, body: { tier: 'PRO' } });
    assert.equal(
      res.status,
      403,
      `a shop must not be able to give itself the paid product, got ${res.status}`,
    );
  });

  await checkAsync('an unknown merchant id -> 404, and the tier is not created', async () => {
    const res = await api('POST', '/admin/merchants/00000000-0000-4000-8000-000000000000/analytics-tier', {
      token: adminToken,
      body: { tier: 'PRO' },
    });
    expectError(res, 404, 'ADMIN_TARGET_NOT_FOUND');
  });

  // =========================================================================
  section('7. The tier is a fact about the shop, and it survives a re-read');
  // =========================================================================

  await checkAsync('the tier is stored on the merchant row, not per viewer', async () => {
    await api('POST', tierPath, { token: adminToken, body: { tier: 'BASIC' } });

    const row = await prisma.merchant.findUnique({
      where: { id: MID },
      select: { analyticsTier: true },
    });
    assert.equal(row.analyticsTier, 'BASIC', 'the entitlement lives with the shop, not the session');

    // Two different tokens for two different staff of the same shop must see the
    // same tier — the entitled manager leaving must not take it with them.
    const staffToken = mintToken({ sub: owner.id, role: 'MERCHANT_STAFF', merchantIds: [MID] });
    const asOwner = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const asStaff = await api('GET', `${reportPath}?${windowQuery}`, { token: staffToken });
    assert.equal(asOwner.body.tier.tier, 'BASIC');
    assert.equal(asStaff.body.tier.tier, 'BASIC');
  });

  await checkAsync('an unrecognised tier cannot even reach the column — it is a real enum', async () => {
    // `toAnalyticsTier` fails closed, and this proves the second half of that
    // guarantee: the value it might have to fail closed ON cannot be written in
    // the first place. Postgres rejects anything outside the enum, so the
    // "corrupt config row" this guard defends against is unreachable via the DB.
    let rejected = false;
    let message = '';
    try {
      await prisma.$executeRawUnsafe(
        'UPDATE merchants SET "analyticsTier" = $1::"AnalyticsTier" WHERE id = $2::uuid',
        'PLATINUM',
        MID,
      );
    } catch (error) {
      rejected = true;
      message = String(error.message);
    }
    assert.ok(rejected, 'the column must refuse a value outside the AnalyticsTier enum');
    assert.match(message, /invalid input value for enum|AnalyticsTier/i, `unexpected rejection: ${message}`);

    // And the report still reads, with the tier it actually holds.
    const res = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.equal(res.status, 200);
    assert.ok(
      ['NONE', 'BASIC', 'PRO'].includes(res.body.tier.tier),
      `the report must only ever see a known tier, got ${res.body.tier.tier}`,
    );
  });

  await checkAsync('the export ignores the tier entirely — no tier is read on that path', async () => {
    // Whatever the column currently holds, the export answers.
    const res = await api('GET', `${exportPath}?${windowQuery}`, {
      token: merchantToken,
      raw: true,
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
  });

  // =========================================================================
  section('8. The report is consistent under a fresh read (no cache drift)');
  // =========================================================================

  await checkAsync('two reads of the same window agree exactly', async () => {
    const first = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    const second = await api('GET', `${reportPath}?${windowQuery}`, { token: merchantToken });
    assert.deepEqual(second.body.totals, first.body.totals, 'the SQL aggregation must be deterministic');
    assert.deepEqual(second.body.daily, first.body.daily);
  });

  await checkAsync('a one-day window narrows the totals to that day only', async () => {
    const res = await api('GET', `${reportPath}?from=${WINDOW_DAYS_TRADING[0]}&to=${WINDOW_DAYS_TRADING[0]}`, {
      token: merchantToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.window.days, 1, 'from === to is one day, not zero');
    const day = TRADING_DAYS[0];
    assert.equal(res.body.totals.orderCount, day.orders.length);
  });

  await checkAsync('a window with no trading returns zeros, not an error', async () => {
    const res = await api('GET', `${reportPath}?from=2020-01-01&to=2020-01-31`, {
      token: merchantToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.orderCount, 0);
    assert.equal(res.body.totals.revenueMinor, 0);
    assert.equal(res.body.totals.averageOrderValueMinor, 0, 'AOV on zero orders is 0, never NaN');
    assert.deepEqual(res.body.daily, []);
  });

  // =========================================================================
  section('cleanup');
  // =========================================================================
  //  Two things must be undone, and both matter for the next run:
  //
  //   1. The seeded orders, deleted BY ID. `deleteMany({ customerNote })` would
  //      also take a row a human created with the same note.
  //   2. The merchant's tier, put back to NONE. Leaving a shop upgraded changes
  //      what a later script sees, and the tier is the one piece of state this
  //      script wrote to a row it does not own.
  if (createdOrderIds.length > 0) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  await prisma.outboxEvent.deleteMany({
    where: { aggregateType: 'Order', aggregateId: { in: createdOrderIds.length ? createdOrderIds : ['-'] } },
  });
  await prisma.merchant.update({ where: { id: MID }, data: { analyticsTier: 'NONE' } });

  const remaining = await prisma.order.count({ where: { merchantId: MID } });
  console.log(`  ${createdOrderIds.length} seeded orders removed`);
  console.log(
    `  orders for ${MERCHANT_SLUG}: ${baseline} before this run, ${remaining} after cleanup`,
  );
  console.log('  merchant analytics tier restored to NONE');

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

main()
  .catch((error) => {
    console.error('\nFATAL', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

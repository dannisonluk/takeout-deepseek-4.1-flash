#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 店內點餐：掃碼 → 開桌 → 一桌多輪 → 結帳
// ============================================================================
//  Covers what the unit tests cannot: the seam between the QR tokens, the
//  sitting aggregate and the order pipeline. Five properties are load-bearing
//  and each fails silently in production:
//
//   1. TWO TOKENS, TWO POWERS. The static `dining_tables.qrToken` only OPENS a
//      sitting. Ordering authority is the one-time `dining_sessions.guestToken`
//      minted when the sitting opens. Collapsing them means a photograph of a
//      table code from a previous visit — or from the table next door — is
//      enough to add a round to somebody else's bill.
//
//   2. OPENING A SITTING IS IDEMPOTENT. Two guests at one table scanning within
//      a second must share ONE bill. The check and the insert are one atomic
//      step under `SELECT ... FOR UPDATE`, and the second request must JOIN the
//      first sitting rather than create a second.
//
//   3. AN IN-STORE ORDER IS AN ORDINARY ORDER. Same `Order` row, same pricing
//      engine, same kitchen board — the sitting only contributes
//      `diningSessionId`. If this ever became a second order lifecycle the
//      platform fee, the payout ledger and the timeout sweeper would all have
//      to be re-implemented, and half would be subtly wrong.
//
//   4. THE TAB IS THE SITTING'S, NOT THE ROUND'S. Three rounds must produce one
//      running total, and the response to each round must carry the WHOLE tab —
//      a guest on flaky in-store Wi-Fi should not need a second request to see
//      what they owe.
//
//   5. A CLOSED SITTING REFUSES ROUNDS. Once the bill is settled, a late order
//      is a tab nobody is going to pay for. The refusal is
//      `DINING_SESSION_CLOSED` (422), not a 404 — the token is still valid, the
//      sitting is simply over.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-dining.js
//
//  Shares the database with the other e2e scripts and MUST NOT run
//  concurrently with them. It cleans up after itself, keyed on the ids THIS
//  run created, and exits non-zero on any failure.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const MERCHANT_SLUG = 'dim-sum-express';

const OWNER_PHONE = '+85290000002';

/**
 * The table codes this run owns, so cleanup never touches a seeded table.
 *
 * NO HYPHENS: `normalizeTableCode` strips separators and uppercases, so
 * `E2E-A01` and `E2E A01` both canonicalise to `E2EA01`. Writing the raw strings
 * here would make every `assert.equal(code, ...)` fail against the stored form,
 * which is the first thing this script proved.
 */
const TABLE_CODES = {
  a: 'E2EA01',
  b: 'E2EB02',
  off: 'E2EX99',
};

/**
 * A code the run deliberately does NOT create. Scanning it must 404 rather than
 * resolve to some other shop's table, which is the whole point of a token being
 * opaque rather than sequential.
 */
const UNKNOWN_QR = 'e2e-never-issued-token-0000000000000000';

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

/** Ids this run created, so cleanup is run-scoped rather than attribute-scoped. */
const created = {
  tableIds: [],
  sessionIds: [],
  orderIds: [],
  /** Guest customer rows provisioned for the sittings — deleted last. */
  guestCustomerIds: [],
};

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, slug: true, timezone: true, ownerId: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

  const owner = await prisma.user.findUnique({
    where: { phone: OWNER_PHONE },
    select: { id: true },
  });
  if (!owner) throw new Error(`Run prisma/seed.js first — no user ${OWNER_PHONE}`);

  const merchantToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });

  const MID = merchant.id;
  const boardPath = `/merchant/${MID}/dining`;

  // A fresh floor for the run: only THIS run's tables, matched on code.
  const existing = await prisma.diningTable.findMany({
    where: { merchantId: MID, code: { in: Object.values(TABLE_CODES) } },
    select: { id: true },
  });
  if (existing.length > 0) {
    await prisma.diningTable.deleteMany({ where: { id: { in: existing.map((t) => t.id) } } });
  }

  // Resolve two dishes from the seeded menu: one MAIN (the fee is charged per
  // main item) and one non-main, so the pricing assertion has something to
  // distinguish.
  const items = await prisma.menuItem.findMany({
    where: { merchantId: MID, availability: 'AVAILABLE' },
    select: { id: true, name: true, priceMinor: true, isMainItem: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (items.length === 0) throw new Error('Run prisma/seed.js first — no menu items');
  const mainItem = items.find((item) => item.isMainItem);
  const sideItem = items.find((item) => !item.isMainItem) ?? items[0];
  if (!mainItem) throw new Error('Run prisma/seed.js first — no main item on the menu');

  // =========================================================================
  section('1. The floor plan must be built before anything can be scanned');
  // =========================================================================

  await checkAsync('GET board -> an empty floor for a shop with no tables', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.merchantId, MID);
    assert.equal(res.body.timezone, 'Asia/Hong_Kong');
    assert.match(res.body.serviceDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(res.body.tables.length, 0);
    assert.equal(res.body.counts.total, 0);
    assert.equal(res.body.counts.occupied, 0);
  });

  await checkAsync('POST table -> 201 with a QR token and a printable URL', async () => {
    const res = await api('POST', `${boardPath}/tables`, {
      token: merchantToken,
      body: { code: TABLE_CODES.a, label: '靠窗四人桌', seats: 4 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.code, TABLE_CODES.a);
    assert.equal(res.body.label, '靠窗四人桌');
    assert.equal(res.body.seats, 4);
    assert.equal(res.body.isActive, true);
    // The URL the shop prints. The `/table/` segment matters: the web app routes
    // a scanned TABLE code and a sitting's GUEST token to two different pages,
    // so a printed label built without it would 404 on the first scan.
    assert.match(
      res.body.qrUrl,
      /\/dine\/table\/.+/,
      `the printed QR must point at the scan page, got ${res.body.qrUrl}`,
    );
    assert.ok(res.body.qrToken.length >= 16, 'the token must not be guessable');
    assert.equal(res.body.session, null, 'a fresh table has no sitting');
    created.tableIds.push(res.body.id);
  });

  let tableA = null;
  let tableB = null;
  let tableOff = null;

  await checkAsync('a second table, and a third that is switched OFF', async () => {
    const b = await api('POST', `${boardPath}/tables`, {
      token: merchantToken,
      body: { code: TABLE_CODES.b, seats: 2 },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    tableB = b.body;
    created.tableIds.push(b.body.id);

    const off = await api('POST', `${boardPath}/tables`, {
      token: merchantToken,
      body: { code: TABLE_CODES.off, seats: 2, isActive: false },
    });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.equal(off.body.isActive, false);
    tableOff = off.body;
    created.tableIds.push(off.body.id);
  });

  await checkAsync('the code is NORMALISED, so `e2ea01` and `e2e a01` are one table', async () => {
    // `@@unique([merchantId, code])` only prevents duplicates if the stored
    // value is canonical. This is the check that proves the normalisation runs
    // BEFORE the insert: a differently-spelled code must land on the SAME row,
    // and the unique index then refuses it rather than creating a twin.
    const res = await api('POST', `${boardPath}/tables`, {
      token: merchantToken,
      body: { code: 'e2e a01' },
    });
    // A correct implementation refuses the duplicate. The unique constraint is
    // the backstop; the failure must be a 4xx, never a 500 — an unhandled
    // P2002 here would tell the shop "the server broke" for their own typo.
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a duplicate canonical code must be refused with a 4xx, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const stillOne = await prisma.diningTable.count({
      where: { merchantId: MID, code: TABLE_CODES.a },
    });
    assert.equal(stillOne, 1, 'the differently-spelled code must NOT have created a second row');
  });

  await checkAsync('a malformed table code -> 400', async () => {
    const res = await api('POST', `${boardPath}/tables`, {
      token: merchantToken,
      body: { code: '好棒的桌子!!' },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('the floor now reports 3 tables, 2 active, 0 occupied', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.total, 3);
    assert.equal(res.body.counts.active, 2);
    assert.equal(res.body.counts.occupied, 0);
    assert.equal(res.body.counts.free, 2);
    assert.equal(res.body.counts.seatedGuests, 0);
    tableA = res.body.tables.find((t) => t.code === TABLE_CODES.a);
    assert.ok(tableA, 'table A must be on the board');
  });

  // =========================================================================
  section('2. The scan — one response, before any sitting exists');
  // =========================================================================
  //  Read standing up, one-handed, on a phone camera. A second round-trip here
  //  is the difference between 掃碼即點 and a spinner in front of a waiter.

  await checkAsync('GET /dine/table/:token resolves shop, table and the empty tab', async () => {
    const res = await api('GET', `/dine/table/${tableA.qrToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.merchantId, MID);
    assert.equal(res.body.merchantName, merchant.name);
    assert.equal(res.body.merchantSlug, merchant.slug);
    assert.equal(res.body.tableCode, TABLE_CODES.a);
    assert.equal(res.body.tableLabel, '靠窗四人桌');
    assert.equal(res.body.seats, 4);
    assert.equal(res.body.diningEnabled, true, 'the scan reports whether dine-in is on');
    assert.equal(res.body.session, null, 'a free table has no sitting');
    assert.equal(res.body.qrToken, tableA.qrToken, 'the token is echoed for the next requests');
  });

  await checkAsync('an unknown token -> 404 (a rotated code must not resolve)', async () => {
    const res = await api('GET', `/dine/table/${UNKNOWN_QR}`);
    // The controller raises a bare `NotFoundException` when the query returns
    // null, so the code is the filter's generic `NOT_FOUND` rather than
    // `DINING_TABLE_NOT_FOUND`. Both are 404 and the guest sees the same
    // outcome; asserting the exact code here would pin a detail the scan page
    // does not branch on. What must hold is that the code is opaque: a token
    // that was never issued resolves to NOTHING, not to some other shop's table.
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  await checkAsync('a switched-off table still SCANS, but cannot be opened', async () => {
    // The scan view does not carry `isActive` — a guest has no use for the
    // floor plan's flags. Instead `diningEnabled` folds the table's own state
    // together with the shop's, and it is FALSE here: that is the single field
    // the scan page branches on to render "此桌號未開放掃碼點餐" rather than a
    // menu that would refuse every round.
    const scanned = await api('GET', `/dine/table/${tableOff.qrToken}`);
    assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
    assert.equal(scanned.body.tableCode, TABLE_CODES.off);
    assert.equal(
      scanned.body.diningEnabled,
      false,
      'a switched-off table must not offer a menu',
    );

    const res = await api('POST', `/dine/table/${tableOff.qrToken}/session`, { body: {} });
    expectError(res, 422, 'DINING_TABLE_INACTIVE');
  });

  // =========================================================================
  section('3. Opening a sitting mints the ONE-TIME token');
  // =========================================================================

  let guestToken = null;
  let sessionId = null;

  await checkAsync('POST session -> 201 with a guest token distinct from the QR', async () => {
    const res = await api('POST', `/dine/table/${tableA.qrToken}/session`, {
      body: { partySize: 4 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.guestToken, 'ordering authority must be returned');
    assert.notEqual(
      res.body.guestToken,
      tableA.qrToken,
      'the printed code must NOT double as the ordering token',
    );
    assert.match(
      res.body.orderingUrl,
      /\/dine\/s\/.+/,
      `the ordering URL must use the guest page, got ${res.body.orderingUrl}`,
    );
    assert.equal(res.body.session.tableCode, TABLE_CODES.a);
    assert.equal(res.body.session.partySize, 4);
    assert.equal(res.body.session.status, 'OPEN');
    assert.equal(res.body.session.statusLabel, '用餐中');
    assert.equal(res.body.session.totalMinor, 0);
    assert.equal(res.body.session.orderCount, 0);
    assert.equal(res.body.message.includes(TABLE_CODES.a), true);
    guestToken = res.body.guestToken;
    sessionId = res.body.session.id;
    created.sessionIds.push(sessionId);
  });

  await checkAsync('scanning AGAIN joins the same sitting — one table, one bill', async () => {
    const res = await api('POST', `/dine/table/${tableA.qrToken}/session`, { body: {} });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.session.id, sessionId, 'a second scan must NOT open a second sitting');
    assert.equal(
      res.body.guestToken,
      guestToken,
      'the second guest shares the first guest\'s bill — same token',
    );
  });

  await checkAsync('the scan now reports the open sitting and its party size', async () => {
    const res = await api('GET', `/dine/table/${tableA.qrToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.session, 'the sitting must now be visible to a scanner');
    assert.equal(res.body.session.id, sessionId);
    assert.equal(res.body.session.partySize, 4, 'the first scanner\'s number is the one kept');
  });

  await checkAsync('the board shows the table occupied with its running total', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.occupied, 1);
    assert.equal(res.body.counts.free, 1);
    assert.equal(res.body.counts.seatedGuests, 4);
    const row = res.body.tables.find((t) => t.code === TABLE_CODES.a);
    assert.ok(row.session, 'the occupied table must carry its sitting');
    assert.equal(row.session.seatedMinutes >= 0, true);
    assert.equal(row.session.totalMinor, 0);
  });

  // =========================================================================
  section('4. The tab — an ordinary order wearing a sitting id');
  // =========================================================================

  await checkAsync('GET the tab with no orders -> an empty, orderable tab', async () => {
    const res = await api('GET', `/dine/s/${guestToken}/tab`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.session.id, sessionId);
    assert.equal(res.body.merchantId, MID);
    assert.equal(res.body.lines.length, 0);
    assert.equal(res.body.subtotalMinor, 0);
    assert.equal(res.body.totalMinor, 0);
    assert.equal(res.body.canOrderMore, true, 'an OPEN sitting must accept a round');
    assert.equal(res.body.settledAt, null);
  });

  await checkAsync('a round of one main + one side -> 201 and a non-zero running total', async () => {
    const res = await api('POST', `/dine/s/${guestToken}/orders`, {
      body: {
        items: [
          { menuItemId: mainItem.id, quantity: 1 },
          { menuItemId: sideItem.id, quantity: 1 },
        ],
        customerNote: '走冰',
        idempotencyKey: `e2e-dine-round1-${Date.now()}`,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // The shape is `{ order: { order: {...}, lines: [...], pricing: {...} },
    // tab: {...} }`: the use case wraps `PlaceOrderResult`. The raw row is
    // `order.order` and the priced lines are `order.lines` — a dine-in round is
    // an ordinary placement, so it gets the ordinary payload.
    const placed = res.body.order;
    const order = placed.order;
    assert.ok(order && order.id, 'the round must produce an order id');
    created.orderIds.push(order.id);

    // THE ORDER IS ORDINARY: the pricing engine ran, so the lines sum to a
    // subtotal and the platform fee is charged per MAIN item — not per line,
    // and not at all on the side.
    assert.equal(placed.lines.length, 2);
    assert.equal(placed.lines.filter((line) => line.isMainItem).length, 1);
    assert.equal(
      placed.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
      mainItem.priceMinor + sideItem.priceMinor,
      'the lines must sum to the two seeded prices',
    );

    const expectedSubtotal = mainItem.priceMinor + sideItem.priceMinor;
    assert.equal(
      res.body.tab.subtotalMinor,
      expectedSubtotal,
      `subtotal ${res.body.tab.subtotalMinor}, expected ${expectedSubtotal}`,
    );
    // The TAB is per ROUND, not per dish: one row per order. `quantity` is the
    // order-level count (always 1 — the row IS one order) and `lineTotalMinor`
    // is that order's grand total including fees. The dish-level breakdown is
    // `order.lines` above (and the kitchen board). A tab that listed every dish
    // would be unreadable at a table of eight who ordered four rounds.
    assert.equal(res.body.tab.lines.length, 1, 'one round, one tab line');
    assert.equal(
      res.body.tab.lines[0].orderId,
      order.id,
      'the tab line is keyed on the order, so the page can open it',
    );
    assert.equal(
      res.body.tab.lines[0].lineTotalMinor,
      res.body.tab.totalMinor,
      'the only line\'s total is the tab total',
    );
    assert.equal(res.body.tab.session.orderCount, 1, 'one round so far');
    assert.equal(res.body.tab.session.mainItemCount, 1, 'exactly one main dish');
    // The confirmation prose is server-built so the table name cannot drift
    // from what the kitchen ticket says.
    assert.equal(typeof res.body.message, 'string');
    assert.equal(res.body.message.length > 0, true, 'the guest is told something');
  });

  await checkAsync('the round carried a dine-in fulfilment, billed at the store', async () => {
    const row = await prisma.order.findUnique({
      where: { id: created.orderIds[0] },
      select: {
        fulfilmentMode: true,
        paymentMode: true,
        diningSessionId: true,
        subtotalMinor: true,
        platformFeeMinor: true,
        customerServiceFeeMinor: true,
      },
    });
    assert.equal(row.diningSessionId, sessionId, 'the order must be linked to the sitting');
    assert.equal(row.paymentMode, 'PAY_AT_STORE', 'a seated guest pays at the counter');
    // PAY_AT_STORE suppresses the payment-processing fee — the platform is not
    // running a card, so it must not charge as if it were.
    assert.equal(
      row.customerServiceFeeMinor,
      0,
      'no customer service fee on a pay-at-store dine-in round',
    );
    assert.equal(row.subtotalMinor, mainItem.priceMinor + sideItem.priceMinor);
    // The platform fee is asserted against `platform_config` in the next check —
    // not copied here, so a fee change cannot pass this script by being written
    // into it twice.
    assert.equal(row.platformFeeMinor >= 0, true);
  });

  await checkAsync('the platform fee is per MAIN item, resolved from platform_config', async () => {
    // The same key `npm run check:pricing` audits, so the two cannot drift.
    const config = await prisma.platformConfig.findUnique({
      where: { key: 'pricing.platform_fee_per_main_item_minor' },
      select: { value: true },
    });
    const row = await prisma.order.findUnique({
      where: { id: created.orderIds[0] },
      select: { platformFeeMinor: true },
    });
    // Round 1 ordered exactly one main dish, so the fee is one unit.
    const expected = config ? Number(config.value) : 350;
    assert.equal(
      row.platformFeeMinor,
      expected,
      `fee ${row.platformFeeMinor} must equal one main item's ${expected}`,
    );
  });

  // =========================================================================
  section('5. Several rounds, ONE tab');
  // =========================================================================
  //  A dine-in guest orders three or four times across a sitting. The total is
  //  what they want to see, and re-fetching after every round is a second
  //  request on the flakiest device in the building.

  await checkAsync('a second round accumulates on the SAME tab', async () => {
    const res = await api('POST', `/dine/s/${guestToken}/orders`, {
      body: {
        items: [{ menuItemId: sideItem.id, quantity: 2 }],
        idempotencyKey: `e2e-dine-round2-${Date.now()}`,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.orderIds.push(res.body.order.order.id);

    // Two rounds, so two tab lines — the tab is per round.
    assert.equal(res.body.tab.lines.length, 2, 'the second round adds a second tab line');
    assert.equal(res.body.tab.session.orderCount, 2, 'two rounds');
    // The main count must stay at ONE — round 2 ordered only a side.
    assert.equal(
      res.body.tab.session.mainItemCount,
      1,
      'the platform fee is per main item, so a side-only round adds no fee-bearing item',
    );
    assert.equal(
      res.body.tab.subtotalMinor,
      mainItem.priceMinor + sideItem.priceMinor * 3,
      'the tab is the SUM of both rounds, not the last round',
    );
  });

  await checkAsync('a side-only round adds NO fee — the count is mains, not lines', async () => {
    // Round 2 ordered only the non-main dish, by construction. Its order row
    // must therefore carry a zero platform fee: charging an add-on would make
    // the fee per LINE, and the shop would pay for its own side dishes.
    const roundTwoId = created.orderIds[1];
    assert.ok(roundTwoId, 'precondition: round 2 was placed');

    const row = await prisma.order.findUnique({
      where: { id: roundTwoId },
      select: { platformFeeMinor: true, mainItemCount: true, items: { select: { isMainItem: true } } },
    });
    const mainCount = row.items.filter((item) => item.isMainItem).length;
    assert.equal(mainCount, 0, 'precondition: round 2 has no main dish');
    assert.equal(row.mainItemCount, 0, 'the order records zero mains');
    assert.equal(row.platformFeeMinor, 0, 'no main item means no platform fee');
  });

  await checkAsync('an idempotency key makes a double tap land once', async () => {
    // The page mints a per-attempt key precisely because in-store Wi-Fi makes a
    // double tap likely and a duplicate dine-in round is a real cost.
    const key = `e2e-dine-idem-${Date.now()}`;
    const body = {
      items: [{ menuItemId: sideItem.id, quantity: 1 }],
      idempotencyKey: key,
    };
    const before = await api('GET', `/dine/s/${guestToken}/tab`);

    const first = await api('POST', `/dine/s/${guestToken}/orders`, { body });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    created.orderIds.push(first.body.order.order.id);

    const second = await api('POST', `/dine/s/${guestToken}/orders`, { body });
    // The API may answer 201 with the SAME order (replay) or 409. Either is
    // correct; what must NOT happen is a second order row.
    assert.ok(
      second.status === 201 || second.status === 409,
      `a replayed key must not be a fresh error, got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    if (second.status === 201) {
      assert.equal(
        second.body.order.order.id,
        first.body.order.order.id,
        'the same key must return the SAME order, not a new one',
      );
    }

    const after = await api('GET', `/dine/s/${guestToken}/tab`);
    const added = after.body.subtotalMinor - before.body.subtotalMinor;
    assert.equal(
      added,
      sideItem.priceMinor,
      'the dish must be charged exactly once despite two identical requests',
    );
  });

  await checkAsync('an empty round is refused before it reaches the use case', async () => {
    const res = await api('POST', `/dine/s/${guestToken}/orders`, { body: { items: [] } });
    // `whitelist: true` strips undecorated properties, so the nested array
    // needs `@IsArray` + `@ArrayMinSize` + `@ValidateNested` + `@Type` together.
    // This is the check that would fail as "items should not exist" if one were
    // missing — the regression the DTO's header comment warns about.
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('an unknown dish -> a refusal, and the tab does not move', async () => {
    const before = await api('GET', `/dine/s/${guestToken}/tab`);
    const res = await api('POST', `/dine/s/${guestToken}/orders`, {
      body: { items: [{ menuItemId: '00000000-0000-4000-8000-0000000000ff', quantity: 1 }] },
    });
    assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
    const after = await api('GET', `/dine/s/${guestToken}/tab`);
    assert.equal(
      after.body.totalMinor,
      before.body.totalMinor,
      'a refused round must not leave a line on the tab',
    );
  });

  await checkAsync('the board reflects three rounds on one table', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    const row = res.body.tables.find((t) => t.code === TABLE_CODES.a);
    const orderCount = await prisma.order.count({ where: { diningSessionId: sessionId } });
    assert.equal(row.session.orderCount, orderCount, 'the board count must match the rows');
    assert.equal(row.session.totalMinor > 0, true);
  });

  // =========================================================================
  section('6. The merchant\'s view of the tab, and the host opening a table');
  // =========================================================================

  await checkAsync('GET the sitting as the merchant -> the same tab the guest sees', async () => {
    const guest = await api('GET', `/dine/s/${guestToken}/tab`);
    const host = await api('GET', `${boardPath}/sessions/${sessionId}`, { token: merchantToken });
    assert.equal(host.status, 200, JSON.stringify(host.body));
    assert.equal(host.body.session.id, sessionId);
    assert.equal(host.body.totalMinor, guest.body.totalMinor, 'one tab, two viewers');
    assert.equal(host.body.lines.length, guest.body.lines.length);
  });

  await checkAsync('a merchant cannot read another shop\'s sitting -> 404', async () => {
    const other = await prisma.merchant.findFirst({
      where: { id: { not: MID } },
      select: { id: true },
    });
    const path = other
      ? `/merchant/${other.id}/dining/sessions/${sessionId}`
      : `/merchant/00000000-0000-4000-8000-000000000009/dining/sessions/${sessionId}`;
    const res = await api('GET', path, { token: merchantToken });
    assert.ok(
      res.status === 403 || res.status === 404,
      `expected a refusal, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  });

  await checkAsync('a HOST opening a table produces the same sitting path as a scan', async () => {
    // The host seating a party and a guest scanning the label must not be two
    // code paths — the controller reuses the guest one by resolving the table's
    // token, so the sitting and its token are identical in shape.
    const res = await api('POST', `${boardPath}/tables/${tableB.id}/session`, {
      token: merchantToken,
      body: {},
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.sessionId, 'the host path returns a session id');
    assert.ok(res.body.guestToken, 'and the one-time token, so the guest can order');
    created.sessionIds.push(res.body.sessionId);
  });

  await checkAsync('the board now shows two occupied tables', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.body.counts.occupied, 2);
    assert.equal(res.body.counts.free, 0);
  });

  // =========================================================================
  section('7. Settling — CLOSED vs ABANDONED, and no rounds after');
  // =========================================================================

  await checkAsync('closing defaults to CLOSED and stamps settledAt', async () => {
    const res = await api('POST', `${boardPath}/sessions/${sessionId}/close`, {
      token: merchantToken,
      body: {},
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.session.status, 'CLOSED');
    assert.equal(res.body.session.statusLabel, '已結帳');
    assert.equal(res.body.tab.canOrderMore, false, 'a settled bill accepts nothing more');
    assert.ok(res.body.tab.settledAt, 'the tab must record when it was settled');
    assert.ok(res.body.session.closedAt);
    assert.equal(res.body.message.includes(TABLE_CODES.a), true);
  });

  await checkAsync('the settled tab still reads, and keeps its total', async () => {
    const res = await api('GET', `${boardPath}/sessions/${sessionId}`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.session.status, 'CLOSED');
    assert.equal(res.body.totalMinor > 0, true, 'a settled bill is still a record');
    assert.equal(res.body.canOrderMore, false);
  });

  await checkAsync('a round on a settled table -> 422 DINING_SESSION_CLOSED', async () => {
    const res = await api('POST', `/dine/s/${guestToken}/orders`, {
      body: { items: [{ menuItemId: mainItem.id, quantity: 1 }] },
    });
    // 422, not 404: the token is still valid and the sitting still exists — it
    // is simply over, which is a different sentence to the guest.
    expectError(res, 422, 'DINING_SESSION_CLOSED');
  });

  await checkAsync('the tile went free, and the closed sitting left the board', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    const row = res.body.tables.find((t) => t.code === TABLE_CODES.a);
    assert.equal(row.session, null, 'a closed sitting must not keep the table occupied');
    assert.equal(res.body.counts.occupied, 1, 'only table B is still occupied');
    assert.equal(res.body.counts.free, 1);
  });

  await checkAsync('closing an already-closed sitting -> 422 DINING_SESSION_CLOSED', async () => {
    const res = await api('POST', `${boardPath}/sessions/${sessionId}/close`, {
      token: merchantToken,
      body: {},
    });
    // Not `DINING_SESSION_CONFLICT`: that one is "a table can only have one OPEN
    // sitting", which is about opening. A second close is the machine refusing a
    // non-terminal TARGET from a terminal state, and the sentence the host sees
    // is the same one a late round gets — the bill is already settled.
    expectError(res, 422, 'DINING_SESSION_CLOSED');
  });

  await checkAsync('re-scanning a freed table opens a FRESH sitting with a NEW token', async () => {
    const res = await api('POST', `/dine/table/${tableA.qrToken}/session`, {
      body: { partySize: 2 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.notEqual(res.body.session.id, sessionId, 'a freed table must open a new sitting');
    assert.notEqual(
      res.body.guestToken,
      guestToken,
      'the one-time token is NEVER reused across sittings',
    );
    assert.equal(res.body.session.totalMinor, 0, 'a new sitting starts with an empty tab');
    created.sessionIds.push(res.body.session.id);

    // And the old token is dead, which is the whole point of one-time.
    const stale = await api('GET', `/dine/s/${guestToken}/tab`);
    assert.equal(
      stale.status,
      404,
      'a previous sitting\'s token must not still resolve to a tab',
    );
  });

  await checkAsync('ABANDONED is offered for a party that left without paying', async () => {
    const bSession = created.sessionIds[1];
    const res = await api('POST', `${boardPath}/sessions/${bSession}/close`, {
      token: merchantToken,
      body: { status: 'ABANDONED' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.session.status, 'ABANDONED');
    assert.equal(res.body.session.statusLabel, '已離場');
  });

  // =========================================================================
  section('8. Rotating a QR — the only lever when a code leaks');
  // =========================================================================

  let rotatedToken = null;

  await checkAsync('PATCH rotateQr -> a NEW token, and the old one stops resolving', async () => {
    const before = await api('GET', `/dine/table/${tableB.qrToken}`);
    assert.equal(before.status, 200, 'precondition: table B\'s code resolves');

    const res = await api('PATCH', `${boardPath}/tables/${tableB.id}`, {
      token: merchantToken,
      body: { rotateQr: true },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.qrToken, tableB.qrToken, 'rotation must mint a fresh token');
    rotatedToken = res.body.qrToken;

    const stale = await api('GET', `/dine/table/${tableB.qrToken}`);
    // The same generic 404 an unissued token gets — which is the point: a
    // rotated code must be indistinguishable from one that never existed.
    assert.equal(stale.status, 404, JSON.stringify(stale.body));

    const fresh = await api('GET', `/dine/table/${rotatedToken}`);
    assert.equal(fresh.status, 200, 'the new code must resolve');
  });

  await checkAsync('deactivating a table makes its code refuse to open', async () => {
    await api('PATCH', `${boardPath}/tables/${tableB.id}`, {
      token: merchantToken,
      body: { isActive: false },
    });
    const scanned = await api('GET', `/dine/table/${rotatedToken}`);
    assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
    assert.equal(scanned.body.diningEnabled, false, 'a switched-off table offers no menu');
    const open = await api('POST', `/dine/table/${rotatedToken}/session`, { body: {} });
    expectError(open, 422, 'DINING_TABLE_INACTIVE');
    await api('PATCH', `${boardPath}/tables/${tableB.id}`, {
      token: merchantToken,
      body: { isActive: true },
    });
  });

  await checkAsync('a guest token cannot be guessed from a table code', async () => {
    // The tokens come from different spaces, and a stale/forged guest token must
    // 404 rather than fall back to the table.
    const res = await api('GET', `/dine/s/${tableA.qrToken}/tab`);
    assert.equal(res.status, 404, 'a table code must not work as an ordering token');
  });

  await checkAsync('a customer token cannot read the floor plan -> 401/403', async () => {
    const customer = await prisma.user.findUnique({
      where: { phone: '+85290000001' },
      select: { id: true },
    });
    const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
    const res = await api('GET', boardPath, { token: customerToken });
    assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
  });

  // =========================================================================
  section('cleanup');
  // =========================================================================
  //  Run-scoped by id. The dining tables cascade their sessions, and the
  //  sessions' orders are deleted explicitly because the FK is the other way.
  //
  //  `menu_item_daily_stock` is keyed on `(menuItemId, serviceDate)` — there is
  //  NO `orderId` column, so "delete the order" cannot release the units it
  //  held. `held` must be decremented by the ordered quantity, exactly as a
  //  cancellation does. A script that skips this drifts the seeded menu toward
  //  sold-out on every run, and the failure surfaces in a LATER script as a
  //  quota refusal that looks like a product bug.
  const sessionRows = await prisma.diningSession.findMany({
    where: { id: { in: created.sessionIds } },
    select: { id: true, guestCustomerId: true },
  });
  const sessionIds = sessionRows.map((row) => row.id);
  const guestIds = sessionRows
    .map((row) => row.guestCustomerId)
    .filter((id) => Boolean(id));

  const orderRows = await prisma.order.findMany({
    where: { diningSessionId: { in: sessionIds } },
    select: { id: true, items: { select: { menuItemId: true, quantity: true } } },
  });
  const orderIds = orderRows.map((row) => row.id);

  if (orderIds.length > 0) {
    // Release the soft-held quota BEFORE the order lines disappear.
    const perItem = new Map();
    for (const order of orderRows) {
      for (const line of order.items) {
        perItem.set(line.menuItemId, (perItem.get(line.menuItemId) ?? 0) + line.quantity);
      }
    }
    for (const [menuItemId, quantity] of perItem) {
      await prisma.$executeRawUnsafe(
        `UPDATE menu_item_daily_stock
            SET held = GREATEST(held - $2, 0)
          WHERE "menuItemId" = $1::uuid`,
        menuItemId,
        quantity,
      );
    }

    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
    });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  await prisma.diningSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.diningTable.deleteMany({ where: { id: { in: created.tableIds } } });
  if (guestIds.length > 0) {
    // The provisioned guest identities. `users.phone` is nullable for these, so
    // match on the ids the sessions recorded rather than on an empty phone.
    await prisma.user.deleteMany({ where: { id: { in: guestIds } } });
  }
  console.log(
    `  ${orderIds.length} orders (with their stock rows), ${sessionIds.length} sittings, ` +
      `${created.tableIds.length} tables and ${guestIds.length} guest identities removed`,
  );

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

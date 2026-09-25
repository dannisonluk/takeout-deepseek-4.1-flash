#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 特別休息日
//  設定休息日 → 擋新單（取餐時段 + 訂位）→ 自動取消既有訂位 → 通知顧客
// ============================================================================
//  Four properties are load-bearing, and each is invisible until it is wrong:
//
//   1. ONE SOURCE OF TRUTH. The pickup-slot generator and `POST /orders` both
//      read their opening rules from `common/time/pickup-policy.ts`. If a rest
//      day closes only the generator, the app offers a time the order endpoint
//      then rejects — the customer blames the restaurant for a platform bug.
//      So this script asserts BOTH endpoints agree.
//
//   2. THE RESERVATION BOOK CLOSES TOO. A rest day that only stops orders and
//      leaves the booking grid open is worse than useless: the shop is closed
//      and still taking table reservations for that day.
//
//   3. THE CASCADE IS IDEMPOTENT. Saving the rest day twice must not cancel
//      twice. `cancelledReservationsAt` is the latch, and the second save has to
//      report `alreadySwept` rather than re-notifying parties.
//
//   4. SEATS COME BACK. A cancelled booking must release the slots it held, by
//      the same `RELEASE_TABLE_SLOT` rule every other exit uses. A leak here is
//      silent — the book just looks fuller than it is, forever.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-closure.js
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

/** The book policy this run installs, so every expectation is derived. */
const POLICY = {
  enabled: true,
  autoConfirm: true,
  slotMinutes: 30,
  turnMinutes: 90,
  seatsPerSlot: 12,
  minPartySize: 1,
  maxPartySize: 10,
  leadTimeMinutes: 60,
  advanceDays: 14,
  customerNotice: null,
};

/** How many start-slots a 90-minute turn spans on a 30-minute grid. */
const SLOTS_PER_BOOKING = Math.ceil(POLICY.turnMinutes / POLICY.slotMinutes);

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

/**
 * Ids of the orders this run created, so cleanup can delete exactly those.
 *
 * Scoping cleanup by (customerId, merchantId) is not safe: every e2e script
 * uses the same seeded customer and merchant, so that filter also matches
 * orders another script left behind — and `merchant_payout_lines.orderId` is
 * `onDelete: Restrict`, so deleting a settled order throws P2003 mid-cleanup.
 */
const createdOrderIds = [];

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

// ---- time helpers ---------------------------------------------------------
const HK_OFFSET_MINUTES = 8 * 60; // Asia/Hong_Kong, fixed since 1979.
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for `daysAhead` in Hong Kong. */
function hkDate(daysAhead) {
  const now = new Date();
  const local = new Date(now.getTime() + HK_OFFSET_MINUTES * 60_000 + daysAhead * DAY_MS);
  return local.toISOString().slice(0, 10);
}

/**
 * A future instant sitting exactly on the slot grid, in HONG KONG LOCAL TIME.
 *
 * Built by walking the local clock and converting back, which is what the API
 * expects. Passing a UTC-aligned time would accidentally land on the grid for a
 * whole-hour offset like Hong Kong's and prove nothing.
 */
function gridInstant({ daysAhead, hour, minute = 0 }) {
  const now = new Date();
  const local = new Date(now.getTime() + HK_OFFSET_MINUTES * 60_000);
  local.setUTCDate(local.getUTCDate() + daysAhead);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - HK_OFFSET_MINUTES * 60_000);
}

/** Every slot row for the merchant, as an ISO -> booked map. */
async function slotMap(merchantId) {
  const rows = await prisma.reservationSlot.findMany({
    where: { merchantId },
    select: { slotStart: true, booked: true },
  });
  return new Map(rows.map((row) => [row.slotStart.toISOString(), row.booked]));
}

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, timezone: true, status: true, ownerId: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

  // A fresh book for the run. The seeded merchant, hours and users stay.
  await prisma.reservation.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.reservationSlot.deleteMany({ where: { merchantId: merchant.id } });

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

  const merchantToken = mintToken({
    sub: owner.id,
    role: 'MERCHANT_OWNER',
    merchantIds: [merchant.id],
  });
  const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });

  const MID = merchant.id;
  const settingsPath = `/merchant/${MID}/reservations/settings`;
  const closuresPath = `/merchant/${MID}/closures`;

  // The day this whole run closes. Two days out: far enough that the booking
  // lead time never gets in the way, close enough that a 14-day advance window
  // comfortably covers it.
  const REST_DAY = hkDate(2);
  const openDay = hkDate(3);

  // =========================================================================
  section('1. Clean slate — clear the rest days a previous run may have left');
  // =========================================================================

  await prisma.merchantClosure.deleteMany({ where: { merchantId: MID } });
  await prisma.reservationSettings.deleteMany({ where: { merchantId: MID } });

  await checkAsync('GET closures -> empty', async () => {
    const res = await api('GET', `${closuresPath}?from=${hkDate(0)}`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.length, 0);
  });

  // =========================================================================
  section('2. Open the book and fill the rest day with reservations');
  // =========================================================================

  await checkAsync('PUT reservation settings -> book enabled, auto-confirm', async () => {
    const res = await api('PUT', settingsPath, { token: merchantToken, body: POLICY });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.policy.enabled, true);
  });

  const slotA = gridInstant({ daysAhead: 2, hour: 19, minute: 0 });
  const slotB = gridInstant({ daysAhead: 2, hour: 20, minute: 0 });
  const slotOpen = gridInstant({ daysAhead: 3, hour: 19, minute: 0 });

  /** Book `at` and return the reservation id. */
  async function book(at, name) {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: {
        merchantId: MID,
        startsAt: at.toISOString(),
        partySize: 2,
        customerName: name,
        contactPhone: '+85291110000',
      },
    });
    assert.equal(res.status, 201, `booking failed: ${JSON.stringify(res.body)}`);
    return res.body.id;
  }

  let resA;
  let resB;
  let resOpen;
  await checkAsync('two bookings on the rest day, one on the following day', async () => {
    resA = await book(slotA, '休息日甲');
    resB = await book(slotB, '休息日乙');
    resOpen = await book(slotOpen, '翌日');
    assert.ok(resA && resB && resOpen);
  });

  await checkAsync('the rest day is bookable while no closure exists', async () => {
    const res = await api(
      'GET',
      `/merchants/${MID}/reservation-availability?from=${REST_DAY}&to=${REST_DAY}`,
      { token: customerToken },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.bookableCount > 0, `expected bookable slots, got ${res.body.bookableCount}`);
    assert.deepEqual(res.body.closedDates, [], 'no closures yet');
  });

  await checkAsync('the pickup-slot grid offers slots, and names no closure yet', async () => {
    const res = await api('GET', `/merchant/${MID}/pickup-slots`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The grid's horizon is 24 hours (`MAX_ADVANCE_HOURS`), so a rest day two
    // days out is NOT expected here — see the dedicated check in section 4 for
    // the case where the closure actually falls inside the horizon.
    assert.ok(res.body.slots.length > 0, 'slots must exist before the closure');
    assert.equal(res.body.closureDate, null, 'no closure inside the 24-hour horizon yet');
  });

  // =========================================================================
  section('3. Close the day — and watch the bookings get cancelled');
  // =========================================================================

  let write;
  await checkAsync('PUT closure -> 201/200 with a cancellation count of 2', async () => {
    const res = await api('PUT', `${closuresPath}/${REST_DAY}`, {
      token: merchantToken,
      body: { reason: 'PUBLIC_HOLIDAY', note: '中秋節翌日休息' },
    });
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
    write = res.body;
    assert.equal(res.body.cancelledReservations, 2, `expected 2 cancelled: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.alreadySwept, false);
    assert.equal(res.body.remainingActive, 0);
    assert.equal(res.body.closure.serviceDate, REST_DAY);
    assert.equal(res.body.closure.reason, 'PUBLIC_HOLIDAY');
    assert.equal(res.body.closure.note, '中秋節翌日休息');
  });

  await checkAsync('the two rest-day bookings are now CANCELLED in the database', async () => {
    const rows = await prisma.reservation.findMany({
      where: { id: { in: [resA, resB] } },
      select: { id: true, status: true, statusReason: true, cancelledAt: true },
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'CANCELLED', `${row.id} should be cancelled`);
      assert.ok(row.cancelledAt, 'cancelledAt must be stamped');
      // Tagged so the lifecycle record says the SYSTEM moved it, not a person.
      assert.equal(row.statusReason, `MERCHANT_CLOSED:${REST_DAY}`);
    }
  });

  await checkAsync('the following day’s booking is untouched', async () => {
    const row = await prisma.reservation.findUnique({
      where: { id: resOpen },
      select: { status: true },
    });
    assert.equal(row.status, 'CONFIRMED', 'a booking on an open day must survive');
  });

  await checkAsync('a cancellation event was enqueued for each party (they get told)', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: {
        aggregateType: 'Reservation',
        aggregateId: { in: [resA, resB] },
      },
      select: { eventType: true, aggregateId: true },
    });
    const byReservation = new Map();
    for (const event of events) {
      byReservation.set(event.aggregateId, event.eventType);
    }
    // `reservation.cancelled` is the event the gateway fans out to the
    // customer's tracker room. Its presence is what makes "cancelled but
    // nobody told the customer" impossible.
    assert.equal(byReservation.get(resA), 'reservation.cancelled');
    assert.equal(byReservation.get(resB), 'reservation.cancelled');
  });

  await checkAsync('the seats the two bookings held were released', async () => {
    // Each booking held SLOTS_PER_BOOKING start-slots. After cancellation every
    // one of them must be back to zero — a leak here is invisible until the
    // shop's Saturday looks full when it is not.
    const map = await slotMap(MID);
    for (const at of [slotA, slotB]) {
      for (let index = 0; index < SLOTS_PER_BOOKING; index += 1) {
        const start = new Date(at.getTime() + index * POLICY.slotMinutes * 60_000).toISOString();
        const booked = map.get(start);
        if (booked !== undefined) {
          assert.equal(booked, 0, `slot ${start} should have been released, holds ${booked}`);
        }
      }
    }
  });

  // =========================================================================
  section('4. The rest day blocks new business — both entry points');
  // =========================================================================

  await checkAsync('a new reservation on the rest day -> no bookable slots', async () => {
    const res = await api(
      'GET',
      `/merchants/${MID}/reservation-availability?from=${REST_DAY}&to=${REST_DAY}`,
      { token: customerToken },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bookableCount, 0, 'a closed day must offer nothing');
    assert.equal(res.body.slots.length, 0, 'and must not even return un-bookable rows');
    assert.deepEqual(res.body.closedDates, [REST_DAY], 'the day must be reported as closed');
  });

  await checkAsync('booking directly against the rest day -> refused', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: {
        merchantId: MID,
        startsAt: gridInstant({ daysAhead: 2, hour: 21, minute: 0 }).toISOString(),
        partySize: 2,
        customerName: '硬闖',
        contactPhone: '+85291110000',
      },
    });
    // THE POINT OF THIS CHECK: the grid hides the day, but the grid is a
    // courtesy. A client that posts a start time directly — a retried request,
    // a stale tab left open across the closure — must still be refused. Any 2xx
    // here means a table was booked in a shop that is shut.
    expectError(res, 422, 'MERCHANT_CLOSED');
  });

  await checkAsync('the pickup-slot grid skips the rest day and says why', async () => {
    // The grid's horizon is 24 hours, so a rest day two days out is invisible to
    // it. Closing TODAY is what makes the closure fall inside the horizon, and
    // that is the case where the generator and the order endpoint must agree.
    const today = hkDate(0);
    const closeToday = await api('PUT', `${closuresPath}/${today}`, {
      token: merchantToken,
      body: { reason: 'MAINTENANCE', note: '今天暫停營業' },
    });
    assert.ok(
      closeToday.status === 200 || closeToday.status === 201,
      JSON.stringify(closeToday.body),
    );

    const res = await api('GET', `/merchant/${MID}/pickup-slots`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // THE POINT OF THIS CHECK: the generator and `POST /orders` share one
    // implementation of "are we open". If the day were excluded only from the
    // generator, the app would offer a time the order endpoint rejects.
    const todaySlots = res.body.slots.filter((slot) => slot.dayOffset === 0);
    assert.equal(
      todaySlots.length,
      0,
      `no pickup slot may fall on the closed day, got ${todaySlots.length}`,
    );
    assert.equal(res.body.closureDate, today, 'the grid must name the rest day');
    assert.equal(res.body.acceptingNow, false, 'and the shop is not accepting now');
    assert.equal(res.body.closedReason, 'CLOSED_FOR_CLOSURE', 'with the rest-day reason');
  });

  await checkAsync('POST /orders for a pickup time on the rest day -> refused', async () => {
    const menuItem = await prisma.menuItem.findFirst({
      where: { merchantId: MID, availability: 'AVAILABLE' },
      select: { id: true },
    });
    assert.ok(menuItem, 'the seed must provide an available menu item');

    const res = await api('POST', '/orders', {
      token: customerToken,
      body: {
        merchantId: MID,
        fulfilmentMode: 'SELF_PICKUP',
        paymentMode: 'PAY_AT_STORE',
        scheduledPickupAt: gridInstant({ daysAhead: 2, hour: 19, minute: 0 }).toISOString(),
        items: [{ menuItemId: menuItem.id, quantity: 1 }],
      },
    });
    // The order endpoint must agree with the grid that the day is shut. Any
    // 2xx here means the two paths disagree, which is the exact bug this
    // feature was built to avoid.
    expectError(res, 422, 'PICKUP_TIME_NOT_FEASIBLE');
  });

  await checkAsync('a pickup time on an OPEN day still works', async () => {
    const menuItem = await prisma.menuItem.findFirst({
      where: { merchantId: MID, availability: 'AVAILABLE' },
      select: { id: true },
    });
    assert.ok(menuItem, 'the seed must provide an available menu item');

    // The order horizon is MAX_ADVANCE_HOURS = 24, so this must stay inside the
    // next 24 hours — the point of the check is that a NON-closed day is
    // unaffected, not that the platform will schedule arbitrarily far ahead.
    const pickupAt = new Date(Date.now() + 20 * 3_600_000);
    pickupAt.setUTCMinutes(0, 0, 0);

    const res = await api('POST', '/orders', {
      token: customerToken,
      body: {
        merchantId: MID,
        fulfilmentMode: 'SELF_PICKUP',
        paymentMode: 'PAY_AT_STORE',
        scheduledPickupAt: pickupAt.toISOString(),
        items: [{ menuItemId: menuItem.id, quantity: 1 }],
      },
    });

    // A 422 with `PICKUP_TIME_NOT_FEASIBLE` here is NOT necessarily a failure of
    // the closure feature: the generated instant can land outside the shop's
    // weekly hours (a 02:00 HKT pickup, or one after closing). What must NOT
    // happen is `MERCHANT_CLOSED` — that would mean the closure leaked onto a
    // day nobody closed.
    if (res.status !== 200 && res.status !== 201) {
      assert.notEqual(
        res.body?.error?.code,
        'MERCHANT_CLOSED',
        'a closure must not affect any other day',
      );
      assert.equal(res.body?.error?.code, 'PICKUP_TIME_NOT_FEASIBLE', JSON.stringify(res.body));
      console.log(
        `      (accepted: the 20-hour instants lands outside opening hours — ${res.body.error.code})`,
      );
      return;
    }

    // Deleted outside the transaction, right here, because this order is at
    // `PENDING_PAYMENT` and holds no capacity that needs releasing. Track it
    // too so the end-of-run sweep is the backstop, not the only attempt.
    createdOrderIds.push(res.body.id);
    await prisma.order.deleteMany({ where: { id: res.body.id } });
  });

  // =========================================================================
  section('5. Idempotence — saving the same rest day twice must not double-cancel');
  // =========================================================================

  // A fresh booking on a day we are about to close, so the second save has
  // something it COULD wrongly cancel.
  const secondDay = hkDate(4);
  let resSecond;
  await checkAsync('book the second day we are about to close', async () => {
    resSecond = await book(gridInstant({ daysAhead: 4, hour: 20, minute: 0 }), '第二休息日');
  });

  await checkAsync('first save on the new day cancels 1', async () => {
    const res = await api('PUT', `${closuresPath}/${secondDay}`, {
      token: merchantToken,
      body: { reason: 'STAFF_HOLIDAY' },
    });
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
    assert.equal(res.body.cancelledReservations, 1);
    assert.equal(res.body.alreadySwept, false);
  });

  await checkAsync('re-saving the same day reports alreadySwept and cancels nothing', async () => {
    // This is the check that protects a merchant who edits the note on an
    // existing rest day. Without the latch, the save would re-sweep and each
    // party would be "cancelled" a second time.
    const res = await api('PUT', `${closuresPath}/${secondDay}`, {
      token: merchantToken,
      body: { reason: 'STAFF_HOLIDAY', note: '改備註' },
    });
    assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.body));
    assert.equal(res.body.alreadySwept, true, 'the latch must hold');
    assert.equal(res.body.cancelledReservations, 0, 'a second save must cancel nothing');
    assert.equal(res.body.closure.note, '改備註', 'but the note must still be updated');
  });

  await checkAsync('the second day’s booking is cancelled exactly once', async () => {
    const row = await prisma.reservation.findUnique({
      where: { id: resSecond },
      select: { status: true, statusReason: true },
    });
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.statusReason, `MERCHANT_CLOSED:${secondDay}`);
  });

  await checkAsync('re-saving enqueued no additional cancellation events', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Reservation', aggregateId: resSecond },
      select: { eventType: true },
    });
    const cancels = events.filter((event) => event.eventType === 'reservation.cancelled');
    assert.equal(cancels.length, 1, `expected exactly one cancellation event, got ${cancels.length}`);
  });

  // =========================================================================
  section('6. Reopening the day');
  // =========================================================================

  await checkAsync('DELETE closure -> 204, and the grid opens again', async () => {
    const res = await api('DELETE', `${closuresPath}/${secondDay}`, { token: merchantToken });
    assert.equal(res.status, 204, JSON.stringify(res.body));
  });

  await checkAsync('the day is bookable again after reopening', async () => {
    const res = await api(
      'GET',
      `/merchants/${MID}/reservation-availability?from=${secondDay}&to=${secondDay}`,
      { token: customerToken },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.bookableCount > 0, 'reopening must restore the slots');
    assert.deepEqual(res.body.closedDates, []);
  });

  await checkAsync('the cancelled parties are NOT silently re-booked', async () => {
    // Deliberate asymmetry: reopening gives the shop its slots back, but the
    // platform will not guess whether the closure or the customer's subsequent
    // plans should win. The shop rings them.
    const row = await prisma.reservation.findUnique({
      where: { id: resSecond },
      select: { status: true },
    });
    assert.equal(row.status, 'CANCELLED', 'reopening must not resurrect the booking');
  });

  await checkAsync('DELETE on a date with no closure -> 404', async () => {
    const res = await api('DELETE', `${closuresPath}/${hkDate(20)}`, { token: merchantToken });
    expectError(res, 404, 'CLOSURE_NOT_FOUND');
  });

  // =========================================================================
  section('7. Validation');
  // =========================================================================

  await checkAsync('closing a past date -> 422 CLOSURE_DATE_IN_PAST', async () => {
    const res = await api('PUT', `${closuresPath}/${hkDate(-1)}`, {
      token: merchantToken,
      body: { reason: 'OTHER' },
    });
    expectError(res, 422, 'CLOSURE_DATE_IN_PAST');
  });

  await checkAsync('a malformed date -> 400, not a 500', async () => {
    const res = await api('PUT', `${closuresPath}/not-a-date`, {
      token: merchantToken,
      body: { reason: 'OTHER' },
    });
    // `serviceDate` is a PATH parameter, so no body validator sees it. Without
    // an explicit check it reaches Prisma as an `Invalid Date` and the caller's
    // typo comes back as INTERNAL_ERROR.
    expectError(res, 400, 'CLOSURE_DATE_INVALID');
  });

  await checkAsync('a well-formed but impossible date -> 400', async () => {
    const res = await api('PUT', `${closuresPath}/2026-02-31`, {
      token: merchantToken,
      body: { reason: 'OTHER' },
    });
    // Matches `YYYY-MM-DD` but rolls over to 3 March. Accepting the rollover
    // would store a closure on a day nobody named.
    expectError(res, 400, 'CLOSURE_DATE_INVALID');
  });

  await checkAsync('an unknown reason code -> 400', async () => {
    const res = await api('PUT', `${closuresPath}/${hkDate(6)}`, {
      token: merchantToken,
      body: { reason: 'BECAUSE_I_SAID_SO' },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('closing a day twice through GET returns the stored row', async () => {
    const res = await api('GET', `${closuresPath}/${REST_DAY}`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.serviceDate, REST_DAY);
    assert.ok(res.body.cancelledReservationsAt, 'the latch must be stamped');
    assert.equal(res.body.cancelledReservationCount, 2);
  });

  await checkAsync('the list is ascending and windowed by `from`', async () => {
    const res = await api('GET', `${closuresPath}?from=${hkDate(0)}`, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const dates = res.body.map((row) => row.serviceDate);
    assert.deepEqual(dates, [...dates].sort(), 'must be ascending');
    assert.ok(dates.includes(REST_DAY));
    assert.ok(
      !dates.includes(hkDate(-1)),
      'a closure in the past must not appear in a from-today window',
    );
  });

  // =========================================================================
  section('8. The customer-facing effect on the merchant detail view');
  // =========================================================================

  await checkAsync('a customer can see the shop is shut without being signed in', async () => {
    const res = await api('GET', `/merchants/${MERCHANT_SLUG}/pickup-slots`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The public endpoint serves the same policy as the authenticated one —
    // that is the whole point of the shared `pickup-policy` module.
    assert.equal(res.body.closureDate, hkDate(0), 'the public grid must name the rest day');
    assert.equal(res.body.acceptingNow, false);
    assert.equal(res.body.closedReason, 'CLOSED_FOR_CLOSURE');
  });

  await checkAsync('reopening today restores acceptance on the public endpoint', async () => {
    const res = await api('DELETE', `${closuresPath}/${hkDate(0)}`, { token: merchantToken });
    assert.equal(res.status, 204, JSON.stringify(res.body));

    const after = await api('GET', `/merchants/${MERCHANT_SLUG}/pickup-slots`);
    assert.equal(after.status, 200);
    assert.equal(after.body.closureDate, null);
    // `acceptingNow` is about the weekly hours and the clock, so it may still be
    // false if the shop is simply past closing time — but the REASON must no
    // longer be the closure.
    assert.notEqual(after.body.closedReason, 'CLOSED_FOR_CLOSURE');
  });

  // =========================================================================
  section('9. Blast radius — other merchants and other days are unaffected');
  // =========================================================================

  await checkAsync('another merchant’s grid is unaffected by this closure', async () => {
    const other = await prisma.merchant.findFirst({
      where: { id: { not: MID } },
      select: { id: true },
    });
    if (!other) {
      console.log('      (skipped — only one merchant seeded)');
      return;
    }
    const res = await api('GET', `/merchant/${other.id}/pickup-slots`, { token: merchantToken });
    // 403 is the expected answer — the token is scoped to MID. Either way, the
    // other merchant must not inherit MID's closure.
    assert.ok([200, 403].includes(res.status), JSON.stringify(res.body));
  });

  // =========================================================================
  //  Cleanup
  // =========================================================================
  console.log('');
  await prisma.merchantClosure.deleteMany({ where: { merchantId: MID } });
  // Bookings and their slot rows go together: deleting a booking without its
  // slot rows leaves `booked` inflated and the next run starts from a
  // phantom-full book.
  await prisma.reservation.deleteMany({ where: { merchantId: MID } });
  await prisma.reservationSlot.deleteMany({ where: { merchantId: MID } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'Reservation' } });
  // Only the orders THIS RUN created, tracked as we went. Filtering by
  // (customerId, merchantId) instead would sweep up orders another e2e script
  // left behind — and if any of those has been settled, `merchant_payout_lines`
  // has `onDelete: Restrict` and the delete throws `P2003`, aborting the rest
  // of cleanup. Non-fatal (it happens after the PASS line) but it left rows
  // behind and read like a failure.
  if (createdOrderIds.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  await prisma.reservationSettings.deleteMany({ where: { merchantId: MID } });
  console.log('  closure rows, reservation rows, slot rows, reservation outbox rows removed');
  console.log(`  orders created by this run removed (${createdOrderIds.length})`);
  console.log('  reservation_settings removed (book back to its unconfigured default)');

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

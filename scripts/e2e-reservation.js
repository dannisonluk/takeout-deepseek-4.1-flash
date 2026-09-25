#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 預約訂位：開放訂位 → 顧客訂位 → 店家確認 → 入座 → 完成
// ============================================================================
//  Covers what unit tests cannot: the seam between the slot counter, the state
//  machine and the database. Three properties are load-bearing and each is
//  invisible until it is wrong in production:
//
//   1. SLOT ARITHMETIC. A 90-minute turn on a 30-minute grid must hold THREE
//      start-slots, not one. Holding only the first is how a shop sells the
//      same table twice on a Saturday night — and it looks perfectly healthy
//      until the second party arrives.
//
//   2. RELEASE SYMMETRY. Cancelling must give back exactly what was taken, from
//      every slot, and confirming must give back NOTHING. Getting either
//      direction wrong is silent: one leaks capacity until the book looks full,
//      the other double-books.
//
//   3. THE NO-SHOW GUARD. A shop must not be able to mark tonight's bookings as
//      no-shows at lunchtime and re-sell the tables while the parties are still
//      planning to turn up.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-reservation.js
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

/** The policy this run installs, so every expectation is derived, not copied. */
const POLICY = {
  enabled: true,
  autoConfirm: false,
  slotMinutes: 30,
  turnMinutes: 90,
  seatsPerSlot: 12,
  minPartySize: 1,
  maxPartySize: 10,
  leadTimeMinutes: 60,
  advanceDays: 14,
  customerNotice: '訂位保留 15 分鐘',
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

/**
 * A future instant sitting exactly on the slot grid.
 *
 * Built in LOCAL time for the merchant's zone and converted back to UTC, which
 * is what the API expects — passing a UTC-aligned time would accidentally land
 * on the grid for a whole-hour offset like Hong Kong's and prove nothing.
 */
function gridInstant({ daysAhead, hour, minute = 0 }) {
  const zoneOffsetMinutes = 8 * 60; // Asia/Hong_Kong, fixed since 1979.
  const now = new Date();
  const local = new Date(now.getTime() + zoneOffsetMinutes * 60_000);
  local.setUTCDate(local.getUTCDate() + daysAhead);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - zoneOffsetMinutes * 60_000);
}

/** Every slot row for the merchant, as a { ISO -> booked } map. */
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

  // A fresh book for the run. The seeded merchant, hours and users stay.
  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, timezone: true, status: true, ownerId: true },
  });
  if (!merchant) throw new Error(`Run prisma/seed.js first — no merchant ${MERCHANT_SLUG}`);

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

  // =========================================================================
  section('1. The book is off until the merchant turns it on');
  // =========================================================================

  await prisma.reservationSettings.deleteMany({ where: { merchantId: MID } });

  await checkAsync('GET settings with no row -> defaults, and disabled', async () => {
    const res = await api('GET', settingsPath, { token: merchantToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.policy.enabled, false, 'a never-configured book must be off');
    assert.equal(res.body.policy.seatsPerSlot, 16, 'defaults come from the domain policy');
    assert.equal(res.body.acceptingNew, false);
  });

  const tomorrow = gridInstant({ daysAhead: 1, hour: 19 });
  await checkAsync('booking while disabled -> 422 RESERVATIONS_DISABLED', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: {
        merchantId: MID,
        startsAt: tomorrow.toISOString(),
        partySize: 2,
        customerName: '未開放',
        contactPhone: '+85291110000',
      },
    });
    expectError(res, 422, 'RESERVATIONS_DISABLED');
  });

  // =========================================================================
  section('2. Merchant opens the book');
  // =========================================================================

  await checkAsync('PUT settings -> 200 with the stored policy', async () => {
    const res = await api('PUT', settingsPath, {
      token: merchantToken,
      body: POLICY,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.policy.enabled, true);
    assert.equal(res.body.policy.seatsPerSlot, POLICY.seatsPerSlot);
    assert.equal(res.body.policy.maxPartySize, POLICY.maxPartySize);
    assert.equal(res.body.customerNotice, POLICY.customerNotice);
    assert.equal(res.body.acceptingNew, true);
  });

  await checkAsync('minPartySize > maxPartySize -> 422 (the pair is unusable)', async () => {
    const res = await api('PUT', settingsPath, {
      token: merchantToken,
      body: { minPartySize: 6, maxPartySize: 4 },
    });
    expectError(res, 422, 'PLATFORM_CONFIG_INVALID');

    // Leave the book as the run intends it.
    await api('PUT', settingsPath, { token: merchantToken, body: { minPartySize: 1 } });
  });

  await checkAsync('turnMinutes < slotMinutes -> 422 (would overbook silently)', async () => {
    const res = await api('PUT', settingsPath, {
      token: merchantToken,
      body: { slotMinutes: 60, turnMinutes: 30 },
    });
    expectError(res, 422, 'PLATFORM_CONFIG_INVALID');
    await api('PUT', settingsPath, { token: merchantToken, body: { slotMinutes: 30 } });
  });

  await checkAsync('a customer cannot read the settings -> 401/403', async () => {
    const res = await api('GET', settingsPath, { token: customerToken });
    assert.ok(
      res.status === 401 || res.status === 403,
      `expected a refusal, got ${res.status}`,
    );
  });

  // =========================================================================
  section('3. Public availability — the grid, in the shop\'s own clock');
  // =========================================================================

  const dayStr = tomorrow.toISOString().slice(0, 10);

  await checkAsync('availability needs no token and reports the shop timezone', async () => {
    const res = await api('GET', `/merchants/${MID}/reservation-availability?from=${dayStr}&partySize=2`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.timezone, 'Asia/Hong_Kong');
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.slots.length > 0, 'a 14-day window must offer slots');
    assert.ok(res.body.bookableCount > 0);
  });

  await checkAsync('every slot sits on the 30-minute grid', async () => {
    const res = await api('GET', `/merchants/${MID}/reservation-availability?from=${dayStr}`);
    for (const slot of res.body.slots) {
      const minutes = new Date(slot.startsAt).getUTCMinutes();
      assert.ok(
        minutes % POLICY.slotMinutes === 0,
        `${slot.startsAt} is not on a ${POLICY.slotMinutes}-minute boundary`,
      );
    }
  });

  await checkAsync('the notice is the merchant\'s own words', async () => {
    const res = await api('GET', `/merchants/${MID}/reservation-availability?from=${dayStr}`);
    assert.equal(res.body.notice, POLICY.customerNotice);
  });

  await checkAsync('an unknown merchant -> 404', async () => {
    const res = await api(
      'GET',
      '/merchants/00000000-0000-4000-8000-000000000009/reservation-availability?from=' + dayStr,
    );
    assert.equal(res.status, 404);
  });

  // =========================================================================
  section('4. Booking — validation the book must refuse');
  // =========================================================================

  const base = {
    merchantId: MID,
    customerName: '陳大文',
    contactPhone: '+85291234567',
  };

  await checkAsync('party size 11 against max 10 -> 422 PARTY_SIZE_NOT_ALLOWED', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: tomorrow.toISOString(), partySize: 11 },
    });
    expectError(res, 422, 'PARTY_SIZE_NOT_ALLOWED');
  });

  await checkAsync('19:07 on a 30-minute grid -> 422 RESERVATION_SLOT_MISALIGNED', async () => {
    const offGrid = gridInstant({ daysAhead: 1, hour: 19, minute: 7 });
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: offGrid.toISOString(), partySize: 2 },
    });
    expectError(res, 422, 'RESERVATION_SLOT_MISALIGNED');
  });

  await checkAsync('inside the 60-minute lead time -> 422 RESERVATION_TOO_SOON', async () => {
    const soon = new Date(Date.now() + 20 * 60_000);
    soon.setUTCMinutes(0, 0, 0);
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: soon.toISOString(), partySize: 2 },
    });
    expectError(res, 422, 'RESERVATION_TOO_SOON');
  });

  await checkAsync('beyond advanceDays -> 422 RESERVATION_TOO_FAR_AHEAD', async () => {
    const far = gridInstant({ daysAhead: 20, hour: 19 });
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: far.toISOString(), partySize: 2 },
    });
    expectError(res, 422, 'RESERVATION_TOO_FAR_AHEAD');
  });

  await checkAsync('an unauthenticated booking -> 401', async () => {
    const res = await api('POST', '/reservations', {
      body: { ...base, startsAt: tomorrow.toISOString(), partySize: 2 },
    });
    assert.equal(res.status, 401);
  });

  // =========================================================================
  section('5. The first booking holds THREE slots, not one');
  // =========================================================================
  //  90-minute turn on a 30-minute grid. Holding one slot is the bug that sells
  //  the same table twice.

  let firstId = null;
  let firstNo = null;

  await checkAsync('POST /reservations -> 201, PENDING (autoConfirm is off)', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: {
        ...base,
        startsAt: tomorrow.toISOString(),
        partySize: 4,
        customerNote: '需要兒童座椅',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'PENDING', 'autoConfirm=false must wait for the shop');
    assert.equal(res.body.partySize, 4);
    assert.equal(res.body.autoConfirmed, false);
    assert.match(res.body.reservationNo, /^R-\d{8}-\d{4}$/);
    firstId = res.body.id;
    firstNo = res.body.reservationNo;
  });

  await checkAsync(`exactly ${SLOTS_PER_BOOKING} slot rows exist, each holding 4 seats`, async () => {
    const slots = await slotMap(MID);
    assert.equal(
      slots.size,
      SLOTS_PER_BOOKING,
      `expected ${SLOTS_PER_BOOKING} slot rows, got ${slots.size}`,
    );
    for (const [start, booked] of slots) {
      assert.equal(booked, 4, `slot ${start} holds ${booked}, expected 4`);
    }
  });

  await checkAsync('the held slots are consecutive and start at the booking time', async () => {
    const slots = await slotMap(MID);
    const starts = [...slots.keys()].sort();
    assert.equal(starts[0], tomorrow.toISOString(), 'the first slot is the booked instant');
    for (let i = 1; i < starts.length; i += 1) {
      const gap = (new Date(starts[i]) - new Date(starts[i - 1])) / 60_000;
      assert.equal(gap, POLICY.slotMinutes, `slot ${i} is ${gap} minutes after the previous`);
    }
  });

  // =========================================================================
  section('6. Capacity is per-slot and enforced');
  // =========================================================================

  await checkAsync('filling the slot exactly to seatsPerSlot -> 201', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: tomorrow.toISOString(), partySize: 8 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.partySize, 8);
  });

  await checkAsync('one more seat at the same time -> 422 RESERVATION_SLOT_UNAVAILABLE', async () => {
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: tomorrow.toISOString(), partySize: 1 },
    });
    expectError(res, 422, 'RESERVATION_SLOT_UNAVAILABLE');
  });

  await checkAsync('the refusal rolled the slot back — it is still exactly 12', async () => {
    const slots = await slotMap(MID);
    for (const [start, booked] of slots) {
      assert.equal(booked, POLICY.seatsPerSlot, `slot ${start} is ${booked}, expected 12`);
    }
  });

  await checkAsync('a later, non-overlapping slot is still bookable', async () => {
    // 19:00 + 90 minutes of turn ends at 20:30; 21:00 is clear of it.
    const later = gridInstant({ daysAhead: 1, hour: 21 });
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: later.toISOString(), partySize: 2 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  // =========================================================================
  section('7. The shop works the book');
  // =========================================================================

  let laterId = null;

  await checkAsync('the customer sees only their own, with canCancel computed', async () => {
    const res = await api('GET', '/reservations?status=ACTIVE', { token: customerToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 3, `expected >=3 active, got ${res.body.data.length}`);
    const first = res.body.data.find((row) => row.id === firstId);
    assert.equal(first.status, 'PENDING');
    assert.equal(first.canCancel, true, 'a PENDING booking is the customer\'s to cancel');
    assert.equal(first.merchantName, merchant.name);
    laterId = res.body.data.find((row) => row.partySize === 2)?.id ?? null;
  });

  await checkAsync('PENDING -> CONFIRMED releases NOTHING', async () => {
    // Snapshot first: confirming must not move a single seat.
    const before = await slotMap(MID);

    const res = await api('POST', `/merchant/${MID}/reservations/${firstId}/confirm`, {
      token: merchantToken,
      body: { merchantNote: '已為您預留靠窗位置' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fromStatus, 'PENDING');
    assert.equal(res.body.toStatus, 'CONFIRMED');
    assert.deepEqual(
      res.body.sideEffects,
      ['NOTIFY_CUSTOMER'],
      'confirming notifies the customer and holds the table — it must not release',
    );
    assert.ok(
      res.body.allowedNextTransitions.includes('SEATED'),
      'the board must be told it can seat the party',
    );
    assert.equal(res.body.reservation.merchantNote, '已為您預留靠窗位置');

    const after = await slotMap(MID);
    assert.deepEqual(
      [...after.entries()].sort(),
      [...before.entries()].sort(),
      'CONFIRMED moved the slot counters',
    );
  });

  await checkAsync('marking NO_SHOW before the booked time -> 409', async () => {
    const res = await api('POST', `/merchant/${MID}/reservations/${firstId}/no-show`, {
      token: merchantToken,
      body: {},
    });
    // The guard is what stops a shop clearing tonight's book at lunchtime.
    expectError(res, 409, 'RESERVATION_OUTSIDE_TURN_WINDOW');
  });

  await checkAsync('a customer cannot reach the merchant\'s book -> 401/403', async () => {
    const res = await api('GET', `/merchant/${MID}/reservations`, { token: customerToken });
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    const transition = await api(
      'POST',
      `/merchant/${MID}/reservations/${firstId}/confirm`,
      { token: customerToken, body: {} },
    );
    assert.ok(transition.status === 401 || transition.status === 403, `got ${transition.status}`);
  });

  await checkAsync('CONFIRMED -> SEATED -> COMPLETED', async () => {
    const seated = await api('POST', `/merchant/${MID}/reservations/${firstId}/seat`, {
      token: merchantToken,
      body: {},
    });
    assert.equal(seated.status, 200, JSON.stringify(seated.body));
    assert.equal(seated.body.toStatus, 'SEATED');

    const completed = await api('POST', `/merchant/${MID}/reservations/${firstId}/complete`, {
      token: merchantToken,
      body: {},
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.toStatus, 'COMPLETED');
    assert.deepEqual(
      completed.body.allowedNextTransitions,
      [],
      'COMPLETED is terminal — the board must offer nothing',
    );
  });

  await checkAsync('completing released the seats back to the pool', async () => {
    const slots = await slotMap(MID);

    // Assert against the slots THIS booking occupied, not every row in the
    // table — other bookings hold other times, and a blanket "everything is 8"
    // is the kind of absolute assertion that passes for the wrong reason.
    const expected = [];
    for (let i = 0; i < SLOTS_PER_BOOKING; i += 1) {
      expected.push(
        new Date(tomorrow.getTime() + i * POLICY.slotMinutes * 60_000).toISOString(),
      );
    }

    for (const start of expected) {
      assert.equal(
        slots.get(start),
        8,
        `slot ${start} holds ${slots.get(start)}, expected the 8-seat booking's 8 — ` +
          'the completed 4-seat booking must have given its seats back',
      );
    }
  });

  await checkAsync('a transition out of a terminal state -> 409', async () => {
    const res = await api('POST', `/merchant/${MID}/reservations/${firstId}/seat`, {
      token: merchantToken,
      body: {},
    });
    expectError(res, 409, 'RESERVATION_ALREADY_TERMINAL');
  });

  // =========================================================================
  section('8. Cancellation returns exactly what was taken');
  // =========================================================================

  await checkAsync('customer cancels their own pending booking', async () => {
    const res = await api('POST', `/reservations/${laterId}/cancel`, {
      token: customerToken,
      body: { reason: '臨時有事' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'CANCELLED');
    assert.ok(res.body.sideEffects.includes('RELEASE_TABLE_SLOT'));

    // 21:00 HKT onward: this booking's own slots must be clear of its 2 seats.
    const later = gridInstant({ daysAhead: 1, hour: 21 });
    const slots = await slotMap(MID);
    for (let i = 0; i < SLOTS_PER_BOOKING; i += 1) {
      const start = new Date(later.getTime() + i * POLICY.slotMinutes * 60_000).toISOString();
      assert.equal(
        slots.get(start) ?? 0,
        0,
        `slot ${start} still holds ${slots.get(start)} after the cancel`,
      );
    }
  });

  await checkAsync('a customer cannot cancel someone else\'s booking -> 404', async () => {
    const other = await prisma.user.findFirst({
      where: { phone: { not: CUSTOMER_PHONE } },
      select: { id: true },
    });
    const alien = mintToken({ sub: other.id, role: 'CUSTOMER' });
    const res = await api('POST', `/reservations/${laterId}/cancel`, {
      token: alien,
      body: {},
    });
    assert.equal(res.status, 404, 'a foreign id must not be distinguishable from a missing one');
  });

  await checkAsync('cancelled bookings drop out of the ACTIVE list', async () => {
    const res = await api('GET', '/reservations?status=ACTIVE', { token: customerToken });
    assert.ok(
      !res.body.data.some((row) => row.id === laterId),
      'a CANCELLED booking must not appear under ACTIVE',
    );
  });

  // =========================================================================
  section('9. autoConfirm takes the shop out of the loop');
  // =========================================================================

  await api('PUT', settingsPath, { token: merchantToken, body: { autoConfirm: true } });

  await checkAsync('with autoConfirm on, a booking lands CONFIRMED', async () => {
    const day3 = gridInstant({ daysAhead: 3, hour: 19 });
    const res = await api('POST', '/reservations', {
      token: customerToken,
      body: { ...base, startsAt: day3.toISOString(), partySize: 2 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'CONFIRMED', 'autoConfirm must skip PENDING');
    assert.equal(res.body.autoConfirmed, true);
  });

  await checkAsync('a PENDING booking cannot be declined once the shop is autoConfirming', async () => {
    // Nothing to decline — the state machine refuses PENDING-only paths from
    // CONFIRMED. The board is told so by allowedNextTransitions.
    const res = await api('GET', `/merchant/${MID}/reservations?status=ACTIVE`, {
      token: merchantToken,
    });
    assert.equal(res.status, 200);
    const confirmed = res.body.data.find((row) => row.status === 'CONFIRMED');
    assert.ok(confirmed, 'expected a CONFIRMED booking on the board');
    assert.ok(
      !confirmed.allowedNextTransitions.merchant.includes('DECLINED'),
      'DECLINED is only reachable from PENDING',
    );
  });

  // =========================================================================
  section('10. Outbox — the customer-side notification cannot be lost');
  // =========================================================================

  await checkAsync('one reservation event per transition, versions to the current row', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Reservation' },
      orderBy: { version: 'asc' },
      select: { aggregateId: true, eventType: true, version: true },
    });
    assert.ok(events.length > 0, 'expected reservation events in the outbox');

    // The completed booking walked PENDING -> CONFIRMED -> SEATED -> COMPLETED.
    const forFirst = events.filter((event) => event.aggregateId === firstId);
    assert.deepEqual(
      forFirst.map((event) => event.eventType),
      [
        'reservation.placed',
        'reservation.confirmed',
        'reservation.seated',
        'reservation.completed',
      ],
    );
    assert.deepEqual(
      forFirst.map((event) => event.version),
      [1, 2, 3, 4],
      'versions must be monotonic so a consumer can detect out-of-order delivery',
    );
  });

  await checkAsync('a cancelled booking emitted reservation.cancelled', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Reservation', aggregateId: laterId },
      orderBy: { version: 'asc' },
      select: { eventType: true },
    });
    assert.equal(events.at(-1).eventType, 'reservation.cancelled');
  });

  // =========================================================================
  section('cleanup');
  // =========================================================================
  //  Reservations are per-run artefacts; the seeded merchant and users stay.
  //  Both tables must go together — deleting a booking without its slot rows
  //  leaves `booked` inflated and the next run starts from a phantom-full book.
  await prisma.reservation.deleteMany({ where: { merchantId: MID } });
  await prisma.reservationSlot.deleteMany({ where: { merchantId: MID } });
  await prisma.outboxEvent.deleteMany({
    where: { aggregateType: 'Reservation' },
  });
  // Restore the shipped default so a later script (or a human) opening the
  // settings screen sees a book that is off, as the seed left it.
  await prisma.reservationSettings.deleteMany({ where: { merchantId: MID } });
  console.log('  reservation rows, slot rows, reservation outbox rows removed');
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

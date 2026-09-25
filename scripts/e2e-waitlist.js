#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — 現場候位：取號 → 叫號 → 入座 ／ 過號 ／ 放棄
// ============================================================================
//  Covers what the unit tests cannot: the seam between the ticket-number
//  allocator, the state machine and the database. Four properties are
//  load-bearing and each fails silently in production:
//
//   1. THE TICKET NUMBER IS UNIQUE PER SHOP PER DAY. `nextTicketNo` must never
//      reuse a gap. Two parties briefly holding `A-014` is a queue nobody can
//      work, and it looks fine until the host calls the wrong one.
//
//   2. ONE GUEST, ONE LIVE TICKET. The take-a-number page is a single large
//      button on a phone with a slow connection, so a double tap is the common
//      case — not the edge case. The second tap must answer "you are already
//      A-014", never issue A-015.
//
//   3. THE GUEST MAY LEAVE ONLY WHILE WAITING. Once called, the shop is
//      holding a table and the exit is a no-show, which only the host may
//      declare. Getting this wrong lets a guest drop out of a queue the shop
//      has already reserved capacity for. The refusal is deliberately
//      `WAITLIST_ACTOR_NOT_PERMITTED` rather than `WAITLIST_NOT_PERMITTED`:
//      `CALLED -> CANCELLED` IS a legal move, just not the guest's.
//
//   4. THE SWEEP IS A NO-OP UNTIL THE TIMEOUT HAS ACTUALLY ELAPSED. A sweeper
//      that fires early marks a guest who is walking back from the car park as
//      a no-show, and the host re-seats their table.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   node apps/api/dist/main.js
//    3. run:             node scripts/e2e-waitlist.js
//
//  Shares the database with the other e2e scripts and MUST NOT run
//  concurrently with them. It cleans up after itself, keyed on the ids THIS
//  run created (never on attributes — a blanket `deleteMany` by status would
//  take another script's rows with it), and exits non-zero on any failure.
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
 * The policy this run installs, so every expectation is derived, not copied.
 *
 * `callTimeoutMinutes` is deliberately tiny (1) so the sweep can be driven to
 * fire inside a test by calling the transition with a chosen `now` rather than
 * by sleeping. A test that sleeps is a test that is slow AND flaky.
 */
const POLICY = {
  enabled: true,
  acceptWhenClosed: true,
  minPartySize: 1,
  maxPartySize: 8,
  averageTurnMinutes: 30,
  callTimeoutMinutes: 1,
  customerNotice: '過號請重新取號',
};

/** A 9-person party against a max of 8 — the refusal the form must show. */
const OVERSIZE_PARTY = POLICY.maxPartySize + 1;

/** Phones this run owns, so cleanup never touches another script's rows. */
const GUEST_PHONES = {
  a: '+85271000001',
  b: '+85271000002',
  c: '+85271000003',
  d: '+85271000004',
  e: '+85271000005',
  alien: '+85271000009',
};

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
const createdEntryIds = [];

// ---- main -----------------------------------------------------------------
async function main() {
  if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env');

  const merchant = await prisma.merchant.findUnique({
    where: { slug: MERCHANT_SLUG },
    select: { id: true, name: true, timezone: true, status: true, ownerId: true },
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
  const settingsPath = `/merchant/${MID}/queue/settings`;
  const boardPath = `/merchant/${MID}/queue`;
  const publicPath = `/merchants/${MID}/queue`;

  // A fresh queue for the run. Scoped to this merchant only.
  await prisma.waitlistEntry.deleteMany({ where: { merchantId: MID } });

  // =========================================================================
  section('1. The queue is off until the merchant turns it on');
  // =========================================================================
  //  Shipping the feature must not start queueing guests at a shop that never
  //  asked for it — so the default is off and the guest is told so plainly.

  await prisma.waitlistSettings.deleteMany({ where: { merchantId: MID } });

  await checkAsync('GET settings with no row -> defaults, and disabled', async () => {
    const res = await api('GET', settingsPath, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.policy.enabled, false, 'a never-configured queue must be off');
    assert.equal(res.body.policy.maxPartySize, 10, 'defaults come from the domain policy');
    assert.equal(res.body.policy.acceptWhenClosed, false);
  });

  await checkAsync('the public entry point says DISABLED, not CLOSED', async () => {
    const res = await api('GET', publicPath);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.acceptingNow, false);
    // Two values rather than a boolean: the guest takes a different action for
    // each — "come back at 11" versus "this shop does not do queues".
    assert.equal(res.body.closedReason, 'DISABLED');
    assert.equal(res.body.merchantName, merchant.name);
    assert.equal(res.body.timezone, 'Asia/Hong_Kong');
  });

  await checkAsync('taking a number while disabled -> 422 WAITLIST_DISABLED', async () => {
    const res = await api('POST', publicPath, {
      body: {
        partySize: 2,
        guestName: '未開放',
        contactPhone: GUEST_PHONES.a,
      },
    });
    expectError(res, 422, 'WAITLIST_DISABLED');
  });

  // =========================================================================
  section('2. Merchant opens the queue');
  // =========================================================================

  await checkAsync('PATCH settings -> 200 with the stored policy', async () => {
    const res = await api('PATCH', settingsPath, { token: merchantToken, body: POLICY });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.policy.enabled, true);
    assert.equal(res.body.policy.maxPartySize, POLICY.maxPartySize);
    assert.equal(res.body.policy.callTimeoutMinutes, POLICY.callTimeoutMinutes);
    assert.equal(res.body.customerNotice, POLICY.customerNotice);
  });

  await checkAsync('minPartySize > maxPartySize -> 400 (a queue that seats nobody)', async () => {
    // Validated against the MERGED result, not against the DTO: this patch is
    // legal in isolation and illegal against the stored maxPartySize of 8.
    const res = await api('PATCH', settingsPath, {
      token: merchantToken,
      body: { minPartySize: 9 },
    });
    expectError(res, 400, 'WAITLIST_PARTY_SIZE');

    // Leave the queue as the run intends it.
    await api('PATCH', settingsPath, { token: merchantToken, body: { minPartySize: 1 } });
  });

  await checkAsync('a customer cannot read the host board -> 401/403', async () => {
    const customer = await prisma.user.findUnique({
      where: { phone: '+85290000001' },
      select: { id: true, role: true },
    });
    const customerToken = mintToken({ sub: customer.id, role: 'CUSTOMER' });
    const res = await api('GET', boardPath, { token: customerToken });
    assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
  });

  await checkAsync('an unknown merchant on the public route -> 404', async () => {
    const res = await api('GET', '/merchants/00000000-0000-4000-8000-000000000009/queue');
    assert.equal(res.status, 404);
  });

  // =========================================================================
  section('3. Taking a number — the whole confirmation in one response');
  // =========================================================================

  let ticketA = null;

  await checkAsync(`party size ${OVERSIZE_PARTY} against max ${POLICY.maxPartySize} -> 400`, async () => {
    const res = await api('POST', publicPath, {
      body: {
        partySize: OVERSIZE_PARTY,
        guestName: '超額',
        contactPhone: GUEST_PHONES.a,
      },
    });
    expectError(res, 400, 'WAITLIST_PARTY_SIZE');
  });

  await checkAsync('a malformed phone -> 400 (the phone IS the ticket identity)', async () => {
    const res = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '壞號碼', contactPhone: '123' },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  await checkAsync('POST -> 201 with number, position and the quoted estimate', async () => {
    const res = await api('POST', publicPath, {
      body: {
        partySize: 3,
        guestName: '陳大文',
        contactPhone: GUEST_PHONES.a,
        note: '需要兒童座椅',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const ticket = res.body.ticket;
    assert.match(ticket.ticketNo, /^[A-Z]-\d{3}$/, `unexpected ticketNo ${ticket.ticketNo}`);
    assert.equal(ticket.status, 'WAITING');
    assert.equal(ticket.statusLabel, '候位中');
    assert.equal(ticket.partySize, 3);
    assert.equal(ticket.guestName, '陳大文');
    // Position is computed against the queue INCLUDING the new ticket, so the
    // very first render is already truthful.
    assert.equal(ticket.position, 1);
    assert.equal(ticket.ahead, 0);
    assert.equal(ticket.quotedMinutes, 0, 'an empty queue quotes no wait');
    assert.equal(ticket.canCancel, true, 'a WAITING guest may leave');
    // The tab's own rule: a terminal ticket has no estimate, and `null` rather
    // than `0` because `0` renders as "now".
    assert.equal(ticket.calledAt, null);
    assert.equal(ticket.callDeadlineAt, null);
    assert.equal(res.body.message.includes(ticket.ticketNo), true);
    ticketA = ticket;
    createdEntryIds.push(ticket.id);
  });

  await checkAsync('the guest can read their own ticket back by phone', async () => {
    const res = await api('GET', `/queue/tickets/${ticketA.id}?phone=${encodeURIComponent(GUEST_PHONES.a)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ticketNo, ticketA.ticketNo);
    assert.equal(res.body.status, 'WAITING');
    assert.equal(res.body.customerNotice, POLICY.customerNotice);
  });

  await checkAsync('the SAME id with the WRONG phone -> 404, not 403', async () => {
    // A 403 would confirm that a ticket exists. A ticket carries a name.
    const res = await api('GET', `/queue/tickets/${ticketA.id}?phone=${encodeURIComponent(GUEST_PHONES.alien)}`);
    assert.equal(res.status, 404, 'a guessed id must reveal nothing');
  });

  await checkAsync('a second tap from the same phone -> 409 WAITLIST_ALREADY_QUEUED', async () => {
    const res = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '陳大文', contactPhone: GUEST_PHONES.a },
    });
    expectError(res, 409, 'WAITLIST_ALREADY_QUEUED');
    assert.equal(
      res.body.error.details.ticketNo,
      ticketA.ticketNo,
      'the refusal must name the ticket they already hold',
    );
  });

  // =========================================================================
  section('4. The queue is a queue — order and numbering');
  // =========================================================================

  let ticketB = null;
  let ticketC = null;

  await checkAsync('the next ticket is the NEXT NUMBER, never a reused one', async () => {
    const res = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '李小明', contactPhone: GUEST_PHONES.b },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ticketB = res.body.ticket;
    createdEntryIds.push(ticketB.id);

    const seqA = Number(ticketA.ticketNo.split('-')[1]);
    const seqB = Number(ticketB.ticketNo.split('-')[1]);
    assert.equal(seqB, seqA + 1, `${ticketA.ticketNo} then ${ticketB.ticketNo} — not consecutive`);
    assert.equal(ticketB.position, 2, 'the second guest is second');
    assert.equal(ticketB.ahead, 1);
    assert.equal(ticketB.quotedMinutes, POLICY.averageTurnMinutes, 'one party ahead = one turn');
  });

  await checkAsync('a third guest sees two ahead and a two-turn estimate', async () => {
    const res = await api('POST', publicPath, {
      body: { partySize: 4, guestName: '黃小美', contactPhone: GUEST_PHONES.c },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ticketC = res.body.ticket;
    createdEntryIds.push(ticketC.id);
    assert.equal(ticketC.position, 3);
    assert.equal(ticketC.ahead, 2);
    assert.equal(ticketC.quotedMinutes, POLICY.averageTurnMinutes * 2);
  });

  await checkAsync('the public entry point now reports the queue length', async () => {
    const res = await api('GET', publicPath);
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.acceptingNow, true);
    assert.equal(res.body.closedReason, null);
    assert.equal(res.body.queueLength, 3);
    assert.equal(res.body.estimatedWaitMinutes, POLICY.averageTurnMinutes * 3);
  });

  await checkAsync('the entry point returns the guest their own ticket when keyed on phone', async () => {
    const res = await api('GET', `${publicPath}?phone=${encodeURIComponent(GUEST_PHONES.a)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.myTicket, 'a guest who already holds a ticket must be shown it');
    assert.equal(res.body.myTicket.ticketNo, ticketA.ticketNo);
  });

  // =========================================================================
  section('5. The host board — one request, every move already computed');
  // =========================================================================

  await checkAsync('GET board -> the live queue, the log, and the next number', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.merchantId, MID);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.active.length, 3, 'all three are still waiting');
    assert.equal(res.body.completed.length, 0, 'nothing has ended yet');
    assert.equal(res.body.counts.waiting, 3);
    assert.equal(res.body.counts.seated, 0);
    assert.equal(res.body.nextTicketNo, ticketC.ticketNo.replace(/\d+$/, (n) => String(Number(n) + 1).padStart(n.length, '0')));
    // The board carries phone numbers; the customer's view must not.
    assert.equal(res.body.active[0].contactPhone, GUEST_PHONES.a);
  });

  await checkAsync('every board row carries allowedNextTransitions from the machine', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    const first = res.body.active.find((row) => row.id === ticketA.id);
    assert.ok(first, 'ticket A must be on the board');
    // Computed for the MERCHANT actor, which is who is looking. The host may
    // seat a waiting guest directly — they were already at the door — so
    // SEATED is reachable from WAITING and the board must offer it.
    assert.deepEqual(
      [...first.allowedNextTransitions].sort(),
      ['CALLED', 'CANCELLED', 'NO_SHOW', 'SEATED'],
      'a WAITING ticket: call, seat, drop or miss — and nothing else',
    );
    assert.equal(first.statusShortLabel, '候位');
    assert.equal(first.waitedMinutes >= 0, true);
  });

  await checkAsync('the customer view does NOT leak the phone numbers of others', async () => {
    const res = await api('GET', publicPath);
    assert.equal(res.status, 200);
    assert.equal(res.body.myTicket, null, 'no phone given, so no ticket');
    const serialised = JSON.stringify(res.body);
    assert.equal(
      serialised.includes(GUEST_PHONES.b),
      false,
      'the public entry point must not carry another guest\'s phone',
    );
  });

  // =========================================================================
  section('6. 叫號 → the called state starts a timer the guest can see');
  // =========================================================================

  await checkAsync('WAITING -> CALLED stamps a deadline and notifies', async () => {
    const res = await api('POST', `${boardPath}/${ticketA.id}/transition`, {
      token: merchantToken,
      body: { to: 'CALLED' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fromStatus, 'WAITING');
    assert.equal(res.body.toStatus, 'CALLED');
    assert.ok(res.body.sideEffects.includes('NOTIFY_CUSTOMER'), 'the guest must be told');
    assert.ok(res.body.sideEffects.includes('START_CALL_TIMEOUT'), 'the countdown must be armed');
    assert.ok(res.body.callDeadlineAt, 'the countdown on the guest page has no source otherwise');
    assert.deepEqual(
      [...res.body.allowedNextTransitions].sort(),
      ['CANCELLED', 'NO_SHOW', 'SEATED'],
      'a called guest can be seated, missed, or dropped BY THE HOST — never by themselves',
    );
  });

  await checkAsync('the deadline is exactly callTimeoutMinutes after the call', async () => {
    const res = await api('GET', `/queue/tickets/${ticketA.id}?phone=${encodeURIComponent(GUEST_PHONES.a)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CALLED');
    assert.equal(res.body.statusLabel, '已叫號');
    assert.equal(res.body.canCancel, false, 'once called, leaving is a no-show for the host to declare');
    assert.equal(res.body.position, 1);
    assert.ok(res.body.calledAt, 'the guest page shows when they were called');
    const elapsed = (new Date(res.body.callDeadlineAt) - new Date(res.body.calledAt)) / 60_000;
    assert.equal(
      elapsed,
      POLICY.callTimeoutMinutes,
      `deadline is ${elapsed} minutes after the call, expected ${POLICY.callTimeoutMinutes}`,
    );
  });

  await checkAsync('the guest cannot cancel their own ticket once called -> 409', async () => {
    const res = await api('POST', `/queue/tickets/${ticketA.id}/cancel?phone=${encodeURIComponent(GUEST_PHONES.a)}`, {
      body: {},
    });
    // `CALLED -> CANCELLED` IS a legal move — it exists for the host, who has a
    // table to release. The refusal is about WHO, not WHAT, so it is
    // `WAITLIST_ACTOR_NOT_PERMITTED`. Reporting `WAITLIST_NOT_PERMITTED` would
    // tell the page "that move does not exist", which is a lie the page would
    // render as a dead button.
    expectError(res, 409, 'WAITLIST_ACTOR_NOT_PERMITTED');
    assert.deepEqual(
      res.body.error.details.allowed,
      ['MERCHANT', 'ADMIN'],
      'the refusal must name who can do it',
    );
  });

  await checkAsync('the board count moved, and a CALLED guest still holds their place', async () => {
    const board = await api('GET', boardPath, { token: merchantToken });
    assert.equal(board.body.counts.waiting, 2);
    assert.equal(board.body.counts.called, 1);

    // A being CALLED does NOT remove them from the line. The party is still
    // occupying a table's worth of the queue until they are seated or missed,
    // and a board that dropped them on being called would let the host seat the
    // next party into a table that is still reserved.
    const guestB = await api('GET', `/queue/tickets/${ticketB.id}?phone=${encodeURIComponent(GUEST_PHONES.b)}`);
    assert.equal(guestB.body.position, 2, 'A is called but still ahead of B');
    assert.equal(guestB.body.ahead, 1);
    // And the ACTIVE list still carries A, with the status that says so.
    const rowA = board.body.active.find((row) => row.id === ticketA.id);
    assert.ok(rowA, 'a called guest is still on the live board');
    assert.equal(rowA.status, 'CALLED');
  });

  await checkAsync('the host MAY cancel a called guest (releasing the table) -> 200', async () => {
    // The mirror of the previous refusal: the move EXISTS, and the host can make
    // it. A dedicated ticket, so the SEATED path below and the guest-cancel
    // path in section 8 both keep a ticket of their own.
    const taken = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '擋門客', contactPhone: GUEST_PHONES.e },
    });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    createdEntryIds.push(taken.body.ticket.id);

    await api('POST', `${boardPath}/${taken.body.ticket.id}/transition`, {
      token: merchantToken,
      body: { to: 'CALLED' },
    });
    const res = await api('POST', `${boardPath}/${taken.body.ticket.id}/transition`, {
      token: merchantToken,
      body: { to: 'CANCELLED' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'CANCELLED');
  });

  // =========================================================================
  section('7. 入座 and 過號 — the two ways a call resolves');
  // =========================================================================

  await checkAsync('CALLED -> SEATED ends the ticket', async () => {
    const res = await api('POST', `${boardPath}/${ticketA.id}/transition`, {
      token: merchantToken,
      body: { to: 'SEATED' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'SEATED');
    assert.deepEqual(res.body.allowedNextTransitions, [], 'SEATED is terminal — offer nothing');
  });

  await checkAsync('the seated ticket left the live list and joined the log', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.body.active.some((row) => row.id === ticketA.id), false);
    assert.equal(res.body.completed.some((row) => row.id === ticketA.id), true);
    assert.equal(res.body.counts.seated, 1);
    assert.equal(res.body.counts.called, 0, 'the call resolved — nothing is mid-call');
    assert.equal(res.body.counts.waiting, 2, 'B and C are still in line');
  });

  await checkAsync('a move out of a terminal ticket -> 409 WAITLIST_ALREADY_TERMINAL', async () => {
    const res = await api('POST', `${boardPath}/${ticketA.id}/transition`, {
      token: merchantToken,
      body: { to: 'CALLED' },
    });
    expectError(res, 409, 'WAITLIST_ALREADY_TERMINAL');
  });

  await checkAsync('a host may mark a called guest a no-show, with a reason', async () => {
    await api('POST', `${boardPath}/${ticketB.id}/transition`, {
      token: merchantToken,
      body: { to: 'CALLED' },
    });
    const res = await api('POST', `${boardPath}/${ticketB.id}/transition`, {
      token: merchantToken,
      body: { to: 'NO_SHOW', reason: 'HOST_MARKED_NO_SHOW' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.toStatus, 'NO_SHOW');
  });

  await checkAsync('the no-show is recorded with WHY, not just that it happened', async () => {
    const ticket = await api('GET', `/queue/tickets/${ticketB.id}?phone=${encodeURIComponent(GUEST_PHONES.b)}`);
    assert.equal(ticket.status, 200);
    assert.equal(ticket.body.status, 'NO_SHOW');
    assert.equal(ticket.body.statusLabel, '過號');
    // A terminal ticket has no position and no estimate — the page must survive
    // that without rendering "number 0".
    assert.equal(ticket.body.position, 0);
    assert.equal(ticket.body.estimatedWaitMinutes, null);
    assert.equal(ticket.body.statusReason, 'HOST_MARKED_NO_SHOW');
  });

  await checkAsync('a foreign shop cannot transition this ticket -> 404/403', async () => {
    // The guard protects the PATH; the row is re-checked inside the use case.
    // A guessed entry id must not reach another shop's queue. ticketB is a
    // NO_SHOW by now, but the point is the CROSS-SHOP refusal, and a foreign
    // path must be refused before the ticket's own status is even considered.
    const other = await prisma.merchant.findFirst({
      where: { id: { not: MID } },
      select: { id: true },
    });
    if (!other) {
      // Only one merchant seeded — assert an unknown merchant id is refused.
      const res = await api(
        'POST',
        '/merchant/00000000-0000-4000-8000-000000000009/queue/' + ticketB.id + '/transition',
        { token: merchantToken, body: { to: 'CALLED' } },
      );
      assert.ok(
        res.status === 403 || res.status === 404,
        `expected a refusal for an unstaffed merchant, got ${res.status}`,
      );
      return;
    }
    const alienToken = mintToken({
      sub: owner.id,
      role: 'MERCHANT_OWNER',
      merchantIds: [other.id],
    });
    const res = await api('POST', `/merchant/${other.id}/queue/${ticketB.id}/transition`, {
      token: alienToken,
      body: { to: 'CALLED' },
    });
    assert.ok(
      res.status === 404 || res.status === 403,
      `expected a refusal for a foreign ticket, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  });

  // =========================================================================
  section('8. The guest leaves — only while still waiting');
  // =========================================================================

  await checkAsync('a WAITING guest cancels their own ticket and is told so', async () => {
    // ticketC is still WAITING (the foreign-shop check did not move it).
    const before = await api('GET', `/queue/tickets/${ticketC.id}?phone=${encodeURIComponent(GUEST_PHONES.c)}`);
    assert.equal(before.body.status, 'WAITING', 'precondition: C must still be waiting');

    const res = await api(
      'POST',
      `/queue/tickets/${ticketC.id}/cancel?phone=${encodeURIComponent(GUEST_PHONES.c)}`,
      { body: {} },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.ticketNo, ticketC.ticketNo);
    assert.equal(res.body.message.includes(ticketC.ticketNo), true);
  });

  await checkAsync('the reason records that the GUEST walked, not that the shop closed', async () => {
    const res = await api('GET', `/queue/tickets/${ticketC.id}?phone=${encodeURIComponent(GUEST_PHONES.c)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.statusLabel, '已取消');
    assert.equal(res.body.statusReason, 'GUEST_CANCELLED');
    assert.ok(res.body.cancelledAt, 'the log needs a timestamp to order by');
  });

  await checkAsync('cancelling frees the number — the next guest is not behind a ghost', async () => {
    // Every ticket before this one has ended (A seated, B no-show, E host-
    // cancelled, C guest-cancelled), so a brand-new guest must be FIRST — a
    // cancelled ticket must not still be holding a place in the line.
    const before = await api('GET', boardPath, { token: merchantToken });
    assert.equal(before.body.active.length, 0, 'precondition: the live queue is empty');

    const res = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '新客人', contactPhone: GUEST_PHONES.d },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdEntryIds.push(res.body.ticket.id);
    assert.equal(res.body.ticket.position, 1, 'every earlier ticket has ended — D is first');
    assert.equal(res.body.ticket.ahead, 0);
    assert.equal(res.body.ticket.quotedMinutes, 0);
  });

  await checkAsync('a cancelled ticket cannot be cancelled again -> 409', async () => {
    const res = await api(
      'POST',
      `/queue/tickets/${ticketC.id}/cancel?phone=${encodeURIComponent(GUEST_PHONES.c)}`,
      { body: {} },
    );
    // The terminal check runs BEFORE the actor check, so a second cancel is
    // reported as "this ticket is over" rather than "you may not do that".
    expectError(res, 409, 'WAITLIST_ALREADY_TERMINAL');
  });

  // =========================================================================
  section('9. 過號 sweep — idempotent, and a NO-OP until the timeout elapses');
  // =========================================================================
  //  The sweeper is what clears a board at closing time. The property that
  //  matters is that it does NOTHING while the guest still has time left.

  const ticketD = createdEntryIds.at(-1);

  await checkAsync('dry run reports what it WOULD mark without marking it', async () => {
    await api('POST', `${boardPath}/${ticketD}/transition`, {
      token: merchantToken,
      body: { to: 'CALLED' },
    });

    const res = await api('POST', `${boardPath}/sweep`, {
      token: merchantToken,
      body: { dryRun: true },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.markedNoShow, 0, 'a dry run must mark nothing');
    // The call was made seconds ago and the timeout is 1 minute, so there is
    // nothing overdue yet. This is the assertion that matters.
    assert.equal(res.body.skipped, 0, 'the guest still has time — nothing is overdue');
    assert.equal(res.body.message.includes('試算'), true);
  });

  await checkAsync('a real sweep this instant is also a no-op (the call has not aged)', async () => {
    const res = await api('POST', `${boardPath}/sweep`, {
      token: merchantToken,
      body: {},
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.markedNoShow, 0, 'marking a guest who is still walking back is the bug');

    const ticket = await api('GET', `/queue/tickets/${ticketD}?phone=${encodeURIComponent(GUEST_PHONES.d)}`);
    assert.equal(ticket.body.status, 'CALLED', 'the guest must still be CALLED');
  });

  await checkAsync('ageing the call past the timeout makes the sweep fire', async () => {
    // Backdate `calledAt` rather than sleeping: a test that sleeps is slow AND
    // flaky, and the rule under test is arithmetic on a timestamp.
    const aged = new Date(Date.now() - (POLICY.callTimeoutMinutes + 2) * 60_000);
    await prisma.waitlistEntry.update({
      where: { id: ticketD },
      data: { calledAt: aged },
    });

    const res = await api('POST', `${boardPath}/sweep`, { token: merchantToken, body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.markedNoShow, 1, 'one overdue call must be marked');

    const ticket = await api('GET', `/queue/tickets/${ticketD}?phone=${encodeURIComponent(GUEST_PHONES.d)}`);
    assert.equal(ticket.body.status, 'NO_SHOW');
    assert.equal(ticket.body.statusReason, 'CALL_TIMEOUT', 'the sweep has its own reason, SYSTEM not host');
  });

  await checkAsync('sweeping again marks nothing — it is idempotent', async () => {
    const res = await api('POST', `${boardPath}/sweep`, { token: merchantToken, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.markedNoShow, 0, 'a second pass must not re-mark a no-show');
  });

  // =========================================================================
  section('10. Outbox — the guest notification cannot be lost');
  // =========================================================================

  await checkAsync('one event per MOVE, versions monotonic', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'WaitlistEntry', aggregateId: ticketA.id },
      orderBy: { version: 'asc' },
      select: { eventType: true, version: true },
    });
    // A took two MOVES: CALLED, then SEATED. Taking a number emits NOTHING —
    // the row is created at version 1 and the first event it produces carries
    // version 2. That is deliberate: the ticket is the confirmation, so there
    // is no "you have joined" push to deliver. The version is therefore read
    // off the ROW, not off the event count, which is why the two numbers
    // differ by one.
    assert.equal(events.length, 2, `expected exactly 2 events for ticket A, got ${events.length}`);
    assert.deepEqual(
      events.map((event) => event.eventType),
      ['waitlist.called', 'waitlist.seated'],
    );
    assert.deepEqual(
      events.map((event) => event.version),
      [2, 3],
      'versions must be monotonic and match the row version the move produced',
    );
  });

  await checkAsync('the no-show emitted its own event type', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'WaitlistEntry', aggregateId: ticketB.id },
      orderBy: { version: 'asc' },
      select: { eventType: true },
    });
    assert.equal(events.at(-1).eventType, 'waitlist.no_show');
  });

  await checkAsync('the sweep\'s no-show carried the SYSTEM reason, not the host\'s', async () => {
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'WaitlistEntry', aggregateId: ticketD },
      orderBy: { version: 'asc' },
      select: { eventType: true, payload: true },
    });
    assert.equal(events.at(-1).eventType, 'waitlist.no_show');
    const payload = events.at(-1).payload;
    assert.equal(
      payload.reason,
      'CALL_TIMEOUT',
      `the sweep must record CALL_TIMEOUT, got ${JSON.stringify(payload)}`,
    );
    assert.equal(payload.recordNoShow, true, 'a sweep no-show counts against the guest');
  });

  // =========================================================================
  section('11. Turning the queue off mid-service');
  // =========================================================================
  //  The guests already in the queue keep their tickets — switching the intake
  //  off is not a way to silently drop them.

  await checkAsync('after disabling, the entry point stops taking NEW numbers', async () => {
    await api('PATCH', settingsPath, { token: merchantToken, body: { enabled: false } });

    const res = await api('POST', publicPath, {
      body: { partySize: 2, guestName: '遲來', contactPhone: GUEST_PHONES.alien },
    });
    expectError(res, 422, 'WAITLIST_DISABLED');

    const entry = await api('GET', publicPath);
    assert.equal(entry.body.enabled, false);
    assert.equal(entry.body.closedReason, 'DISABLED');
  });

  await checkAsync('the board still shows what was already taken', async () => {
    const res = await api('GET', boardPath, { token: merchantToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.completed.length >= 3, true, 'the day\'s log survives the switch');
  });

  // =========================================================================
  section('cleanup');
  // =========================================================================
  //  Run-scoped by id. Deleting by `merchantId` would be safe here (the queue
  //  is this shop's alone) but by status it would not, and the habit is what
  //  keeps the scripts composeable.
  await prisma.waitlistEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.outboxEvent.deleteMany({
    where: { aggregateType: 'WaitlistEntry', aggregateId: { in: createdEntryIds } },
  });
  // Restore the shipped default: a shop whose queue screen is opened next must
  // see the feature off, as the seed left it.
  await prisma.waitlistSettings.deleteMany({ where: { merchantId: MID } });
  console.log(`  ${createdEntryIds.length} waitlist entries, their outbox rows, and the settings removed`);

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

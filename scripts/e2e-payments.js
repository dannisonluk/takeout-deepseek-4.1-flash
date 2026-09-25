#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  End-to-end test — payment rails (Stripe / PayMe / Octopus / FPS QR)
// ============================================================================
//  Three halves, because the interesting behaviour is split across a pure
//  adapter and two differently-configured deployments:
//
//    A. offline — construct the compiled adapters directly and assert the
//       contract: the EMVCo QR is self-consistent, the provider reference is
//       derived from the idempotency key rather than generated, an unconfigured
//       rail refuses, a forged callback is rejected, and a refund is recorded
//       as PENDING rather than reported as settled.
//    B. HTTP, unconfigured — the main instance has no HK credentials, so it must
//       list those rails as unavailable and answer `422 PAYMENT_RAIL_UNAVAILABLE`
//       naming the environment variables when one is asked for.
//    C. HTTP, configured — a second instance is spawned with all four rails
//       configured and `PAYMENT_LIVE_MODE=true`. A second process is required:
//       `PAYMENT_LIVE_MODE` and the rail credentials are read once at boot, and a
//       running server's environment cannot be changed underneath it.
//
//  `PAYMENT_LIVE_MODE=true` is safe here because none of the three HK rails
//  touches the network in `createIntent` or `refund` — a PayMe intent is a deep
//  link, an FPS intent is a locally-computed QR, and a refund is a record for a
//  human. Stripe is never called: every intent in section C names a HK rail.
//
//  Usage
//  -----
//    1. seed:            node prisma/seed.js
//    2. start the API:   ORDER_BACKGROUND_JOBS=false node apps/api/dist/main.js
//    3. run:             node scripts/e2e-payments.js
//
//  Exits non-zero on any failure and leaves the database as it found it.
// ============================================================================

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';

const SEEDED_SLUG = 'dim-sum-express';
const CUSTOMER_PHONE = '+85290000001';
const ADMIN_PHONE = '+85290000003';

// Section C's deployment. The merchant name is deliberately Chinese: the EMVCo
// length field counts BYTES while a JavaScript string index counts code units,
// and that difference is the whole reason the QR builder has its own UTF-8
// encoder. An ASCII name would hide the bug.
const CHILD_PORT = 3198;
const CHILD_ORIGIN = `http://127.0.0.1:${CHILD_PORT}`;
const CHILD_BASE = `${CHILD_ORIGIN}/v1`;
const FPS_ID = '85290000099';
const FPS_MERCHANT_NAME = '點心快線';
const PAYME_MERCHANT_ID = 'pm_e2e_merchant';
const OCTOPUS_MERCHANT_ID = 'oct_e2e_merchant';
const SECRETS = {
  payme: 'e2e-payme-webhook-secret',
  octopus: 'e2e-octopus-webhook-secret',
  fps: 'e2e-fps-webhook-secret',
};

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
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The HK rails sign the raw body with a bare HMAC-SHA256, hex encoded. */
function railSignature(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ---- http -----------------------------------------------------------------
async function apiAt(base, method, pathname, options = {}) {
  const { token, body, headers = {} } = options;
  const response = await fetch(`${base}${pathname}`, {
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

const api = (method, pathname, options) => apiAt(BASE, method, pathname, options);
const childApi = (method, pathname, options) => apiAt(CHILD_BASE, method, pathname, options);

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

// ---- EMVCo TLV reading ----------------------------------------------------
/**
 * Read a TLV payload the way a scanner does.
 *
 * Iterates by CODE POINT and counts BYTES, which is the only correct way: the
 * length field is a byte count, so slicing by string index desynchronises on the
 * first non-ASCII character and silently reports the wrong merchant name. The
 * domain `parseFpsQrPayload` was fixed for the same reason; this reader is kept
 * independent of it so the test does not validate the builder with the builder.
 * `Buffer` is fine here — only `packages/domain/src` must stay dependency-free.
 */
function readTlv(payload) {
  const points = [...payload];
  const fields = {};
  let cursor = 0;

  while (cursor + 4 <= points.length) {
    const id = points.slice(cursor, cursor + 2).join('');
    const length = Number.parseInt(points.slice(cursor + 2, cursor + 4).join(''), 10);
    if (!Number.isFinite(length)) break;

    let bytes = 0;
    let end = cursor + 4;
    while (end < points.length && bytes < length) {
      bytes += Buffer.byteLength(points[end], 'utf8');
      end += 1;
    }
    assert.equal(bytes, length, `field ${id} declares ${length} bytes but consumed ${bytes}`);
    fields[id] = points.slice(cursor + 4, end).join('');
    cursor = end;
  }

  return fields;
}

// ---- bookkeeping ----------------------------------------------------------
const created = { orderIds: [], merchantId: null };

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

  if (created.orderIds.length > 0) {
    const ids = created.orderIds;
    await step(`${ids.length} order(s) and their payment rows removed`, async () => {
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

  // Deleting an order does not return `held` daily quota, so the stock rows this
  // run created would accumulate until orders started failing.
  if (created.merchantId) {
    await step('daily stock rows cleared', async () => {
      await prisma.menuItemDailyStock.deleteMany({ where: { merchantId: created.merchantId } });
    });
  }
}

// ---- order helpers --------------------------------------------------------
async function placeOrder(base, customerToken, merchantId, menuItemId) {
  const response = await apiAt(base, 'POST', '/orders', {
    token: customerToken,
    body: { merchantId, items: [{ menuItemId, quantity: 1 }] },
  });
  assert.equal(response.status, 201, `place failed: ${JSON.stringify(response.body)}`);
  created.orderIds.push(response.body.id);
  return response.body;
}

async function openIntent(base, customerToken, orderId, body = {}) {
  return apiAt(base, 'POST', `/orders/${orderId}/payment-intent`, {
    token: customerToken,
    body,
  });
}

function callbackEvent({ id, providerRef, amountMinor, type = 'payment.succeeded' }) {
  return { eventId: id, type, providerRef, amountMinor, currency: 'HKD' };
}

// ===========================================================================
//  A. the adapter contract, offline
// ===========================================================================
function configWith(overrides = {}) {
  return {
    nodeEnv: 'test',
    payment: {
      defaultProvider: 'STRIPE',
      stripe: { secretKey: 'sk_test_dummy', webhookSecret: '' },
      payme: { merchantId: '', webhookSecret: '' },
      octopus: { merchantId: '', webhookSecret: '' },
      fps: { fpsId: '', merchantName: '', webhookSecret: '' },
      checkoutBaseUrl: 'https://checkout.test/pay',
      feeRateBps: 340,
      feeFixedMinor: 235,
      liveMode: false,
      ...overrides,
    },
  };
}

const INTENT_PARAMS = {
  orderId: '00000000-0000-0000-0000-000000000001',
  orderNo: 'DS-20260924-0001',
  amountMinor: 15200,
  currency: 'HKD',
  idempotencyKey: 'pi:00000000-0000-0000-0000-000000000001',
  customerId: '00000000-0000-0000-0000-000000000002',
};

function loadAdapters() {
  const hk = require(path.join(ROOT, 'apps/api/dist/infrastructure/payment/hk-payment.providers.js'));
  const { StripePaymentProvider } = require(
    path.join(ROOT, 'apps/api/dist/infrastructure/payment/stripe-payment.provider.js'),
  );
  const { PaymentProviderRegistry } = require(
    path.join(ROOT, 'apps/api/dist/infrastructure/payment/payment-provider.registry.js'),
  );
  return {
    PayMePaymentProvider: hk.PayMePaymentProvider,
    OctopusPaymentProvider: hk.OctopusPaymentProvider,
    FpsQrPaymentProvider: hk.FpsQrPaymentProvider,
    StripePaymentProvider,
    PaymentProviderRegistry,
  };
}

const configuredFps = (extra = {}) =>
  configWith({
    fps: { fpsId: FPS_ID, merchantName: FPS_MERCHANT_NAME, webhookSecret: SECRETS.fps, ...extra },
  });

async function offline() {
  const domain = require('@takeout/domain');
  const adapters = loadAdapters();

  // ---- A1. the QR itself --------------------------------------------------
  const fps = new adapters.FpsQrPaymentProvider(configuredFps());
  const intent = await fps.createIntent(INTENT_PARAMS);

  check('FPS createIntent returns a QR payload in the clientSecret slot', () => {
    assert.equal(intent.status, 'REQUIRES_ACTION', 'a QR rail has nothing to capture');
    assert.ok(intent.clientSecret, 'the QR payload must come back to the client');
    assert.ok(intent.providerRef.startsWith('fps_'), `unexpected ref ${intent.providerRef}`);
    assert.ok(
      intent.redirectUrl.includes(`/fps/${intent.providerRef}`),
      `the fallback page is missing: ${intent.redirectUrl}`,
    );
  });

  check('the QR carries the payee, the amount in major units, and our order number', () => {
    const fields = readTlv(intent.clientSecret);

    assert.equal(fields['00'], '01', 'payload format indicator');
    assert.equal(fields['01'], '12', 'point of initiation must be dynamic');
    assert.equal(fields['53'], 'HKD', 'currency');
    assert.equal(fields['54'], '152.00', 'tag 54 is major units with a dot — not minor units');
    assert.equal(fields['58'], 'HK', 'country');
    assert.equal(fields['59'], FPS_MERCHANT_NAME, 'merchant name');

    const account = readTlv(fields['26']);
    assert.equal(account['00'], 'hk.com.hkicl', 'the FPS globally-unique identifier');
    assert.equal(account['01'], FPS_ID, 'the payee id a banking app will pay');

    const additional = readTlv(fields['62']);
    assert.equal(additional['05'], INTENT_PARAMS.orderNo, 'the reconciliation reference');
  });

  check('the CRC trailer is present and correct', () => {
    const payload = intent.clientSecret;
    const declared = payload.slice(-4);
    const recomputed = domain.crc16Ccitt(payload.slice(0, -4));
    assert.match(declared, /^[0-9A-F]{4}$/, `CRC is not four hex digits: ${declared}`);
    assert.equal(
      declared,
      recomputed,
      'a wrong CRC makes the payload look fine and never scan — this is the whole point of the check',
    );
  });

  check('the domain parser reads a multi-byte merchant name back exactly', () => {
    const viaDomain = domain.parseFpsQrPayload(intent.clientSecret);
    assert.equal(viaDomain['59'], FPS_MERCHANT_NAME);
    assert.equal(viaDomain['60'], 'HONG KONG', 'the fields after a multi-byte value must survive');
    assert.equal(viaDomain['53'], 'HKD');
    assert.equal(viaDomain['63'], intent.clientSecret.slice(-4));
  });

  await checkAsync('an over-long merchant name is truncated, not refused', async () => {
    const long = new adapters.FpsQrPaymentProvider(
      configuredFps({ merchantName: 'A'.repeat(80) }),
    );
    const result = await long.createIntent(INTENT_PARAMS);
    assert.equal(readTlv(result.clientSecret)['59'].length, 25, 'tag 59 is capped at 25 characters');
  });

  // ---- A2. determinism ----------------------------------------------------
  const again = await fps.createIntent(INTENT_PARAMS);

  check('the provider reference is derived from the idempotency key, not generated', () => {
    assert.equal(
      again.providerRef,
      intent.providerRef,
      'a retried checkout must not produce a second reference — the unique index would reject it',
    );
  });

  check('the QR is byte-identical on a retry', () => {
    assert.equal(again.clientSecret, intent.clientSecret);
  });

  await checkAsync('a different idempotency key produces a different reference', async () => {
    const other = await fps.createIntent({ ...INTENT_PARAMS, idempotencyKey: 'pi:other' });
    assert.notEqual(other.providerRef, intent.providerRef);
  });

  // ---- A3. configuration --------------------------------------------------
  check('an unconfigured rail says so instead of opening an unusable intent', () => {
    assert.equal(new adapters.FpsQrPaymentProvider(configWith()).configured, false);

    const noPayee = new adapters.FpsQrPaymentProvider(
      configWith({ fps: { fpsId: '', merchantName: 'X', webhookSecret: SECRETS.fps } }),
    );
    assert.equal(noPayee.configured, false, 'a QR with no payee cannot be paid by anyone');
  });

  check('Stripe needs both halves: a key alone cannot confirm a payment', () => {
    const keyOnly = new adapters.StripePaymentProvider(
      configWith({ stripe: { secretKey: 'sk_test_dummy', webhookSecret: '' } }),
    );
    assert.equal(keyOnly.configured, false, 'an intent with no verifiable callback strands the order');

    const both = new adapters.StripePaymentProvider(
      configWith({ stripe: { secretKey: 'sk_test_dummy', webhookSecret: 'whsec_x' } }),
    );
    assert.equal(both.configured, true);
  });

  // ---- A4. the registry ---------------------------------------------------
  const stripeConfigured = configWith({
    stripe: { secretKey: 'sk_test_dummy', webhookSecret: 'whsec_x' },
  });
  const registry = new adapters.PaymentProviderRegistry(
    new adapters.StripePaymentProvider(stripeConfigured),
    new adapters.PayMePaymentProvider(
      configWith({ payme: { merchantId: PAYME_MERCHANT_ID, webhookSecret: SECRETS.payme } }),
    ),
    new adapters.OctopusPaymentProvider(configWith()),
    new adapters.FpsQrPaymentProvider(configuredFps()),
    stripeConfigured,
  );

  check('the registry lists every rail, and only configured ones are usable', () => {
    const rails = registry.list();
    assert.deepEqual(rails.map((rail) => rail.name).sort(), ['FPS_QR', 'OCTOPUS', 'PAYME', 'STRIPE']);
    assert.equal(rails.find((rail) => rail.name === 'OCTOPUS').configured, false);
    assert.equal(rails.find((rail) => rail.name === 'OCTOPUS').flow, 'REDIRECT');
    assert.equal(rails.find((rail) => rail.name === 'FPS_QR').flow, 'QR');
    assert.equal(rails.find((rail) => rail.name === 'STRIPE').flow, 'IN_APP');
  });

  check('resolve() refuses an unconfigured rail and names the variables to set', () => {
    assert.throws(
      () => registry.resolve('OCTOPUS'),
      (error) => {
        assert.equal(error.code, 'PAYMENT_RAIL_UNAVAILABLE');
        assert.match(error.message, /OCTOPUS/);
        assert.equal(error.details.envVars, 'OCTOPUS_MERCHANT_ID / OCTOPUS_WEBHOOK_SECRET');
        return true;
      },
    );
  });

  check('resolve() rejects a rail name that is not in the registry at all', () => {
    assert.throws(() => registry.resolve('BITCOIN'), (error) => {
      assert.equal(error.code, 'UNKNOWN_PAYMENT_PROVIDER');
      return true;
    });
  });

  check('find() still returns an unconfigured rail, so a callback can be rejected properly', () => {
    assert.ok(
      registry.find('octopus'),
      'the webhook path is case-insensitive and must reach verifyWebhook to refuse the payload',
    );
    assert.equal(registry.find('nonsense'), undefined);
  });

  check('railFor() refunds through the rail that took the payment', () => {
    assert.equal(registry.railFor('PAYME').name, 'PAYME');
    assert.equal(registry.railFor('payme').name, 'PAYME', 'the stored value is case-insensitive');
    // Lenient on purpose: the refund row must still be written when the rail is
    // no longer configured, so an operator can settle it by hand.
    assert.equal(registry.railFor('OCTOPUS').name, 'OCTOPUS');
    assert.equal(registry.railFor(null).name, 'STRIPE', 'no recorded rail falls back to the default');
  });

  check('the default falls back to a configured rail when PAYMENT_PROVIDER is not usable', () => {
    const fallback = new adapters.PaymentProviderRegistry(
      new adapters.StripePaymentProvider(stripeConfigured),
      new adapters.PayMePaymentProvider(configWith()),
      new adapters.OctopusPaymentProvider(configWith()),
      new adapters.FpsQrPaymentProvider(configWith()),
      configWith({
        defaultProvider: 'PAYME',
        stripe: { secretKey: 'sk_test_dummy', webhookSecret: 'whsec_x' },
      }),
    );
    assert.equal(fallback.defaultName, 'STRIPE', 'a default that cannot be used is not a default');
    assert.equal(fallback.default.name, 'STRIPE');
  });

  // ---- A5. the rail-specific payloads -------------------------------------
  const payme = new adapters.PayMePaymentProvider(
    configWith({ payme: { merchantId: PAYME_MERCHANT_ID, webhookSecret: SECRETS.payme } }),
  );
  const paymeIntent = await payme.createIntent(INTENT_PARAMS);

  check('the PayMe client secret carries the merchant account, the reference and the amount', () => {
    assert.equal(
      paymeIntent.clientSecret,
      `${PAYME_MERCHANT_ID}:${paymeIntent.providerRef}:${INTENT_PARAMS.amountMinor}`,
    );
    assert.ok(paymeIntent.redirectUrl.startsWith('https://checkout.test/pay/payme/'));
  });

  const octopus = new adapters.OctopusPaymentProvider(
    configWith({ octopus: { merchantId: OCTOPUS_MERCHANT_ID, webhookSecret: SECRETS.octopus } }),
  );
  const octopusIntent = await octopus.createIntent(INTENT_PARAMS);

  check('the Octopus client secret carries the reference, not the params object', () => {
    assert.equal(octopusIntent.clientSecret, `${OCTOPUS_MERCHANT_ID}:${octopusIntent.providerRef}`);
    assert.ok(
      !octopusIntent.clientSecret.includes('[object'),
      'a subclass that declared fewer parameters received the params object in that slot',
    );
  });

  // ---- A6. signature verification ----------------------------------------
  const body = Buffer.from(
    JSON.stringify(
      callbackEvent({
        id: 'evt_a1',
        providerRef: intent.providerRef,
        amountMinor: INTENT_PARAMS.amountMinor,
      }),
    ),
  );

  check('a correctly signed callback is accepted and normalised', () => {
    const event = fps.verifyWebhook(body, { 'x-fps-signature': railSignature(body, SECRETS.fps) });
    assert.equal(event.type, 'PAYMENT_CAPTURED');
    assert.equal(event.providerRef, intent.providerRef);
    assert.equal(event.amountMinor, INTENT_PARAMS.amountMinor);
    assert.equal(event.currency, 'HKD');
  });

  check("the acquirer's own event vocabulary and key names are normalised too", () => {
    // Both the camelCase key our own fixtures use and the snake_case key a real
    // acquirer sends. Reading only `eventType` meant a genuine
    // `{"event_type":"payment.captured"}` normalised to UNKNOWN and the
    // settlement was dropped — the worst kind of bug, because the customer has
    // paid and the order still says otherwise.
    for (const payload of [
      { id: 'evt_a2', eventType: 'payment.captured', providerRef: 'fps_x', amountMinor: 1 },
      { id: 'evt_a3', event_type: 'payment.captured', reference: 'fps_x', amount: 1 },
      { id: 'evt_a4', type: 'PAYMENT_SUCCEEDED', provider_ref: 'fps_x', amount_minor: 1 },
    ]) {
      const raw = Buffer.from(JSON.stringify(payload));
      const event = fps.verifyWebhook(raw, { 'x-fps-signature': railSignature(raw, SECRETS.fps) });
      assert.equal(
        event.type,
        'PAYMENT_CAPTURED',
        `a settled payment must never be silently ignored: ${JSON.stringify(payload)}`,
      );
      assert.equal(event.providerRef, 'fps_x', `reference key not recognised: ${JSON.stringify(payload)}`);
      assert.equal(event.amountMinor, 1, `amount key not recognised: ${JSON.stringify(payload)}`);
    }
  });

  check('a forged signature is rejected', () => {
    assert.throws(
      () => fps.verifyWebhook(body, { 'x-fps-signature': railSignature(body, 'wrong-secret') }),
      (error) => {
        assert.equal(error.code, 'INVALID_WEBHOOK_SIGNATURE');
        return true;
      },
    );
  });

  check('a tampered body under a valid signature is rejected', () => {
    const tampered = Buffer.from(
      JSON.stringify(
        callbackEvent({ id: 'evt_a1', providerRef: intent.providerRef, amountMinor: 1 }),
      ),
    );
    assert.throws(
      () => fps.verifyWebhook(tampered, { 'x-fps-signature': railSignature(body, SECRETS.fps) }),
      (error) => {
        assert.equal(error.code, 'INVALID_WEBHOOK_SIGNATURE');
        return true;
      },
    );
  });

  check('a missing signature header is rejected rather than trusted', () => {
    assert.throws(() => fps.verifyWebhook(body, {}), (error) => {
      assert.equal(error.code, 'INVALID_WEBHOOK_SIGNATURE');
      return true;
    });
  });

  check('a rail with no secret refuses to trust any payload', () => {
    const bare = new adapters.FpsQrPaymentProvider(configWith());
    assert.throws(
      () => bare.verifyWebhook(body, { 'x-fps-signature': 'anything' }),
      (error) => {
        // 503, not 401: the payload may be genuine, we simply cannot tell.
        assert.equal(error.code, 'WEBHOOK_NOT_CONFIGURED');
        return true;
      },
    );
  });

  check('each rail reads its own header', () => {
    const paymeBody = Buffer.from(
      JSON.stringify({ id: 'e', type: 'paid', providerRef: 'payme_x', amountMinor: 1 }),
    );
    assert.throws(
      () =>
        payme.verifyWebhook(paymeBody, { 'x-fps-signature': railSignature(paymeBody, SECRETS.payme) }),
      'the FPS header must not authenticate a PayMe callback',
    );
    const ok = payme.verifyWebhook(paymeBody, {
      'x-payme-signature': railSignature(paymeBody, SECRETS.payme),
    });
    assert.equal(ok.type, 'PAYMENT_CAPTURED');
  });

  // ---- A7. refunds --------------------------------------------------------
  const REFUND = {
    providerRef: intent.providerRef,
    amountMinor: 5000,
    reason: 'customer cancelled',
    idempotencyKey: 'refund:abc',
  };

  await checkAsync('a rail with no refund API records PENDING and never claims SUCCEEDED', async () => {
    const result = await fps.refund(REFUND);
    assert.equal(
      result.status,
      'PENDING',
      'returning SUCCEEDED from a method that contacted nobody reports money as returned while it is still in the account',
    );
    assert.ok(result.refundRef.startsWith('fps_rf_'));
  });

  await checkAsync('a retried refund produces the same reference', async () => {
    const first = await fps.refund(REFUND);
    const second = await fps.refund(REFUND);
    assert.equal(first.refundRef, second.refundRef);
  });
}

// ===========================================================================
//  B. HTTP — the rails this deployment does not have
// ===========================================================================
async function unconfiguredOverHttp(ctx) {
  const rails = await api('GET', '/payments/rails');

  check('GET /payments/rails is public and lists all four rails', () => {
    assert.equal(rails.status, 200, JSON.stringify(rails.body));
    assert.deepEqual(
      rails.body.rails.map((rail) => rail.name).sort(),
      ['FPS_QR', 'OCTOPUS', 'PAYME', 'STRIPE'],
    );
  });

  check('this instance has Stripe configured and the HK rails not', () => {
    const byName = Object.fromEntries(rails.body.rails.map((rail) => [rail.name, rail]));
    assert.equal(byName.STRIPE.configured, true, 'the local .env carries a dummy Stripe key');
    for (const name of ['PAYME', 'OCTOPUS', 'FPS_QR']) {
      assert.equal(
        byName[name].configured,
        false,
        `${name} must be reported unavailable — section C covers the configured path`,
      );
    }
  });

  check('the default rail is a rail that is actually usable', () => {
    assert.equal(rails.body.defaultRail, 'STRIPE');
  });

  const order = await placeOrder(BASE, ctx.customerToken, ctx.merchant.id, ctx.cheapItem.id);
  const refused = await openIntent(BASE, ctx.customerToken, order.id, { provider: 'PAYME' });

  check('asking for an unconfigured rail -> 422 naming the environment variables', () => {
    expectError(refused, 422, 'PAYMENT_RAIL_UNAVAILABLE');
    assert.match(refused.body.error.message, /PAYME/);
    assert.equal(refused.body.error.details.provider, 'PAYME');
    assert.equal(
      refused.body.error.details.envVars,
      'PAYME_MERCHANT_ID / PAYME_WEBHOOK_SECRET',
      'a refusal without the variable names is a support ticket, not a diagnosis',
    );
  });

  await checkAsync('the refused intent wrote no payment row', async () => {
    const count = await prisma.payment.count({ where: { orderId: order.id } });
    assert.equal(count, 0, 'an unusable rail must not leave a PENDING row behind');
  });

  const typo = await openIntent(BASE, ctx.customerToken, order.id, { provider: 'PAYME ' });

  check('a malformed rail name -> 400, not a 500', () => {
    expectError(typo, 400, 'VALIDATION_ERROR');
  });

  const defaultIntent = await openIntent(BASE, ctx.customerToken, order.id, {});

  check('omitting the rail still uses the configured default', () => {
    assert.equal(defaultIntent.status, 200, JSON.stringify(defaultIntent.body));
    assert.equal(defaultIntent.body.provider, 'STRIPE');
    assert.ok(defaultIntent.body.notice, 'PAYMENT_LIVE_MODE=false must be disclosed');
  });

  const unknownPath = await api('POST', '/webhooks/payments/nonsense', {
    body: { eventId: 'x', type: 'payment.succeeded', providerRef: 'x', amountMinor: 1 },
    headers: { 'x-signature': 'whatever' },
  });

  check('a callback for a rail that does not exist -> acknowledged but not handled', () => {
    assert.equal(unknownPath.status, 200, JSON.stringify(unknownPath.body));
    assert.equal(unknownPath.body.handled, false);
    assert.match(unknownPath.body.reason, /unknown payment provider/);
  });

  const unconfiguredCallback = await api('POST', '/webhooks/payments/payme', {
    body: { eventId: 'x', type: 'payment.succeeded', providerRef: 'payme_x', amountMinor: 1 },
    headers: { 'x-payme-signature': 'deadbeef' },
  });

  check('a callback for a rail with no secret -> 503, so the sender retries later', () => {
    expectError(unconfiguredCallback, 503, 'WEBHOOK_NOT_CONFIGURED');
  });

  const noSignature = await api('POST', '/webhooks/payments/stripe', {
    body: { id: 'evt', type: 'payment_intent.succeeded' },
  });

  check('a callback with no signature -> 401, not a 500', () => {
    expectError(noSignature, 401, 'INVALID_WEBHOOK_SIGNATURE');
  });
}

// ===========================================================================
//  C. HTTP — a deployment where the HK rails are configured
// ===========================================================================
async function configuredOverHttp(ctx) {
  const child = spawn(process.execPath, [path.join(ROOT, 'apps/api/dist/main.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(CHILD_PORT),
      ORDER_BACKGROUND_JOBS: 'false',
      PAYMENT_PROVIDER: 'FPS_QR',
      PAYMENT_LIVE_MODE: 'true',
      PAYMENT_CHECKOUT_BASE_URL: 'https://checkout.test/pay',
      PAYME_MERCHANT_ID,
      PAYME_WEBHOOK_SECRET: SECRETS.payme,
      OCTOPUS_MERCHANT_ID,
      OCTOPUS_WEBHOOK_SECRET: SECRETS.octopus,
      FPS_ID,
      FPS_MERCHANT_NAME,
      FPS_WEBHOOK_SECRET: SECRETS.fps,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        ready = (await fetch(`${CHILD_ORIGIN}/health`)).status === 200;
      } catch {
        /* not listening yet */
      }
    }
    if (!ready) throw new Error(`the configured instance never became ready:\n${log}`);

    const rails = await childApi('GET', '/payments/rails');
    check('the configured instance reports all four rails as usable', () => {
      assert.equal(rails.status, 200, JSON.stringify(rails.body));
      assert.ok(rails.body.rails.every((rail) => rail.configured), JSON.stringify(rails.body.rails));
      assert.equal(rails.body.defaultRail, 'FPS_QR');
    });

    // ---- C1. FPS QR through the real endpoint ------------------------------
    const fpsOrder = await placeOrder(CHILD_BASE, ctx.customerToken, ctx.merchant.id, ctx.cheapItem.id);
    const fpsIntent = await openIntent(CHILD_BASE, ctx.customerToken, fpsOrder.id);

    check('POST /orders/:id/payment-intent -> 200 with a scannable FPS QR', () => {
      assert.equal(fpsIntent.status, 200, JSON.stringify(fpsIntent.body));
      assert.equal(fpsIntent.body.provider, 'FPS_QR');
      assert.equal(fpsIntent.body.notice, null, 'live mode means no simulation notice');
      assert.equal(fpsIntent.body.amountMinor, fpsOrder.pricing.totalMinor);

      const fields = readTlv(fpsIntent.body.clientSecret);
      assert.equal(fields['01'], '12');
      assert.equal(fields['54'], (fpsIntent.body.amountMinor / 100).toFixed(2));
      assert.equal(fields['59'], FPS_MERCHANT_NAME);
      assert.equal(readTlv(fields['62'])['05'], fpsOrder.orderNo);
      assert.equal(
        fields['63'],
        require('@takeout/domain').crc16Ccitt(fpsIntent.body.clientSecret.slice(0, -4)),
      );
    });

    check('the FPS intent points at the platform-hosted payment page', () => {
      assert.match(
        fpsIntent.body.redirectUrl,
        /^https:\/\/checkout\.test\/pay\/fps\/fps_[0-9a-f]{24}/,
      );
      assert.match(fpsIntent.body.redirectUrl, new RegExp(`order=${fpsOrder.orderNo}`));
    });

    const fpsAgain = await openIntent(CHILD_BASE, ctx.customerToken, fpsOrder.id);

    check('reloading the checkout page returns the same QR, not a second one', () => {
      assert.equal(fpsAgain.body.providerRef, fpsIntent.body.providerRef);
      assert.equal(fpsAgain.body.clientSecret, fpsIntent.body.clientSecret);
    });

    // ---- C2. a signed callback settles the order ---------------------------
    const fpsEvent = callbackEvent({
      id: `evt_fps_${Date.now()}`,
      providerRef: fpsIntent.body.providerRef,
      amountMinor: fpsIntent.body.amountMinor,
    });
    const fpsBody = JSON.stringify(fpsEvent);

    const fpsWebhook = await childApi('POST', '/webhooks/payments/fps_qr', {
      body: fpsEvent,
      headers: { 'x-fps-signature': railSignature(fpsBody, SECRETS.fps) },
    });

    check('a signed FPS callback is accepted and handled', () => {
      assert.equal(fpsWebhook.status, 200, JSON.stringify(fpsWebhook.body));
      assert.equal(fpsWebhook.body.handled, true, JSON.stringify(fpsWebhook.body));
    });

    await checkAsync('the order advanced to PAID and the payment row is CAPTURED', async () => {
      const row = await prisma.order.findUnique({
        where: { id: fpsOrder.id },
        select: { status: true, acceptDeadlineAt: true },
      });
      assert.equal(row.status, 'PAID');
      assert.ok(row.acceptDeadlineAt, 'the accept-deadline side effect must have fired');

      const payment = await prisma.payment.findFirst({
        where: { orderId: fpsOrder.id },
        select: { status: true, provider: true },
      });
      assert.equal(payment.status, 'CAPTURED');
      assert.equal(payment.provider, 'FPS_QR', 'the row records the rail that was actually used');
    });

    const replay = await childApi('POST', '/webhooks/payments/fps_qr', {
      body: fpsEvent,
      headers: { 'x-fps-signature': railSignature(fpsBody, SECRETS.fps) },
    });

    check('a replayed callback is idempotent', () => {
      assert.equal(replay.status, 200);
      assert.equal(replay.body.duplicate, true, JSON.stringify(replay.body));
    });

    // ---- C3. a forged callback changes nothing -----------------------------
    const paymeOrder = await placeOrder(CHILD_BASE, ctx.customerToken, ctx.merchant.id, ctx.cheapItem.id);
    const paymeIntent = await openIntent(CHILD_BASE, ctx.customerToken, paymeOrder.id, {
      provider: 'PAYME',
      returnUrl: 'https://checkout.test/pay/done',
    });

    check('a PayMe intent comes back with a deep link and the merchant account', () => {
      assert.equal(paymeIntent.status, 200, JSON.stringify(paymeIntent.body));
      assert.equal(paymeIntent.body.provider, 'PAYME');
      assert.match(paymeIntent.body.redirectUrl, /^https:\/\/checkout\.test\/pay\/payme\/payme_/);
      assert.equal(
        paymeIntent.body.clientSecret,
        `${PAYME_MERCHANT_ID}:${paymeIntent.body.providerRef}:${paymeIntent.body.amountMinor}`,
      );
    });

    const paymeEvent = callbackEvent({
      id: `evt_payme_${Date.now()}`,
      providerRef: paymeIntent.body.providerRef,
      amountMinor: paymeIntent.body.amountMinor,
    });
    const paymeBody = JSON.stringify(paymeEvent);

    const forged = await childApi('POST', '/webhooks/payments/payme', {
      body: paymeEvent,
      headers: { 'x-payme-signature': railSignature(paymeBody, 'not-the-secret') },
    });

    await checkAsync('a forged PayMe callback -> 401 and the order is untouched', async () => {
      expectError(forged, 401, 'INVALID_WEBHOOK_SIGNATURE');
      const row = await prisma.order.findUnique({
        where: { id: paymeOrder.id },
        select: { status: true },
      });
      assert.equal(row.status, 'PENDING_PAYMENT', 'a forgery must not move money or status');
    });

    const crossed = await childApi('POST', '/webhooks/payments/payme', {
      body: paymeEvent,
      headers: { 'x-fps-signature': railSignature(paymeBody, SECRETS.fps) },
    });

    check("one rail's signature cannot settle another rail's payment", () => {
      expectError(crossed, 401, 'INVALID_WEBHOOK_SIGNATURE');
    });

    const signed = await childApi('POST', '/webhooks/payments/payme', {
      body: paymeEvent,
      headers: { 'x-payme-signature': railSignature(paymeBody, SECRETS.payme) },
    });

    check('the correctly signed PayMe callback settles it', () => {
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.handled, true, JSON.stringify(signed.body));
    });

    await checkAsync('the PayMe payment is CAPTURED on the PAYME rail', async () => {
      const payment = await prisma.payment.findFirst({
        where: { orderId: paymeOrder.id },
        select: { status: true, provider: true, providerRef: true },
      });
      assert.equal(payment.status, 'CAPTURED');
      assert.equal(payment.provider, 'PAYME');
      assert.ok(payment.providerRef.startsWith('payme_'));
    });

    // ---- C4. the refund goes back the way it came --------------------------
    const refund = await childApi('POST', `/admin/orders/${paymeOrder.id}/refund`, {
      token: ctx.adminToken,
      body: { reason: 'e2e: rail routing' },
    });

    check('an admin refund on a PayMe order is accepted', () => {
      assert.equal(refund.status, 200, JSON.stringify(refund.body));
    });

    await checkAsync('the refund was routed through PayMe, not the deployment default', async () => {
      const row = await prisma.refund.findFirst({
        where: { payment: { orderId: paymeOrder.id } },
        select: { status: true, providerRef: true, payment: { select: { provider: true } } },
      });
      assert.ok(row, 'no refund row was written');
      assert.equal(row.payment.provider, 'PAYME');
      assert.ok(
        row.providerRef && row.providerRef.startsWith('payme_rf_'),
        `the refund reference is ${row.providerRef}; a fps_rf_ here means it went through the default rail`,
      );
      assert.equal(row.status, 'PENDING', 'PayMe has no refund API — it must not read as settled');
    });

    const octopusIntent = await openIntent(CHILD_BASE, ctx.customerToken, paymeOrder.id, {
      provider: 'OCTOPUS',
    });

    check('a rail cannot be switched once the order has left PENDING_PAYMENT', () => {
      expectError(octopusIntent, 409, 'PAYMENT_NOT_REQUIRED');
    });
  } finally {
    child.kill();
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  console.log('='.repeat(66));
  console.log('Payment rails — Stripe, PayMe, Octopus, FPS QR — end to end');
  console.log('='.repeat(66));

  const merchant = await prisma.merchant.findUnique({ where: { slug: SEEDED_SLUG } });
  if (!merchant) throw new Error(`Seeded merchant ${SEEDED_SLUG} not found — run \`npm run db:seed\``);
  created.merchantId = merchant.id;

  const [customer, admin] = await Promise.all([
    prisma.user.findUnique({ where: { phone: CUSTOMER_PHONE } }),
    prisma.user.findUnique({ where: { phone: ADMIN_PHONE } }),
  ]);
  if (!customer || !admin) throw new Error('Seeded users not found — run `npm run db:seed`');

  const items = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id, availability: 'AVAILABLE', isMainItem: true },
    orderBy: { priceMinor: 'asc' },
    take: 1,
  });
  if (items.length === 0) throw new Error('Seeded merchant needs at least one main item');

  const ctx = {
    merchant,
    cheapItem: items[0],
    customerToken: mintToken({ sub: customer.id, role: 'CUSTOMER' }),
    adminToken: mintToken({ sub: admin.id, role: 'ADMIN' }),
  };

  try {
    section('A. adapter contract (offline, compiled classes)');
    await offline();

    section('B. HTTP — rails this deployment does not have');
    await unconfiguredOverHttp(ctx);

    section('C. HTTP — rails configured (second instance on :3198)');
    await checkAsync('a deployment with the HK rails configured', () => configuredOverHttp(ctx));
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${'='.repeat(66)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks`);
  } else {
    console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.log(`  \u2717 ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(`\nFATAL: ${error.message}`);
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  await prisma.$disconnect();
  process.exitCode = 1;
});

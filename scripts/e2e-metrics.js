#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  Observability — /metrics
// ============================================================================
//  Two halves, because the interesting behaviour is split across a pure
//  authorisation rule and an HTTP surface:
//
//    A. offline — construct the compiled `MetricsService` with a stub Prisma
//       and assert the access rule for all five cases. This is the only way to
//       test the `METRICS_TOKEN`-is-set branch without restarting the API with
//       a different environment, and it runs in milliseconds.
//    B. HTTP    — scrape the real endpoint and validate the exposition.
//
//  The exposition is validated structurally rather than by snapshot: a metric
//  file that a scraper *rejects* takes every metric down, not just the broken
//  line, so the shape matters more than the values.
//
//  Usage
//  -----
//    1. start the API:   ORDER_BACKGROUND_JOBS=false node apps/api/dist/main.js
//    2. run:             node scripts/e2e-metrics.js
//
//  Exits non-zero on any failure. Read-only: touches no table.
// ============================================================================

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

/**
 * `--noproxy '*'` equivalent. A sandbox HTTP proxy will otherwise intercept a
 * request to 127.0.0.1 and return something that is not the API's answer.
 */
async function get(pathname, headers = {}) {
  const response = await fetch(`${API_ORIGIN}${pathname}`, { headers });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

// ---- A. the access rule, offline ------------------------------------------
// The compiled service is a plain class, so it can be instantiated directly.
// `@nestjs/common` only supplies decorators here; no container is involved.
const { MetricsService } = require(path.join(ROOT, 'apps/api/dist/metrics/metrics.service.js'));

function serviceWith({ token, nodeEnv }) {
  return new MetricsService({}, { metrics: { token }, nodeEnv });
}

// Stub Prisma: the render path only reads groupBy / aggregate / count, and
// stubbing it keeps this script independent of what is in the database.
const stubPrisma = {
  order: { groupBy: async () => [{ status: 'COMPLETED', _count: { _all: 3 } }] },
  outboxEvent: { groupBy: async () => [{ status: 'PENDING', _count: { _all: 2 } }] },
  merchant: { groupBy: async () => [] },
  payment: { aggregate: async () => ({ _sum: { amountMinor: 15200 }, _count: { _all: 1 } }) },
  refund: { groupBy: async () => [] },
  menuItemDailyStock: { count: async () => 0 },
};

const EXPECTED = [
  'takeout_orders',
  'takeout_outbox_events',
  'takeout_merchants',
  'takeout_refunds',
  'takeout_payments_captured_count',
  'takeout_payments_captured_minor',
  'takeout_daily_stock_rows',
  'takeout_process_uptime_seconds',
];

/** Parse an exposition into its three line kinds, asserting the shape as it goes. */
function parseExposition(text) {
  assert.ok(text.endsWith('\n'), 'a trailing newline is required by the format');
  const help = new Set();
  const types = new Map();
  const samples = new Set();
  for (const line of text.split('\n').filter(Boolean)) {
    if (line.startsWith('# HELP ')) {
      const name = line.split(' ')[2];
      assert.ok(line.length > `# HELP ${name} `.length, `${name} has no help text`);
      assert.ok(!help.has(name), `${name} has two HELP lines`);
      help.add(name);
    } else if (line.startsWith('# TYPE ')) {
      const [, , name, kind] = line.split(' ');
      assert.ok(['counter', 'gauge'].includes(kind), `${name} has unknown type ${kind}`);
      assert.ok(!types.has(name), `${name} is declared twice`);
      types.set(name, kind);
    } else {
      assert.ok(!line.startsWith('#'), `unexpected comment line: ${line}`);
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (-?\d+(?:\.\d+)?)$/.exec(line);
      assert.ok(match, `sample line is not parseable: ${line}`);
      samples.add(match[1]);
    }
  }
  for (const name of samples) {
    assert.ok(types.has(name), `${name} has samples but no TYPE line`);
  }
  assert.equal(help.size, types.size, 'every typed metric needs exactly one HELP line');
  return { help, types, samples };
}

async function offline() {
  check('no token, development: the endpoint is served (a laptop must work)', () => {
    assert.equal(serviceWith({ token: '', nodeEnv: 'development' }).isAuthorised(undefined), true);
  });

  check('no token, test: served', () => {
    assert.equal(serviceWith({ token: '', nodeEnv: 'test' }).isAuthorised(undefined), true);
  });

  check('no token, production: refused, so a deployment never exposes itself', () => {
    assert.equal(serviceWith({ token: '', nodeEnv: 'production' }).isAuthorised(undefined), false);
  });

  check('token set: the matching bearer is accepted, with or without the scheme', () => {
    const service = serviceWith({ token: 's3cret', nodeEnv: 'production' });
    assert.equal(service.isAuthorised('Bearer s3cret'), true);
    assert.equal(service.isAuthorised('bearer s3cret'), true, 'the scheme is case-insensitive');
    assert.equal(service.isAuthorised('s3cret'), true, 'a bare token is tolerated');
  });

  check('token set: a wrong, empty or missing token is refused in every environment', () => {
    const service = serviceWith({ token: 's3cret', nodeEnv: 'development' });
    assert.equal(service.isAuthorised('Bearer nope'), false);
    assert.equal(service.isAuthorised('Bearer s3cre'), false, 'a prefix is not a match');
    assert.equal(service.isAuthorised('Bearer s3cret '), false, 'no trimming');
    assert.equal(service.isAuthorised(undefined), false);
    assert.equal(service.isAuthorised(''), false);
  });

  check('a configured token beats the environment, in both directions', () => {
    const prod = serviceWith({ token: 's3cret', nodeEnv: 'production' });
    assert.equal(prod.isAuthorised(undefined), false, 'production is never anonymous');
    assert.equal(prod.isAuthorised('Bearer s3cret'), true);
    const dev = serviceWith({ token: 's3cret', nodeEnv: 'development' });
    assert.equal(dev.isAuthorised(undefined), false, 'dev is not a bypass once a token exists');
  });

  await checkAsync('renders a well-formed exposition for a stub database', async () => {
    const service = new MetricsService(stubPrisma, { metrics: { token: '' }, nodeEnv: 'test' });
    const text = await service.render();
    const { types, samples } = parseExposition(text);

    for (const name of EXPECTED) {
      assert.ok(types.has(name), `${name} is missing from the exposition`);
    }
    assert.ok(samples.has('takeout_orders'), 'the order gauge produced no sample');
    assert.ok(text.includes('takeout_orders{status="COMPLETED"} 3'), 'the order count is wrong');
    assert.ok(
      text.includes('takeout_payments_captured_minor 15200'),
      'captured minor units are wrong',
    );
    assert.ok(
      !/takeout_payments_captured_minor \d+\.\d/.test(text),
      'money must never be rendered as a float',
    );
  });

  await checkAsync('a metric with no rows still declares HELP and TYPE', async () => {
    // `takeout_merchants` and `takeout_refunds` have no samples in the stub. A
    // scraper needs the declaration to exist even when the series is empty,
    // otherwise an alert on "no refunds pending" cannot be written.
    const service = new MetricsService(stubPrisma, { metrics: { token: '' }, nodeEnv: 'test' });
    const text = await service.render();
    for (const name of ['takeout_merchants', 'takeout_refunds']) {
      assert.ok(text.includes(`# HELP ${name} `), `${name} has no HELP line`);
      assert.ok(text.includes(`# TYPE ${name} gauge`), `${name} has no TYPE line`);
    }
  });

  await checkAsync('escapes label values, so one odd status cannot break the whole scrape', async () => {
    const nasty = 'a"b\\c\nd';
    const service = new MetricsService(
      { ...stubPrisma, order: { groupBy: async () => [{ status: nasty, _count: { _all: 1 } }] } },
      { metrics: { token: '' }, nodeEnv: 'test' },
    );
    const text = await service.render();
    const line = text.split('\n').find((l) => l.startsWith('takeout_orders{'));
    assert.ok(line, 'the sample vanished instead of being escaped');
    assert.ok(line.includes('\\"'), 'quotes are not escaped');
    assert.ok(line.includes('\\\\'), 'backslashes are not escaped');
    assert.ok(line.includes('\\n'), 'a newline is not escaped');
    parseExposition(text); // the whole file still parses
  });

  await checkAsync('in-process counters are per-replica and carry their help text', async () => {
    const service = new MetricsService(stubPrisma, { metrics: { token: '' }, nodeEnv: 'test' });
    service.increment('takeout_test_events_total', { kind: 'a' }, 'A counter used by the tests.');
    service.increment('takeout_test_events_total', { kind: 'a' });
    service.increment('takeout_test_events_total', { kind: 'b' });
    const text = await service.render();
    assert.ok(text.includes('# TYPE takeout_test_events_total counter'), 'counter type is missing');
    assert.ok(text.includes('A counter used by the tests.'), 'help text is missing');
    assert.ok(text.includes('takeout_test_events_total{kind="a"} 2'), 'increment did not accumulate');
    assert.ok(text.includes('takeout_test_events_total{kind="b"} 1'), 'labels are not distinct');
    parseExposition(text);
  });
}

async function http() {
  let scrape = null;

  await checkAsync('GET /metrics is served with the Prometheus content type', async () => {
    scrape = await get('/metrics');
    assert.equal(scrape.status, 200, `expected 200, got ${scrape.status}`);
    assert.match(
      scrape.headers.get('content-type') ?? '',
      /text\/plain; version=0\.0\.4/,
      `unexpected content type: ${scrape.headers.get('content-type')}`,
    );
  });

  check('the live scrape parses, and every declared metric is present', () => {
    assert.ok(scrape, 'the scrape did not run');
    const { types } = parseExposition(scrape.body);
    for (const name of EXPECTED) {
      assert.ok(types.has(name), `${name} is missing from the live exposition`);
    }
  });

  await checkAsync('GET /v1/metrics is a 404 — the prefix exclusion is intact', async () => {
    const response = await get('/v1/metrics');
    assert.equal(response.status, 404, `expected 404, got ${response.status}`);
  });

  await checkAsync('the metrics endpoint is not behind the API version prefix', async () => {
    const bare = await get('/metrics');
    assert.equal(bare.status, 200);
    assert.ok(bare.body.includes('takeout_orders'), 'the bare path is not the scrape target');
  });
}

// ---- C. the guarded path, over HTTP ---------------------------------------
// The offline checks prove the *rule*; this proves the wiring — guard, status
// code, headers and body all together. A second API process is required
// because `METRICS_TOKEN` is read once at boot and a running server's
// environment cannot be changed underneath it.
async function guardedOverHttp() {
  const token = 'e2e-metrics-token';
  const port = 3199;
  const origin = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [path.join(ROOT, 'apps/api/dist/main.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_TOKEN: token,
      ORDER_BACKGROUND_JOBS: 'false',
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
        ready = (await fetch(`${origin}/health`)).status === 200;
      } catch {
        /* not listening yet */
      }
    }
    if (!ready) throw new Error(`the guarded instance never became ready:\n${log}`);

    const anonymous = await fetch(`${origin}/metrics`);
    assert.equal(anonymous.status, 401, `an anonymous scrape got ${anonymous.status}`);

    const wrong = await fetch(`${origin}/metrics`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401, `a wrong token got ${wrong.status}`);

    const right = await fetch(`${origin}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(right.status, 200, `the correct token got ${right.status}`);
    assert.equal(
      right.headers.get('content-type'),
      'text/plain; version=0.0.4; charset=utf-8',
      `the content type was rewritten: ${right.headers.get('content-type')}`,
    );
    const body = await right.text();
    parseExposition(body);
    assert.ok(body.includes('takeout_orders'), 'the authorised scrape carried no metrics');

    const refusal = await anonymous.text();
    assert.ok(!refusal.includes(token), 'the refusal leaked the token');
  } finally {
    child.kill();
  }
}

async function main() {
  console.log('--- A. access rule + exposition (offline) ---');
  await offline();
  console.log('--- B. HTTP surface ---');
  await http();
  console.log('--- C. guarded path over HTTP (second instance) ---');
  await checkAsync('a configured METRICS_TOKEN gates the live endpoint', guardedOverHttp);

  console.log(`\n${'='.repeat(66)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks`);
  } else {
    console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.log(`  \u2717 ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nFATAL: ${error.message}`);
  process.exitCode = 1;
});

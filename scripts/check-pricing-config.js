#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================================
//  Pricing configuration check
// ============================================================================
//  Proves the platform fee is a *configuration* value, not a constant:
//
//      platform_config row  ->  environment variable  ->  code default
//
//  Places one real order through the running API and prints what the engine
//  charged, next to what the `platform_config` row says it should charge.
//  Change the row, restart the API, run again — the fee follows the row.
//
//  Usage
//  -----
//    node scripts/check-pricing-config.js
// ============================================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000/v1';
const CONFIG_KEY = 'pricing.platform_fee_per_main_item_minor';

const prisma = new PrismaClient();

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function mintToken(secret, { sub, role }) {
  const b64url = (input) => Buffer.from(input).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub, role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function main() {
  const env = loadEnv();

  const configRow = await prisma.platformConfig.findUnique({ where: { key: CONFIG_KEY } });
  const configuredFee = configRow ? Number(configRow.value) : null;

  const merchant = await prisma.merchant.findUnique({
    where: { slug: 'dim-sum-express' },
    select: { id: true },
  });
  const customer = await prisma.user.findUnique({
    where: { phone: '+85290000001' },
    select: { id: true },
  });
  const mains = await prisma.menuItem.findMany({
    where: { merchantId: merchant.id, isMainItem: true },
    select: { id: true, name: true },
    orderBy: { sortOrder: 'asc' },
  });

  const mainCount = mains.length; // order one of every main item
  const token = mintToken(env.JWT_SECRET, { sub: customer.id, role: 'CUSTOMER' });

  const response = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      merchantId: merchant.id,
      items: mains.map((item) => ({ menuItemId: item.id, quantity: 1 })),
      customerNote: 'pricing config check',
    }),
  });

  if (response.status !== 201) {
    console.error(`Order failed (${response.status}): ${await response.text()}`);
    process.exitCode = 1;
    return;
  }

  const { pricing } = await response.json();
  const perItem = pricing.platformFeeMinor / pricing.mainItemCount;
  const envFallback = Number(env.PLATFORM_FEE_PER_MAIN_ITEM_MINOR ?? 350);

  console.log(`platform_config "${CONFIG_KEY}" : ${configuredFee ?? '(absent — env default applies)'}`);
  console.log(`env PLATFORM_FEE_PER_MAIN_ITEM_MINOR : ${envFallback}`);
  console.log(`code default                         : 350`);
  console.log('');
  console.log(`order: ${pricing.mainItemCount} main items, subtotal ${pricing.subtotalMinor} minor units`);
  console.log(`charged platformFee                  : ${pricing.platformFeeMinor}`);
  console.log(`implied fee per main item            : ${perItem}`);
  console.log(`merchantPayout                       : ${pricing.merchantPayoutMinor}`);

  const expected = configuredFee ?? envFallback;
  if (perItem === expected) {
    console.log(`\nPASS — the engine is charging the configured ${expected} minor units per main item.`);
  } else {
    console.log(`\nFAIL — expected ${expected} per main item, engine charged ${perItem}.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`FATAL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/* eslint-disable no-console */
// ============================================================================
//  Seed — demo data for local development
// ============================================================================
//  Idempotent: re-running updates rather than duplicating. Keys are chosen so
//  that a second run is a no-op:
//      users           -> phone (unique)
//      merchants       -> slug (unique)
//      categories      -> (merchantId, name) unique
//      operating hours -> (merchantId, dayOfWeek) unique
//      menu items      -> no natural key, so find-then-create by name
//
//  Run:  node prisma/seed.js
// ============================================================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/** HK$ in minor units. */
const hkd = (major) => Math.round(major * 100);

const MERCHANT = {
  slug: 'dim-sum-express',
  name: '點心快線',
  nameEn: 'Dim Sum Express',
  description: '傳統手工點心，即點即蒸。中環街市旁，自取免等位。',
  phone: '+85221234567',
  addressLine1: '中環德輔道中 88 號',
  addressLine2: '地下 A 舖',
  district: 'Central',
  // Central, Hong Kong.
  latitude: 22.2819,
  longitude: 114.1582,
  prepTimeMinutes: 15,
  pickupWindowMinutes: 60,
  acceptTimeoutMinutes: 5,
  autoAcceptOrders: false,
};

/** `isMainItem` is the flag that drives the HK$3.50-per-item platform fee. */
const MENU = [
  {
    category: '點心',
    name: '晶瑩蝦餃',
    nameEn: 'Steamed Shrimp Dumpling',
    description: '每天手打蝦膠，十二摺薄皮。一籠四件。',
    priceMinor: hkd(48),
    isMainItem: true,
    dailyQuota: 50,
    sortOrder: 1,
  },
  {
    category: '點心',
    name: '蟹籽燒賣',
    nameEn: 'Pork & Shrimp Siu Mai',
    description: '豬肉蝦仁比例三七，面頭鋪蟹籽。一籠四件。',
    priceMinor: hkd(38),
    isMainItem: true,
    dailyQuota: 40,
    sortOrder: 2,
  },
  {
    category: '點心',
    name: '蜜汁叉燒包',
    nameEn: 'BBQ Pork Bun',
    description: '自家醃製叉燒，半肥瘦。一籠三件。',
    priceMinor: hkd(32),
    isMainItem: true,
    // null = 不限量
    dailyQuota: null,
    sortOrder: 3,
  },
  {
    category: '飲品',
    name: '凍檸茶',
    nameEn: 'Iced Lemon Tea',
    description: '錫蘭紅茶配新鮮檸檬，少甜可選。',
    priceMinor: hkd(18),
    isMainItem: false,
    dailyQuota: 100,
    sortOrder: 1,
  },
  {
    category: '甜品',
    name: '楊枝甘露',
    nameEn: 'Mango Pomelo Sago',
    description: '呂宋芒配泰國金柚，每日限量。',
    priceMinor: hkd(28),
    isMainItem: false,
    dailyQuota: 20,
    sortOrder: 1,
  },
];

async function upsertUser({ phone, displayName, role }) {
  return prisma.user.upsert({
    where: { phone },
    update: { displayName, role },
    create: { phone, displayName, role },
  });
}

async function main() {
  // ---- identity ------------------------------------------------------------
  const customer = await upsertUser({
    phone: '+85290000001',
    displayName: '陳大文',
    role: 'CUSTOMER',
  });
  const owner = await upsertUser({
    phone: '+85290000002',
    displayName: '李老闆',
    role: 'MERCHANT_OWNER',
  });
  // Platform operator. There is deliberately only ONE seeded admin: the admin
  // console refuses to let the last enabled admin be demoted or disabled, so a
  // second admin has to be created through the console itself.
  const admin = await upsertUser({
    phone: '+85290000003',
    displayName: '平台管理員',
    role: 'ADMIN',
  });

  // ---- merchant ------------------------------------------------------------
  const merchant = await prisma.merchant.upsert({
    where: { slug: MERCHANT.slug },
    update: { ...MERCHANT, ownerId: owner.id, status: 'ACTIVE', acceptsOrders: true },
    create: { ...MERCHANT, ownerId: owner.id, status: 'ACTIVE', acceptsOrders: true },
  });

  // Staff row so the owner's JWT `merchantIds` claim has something to match.
  await prisma.merchantStaff.upsert({
    where: { merchantId_userId: { merchantId: merchant.id, userId: owner.id } },
    update: { isManager: true },
    create: { merchantId: merchant.id, userId: owner.id, isManager: true },
  });

  // ---- opening hours: 11:00–22:00 every day --------------------------------
  // 0 = Sunday … 6 = Saturday. Both bounds are minutes from local midnight.
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await prisma.merchantOperatingHour.upsert({
      where: { merchantId_dayOfWeek: { merchantId: merchant.id, dayOfWeek } },
      update: { opensAtMinute: 660, closesAtMinute: 1320, isClosed: false },
      create: { merchantId: merchant.id, dayOfWeek, opensAtMinute: 660, closesAtMinute: 1320 },
    });
  }

  // ---- menu ----------------------------------------------------------------
  const categoryIdByName = new Map();
  for (const name of [...new Set(MENU.map((item) => item.category))]) {
    const category = await prisma.menuCategory.upsert({
      where: { merchantId_name: { merchantId: merchant.id, name } },
      update: {},
      create: { merchantId: merchant.id, name },
    });
    categoryIdByName.set(name, category.id);
  }

  for (const item of MENU) {
    const { category, ...fields } = item;
    const existing = await prisma.menuItem.findFirst({
      where: { merchantId: merchant.id, name: fields.name },
      select: { id: true },
    });

    const data = {
      ...fields,
      merchantId: merchant.id,
      categoryId: categoryIdByName.get(category) ?? null,
      availability: 'AVAILABLE',
    };

    if (existing) {
      await prisma.menuItem.update({ where: { id: existing.id }, data });
    } else {
      await prisma.menuItem.create({ data });
    }
  }

  const itemCount = await prisma.menuItem.count({ where: { merchantId: merchant.id } });
  const mainItemCount = await prisma.menuItem.count({
    where: { merchantId: merchant.id, isMainItem: true },
  });

  console.log('Seed complete.');
  console.log(`  customer : ${customer.displayName} (${customer.id})`);
  console.log(`  owner    : ${owner.displayName} (${owner.id})`);
  console.log(`  admin    : ${admin.displayName} (${admin.id})`);
  console.log(`  merchant : ${merchant.name} / ${merchant.slug} (${merchant.id})`);
  console.log(`  menu     : ${itemCount} items (${mainItemCount} main items)`);
  console.log('  hours    : 11:00-22:00, 7 days');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

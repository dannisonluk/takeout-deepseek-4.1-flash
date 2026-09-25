# Takeout Platform（外賣自取平台）

A Hong Kong **self-pickup（外賣自取）** platform. The MVP is pickup-only, but the
architecture already reserves fleet management, live tracking and dynamic
dispatch. Three frontend entry points share a single API: the **customer
storefront（顧客前台）**, the **merchant console（商戶後台）** and the **platform
admin console（平台管理台）**.

Alongside self-pickup, six merchant requirements are implemented: **order status
flow（訂單狀態流轉）**, **refund request tickets — the platform never touches
money（退款申請工單，平台不碰錢）**, **special closure days（特別休息日）**,
**merchant business reports（商戶營業報表）**, **walk-in waitlist（現場候位）** and
**dine-in ordering（店內點餐）**.

```
Customer orders ─▶ PricingEngine prices ─▶ daily quota decremented ─▶ merchant accepts ─▶ preparing ─▶ ready ─▶ completed
                                                    │
                                    Outbox ─▶ Redis ─▶ WebSocket（廚房板 kitchen board / 顧客追蹤 customer tracking）
```

### Contents

| Section | What it covers |
|---|---|
| [Installation & Usage](#installation--usage) | Requirements, nine-step startup, seed accounts |
| [Project Structure](#project-structure) | What each of the three workspaces owns |
| [Main Features](#main-features) | Overview of the six merchant requirements |
| [Core Business Rules](#core-business-rules) | Pricing, state machines, waitlist, dine-in, report tiers |
| [Three Frontend Entry Points](#three-frontend-entry-points) | Customer / merchant / platform, and each one's UI bias |
| [Verified](#verified) | 285 unit tests + thirteen e2e scripts |
| [Known Gaps](#known-gaps) | Deliberate technical debt and untested surfaces |
| [Contributing](#contributing) | Workflow, commit format, non-negotiable architecture rules |

---

## Installation & Usage

### Requirements

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | 22 recommended |
| PostgreSQL | ≥ 14 | **PostGIS required** — merchant search and distance ranking depend on it |
| Redis | ≥ 6 | **Optional**: boots fine without it; only idempotency keys / outbox / WebSocket degrade |
| npm | ≥ 9 | workspaces |

> **The API boots normally when Redis is absent.** Only idempotency keys, the
> outbox relay and WebSocket fan-out degrade. Local development works without Redis.

```bash
# 1. Dependencies (on Windows the esbuild postinstall can be blocked by the
#    sandbox — use --ignore-scripts)
npm install --ignore-scripts

# 2. Environment
cp .env.example .env        # at minimum DATABASE_URL / REDIS_URL / JWT_SECRET

# 3. Start Postgres (PostGIS) + Redis
npm run infra:up

# 4. Create tables + PostGIS indexes + platform-fee seed
npx prisma migrate dev --name init
psql "$DATABASE_URL" -f prisma/sql/post-init.sql

# 5. Seed demo data (3 identities / 1 merchant / 5 dishes / 7 days of hours)
npm run db:seed

# 6. Run the domain tests (285 of them, no database needed)
npm test

# 7. Start the API
npm run dev                 # http://127.0.0.1:3000/v1

# 8. Start the frontend (all three entry points, one process)
npm run dev -w @takeout/web # http://127.0.0.1:3001

# 9. Verify
npm run e2e              # 48 checks: order → pay → accept → complete → reconcile
npm run e2e:admin        # 79 checks: merchant lifecycle, menu CRUD, permissions, reconciliation
npm run e2e:reservation  # 36 checks: reservation lifecycle, seat capacity, release symmetry
npm run e2e:closure      # 33 checks: closure days, blocking new orders, auto-cancel, idempotency
npm run e2e:refund       # 40 checks: refund tickets, merchant negotiation, platform never touches money
npm run e2e:waitlist     # 44 checks: walk-in queue, take-a-number, call timeout, host board
npm run e2e:dining       # 38 checks: dine-in, one-time QR, multiple orders per table, idempotent close
npm run e2e:analytics    # 46 checks: report tiers, free CSV, timezone, period comparison
npm run check:pricing    # fee the engine actually charges vs platform_config
npm run check:contract   # hand-written frontend types vs fields the API actually returns
npm run e2e:all          # all of the above, sequentially (they share one database)
```

> All of the e2e scripts share one database and **must run sequentially**. Run in
> parallel, one script's deferred `check()` reads a `held` count that another
> script just inflated. That is what `npm run e2e:all` exists for.
>
> Each script cleans up after itself and **passes twice in a row**. A test that
> only passes on a clean database is a test that will fail in CI.

Smoke check: `curl --noproxy '*' http://127.0.0.1:3000/health` (liveness, always 200)

> `/health/ready` returns **503 + `status: degraded`** when Redis is missing.
> That is deliberate — it tells the orchestrator to degrade, not to restart.
> There is no Redis on this machine, so that route is always 503 here.
> Also: `curl` against localhost **must** pass `--noproxy '*'`; the sandbox sets
> `HTTP_PROXY`, and without the flag you get the proxy's 502, which looks
> exactly like a dead server.

### Seed accounts（`npm run db:seed`; the OTP code is returned in the API response）

| Role | Phone | Entry point |
|---|---|---|
| Customer（顧客） | `+85290000001` | `/` |
| Merchant owner（商戶擁有人） | `+85290000002` | `/merchant` |
| Platform admin（平台管理員） | `+85290000003` | `/admin` |

---

## Project Structure

```
packages/domain/          ★ pure domain — zero runtime dependencies, 285 unit tests
  src/shared/             Money (integer minor units), GeoPoint, Clock, IdGenerator
  src/pricing/            PricingEngine — per-item brokerage fee, merchant settlement
  src/order/              OrderStateMachine — lifecycle, authorization, side effects
  src/reservation/        reservation（訂位）state machine, seating policy, capacity planning
  src/refund/             RefundRequestStateMachine — refund tickets（通知 only, never money）
  src/waitlist/           WaitlistStateMachine, ticket-number generation, CALLED keeps its position
  src/dining/             DiningSessionMachine (OPEN / CLOSED / ABANDONED)
  src/merchant/           closure-day policy, AnalyticsTier, report aggregation, CSV export
  src/dispatch/           IDispatchService, SelfPickup, Fleet, DispatchScoringEngine
  src/fleet/              Phase-2 ports (driver roster / location / tasks)

apps/api/                 NestJS — interface / application / infrastructure layers
  src/modules/auth/       OTP login, refresh-token rotation, reuse detection
  src/modules/ordering/   placing orders and transitioning them (the core vertical slice)
  src/modules/pricing/    PricingEngine loaded from platform_config, live repricing
  src/modules/payment/    payment intent, webhook, refunds, simulated payment (not production)
  src/modules/merchants/  merchant profile, menu CRUD, discovery, closure days, reports
  src/modules/reservation/ reservations (customer side + merchant 訂位簿 + availability)
  src/modules/waitlist/   walk-in queue（顧客取號 + 帶位板 host board + settings）
  src/modules/dining/     dine-in ordering（two-token design, 桌況板 table board）
  src/modules/admin/      platform admin console (overview / orders / merchants / finance / config / users / ops)
  src/modules/dispatch/   IDispatchService binding (Phase 2 swaps one line)
  src/modules/realtime/   WebSocket fan-out (subscribes to the outbox Redis channel)
  src/modules/media/      R2 two-phase upload presign
  src/infrastructure/     Prisma / Redis / Outbox relay / R2 / Stripe

apps/web/                 Next.js 15 App Router (React 19) — 36 pages, three entry points
  src/lib/                api client (single-flight refresh), auth, types, format, cart
  src/components/         ui.tsx (design system), app-shell, merchant/admin shell
  src/app/                customer  /、/m/[slug]、/m/[slug]/reserve、/m/[slug]/queue
                              /dine/table/[qrToken]、/checkout、/orders ...
                          merchant /merchant、/merchant/orders（廚房板）、/merchant/menu
                              /merchant/settings、/merchant/reservations、/merchant/closures
                              /merchant/refunds、/merchant/queue、/merchant/dining
                              /merchant/analytics
                          platform /admin、/admin/orders、/admin/merchants、/admin/finance
                              /admin/config、/admin/users、/admin/ops、/admin/refunds

prisma/schema.prisma      34 models, 25 enums, indexes, FKs, PostGIS, Phase-2 tables
prisma/sql/post-init.sql  indexes, trgm search, platform-fee seed, reconciliation view
                          (contains the field-name mapping table at the top)
prisma/seed.js            idempotent demo data: 3 identities / 1 merchant / 5 dishes / 7 days
scripts/                  e2e-smoke.js、e2e-admin.js、e2e-reservation.js、e2e-closure.js
                              e2e-refund.js、e2e-waitlist.js、e2e-dining.js、e2e-analytics.js
                              contract-check.js、check-pricing-config.js
docs/                     ARCHITECTURE.md / API.md / ROADMAP.md / CHANGES.md
```

---

## Main Features

### Self-pickup (the core)

Customer picks a shop → adds to cart → checks out → merchant accepts →
preparing → ready for pickup → completed. Supports **immediate preparation（即時製作）**
and **scheduled pickup（預約取餐）** via `scheduledPickupAt`; per-dish daily
quotas decrement in real time.

### The six merchant requirements

| # | Feature（功能） | In one sentence | Status |
|---|---|---|---|
| 1 | Order status flow（訂單狀態流轉） | Merchant marks "payment received / preparing / done"; the customer sees it live | ✅ |
| 2 | Refund request ticket（退款申請工單） | Platform **files the ticket but never touches the money**; merchant and customer settle offline | ✅ |
| 3 | Special closure days（特別休息日） | Pre-set a rest day or a fixed weekly closure; blocks new orders + auto-cancels existing bookings | ✅ |
| 4 | Merchant reports（商戶營業報表） | Excel export is **free**; the BI dashboard is paid across `NONE/BASIC/PRO` | ✅ |
| 5 | Walk-in waitlist（現場候位） | Customer takes a number on their phone, merchant seats from a tablet; call timeouts mark no-shows | ✅ |
| 6 | Dine-in ordering（店內點餐） | Scan the table QR to open a sitting → a one-time `guestToken` carries ordering authority | ✅ |

### Also implemented

OTP phone login, per-dish daily quota and stock, live platform-fee repricing
(`platform_config`), FPS / QR payment (simulated), ratings and reports, merchant
application review, platform admin console (overview / orders / merchants /
finance / config / users / ops), audit trail, outbox events.

---

## Core Business Rules

### Pricing（計費）

```
Platform_Fee    = Count(Ordered_Main_Items) × HK$3.50
Merchant_Payout = Subtotal − Platform_Fee − Payment_Processing_Fee
Total (paid by customer) = Subtotal + Customer_Service_Fee (0 in the MVP)
```

`HK$3.50` is **not hard-coded**. Resolution order: `platform_config` table →
environment variable → code default. Repricing is an `UPDATE platform_config`;
no redeploy needed.

`isMainItem` lives on `MenuItem` — only **main dishes（主餐）** are charged
per item; drinks and **side dishes（配菜）** are not. It accumulates over
`quantity`: 3 × 招牌飯 = 3 main items = HK$10.50.

**Live repricing really reaches the money.** `PricingEngine.usePolicy()` swaps
the policy **in place**, not the engine instance — DI hands `PlaceOrderUseCase`
that very object, so swapping instances would leave consumers holding the
boot-time policy forever: the console would show the new price while the next
order still charged the old one. A test locks this path (asserting fee *and*
payout together, so a half-swapped policy cannot slip through).

### Order state machine（訂單狀態機）

```
PENDING_PAYMENT ──▶ PAID ──▶ ACCEPTED ──▶ PREPARING ──▶ READY_FOR_PICKUP ──▶ COMPLETED
       │              │          │             │                 │
       │              ├──▶ REJECTED ──────────┴────▶ REFUNDED ◀──┘
       ├──▶ EXPIRED   ├──▶ EXPIRED
       └──▶ CANCELLED ├──▶ CANCELLED ──▶ REFUNDED
```

- Authorization lives in the transition table, not scattered across services.
  `OrderActor.ADMIN` can bypass the `MERCHANT_ACCEPTING` guard.
- `REJECTED` is **not** terminal — a paid order that is rejected must go through
  `REFUNDED`; the refund is a mandatory path in the graph.
- After `PREPARING` the customer cannot cancel (the kitchen has already started).
- Every transition returns `sideEffects`, and the application layer decides how
  to discharge them. **Declared means implemented** — `RECORD_PAYOUT_LEDGER` was
  once left unimplemented, which made reconciliation（對帳）permanently unbalanced.

### Why money is an integer

`Money` is integer **minor units（最小貨幣單位）** internally (HK$3.50 → `350`).
Percentages use basis points (`340` = 3.40%) with integer intermediates, rounding
via `roundHalfAwayFromZero` only at the final step. Floats are a bug factory in
a ledger system.

### Special closure days（特別休息日）

A closure day applies to the **whole day**, and there is only **one source of
truth**: the 4th parameter of `checkOpening()`.

```
ClosureReason = PUBLIC_HOLIDAY | STAFF_HOLIDAY | PRIVATE_EVENT | MAINTENANCE | OTHER
```

- "Closed every Wednesday" is **not** a closure day, it is **opening hours（營業時間）**:
  `PUT /hours` sets that day's `isClosed` to `true`. `merchant_closures` holds
  only **exceptions（例外）** — public holidays, staff trips, unscheduled maintenance.
- Setting a closure day **blocks new orders** (both pickup and reservation paths)
  and **auto-cancels existing active bookings** on that date, each one going
  through `ReservationStateMachine`, so seats are returned and the customer gets
  a `reservation.cancelled` notification.
- The cancellation `statusReason` is `MERCHANT_CLOSED:<date>`, **not** a
  human sentence — a merchant editing `note` later must not rewrite the audit trail.
- **`DELETE` does not restore cancelled bookings.** The cancellation was already
  notified and the seats already returned; restoring would be re-booking from thin air.

> A real defect was found here: the calendar hid the closure day, but
> `POST /reservations` still succeeded when posted directly. **Filtering only on
> the read side is not blocking** — the write side has to ask again. See
> `docs/CHANGES.md` §9.3.

### Refund request tickets — the platform never touches money（退款申請工單，平台不碰錢）

This is a **booking platform（預訂平台）**: it never handles the customer's money
and never refunds anyone. The customer **files** a refund request through the
platform; the merchant and customer then **negotiate offline（線下商議）**.

```
OPEN ──┬── IN_DISCUSSION ──┬── RESOLVED_OFFLINE   （terminal）
       │                    ├── DECLINED           （terminal）
       │                    └── CANCELLED          （terminal, customer / ADMIN only）
       ├── RESOLVED_OFFLINE / DECLINED / CANCELLED
```

- **There is no `REFUNDED` status** — that would be the platform asserting
  something it never verified. `RESOLVED_OFFLINE` means "the merchant **says** it
  handled this offline", and that is the only way the UI may render it.
- **`RefundRequestSideEffect` has only `NOTIFY_CUSTOMER` / `NOTIFY_MERCHANT`**,
  no money members. **That omission is the design**: adding a money path later
  must be a deliberate act.
- **At most one open ticket per order** (a second one is 409) — two open tickets
  means one complaint has two conversations, and whichever the merchant answered
  last looks like the truth.
- **The customer can withdraw, never resolve or decline.** Only the merchant
  decides what it has given back.
- `RESOLVED_OFFLINE` **requires at least an amount or a proof** — an empty
  "handled" is worse than nothing: it closes the queue item while the customer
  is still waiting.
- **The admin console is read-only**; `ADMIN` may advance on the merchant's
  behalf (for "the merchant left it hanging"), recorded in `resolvedById`.

> This round fixed a **recurring** WebSocket routing defect: `aggregateRoom()` was
> a ternary, so anything that was not a `Reservation` fell into `order:`. See
> `docs/CHANGES.md` §10.5.1.

### Walk-in waitlist（現場候位）

```
WAITING ──┬── CALLED ──┬── SEATED    （terminal）
          │            ├── NO_SHOW   （terminal）
          │            └── CANCELLED （terminal, merchant only）
          ├── SEATED / NO_SHOW / CANCELLED
```

- **A `CALLED` party keeps its original queue position.** Calling a number does
  not kick them out of the queue — they are still at the door. If `CALLED` moved
  them to the back, the second call would land behind someone already called.
- **Taking a number emits no outbox event**; the first event
  (`waitlist.called`) carries `version: 2`. Taking a number is an in-store act
  that notifies no one, so `version` proves "a write happened and no event fired".
- **`acceptWhenClosed` defaults to `false`**: queueing before opening puts the
  first guest through the door behind six people who are still asleep. A shop
  that wants a warm queue turns it on deliberately.
- The take-a-number page's `closedReason` has **two values** (`'CLOSED'` /
  `'DISABLED'`), not a boolean — they ask the guest to do different things
  ("come back at 11" vs "try another shop").
- **The host board's buttons are computed by the same state machine the write
  path uses** (actor = `MERCHANT`), so it can never render a button the server
  would refuse.

### Dine-in ordering — two tokens（店內點餐，兩段 token）

The authorization problem with anonymous ordering: if scanning the code on the
table is enough to order, then anyone who photographs that code at any time can
order for that table from outside the shop. So it is split in two:

| token | Where it lives | Lifetime | What it can do |
|---|---|---|---|
| `dining_tables.qrToken` | static, printed on the table | permanent | **only opens a sitting** |
| `dining_sessions.guestToken` | minted when the sitting opens | this meal | **ordering authority** |

`POST /dine/table/:qrToken/session` exchanges the first for the second. The next
table photographing your code can only open a **new** session; it cannot touch
yours. Opening a sitting is one-time; the authority is what persists.

- **A dine-in order is still an ordinary `Order`**: `paymentMode: PAY_AT_STORE`,
  `customerServiceFeeMinor: 0`, `diningSessionId` pointing at its sitting.
  **`OrderStatus` must not be polluted** — it runs the same state machine and
  the same pricing engine.
- `DiningSessionStatus` is a separate `OPEN | CLOSED | ABANDONED`.
  **A second close returns 422 `DINING_SESSION_CLOSED`** — coming back after a
  screen lock and pressing settle again should not 500, and should not settle twice.
- `@@unique([merchantId, code])` is the real guard-rail; `normalizeTableCode` only
  strips separators and upper-cases.

### Merchant reports — three tiers（商戶營業報表，三層）

| tier | Label | Capabilities | Paid |
|---|---|---|---|
| `NONE` | 標準 Standard | `[]` | Free (**export always available**) |
| `BASIC` | 進階報表 Advanced | `DAILY_ROLLUP`, `ITEM_MIX`, `HOUR_OF_DAY`, `CHANNEL_MIX` | Paid |
| `PRO` | 專業報表 Professional | all 5 (+ `COMPARISON`) | Paid |

Three invariants:

1. **Export is never tier-gated.** `canExportRawData` is always `true`. Locking a
   shop's own records behind a paywall does not collect money — it makes the shop leave.
2. **The tier decides which panels *render*, not which numbers *exist*.** The API
   always returns the full numbers; the frontend decides how many blocks to draw.
   A downgrade looks like "fewer panels", never "different numbers".
3. **The tier is a fact about the shop, not about the viewer.** `UPDATE merchants
   SET "analyticsTier"='PLATINUM'` is **rejected by Postgres** — it is a real
   enum, so fail-closed is guaranteed by the database.

**Load-bearing CSV details**: UTF-8 BOM (`EF BB BF` — without it Excel renders
the Chinese header as mojibake), CRLF line endings, money as decimal strings,
a leading `'` on any value starting with `= + @ -` (CSV injection), and an empty
window still exports with `X-Row-Count: 0`.

> ⚠️ The report SQL `GROUP BY`s
> `(serviceDate, hourOfDay, status, fulfilmentMode, paymentMode)`, so **a row is
> not an order**. Counting grouped rows as orders once showed a shop fewer sales
> than it made — invisible in development, where a group usually holds one order.
> `ReportableOrder.orderCount` is now a **required** field, so the type system
> blocks the `.length` idiom. See `docs/CHANGES.md` §13.2.

---

## Three Frontend Entry Points

| Entry point | Audience | Design rationale |
|---|---|---|
| `/`, `/m/[slug]`, `/m/[slug]/reserve`, `/m/[slug]/queue`, `/dine/table/[qrToken]`, `/checkout`, `/orders`, `/reservations`, `/refunds` | Customer（顧客） | One-handed phone use, top nav rather than a sidebar; `/m/[slug]` is the only SSR route (shared links need metadata), and `/m/[slug]/reserve` and `/m/[slug]/queue` only SSR a shop-name shell |
| `/merchant/*`, `/merchant/reservations`, `/merchant/closures`, `/merchant/refunds`, `/merchant/queue`, `/merchant/dining`, `/merchant/analytics` | Merchant（商戶） | Sidebar + 廚房板 kitchen board / 訂位簿 reservation book / closure days / refund queue / 帶位板 host board / 桌況板 table board / reports; dark theme (kitchens are dim, screens are watched for hours). Polling: orders 15s, reservations 20s, refunds 20s, host board 5s |
| `/admin/*`, `/admin/refunds`, `/admin/merchants` (tier editing) | Platform（平台） | Same shell, higher data density; every destructive action requires a reason and writes an audit record; refunds are read-only |

**Two pages are phone-first, not "responsive as a side effect".** The users of
`/m/[slug]/queue`（取號 take a number）and `/dine/table/[qrToken]`（掃碼點餐 scan
to order）are standing at the door or sitting at the table — one hand, daylight,
possibly walking — so these are **big buttons, little information, one screen
top to bottom**, and do not inherit desktop information density. The host board
and table board are the opposite: counter tablets that must be read at a glance.

**A customer's ticket carries no one else's phone number.**
`CustomerQueueTicketView` deliberately omits `contactPhone`,
`allowedNextTransitions`, `version`, `note` and `waitedMinutes`. The contract
check has a **negative assertion** guarding exactly this — "the API sent an extra
field" is a defect class that used to be invisible.

**The reservation book's buttons are a projection, not a mirror.** The kitchen
board's `ACTIONS_FROM` is a hand-written lifecycle table (because
`MerchantOrderView` has no transition list), but reservations, the host board and
the table board deliberately return `allowedNextTransitions`, so the frontend
draws buttons straight from it — changing a rule needs no frontend redeploy, and
a button the server would refuse can never appear.

**The frontend is not an authorization boundary.** `useRequireRole` only routes
people without a role somewhere they can use; the real check is in the API
(`JwtAuthGuard` → `RolesGuard` → `MerchantScopeGuard`). Any route that relies on
a frontend guard to protect data is a route that leaks.

`apps/web/src/lib/types.ts` is a **hand-written（手寫）** mirror, not generated —
a generator will happily emit a type for a field that should never be exposed.
The cost is that renaming a field produces no compile error, which is why
`npm run check:contract` compares the fields the API actually returns against the
fields the frontend declares, **in both directions**.

---

## Verified

**Domain unit tests（領域層單元測試）— 285, pure in-memory, milliseconds**

```bash
$ npm test
 ✓ tests/reservation.spec.ts            (35 tests)
 ✓ tests/waitlist.spec.ts               (30 tests)
 ✓ tests/analytics.spec.ts              (28 tests)
 ✓ tests/order-state-machine.spec.ts    (28 tests)
 ✓ tests/refund.spec.ts                 (25 tests)
 ✓ tests/cancellation-policy.spec.ts    (25 tests)
 ✓ tests/dispatch.spec.ts               (19 tests)
 ✓ tests/pricing-engine.spec.ts         (18 tests)
 ✓ tests/fps-qr.spec.ts                 (18 tests)
 ✓ tests/closure.spec.ts                (15 tests)
 ✓ tests/merchant-ranking.spec.ts       (14 tests)
 ✓ tests/rating.spec.ts                 (13 tests)
 ✓ tests/money.spec.ts                  (9 tests)
 ✓ tests/dining.spec.ts                 (8 tests)
     Test Files  14 passed (14)
          Tests  285 passed (285)
```

**End-to-end — thirteen scripts, real HTTP + real SQL + real state machines**

```bash
$ npm run e2e                             # 48 checks
 1. Boot + auth ........................ 4
 2. Place an order (immediate prep) .... 10
 3. Scheduled-pickup validation ......... 2
 4. State machine rejects illegal ....... 1
 5. Payment intent + webhook ............ 12
 6. Kitchen lifecycle ................... 7
 7. Audit trail, outbox and settlement .. 12

$ npm run e2e:admin                       # 79 checks
 1. Admin guard (401 / 403) ............. 6
 2. Paging regression lock .............. 4
 3. Merchant lifecycle .................. 14
 4. Menu CRUD (incl. quota push) ........ 18
 5. Live pricing reload ................. 6
 6. Order administration ................ 12
 7. Users — cannot lock yourself out .... 10
 8. Ops — outbox, audit, reconciliation . 9

$ npm run e2e:reservation                 # 36 checks  (reservations run the real state machine)
$ npm run e2e:closure                     # 33 checks  (closure days block orders + auto-cancel)
$ npm run e2e:refund                      # 40 checks  (refund tickets; money path untouched)
$ npm run e2e:waitlist                    # 44 checks  (take-a-number emits no event; CALLED keeps position)
$ npm run e2e:dining                      # 38 checks  (two tokens; only the second carries authority)
$ npm run e2e:analytics                   # 46 checks  (tiers; free CSV; BOM; timezone; comparison)
$ npm run e2e:pay-at-store                # 48 checks  (pay at store)
$ npm run e2e:payments                    # 53 checks  (payment channels / webhook)
$ npm run e2e:feedback                    # 65 checks  (ratings + reports)
$ npm run e2e:timeouts                    # 29 checks  (timeout sweeps)
$ npm run e2e:metrics                     # 15 checks

$ npm run e2e:all                         # all thirteen, sequentially
```

> **These share one database and must not run in parallel.** In parallel, the
> smoke script's deferred `check()` runs last and reads a
> `menu_item_daily_stock.held` that the admin script just inflated. That is what
> `npm run e2e:all` exists for.

**Frontend type contract (compared in both directions)**

```bash
$ npm run check:contract
  ok    MerchantSummary / MerchantDetail / MenuCategory / MenuItem
  ok    PickupSlots (incl. closedReason / closureDate) / PickupSlot
  ok    DistrictCount / OperatingHour
  ok    OwnedMerchant / OwnerMenu / MerchantOrder
  ok    DashboardStats (incl. merchants / orders / users / payouts / ops)
  ok    PlatformConfigEntry / PricingPolicy / AdminUser / AdminMerchant
  ok    AdminOrderSummary / AdminOrder / pricingSnapshot / statusEvents
  ok    AdminPayment / AdminRefund / AdminPayout / Reconciliation
  ok    ReservationAvailability (incl. closedDates) / CustomerReservation
  ok    MerchantReservation / ReservationSettings / ReservationTransition
  ok    CustomerRefundRequest / MerchantRefundRequest / RefundTransition
  ok    CustomerOrder.refundRequests (incl. the empty array)
  PASS — 92 contract checks agree, 5 skipped (no sample row)
```

The same five are always skipped; the criterion is **0 failures**:

```
  skip  AdminPayment / AdminRefund / AdminPayout / ReconciliationRow  (no sample row)
  skip  MerchantClosure  (no rest day set for this merchant)
```

The first four need **payment data** to verify; `MerchantClosure` is **deliberately
not created** — `PUT`-ing a closure day is a write with side effects (it cancels
that day's existing bookings), and a verification script should not touch real
data just to check a shape.

> **This script's `agree` count depends on what is in the database at the time** —
> the same code has produced 65 / 67 / 69, and this round extended it to **92**.
> So the criterion is "**0 failures**", not "agree equals some fixed number".
> Treating a number as the expected value manufactures false reds. The four skips
> above are expected, not a regression; to run against full data,
> **run `npm run e2e` first** (it leaves settled orders and payments behind).

**Build**

```bash
$ npm run build          # domain → api → web
$ npm run typecheck      # all 3 workspaces pass
$ next build             # 36 pages + redirects / layouts (**must run outside the sandbox**)
```

**Configurability (no code change needed)**

```bash
$ npm run check:pricing                      # platform_config = 350
charged platformFee : 1050   (3 main items)
PASS — the engine is charging the configured 350 minor units per main item.
```

The env var and the code default are both still 350, so this test only passes if
`platform_config` is genuinely being read.

---

## Known Gaps

- **Closure days have no bulk or recurring interface.** `PUT` handles one day at
  a time, and so does the frontend — setting a week of annual leave takes seven
  clicks. The data model supports it (`serviceDate` is a unique key); there is
  simply no `PUT /closures/bulk` yet. Deliberate trade-off: get the single-day
  path (including the booking-cancellation side effects) exactly right first.
- **The closure-day cancellation sweep caps at 200 rows.** Above that the
  response carries `sweepComplete: false` and you save again. A shop with more
  than 200 bookings in a day will not happen in Phase 1, but this is a **known
  boundary**, not something that "just won't happen".
- **`menu_item_daily_stock.sold` is always 0.** Ordering increments `held`, and
  completion does **not** move it to `sold`. The daily cap is still correct
  (`quota − sold − held`, and `held` keeps holding the slot), so accepting orders
  behaves correctly, but `sold` cannot be used for sales reporting. Fixing it
  means adding a `CONVERT_HOLD_TO_SOLD` side effect to the state machine — a
  change to the transition table, left for the owner to decide.
- **`releaseDailyQuota` only decrements `held`**; it does not distinguish
  "released" from "consumed". Cancellation / expiry / rejection release;
  completion consumes, and both land in the same column today.
- **`menu_item_daily_stock` is seeded once per service day**
  (`INSERT ... ON CONFLICT DO NOTHING`) and never re-synced. Changing a quota
  mid-day therefore has to be pushed into that stock row explicitly, or the
  remaining count the customer sees will not move.
- **The merchant console's today figures are computed from the last 200 orders**,
  not a SQL aggregate — a day with more than 200 orders is under-counted, and the
  page says so. The admin dashboard is the one with the real aggregation.
- **Redis-absent paths are unverified**: idempotency-key replay protection, actual
  outbox delivery, and WebSocket fan-out have never run here (no Redis installed).
  The code paths are written and degrade gracefully, but not proven by real delivery.
- **The frontend has no browser test.** SSR routes and per-page HTTP responses are
  verified and the type contract is compared field by field, but no real browser
  has driven it (Playwright needs a browser binary; costly in this sandbox).
  Interactive flows (cart, polling, modals, the refund request dialog, take-a-number,
  scan-to-order) are guaranteed only at the type and build level.
  **Reservations, refund tickets, waitlist and dine-in all poll rather than use
  WebSocket** — this app does not install `socket.io-client`. The backend rooms
  `order:{id}` / `reservation:{id}` / `refund_request:{id}` / `waitlist:{id}` /
  `dining:{id}` / `merchant:{id}` are implemented and registered at boot, but no
  client is connected.
- **The narrow-screen layouts of `/m/[slug]/queue` and `/dine/table/[qrToken]`
  are not automatically verified.** These two pages are **phone-first**（手機專用）,
  not desktop-shrunk, but "reachable with one thumb, readable in one screen" is
  currently an intention, not a measurement. This is the largest unverified surface.
- **The six business lines have no combined schedule view.** Today a merchant
  looks in four places: the kitchen board (pickup), the reservation book, the host
  board and the table board. All four have data, but no "the whole shop today"
  screen lays them out together. Intentional — get each line correct before merging.
- **Waitlist and dine-in have no notification channel.** Same gap as refund
  tickets: status changes write outbox events, push to rooms, and are visible by
  polling — but there is no email / SMS / push. **Calling a guest（叫號）** needs
  this most; today it relies on the guest watching their own phone.
- **No year-over-year comparison in reports.** `COMPARISON` compares the
  **previous equal-length window**, not the same month last year. Cross-year
  comparison has to handle the lunar calendar and year offsets; it is not the
  same thing.
- **`analyticsTier` has no billing record.** Tier changes are audited, but there
  is no invoice or subscription model — "charging extra" is currently a manual
  platform setting, not an automated billing flow.
- **Refund tickets track neither "read" nor assignment.** A queue worked by one
  person needs neither, and both would require a read-receipt model the platform
  has no use for. Revisit if it ever becomes a multi-agent support desk.
- **The `RESOLVED_OFFLINE` amount and proof are an *assertion*, not a settlement
  record.** The platform is not on the money path and cannot verify it, so the UI
  must show "the merchant says this was handled offline", never "refunded". Any
  code that feeds `settledAmountMinor` into reconciliation is wrong — it cannot
  match the platform's own books, because the platform never moved that money.
- **`next build` cannot complete inside the sandbox.** Besides the known
  `.next/trace` EPERM, there is a second `safe-delete` obstacle: Next deletes
  50+ existing files under `apps/web/.next` within a single turn, which trips
  `SAFE_DELETE_BULK_CONFIRM_REQUIRED` and aborts. Emptying `.next` gets past the
  first hurdle (leaving `EPERM`), but any leftover `.next/types/**` fails the
  second. Outside the sandbox, `rm -rf apps/web/.next` first and it passes.
  `npm run typecheck` covers `apps/web` fully, so `web` type errors are always
  visible in the sandbox; only Next's own bundling and route generation are affected.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layered architecture, bounded contexts, data flow, concurrency and idempotency strategy, Phase-2 checklist |
| [`docs/API.md`](docs/API.md) | REST specification, error-code table, WebSocket events |
| [`docs/CHANGES.md`](docs/CHANGES.md) | Design decisions per round, defects found and lessons, verification results |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | M0–M3 delivery order, acceptance criteria, deliberate technical debt |

---

## Phase 2 — plugging in fleet dispatch（階段二：車隊派單）

The interface is settled and `FleetDispatchService` is implemented and tested
(against an in-memory fake; no Redis needed).

```ts
// apps/api/src/modules/dispatch/dispatch.module.ts
useFactory: (idGenerator) => new SelfPickupDispatchService(idGenerator)
//                            ^ swap this for FleetDispatchService
```

**Criterion**: if a Phase-2 PR needs to touch `packages/domain/src/order/` or
`pricing/`, the boundary was drawn in the wrong place.

---

## Environment Notes

**Read before writing SQL: Prisma field names are camelCase**

Prisma only converts **table** names to snake_case (`@@map`); **columns** without
`@map` go into the database verbatim, and the schema uses camelCase. So
hand-written SQL must quote them:

```sql
-- correct
INSERT INTO menu_item_daily_stock (id, "menuItemId", "serviceDate", ...)
-- wrong (builds fine, explodes at runtime)
INSERT INTO menu_item_daily_stock (id, menu_item_id, service_date, ...)
```

The full field-name mapping table is at the top of `prisma/sql/post-init.sql`.

**Other traps already hit**

- **`npm install` needs `--ignore-scripts` under the Windows sandbox**: esbuild's
  postinstall spawns a child process that gets blocked (`EBUSY`). esbuild's binary
  comes from an optional dependency, so skipping postinstall changes nothing.
- **vitest uses `pool: 'threads'`**: the default `forks` pool writes modules into
  `os.tmpdir()`, hitting `EPERM` on restricted hosts — and the whole test **file**
  silently disappears (4 → 2 → 1). Now set in `vitest.config.ts`.
- **`nest build` needs `deleteOutDir: false`**: the sandbox blocks it from
  clearing `dist/` (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`).
- **Local Postgres must be started with `-p 5433`**: `.pgdata`'s
  `postgresql.conf` says 5432, but `DATABASE_URL` points at 5433. Starting with
  `postgres -D .pgdata` silently listens on 5432, `pg_isready -p 5433` reports
  `no response`, and the API only fails at boot with `P1001 Can't reach database
  server`. Correct command: `postgres -D .pgdata -p 5433`.
- **Postgres started via `pg_ctl start` dies with the shell**: in this
  environment run `postgres` in the foreground as a managed background task so
  the pid file is correct. If a previous run was killed, remove
  `.pgdata/postmaster.pid` first (after confirming the PID is really gone).
- **NestJS DI errors only appear at boot**: `nest build` does not complain at all
  about "a module injects a token someone exports but never `imports`"; it blows
  up at `app.listen()`. Always actually boot after changing module wiring.
- **Do not let Redis block boot**: `app.listen()` waits for every `onModuleInit`
  to settle. If you `await` a Redis command in `onModuleInit` while ioredis's
  offline queue is enabled, that promise **never settles** when Redis is down and
  the HTTP server never binds. Every Redis client sets
  `enableOfflineQueue: false` (fail fast), and the WebSocket subscription is not awaited.
- **`class-transformer` stuffs every key of the request body/query onto the DTO
  instance**: if a DTO has a getter-only property and a client guesses that name
  (e.g. `?take=5`), you get `Cannot set property take of #<Dto> which has only a
  getter` — a 500. Keep only decorated data fields on DTOs and compute derived
  values with free functions (see `paginate()` in `common/validation/query.ts`).
- **Prisma cannot index `Unsupported("geography")`**: the GIST / GIN indexes and
  the `location` sync trigger live in `prisma/sql/post-init.sql`, and are only
  created if the server actually has PostGIS; without it, they fall back to a
  (latitude, longitude) btree index.

---

## Contributing

### Workflow

```bash
# 1. Branch
git switch -c feat/<scope>-<what>      # or fix/、docs/、refactor/

# 2. Fast checks first
npm test                 # 285 domain unit tests, milliseconds, no database
npm run typecheck        # all three workspaces

# 3. Touched an API view or a frontend type — required
npm run check:contract   # the criterion is "0 failures", not a number

# 4. Touched pricing — required
npm run check:pricing

# 5. Touched anything that creates orders — boot the API and run everything
node apps/api/dist/main.js &
npm run e2e:all          # thirteen scripts, sequential (one shared database)
```

**Every e2e script must pass twice in a row.** A test that only passes on a clean
database is a test that will fail in CI. Likewise, a new e2e must **clean up
after itself**, and its cleanup must be **run-scoped by id** (remember which ids
you created and delete only those) — never attribute-based, which deletes other
scripts' data.

### Commit messages

```
<type>(<scope>): <one-line summary>

<why the change, not what changed>

<optional: blast radius / trade-offs the owner should decide>
```

`type` is one of `feat` / `fix` / `docs` / `refactor` / `test` / `chore`.
`scope` is a workspace or module name (`domain` / `api` / `web` / `waitlist` / `dining` …).

> **Before committing, confirm `.env`, `.pgdata/` and `.next/` are not staged.**
> All three are in `.gitignore`, but `git add -f` or new paths can still slip them in.

### Non-negotiable architecture rules

These are not style preferences; breaking them invalidates the whole testing strategy:

1. **`packages/domain` has zero runtime dependencies.** No framework, ORM, HTTP or
   `process.env` imports. This is the only reason pricing and the six state
   machines are testable in milliseconds.
2. **Money is always integer minor units.** Never store a balance as a float.
3. **Transitions go through the state machine only.** No
   `if (order.status === ...)` to decide authorization anywhere — ask
   `OrderStateMachine`. Frontend buttons are drawn from `allowedNextTransitions`,
   never hand-written.
4. **`packages/domain` is CommonJS** (`module: CommonJS`, no `"type": "module"`).
   Switching to ESM breaks NestJS's `require()`.
5. **Cross-context communication goes through domain events (outbox) only** — never
   call another context's repository directly.
6. **The frontend is not an authorization boundary.** `useRequireRole` only
   redirects; the real check is in the API (`JwtAuthGuard` → `RolesGuard` →
   `MerchantScopeGuard`). Any route relying on a frontend guard to protect data
   is a route that leaks.
7. **Declared `sideEffects` must be implemented.** A side effect the state machine
   returns but the application layer ignores is silent data loss
   (`RECORD_PAYOUT_LEDGER` was once missed, leaving reconciliation permanently unbalanced).
8. **Never `await` a network call in `onModuleInit`.** `app.listen()` waits for every
   init hook to settle; with Redis down that promise never settles and the port
   never binds.

### Checklist for adding a feature

- [ ] Domain first (pure functions / state machine) + unit tests, **no** IO
- [ ] The state machine has a `TRANSITIONS` table, `transition()`,
      `allowedTransitions()` and `can()`
- [ ] The API has a dedicated **view interface**, deliberately different for
      customer and merchant (see [Three Frontend Entry Points](#three-frontend-entry-points))
- [ ] `apps/web/src/lib/types.ts` mirrors that view by hand
- [ ] `scripts/contract-check.js` gains a shape check for that view
- [ ] A `scripts/e2e-*.js`, wired into `npm run e2e:all`
- [ ] `docs/CHANGES.md` records the design decisions and any defects found

### Read before writing SQL

Prisma converts only **table** names to snake_case (`@@map`); **columns** without
`@map` go in verbatim. The schema is camelCase, so hand-written SQL **must quote**
column names:

```sql
-- correct
INSERT INTO menu_item_daily_stock (id, "menuItemId", "serviceDate", ...)
-- wrong: the build will not catch it, runtime will
INSERT INTO menu_item_daily_stock (id, menu_item_id, service_date, ...)
```

The full mapping table is at the top of `prisma/sql/post-init.sql`.

### Trade-offs the owner should decide

These are not bugs — they are deliberate, but check before changing them:

- `menu_item_daily_stock.sold` is always 0 (completion does not move `held` to
  `sold`). Fixing it means a `CONVERT_HOLD_TO_SOLD` side effect — that touches the
  transition table.
- Refund tickets have **no** `REFUNDED` status and no money side effects. By design.
- Closure days have no bulk interface; one day per call. The single-day path is
  correct first.
- The report's `COMPARISON` compares the **previous equal-length window**, not the
  same period last year.

### Reporting issues

When opening an issue, include: reproduction steps, the API route and response
code, and the output of `npm test` plus the relevant e2e script. If you suspect a
data problem, include `npm run check:pricing` and `npm run check:contract` results.

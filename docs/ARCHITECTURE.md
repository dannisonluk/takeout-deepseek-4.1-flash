# 系統架構設計 — 外賣自取平台

> Phase 1 目標：純自取（Self-Pickup）MVP。
> Phase 2 預留：車隊管理、即時追蹤、動態派單。
> 全文以 **Clean Architecture + DDD** 為準則，重點是讓 Phase 2 的接入是「插線」而不是「重寫」。

---

## 1. 技術選型與理由

| 層 | 選型 | 為什麼是它 |
|---|---|---|
| Backend | **NestJS (TypeScript)** | 你明確要求 `PricingEngine` / `OrderStateMachine` / `IDispatchService` 三個模組解耦且可單元測試。NestJS 的 DI container + module 邊界天然對應 DDD 的分層，`interface` + `InjectionToken` 讓「換實作」是一個 provider 註冊的差異。FastAPI 也可行，但 Python 的 Protocol 在 DI 上沒有 NestJS 這麼結構化。 |
| DB | **PostgreSQL 16 + PostGIS** | 交易一致性（下單扣配額）需要 ACID；Phase 2 的 `geography(Point,4326)` 需要 PostGIS。 |
| Cache / Realtime | **Redis 7** | 三個獨立用途：① 熱門菜單快取 ② 分散式鎖（每日配額）③ Phase 2 的 `GEOADD`/`GEOSEARCH` 車手位置。 |
| ORM | **Prisma** | Migration 可讀、型別由 schema 生成；`Unsupported("geography(...)")` 讓我們保留 PostGIS 欄位。 |
| 圖片 | **Cloudflare R2** | S3-compatible、無 egress fee。DB 只存 object key，永不存 public URL。 |
| Frontend | **Next.js 15 (App Router) + 手寫 CSS design tokens** | 三個入口（顧客／商戶／平台）同一 codebase、不同 route group 與 shell；SEO 對「附近餐廳」有價值，所以 `/m/:slug` 走 SSR，其餘走 CSR。**刻意不用 Tailwind**：v4 會多帶一個 oxide native binary，而這個環境的 npm install 已經要靠 `--ignore-scripts` 才過；而且三個 portal 由三個人各挑 utility class 正是設計會走樣的成因。所有顏色、圓角、間距都是 `globals.css` 裡的命名 token，改一處三個入口一起改。 |
| 支付 | **Provider 抽象層** | `IPaymentProvider` 介面 + Stripe / PayMe / Octopus / FPS-QR adapter。香港市場不能只綁一家。 |

### 為什麼金額一律用 integer minor units
`Money` 是 value object，內部存 `minor`（分）。HK$3.50 → `350`。
浮點數在帳務系統是 bug 製造機：`0.1 + 0.2 !== 0.3`。所有運算走整數，百分比用 **basis points**（340 = 3.40%）配整數中間值，只在最後一步 `roundHalfAwayFromZero`。

---

## 2. 分層架構

```
┌──────────────────────────────────────────────────────────────┐
│  Interface Layer          HTTP controllers / WS gateways /    │
│  (apps/api/src/interface) DTO + validation (class-validator)  │
├──────────────────────────────────────────────────────────────┤
│  Application Layer        Use cases (orchestration)           │
│  (apps/api/src/application)  PlaceOrder / AcceptOrder / ...   │
│                            Transaction boundary lives HERE    │
├──────────────────────────────────────────────────────────────┤
│  Domain Layer             ★ packages/domain — zero deps       │
│                            PricingEngine                      │
│                            OrderStateMachine                  │
│                            IDispatchService                   │
│                            Money / GeoPoint / DomainError     │
├──────────────────────────────────────────────────────────────┤
│  Infrastructure Layer     Prisma repositories / Redis /       │
│  (apps/api/src/infrastructure) R2 / PSP adapters / outbox     │
└──────────────────────────────────────────────────────────────┘
        ▲ dependency direction: 外層依賴內層，內層不知道外層存在
```

**鐵律：`packages/domain` 不 import 任何框架、ORM、HTTP library、`process.env`。**
這就是為什麼 61 個領域層測試可以在毫秒級跑完，完全不需要資料庫或網路。
這條界線同時是計費可審計性的基礎：`PricingEngine` 是純函式，同一組輸入永遠得到同一組輸出。

---

## 3. Bounded Contexts

| Context | 職責 | 主要 Aggregate |
|---|---|---|
| **Identity** | 帳號、角色、登入 | `User` |
| **Merchant** | 商戶資料、營業時間、菜單、每日配額、接單開關 | `Merchant`, `MenuItem` |
| **Ordering** | 購物車、下單、生命週期、狀態稽核 | `Order` (root), `OrderItem` |
| **Pricing** | 平台費、支付手續費、商戶結算 | 純函式，無持久化狀態 |
| **Payment** | 支付、退款、結算批次 | `Payment`, `MerchantPayout` |
| **Fulfilment** | 自取 / 派單 / 車隊（Phase 2） | `DeliveryTask`（Phase 2） |

跨 context 只透過 **domain event**（outbox）溝通，不直接呼叫對方的 repository。

---

## 4. 核心資料流

### 4.1 下單（Place Order）

```
Customer        API              PricingEngine      DB (tx)          Outbox
   │             │                    │               │                │
   ├─ POST /orders ──▶                │               │                │
   │             ├─ 驗證菜單/配額 ──────────────────▶ │                │
   │             ├─ price(lines) ────▶ │               │                │
   │             │                    ├─ 回傳 breakdown│                │
   │             │◀───────────────────┘               │                │
   │             ├─ BEGIN ────────────────────────────▶│                │
   │             │   INSERT order + order_items        │                │
   │             │   UPDATE daily_stock held += n      │                │
   │             │   INSERT outbox(order.placed) ──────────────────────▶│
   │             ├─ COMMIT ───────────────────────────▶│                │
   │◀─ 201 { orderNo, total, pricingSnapshot } ────────┤                │
```

關鍵點：
1. **`PricingEngine` 在 transaction 之外先算**，但算出的 `PricingSnapshot` 與 order 同一個 transaction 寫入。價格不會在下單與付款之間被改動。
2. **`held`（soft hold）** 在 `PENDING_PAYMENT` 階段先佔配額，避免超賣。逾時未付 → 釋放。
3. **Outbox 與 order 同 transaction**。這是「訂單寫入了但通知丟了」的根治方案。

### 4.2 支付與接單

```
PSP webhook ──▶ PaymentService
                  ├─ 冪等檢查（idempotencyKey / (provider, providerRef) unique）
                  ├─ UPDATE payment status = CAPTURED
                  ├─ OrderStateMachine.transition(PENDING_PAYMENT → PAID)
                  ├─ 套用 sideEffects:
                  │    NOTIFY_MERCHANT_NEW_ORDER      → outbox
                  │    SCHEDULE_MERCHANT_ACCEPT_TIMEOUT → Redis delayed job
                  └─ 計算 acceptDeadlineAt = now + merchant.acceptTimeoutMinutes
```

### 4.3 狀態變更 → 即時推送

```
Order update (tx)
   └─ outbox_events(PENDING)
          │  relay worker（SELECT ... FOR UPDATE SKIP LOCKED）
          ▼
      Redis Stream  ──▶  WebSocket Gateway
                            ├─ room `merchant:{id}` → 廚房看板
                            └─ room `order:{id}`    → 顧客追蹤頁
```

Relay 用 `FOR UPDATE SKIP LOCKED`，所以可以水平開多個 worker 而不會重複投遞。
`version` 欄位讓 consumer 偵測亂序，前端可丟棄過期事件。

### 4.4 每日配額與併發

`MenuItemDailyStock` 每（菜品 × 服務日）一列，欄位 `quota / sold / held`。
扣減用條件式 UPDATE，不靠應用層鎖：

```sql
UPDATE menu_item_daily_stock
   SET held = held + $1, "updatedAt" = now()
 WHERE "menuItemId" = $2::uuid
   AND "serviceDate" = $3::date
   AND (quota = 0 OR sold + held + $1 <= quota);
-- affected rows = 0  →  售罄，回 409
```

> **欄位名是 camelCase 且必須加引號。** Prisma 只把表名轉 snake_case（`@@map`）；
> 沒有 `@map` 的欄位原樣進資料庫，而 schema 用 camelCase 欄位名。寫成
> `menu_item_id` / `service_date` 不會在 build 時報錯，只會在執行期炸。

`quota = 0` 代表不限量。這個寫法在 READ COMMITTED 下即安全，不需要 advisory lock。

**已知缺口：`sold` 永遠是 0。** 下單把單位記進 `held`，但訂單完成時沒有把它轉記到
`sold`——`RELEASE_DAILY_QUOTA` 只在取消 / 過期 / 拒單時觸發，完成不在其中。
每日上限仍然正確（`held` 一直佔著額度，`quota − sold − held` 會如預期遞減），
但 `sold` 不能用於銷量報表。修法是補一個 `CONVERT_HOLD_TO_SOLD` side effect——
那會動到 transition table，屬於設計決定，尚未實作。

---

## 5. 計費引擎（PricingEngine）

### 業務公式

```
Platform_Fee      = Count(Ordered_Main_Items) × feePerMainItem   // 預設 HK$3.50
Merchant_Payout   = Subtotal − Platform_Fee − Payment_Processing_Fee
Total (customer)  = Subtotal + Customer_Service_Fee              // MVP: 0
```

### 設計決策

| 決策 | 理由 |
|---|---|
| **`isMainItem` 旗標放在 `MenuItem`** | 「主餐」是菜單資料，不是 runtime 判斷。加配菜/飲品不計費。 |
| **按 `quantity` 累加，不是按 line 數** | 3 × 招牌飯 = 3 件主餐 = HK$10.50。這是唯一合理的解讀。 |
| **`countAddOnItems` 可開關** | 若日後改成「所有品項都收費」，改一個 flag。 |
| **`feePerMainItemMinor` 三層解析** | `PlatformConfig` 表 → 環境變數 → 程式碼預設。改價不用重新部署。 |
| **`minimumPayoutMinor` 觸發 exception，不 clamp** | 一單 HK$4.00 的外賣：350 + 249 = 599 > 400，商戶倒蝕。默默 clamp 成 0 會讓虧損單無聲流入帳務。丟 `NegativeMerchantPayoutError` 讓它變成可見的設定問題。 |
| **`PricingSnapshot` 凍結入庫** | 日後改價不能改寫歷史帳。 |

### 可配置參數

| 參數 | 預設 | 位置 |
|---|---|---|
| `feePerMainItemMinor` | `350` (HK$3.50) | `platform_config.pricing.platform_fee_per_main_item_minor` |
| `paymentFeeRateBps` | `340` (3.40%) | `platform_config.pricing.payment_fee_rate_bps` |
| `paymentFeeFixedMinor` | `235` (HK$2.35) | `platform_config.pricing.payment_fee_fixed_minor` |
| `countAddOnItems` | `false` | `platform_config.pricing.count_add_on_items` |
| `customerServiceFeeMinor` | `0` | `platform_config.pricing.customer_service_fee_minor` |
| `minimumPayoutMinor` | `0` | `platform_config.pricing.minimum_payout_minor` |

---

## 6. 訂單狀態機（OrderStateMachine）

```
PENDING_PAYMENT ──▶ PAID ──▶ ACCEPTED ──▶ PREPARING ──▶ READY_FOR_PICKUP ──▶ COMPLETED
       │              │          │             │                 │
       │              ├──▶ REJECTED ──────────┴────▶ REFUNDED ◀──┘
       ├──▶ EXPIRED   ├──▶ EXPIRED
       └──▶ CANCELLED ├──▶ CANCELLED ──▶ REFUNDED
```

三個刻意的設計：

1. **`REJECTED` 不是終態。** 已付款的訂單被拒，一定要走 `REFUNDED` 才能關閉。把退款變成狀態圖的必經之路，就不會有人忘記退。
2. **授權寫在 transition table，不寫在 service。**
   `CUSTOMER` 可以取消 `PAID`/`ACCEPTED`，但 `PREPARING` 之後不行（廚房已落料）。
   這條規則只有一個地方定義，`allowedTransitions()` 直接餵給商戶端 UI 決定顯示哪些按鈕。
3. **Side effect 是 transition 的回傳值，不是隱藏副作用。**
   `PAID → ACCEPTED` 回傳 `[CANCEL_MERCHANT_ACCEPT_TIMEOUT, NOTIFY_CUSTOMER_STATUS, DISPATCH_RIDER]`。
   Domain 說「必須做什麼」，application 層決定「怎麼做」。`DISPATCH_RIDER` 在 Phase 1 接到 `SelfPickupDispatchService`，是一個 no-op——所以 Phase 2 不需要改狀態機。

`transition()` 永遠丟 exception，不返回 sentinel 值。呼叫者不可能忘記檢查回傳值。

---

## 7. 派單設計（Phase 2 擴充）

### 現在就有的是介面

```ts
interface IDispatchService {
  readonly mode: FulfilmentMode;
  supports(request: DispatchRequest): boolean;
  dispatch(request: DispatchRequest, ctx: DispatchContext): Promise<DispatchAssignment>;
  cancel(taskId: string, reason: string): Promise<void>;
}
```

- `SelfPickupDispatchService` — Phase 1 實作。回傳一張「取餐票」，`riderId` 為 `undefined`，ETA 用商戶的 `prepTimeMinutes`。
- `FleetDispatchService` — Phase 2 參考實作，**已經寫好並通過測試**（用 in-memory fake，不需要 Redis）。

### 派單演算法

`DispatchScoringEngine` 是純函式，零 I/O：

```
score = w_distance · (1 − d/radius)
      + w_load     · (1 − active/max)
      + w_idle     · min(idle/cap, 1)
      + w_reliability · acceptanceRate

權重預設：distance 0.55 / load 0.25 / idle 0.10 / reliability 0.10
ETA = d / vehicleSpeed × 60 + handoverBuffer + activeTaskCount × loadPenalty
```

三個特性：
- **確定性**：同分時依 ETA、再依 `riderId` 排序。同一個輸入永遠選同一個車手，可重放、可測試。
- **可調**：權重是建構子參數。每個城市、每個時段可以不同。
- **可換**：Phase 3 換 ML ranker，只換這一個 class。

`idle` 維度的作用是防止「熱門車手被連續派單、新上線車手餓死」。

### 定位存儲

| 資料 | 存哪 | 指令 |
|---|---|---|
| 車手當前位置 | Redis | `GEOADD riders:geo <lng> <lat> <riderId>` |
| 附近查詢 | Redis | `GEOSEARCH FROMMEMBER ... BYRADIUS 3 km ASC COUNT 20` |
| 歷史軌跡 | Redis Stream（capped） | 每車手一條，TTL 24h |
| 車手檔案 / 任務 | Postgres | `driver_profiles`, `delivery_tasks` |

PostGIS 的 `merchants.location` 用於「附近的餐廳」查詢（顧客端），與車手定位是兩個獨立問題。

---

## 8. 橫切關注點

### 冪等性（Idempotency）
| 場景 | 機制 |
|---|---|
| 建立訂單 | Client 帶 `Idempotency-Key` header，Redis `SETNX` 24h |
| 支付 webhook | `payments.idempotencyKey` unique + `(provider, providerRef)` unique |
| Outbox relay | `outbox_events.id` 為 consumer 的去重鍵 |
| 派單 | `delivery_tasks.order_id` unique |

### 併發
- 配額扣減：條件式 UPDATE（見 4.4）。
- Outbox relay：`FOR UPDATE SKIP LOCKED`。
- 訂單狀態變更：`UPDATE orders SET status = $new WHERE id = $id AND status = $expected`，比對 affected rows，樂觀鎖。狀態機已保證 `expected` 合法。

### 時區
所有 timestamp 存 `timestamptz`，業務邏輯跑 UTC。**服務日（`service_date`）用商戶的 `timezone` 計算**，不是伺服器時區。
凌晨 00:30 的訂單在 `Asia/Hong_Kong` 屬於當天，但 UTC 還是前一天——這是最容易錯的地方。

### 可觀測性
- 每個 request 帶 `X-Request-Id`，貫穿 log / outbox / PSP 呼叫。
- 關鍵 business metric：`order_placed_total`、`order_accept_latency_seconds`、`platform_fee_collected_minor`、`dispatch_no_rider_total`。
- 對帳：每日跑 `SUM(orders.platform_fee_minor) vs SUM(payout_lines.platform_fee_minor)`，不一致就報警。

---

## 9. 前端架構（三個入口，一個 codebase）

```
apps/web/src/
├── app/
│   ├── (customer)  /  /m/[slug]  /checkout  /orders  /orders/[id]  /account  /login  /merchant-apply
│   ├── merchant/   layout.tsx 守 MERCHANT_OWNER|MERCHANT_STAFF
│   │               /merchant  /merchant/orders  /merchant/menu  /merchant/settings
│   └── admin/      layout.tsx 守 ADMIN
│                   /admin  /admin/orders  /admin/merchants  /admin/finance
│                   /admin/config  /admin/users  /admin/ops
├── components/     ui.tsx（design system）、app-shell、merchant-shell、admin-shell、customer-nav
└── lib/            api.ts（transport + token）、auth.tsx、merchant.tsx、types.ts、format.ts、cart.ts、use-async.ts
```

### 三個入口的差異是有理由的，不是三份複製品

| 入口 | 裝置姿態 | 因此 |
|---|---|---|
| 顧客 | 手機、單手、在街上 | 頂部導覽而非側邊欄；購物車放 `sessionStorage`（一個商戶一個籃）；`/m/:slug` 是唯一 SSR 路由（分享連結要有 metadata） |
| 商戶 | 廚房平板、光線暗、長時間 | 側邊欄 + 廚房板；15 秒輪詢；接單倒數每秒重繪 |
| 平台 | 桌面、長 session、高資料密度 | 同一套 shell；所有破壞性操作強制填原因並寫稽核 |

### 授權邊界在 API，不在前端

`useRequireRole` 只決定「要不要畫這個 shell」，並且把無權者導向 `homeFor(role)` 而不是死路。
每個 `/v1/merchant/:merchantId/*` 與 `/v1/admin/*` 都會在伺服器端重新驗 token 與角色。
**依賴前端 guard 保護資料的路由，就是一條會洩漏的路由。**

### 兩個前端專屬的失敗模式

**單飛 refresh（single-flight）**。access token 只存在模組變數，refresh token 才進
`localStorage`。一個頁面同時發六個請求而 token 過期時，若沒有共用同一個 refresh promise，
就會觸發六次 refresh；而 API 每次輪替 refresh token 並在偵測重用時撤銷整條鏈，
於是其中五次會失敗**並殺掉 session** —— 使用者只是載入一個 dashboard 就被登出。

**型別是手寫鏡像**。`lib/types.ts` 不從 API 產生，因為產生器會很樂意為不該曝露的欄位生出型別。
代價是欄位改名不會有編譯錯誤（前端自己的型別是自洽的），所以有
`npm run check:contract` 逐欄雙向比對。這條檢查抓到過
`pricingSnapshot.paymentFeeMinor` —— 一個宣告成 optional、API 從未回傳、執行期永遠是
`undefined` 的欄位。

---

## 10. 目錄結構

```
takeout/
├── packages/
│   └── domain/                 ★ 純領域層，零 runtime 依賴，61 個單元測試
│       ├── src/shared/         Money, GeoPoint, Clock, IdGenerator, DomainError
│       ├── src/pricing/        PricingEngine, PricingPolicy
│       ├── src/order/          OrderStateMachine, OrderStatus, events
│       ├── src/dispatch/       IDispatchService, SelfPickup, Fleet, ScoringEngine
│       ├── src/fleet/          Phase 2 ports（registry / geo / tasks）
│       └── tests/
├── apps/
│   ├── api/                    NestJS — interface / application / infrastructure
│   │   └── src/modules/        auth / ordering / pricing / payment / merchants
│   │                           admin / dispatch / realtime / media
│   └── web/                    Next.js — 三個入口（見 §9）
├── prisma/
│   ├── schema.prisma           22 個 model、索引、外鍵、PostGIS、Phase 2 表
│   ├── sql/post-init.sql       索引、trgm、平台費種子、對帳 view（含欄位名對照表）
│   └── seed.js                 冪等示範資料：3 身份 / 1 商戶 / 5 菜式 / 7 日營業時間
├── scripts/
│   ├── e2e-smoke.js            48 個端到端檢查
│   ├── e2e-admin.js            79 個管理台檢查
│   ├── contract-check.js       前端型別 vs API 實際欄位
│   └── check-pricing-config.js engine 實收平台費 vs platform_config
├── docs/
│   ├── ARCHITECTURE.md         本文件
│   ├── API.md                  RESTful 規格
│   └── ROADMAP.md              交付順序
└── docker-compose.yml          Postgres+PostGIS / Redis
```

---

## 11. Phase 2 接入清單

| 要做的事 | 改哪裡 | 不改哪裡 |
|---|---|---|
| 啟用車隊派單 | `DispatchModule` 換 provider → `FleetDispatchService` | 狀態機、Order module、Outbox |
| 車手 App | 新 `apps/rider` | — |
| 位置上報 | 實作 `IDriverLocationRepository`（Redis adapter） | `DispatchScoringEngine` |
| 即時追蹤 | 擴充 WS gateway 加 `rider:position` event | Outbox schema |
| 派單調參 | 建構子傳不同權重 | 演算法程式碼 |
| 商戶自有車隊 | 新增 `MerchantFleetDispatchService` 實作同一介面 | 上游全部 |

**判斷標準**：如果 Phase 2 的 PR 需要改 `packages/domain/src/order/` 或 `pricing/`，代表 Phase 1 的邊界畫錯了。

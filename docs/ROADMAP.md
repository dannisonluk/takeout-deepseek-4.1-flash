# 交付路線圖 — 外賣自取平台

原則：**先讓錢流正確，再讓體驗流暢。** 計費與狀態機是唯一不能事後補的東西，所以它們最先落地，而且先於任何 UI。

> 這份文件記錄的是**實際狀態**，不是計畫。勾選代表已經有對應的驗證（測試或指令），
> 不是「程式碼看起來寫好了」。

---

## M0 — 純領域層與骨架 ✅

| 項目 | 產出 | 驗證 |
|---|---|---|
| 純領域層 | `packages/domain` — Money / PricingEngine / OrderStateMachine / IDispatchService / DispatchScoringEngine | `npm test` → 61 個單元測試全綠 |
| 資料庫 Schema | `prisma/schema.prisma` — 22 個 model、索引、外鍵、PostGIS、Phase 2 表 | `npx prisma validate` |
| 手寫 SQL | `prisma/sql/post-init.sql` — GIST / trgm 索引、對帳 view、平台費種子 | 套用後 `check:pricing` 通過 |
| 架構文件 | `docs/ARCHITECTURE.md` / `docs/API.md` / `docs/ROADMAP.md` | — |
| API 骨架 | `apps/api` — NestJS，Clean Architecture 分層 | `npm run build` |

---

## M1 — 可下單的 MVP ✅

### M1.1 基礎設施 ✅

- [x] `docker-compose.yml`：Postgres + PostGIS + Redis
      （本機環境 docker 起不來，實際跑的是 `.pgdata` 裡的 PostgreSQL 17.2 @ 127.0.0.1:**5433**）
- [x] 第一個 migration
- [x] **手寫 SQL 補 PostGIS 索引**（Prisma 不支援 `Unsupported` 型別的索引）；
      沒有 PostGIS 時退回 (latitude, longitude) btree
- [x] `platform_config` seed：`pricing.platform_fee_per_main_item_minor = 350`
- [x] OTP 登入 + JWT + role guard（`JwtAuthGuard` → `RolesGuard` → `MerchantScopeGuard`）
      ＋ refresh token 輪替與重用偵測（重用即撤銷整條鏈）
- [x] `DomainExceptionFilter`：`DomainError.code` → HTTP status（見 `docs/API.md` 對照表）

### M1.2 商戶端 ✅

- [x] 商戶 CRUD + 營業時間（`PUT /hours` 整批覆寫）
- [x] 菜單 CRUD（分類、品項、`isMainItem`、`dailyQuota`、availability、批次重排）
- [x] 入駐申請（`POST /merchant/apply`，呼叫者提升為 owner 並建立 `merchant_staff` 列）
- [x] 接單 / 停單開關（`POST /intake`）
- [x] 廚房看板 + 五個具名動作，全部走同一個狀態機
- [x] R2 presign 兩段式上傳
- [ ] **`sharp` 產生 3 個尺寸 + blurhash** — 未做。presign 有了，但 `imageBlurhash` 欄位沒有東西寫入

### M1.3 顧客端 ✅

- [x] 附近餐廳查詢（PostGIS `ST_DWithin` + `pg_trgm` 搜尋 + 地區篩選）
- [x] 菜單瀏覽（含 `remainingToday`）
- [x] 取餐時段（`GET /merchants/:slug/pickup-slots`，商戶時區計算）
- [x] 購物車（前端 `sessionStorage`，一商戶一籃，不入庫）
- [x] 下單：一個 transaction 內完成
      `orders` + `orderItems` + `menuItemDailyStock.held` + `outboxEvents`
- [x] 訂單追蹤頁
- [ ] **前端用輪詢而非 WebSocket** — WS gateway 與 outbox 扇出已實作，
      但前端選擇 15 秒輪詢（本機沒有 Redis 可驗證扇出，輪詢是保底）

### M1.4 支付 ✅（一家）

- [x] `IPaymentProvider` 介面 + Stripe adapter（含 raw-body 簽名驗證）
- [x] `POST /orders/:orderId/payment-intent`（三層冪等）
- [x] Webhook 驗簽 + 冪等 + 狀態機推進
- [x] 退款路徑（`REJECTED` / `CANCELLED` → `REFUNDED`）
- [x] 模擬付款通道（`PAYMENT_LIVE_MODE=false` 時可用；live 時回 404）
- [ ] **PayMe / Octopus / FPS-QR adapter** — 介面已定，尚未實作

### M1.5 背景工作 ⚠️

- [x] Outbox relay（`FOR UPDATE SKIP LOCKED` → Redis → WS 扇出），含失敗重試與 dead letter
- [ ] **逾時掃描器** — 未做。`PENDING_PAYMENT` 超時 → `EXPIRED`、
      `PAID` 超 `acceptDeadlineAt` → `EXPIRED` + 退款，目前**沒有排程在跑**。
      資料模型與狀態機都已支援（`acceptDeadlineAt` 有寫入），缺的是那個 cron。
      這是 M1 最明顯的缺口：逾時單會一直停在原地等管理員手動處理。
- [ ] **每日配額 `held` 釋放排程** — 未做。釋放是事件驅動的（取消 / 拒單時同步遞減），
      但沒有「跨服務日的殘留 held 清理」。因為額度是按 `serviceDate` 分列，
      跨日不會污染新的一天，所以不急，但舊列會慢慢累積。

### M1 驗收標準

| # | 標準 | 狀態 |
|---|---|---|
| 1 | 顧客能下單、付款、看到「可取餐」 | ✅ 由 `e2e-smoke.js` 涵蓋 |
| 2 | 商戶能接單、標記完成，結算數字與 `PricingEngine` 完全一致 | ✅ 逐項斷言 fee 與 payout |
| 3 | 停單中的商戶無法接單（`MERCHANT_NOT_ACCEPTING_ORDERS`） | ✅ |
| 4 | 併發搶配額不超賣 | ✅ 單一原子 UPDATE；未做高併發壓測 |
| 5 | 支付 webhook 重放，訂單狀態只推進一次 | ✅ 冪等鍵 + `(provider, providerRef)` unique |

---

## M2 — 營運強化 ⚠️ 大部分完成

- [x] **結算批次產生器** — `RECORD_PAYOUT_LEDGER` 在 `READY_FOR_PICKUP → COMPLETED` 時
      寫入該商戶當週批次，並用 `v_daily_platform_fee_reconciliation` 比對
      `SUM(orders."platformFeeMinor")` vs `SUM(payout_lines."platformFeeMinor")`
- [x] **對帳報表** — `GET /admin/reconciliation`，逐商戶逐服務日，`totalDeltaMinor`
- [x] **撥款標記** — `mark-paid` / `mark-failed`（只記錄，不真的轉帳）
- [x] **管理後台** — 商戶審核 / 暫停 / 恢復 / 結業、強制退款、強制狀態轉換、
      平台設定線上調價、使用者與權限管理、outbox 與稽核
- [x] **商戶端營收儀表板** — `/merchant` 今日概況（注意：從最近 200 張訂單計算，非 SQL 聚合）
- [x] **稽核記錄** — 含 `before` / `after` diff，與觸發它的業務交易同一個 transaction
- [x] **OTP rate limiting** — `OTP_RATE_LIMITED` + `retryAfterSeconds`
- [ ] **顧客評價與評分** — `ratingAvg` / `ratingCount` 欄位已在，但沒有寫入路徑
- [ ] **搜尋排序權重**（距離 / 評分 / 準備時間）— 目前是距離優先
- [ ] **訂單取消政策引擎**（依時間窗決定退多少）— 目前是全額或不能取消
- [ ] **可觀測性**：OpenTelemetry trace + Prometheus metrics + 告警 —
      `/metrics` 端點未實作
- [ ] **`PlatformConfig` 版本歷史** — 只有 `updatedAt`，改價的歷史只留在稽核記錄裡

---

## M3 — 車隊與派單（Phase 2）

**前提**：`packages/domain/src/dispatch` 與 `fleet/ports.ts` 的介面已定案，
`FleetDispatchService` 已實作並通過 19 個單元測試（用 in-memory fake，不需要 Redis）。
這階段只寫 adapter。

- [ ] 車手 App（React Native / Flutter）：註冊、身份驗證上傳、上線/下線
- [ ] `RedisDriverLocationRepository`：`GEOADD` / `GEOSEARCH` + capped Stream 軌跡
- [ ] `PrismaDriverRegistry` / `PrismaDriverAssignmentRepository`
- [ ] `DispatchModule` 換 provider：`SelfPickupDispatchService` → `FleetDispatchService`
- [ ] 車手端推送（FCM / APNs）
- [ ] WebSocket 加 `rider.position`，顧客端地圖追蹤
- [ ] 派單權重調參（`DispatchScoringEngine` 建構子）
- [ ] 無車手 fallback：`NO_RIDER_AVAILABLE` → 自動降級為自取 + 通知顧客

### M3 驗收標準

1. **不需要改 `packages/domain/src/order/` 或 `pricing/` 任何一行。**
2. 派單決策可重放：同一組輸入永遠選同一個車手。
3. 車手離線 / 超載時自動排除，不會派單給不可用的人。

---

## 技術債與已知取捨（刻意留下，不是遺漏）

| 項目 | 現況 | 何時處理 |
|---|---|---|
| 購物車不入庫 | 前端 `sessionStorage`，只在 `POST /orders` 落地 | 需要跨裝置購物車時 |
| 單一 Postgres 實例 | 無讀寫分離 | 查詢壓力 > 3000 QPS |
| `Money` 用 `Int` | 單筆上限 HK$21.4M | 幾乎不會；`MerchantPayout` 已用 `BigInt` |
| `PlatformConfig` 無版本歷史 | 只有 `updatedAt`；改價歷史在 `auditLog` 裡可查但不結構化 | 需要獨立報表時加 `platform_config_history` |
| 派單是貪心演算法 | 非全域最優 | 訂單密度高時換匈牙利演算法或 ML ranker |
| 無多語系後端支援 | 商品名有 `name` / `nameEn` 兩欄；UI 文案直接寫在 TSX | 需要日文/簡體時改 i18n 表 |
| **`dailyStock.sold` 永遠是 0** | 完成時 `held` 沒轉記到 `sold`。每日上限仍正確（`held` 一直佔額度），但 `sold` 不能用於銷量報表 | 需要銷量報表時——要補 `CONVERT_HOLD_TO_SOLD` side effect，動到 transition table，屬設計決定 |
| `releaseDailyQuota` 不分釋放/消耗 | 取消與完成都落在 `held` 同一欄位 | 同上，與 `sold` 一起處理 |
| `menuItemDailyStock` 每個服務日只種一次 | `INSERT ... ON CONFLICT DO NOTHING`，之後不再同步。日中改配額必須明確推入 stock 那列 | 已在商戶端「改配額」路徑處理；但沒有通用的同步機制 |
| 商戶端今日數字是估算 | 從最近 200 張訂單加總，不是 SQL 聚合 | 單店日單量 > 200 時改為聚合端點 |
| 前端未經瀏覽器實測 | 20 條路由的 HTTP 回應與型別契約已驗證，但沒有跑真實瀏覽器 | 引入 Playwright 時 |
| 逾時掃描器缺席 | 見 M1.5 | **M1 上線前必補** |

---

## 開發指令

```bash
npm install --ignore-scripts  # 安裝所有 workspace 依賴（沙箱需要 --ignore-scripts）
npm test                      # domain 單元測試（61 個）
npm run typecheck             # 全 workspace 型別檢查
npm run build                 # 建置 domain → api → web
npm run db:seed               # 冪等示範資料（3 身份 / 1 商戶 / 5 菜式 / 7 日營業時間）

# 需要 API 正在跑
npm run e2e                   # 48 個端到端檢查
npm run e2e:admin             # 79 個管理台檢查
npm run check:pricing         # engine 實收平台費 vs platform_config
npm run check:contract        # 前端型別 vs API 實際回傳欄位

npm run infra:up              # 起 Postgres + PostGIS + Redis（需要 docker）
npx prisma migrate dev        # 建表
npx prisma studio             # 視覺化檢視資料
```

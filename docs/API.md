# API 規格 — 外賣自取平台

Base URL: `http://127.0.0.1:3000/v1`（本機）／`https://api.<domain>/v1`（正式）
所有 request / response 為 `application/json; charset=utf-8`。
**金額一律為 integer minor units**（HK$3.50 → `350`），欄位名以 `Minor` 結尾。
百分比一律為 basis points（3.40% → `340`），欄位名以 `Bps` 結尾。

> 本文件描述的是**已實作**的介面。任何與 `apps/api/src/modules/**/interface/*.controller.ts`
> 不符的地方，以程式碼為準。

---

## 1. 通用約定

### 認證

```
Authorization: Bearer <JWT>
```

Access token 15 分鐘，refresh token 30 天。JWT payload 帶 `sub`（userId）、`role`、
`merchantIds[]`。商戶端 endpoint 由 `MerchantScopeGuard` 驗證 `merchantIds` 是否包含路徑中的
`:merchantId`；平台端由 `RolesGuard` 驗證 `role === ADMIN`。

**角色存在 token 內，`JwtAuthGuard` 不查資料庫**（只驗簽名），所以改角色要等 token 輪替才生效。
管理台在改角色後會提示操作者撤銷該使用者的 session。

Refresh token 每次使用都輪替，且偵測重用：同一個 refresh token 被用第二次，整條鏈會被撤銷。

### 錯誤格式

```json
{
  "error": {
    "code": "PICKUP_TIME_NOT_FEASIBLE",
    "message": "取餐時間需晚於 12:15",
    "details": { "requestedAt": "2026-09-24T11:00:00.000Z", "earliestAt": "..." },
    "requestId": "req_01J8..."
  }
}
```

`code` 直接來自 domain 層的 `DomainError.code`。前端據此顯示文案，不需要解析 `message`。
`details.validation.message` 是陣列時，代表 `ValidationPipe` 的欄位級錯誤。

### Domain code → HTTP status 對照

對照表在 `apps/api/src/common/filters/domain-exception.filter.ts`，是**唯一**把業務碼轉成
status code 的地方。新 domain error 忘了登記不會靜默變成 500，會落到最後一行的預設值。

| HTTP | Domain codes |
|---|---|
| **400** | `VALIDATION_ERROR`、`EMPTY_ORDER`、`INVALID_QUANTITY`、`INVALID_UNIT_PRICE`、`MONEY_NOT_FINITE`、`MONEY_NON_INTEGER_MINOR`、`MONEY_CURRENCY_MISMATCH`、`UNKNOWN_PAYMENT_PROVIDER`、`CLOSURE_DATE_INVALID`、`REFUND_NOTE_REQUIRED`、`REFUND_AMOUNT_INVALID` |
| **401** | `UNAUTHENTICATED`、`INVALID_OTP`、`SESSION_EXPIRED`、`INVALID_WEBHOOK_SIGNATURE` |
| **403** | `FORBIDDEN`、`ACTOR_NOT_PERMITTED`、`ACCOUNT_DISABLED`、`SELF_MODIFICATION`、`PLATFORM_CONFIG_READONLY`、`REVIEW_NOT_OWNED`、`REVIEW_REPLY_NOT_ALLOWED` |
| **404** | `ORDER_NOT_FOUND`、`MERCHANT_NOT_FOUND`、`MENU_ITEM_NOT_FOUND`、`CATEGORY_NOT_FOUND`、`ADMIN_TARGET_NOT_FOUND`、`RESERVATION_NOT_FOUND`、`REVIEW_NOT_FOUND`、`IMAGE_ASSET_NOT_FOUND`、`CLOSURE_NOT_FOUND`、`REFUND_REQUEST_NOT_FOUND` |
| **409** | `ILLEGAL_ORDER_TRANSITION`、`ORDER_ALREADY_TERMINAL`、`PAYMENT_NOT_REQUIRED`、`MERCHANT_NOT_ACCEPTING_ORDERS`、`DAILY_QUOTA_EXHAUSTED`、`DUPLICATE_IDEMPOTENCY_KEY`、`MERCHANT_SLUG_TAKEN`、`CATEGORY_NAME_TAKEN`、`CATEGORY_IN_USE`、`MERCHANT_NOT_EDITABLE`、`MERCHANT_STATUS_TRANSITION`、`LAST_ADMIN`、`OUTBOX_NOT_RETRYABLE`、`PAYOUT_NOT_SETTLEABLE`、`MANUAL_SETTLEMENT_NOT_ALLOWED`、`RESERVATION_NOT_PERMITTED`、`RESERVATION_ALREADY_TERMINAL`、`RESERVATIONS_PAUSED`、`RESERVATION_OUTSIDE_TURN_WINDOW`、`REVIEW_ALREADY_EXISTS`、`IMAGE_ASSET_NOT_READY`、`REFUND_REQUEST_NOT_PERMITTED`、`REFUND_REQUEST_ALREADY_TERMINAL`、`REFUND_REQUEST_ALREADY_OPEN` |
| **422** | `NEGATIVE_MERCHANT_PAYOUT`、`REFUND_WITHOUT_PAYMENT`、`REFUND_NOT_AVAILABLE`、`REFUND_EXCEEDS_CAPTURE`、`UNSUPPORTED_FULFILMENT_MODE`、`PLATFORM_CONFIG_INVALID`、`OPERATING_HOURS_INVALID`、`CATEGORY_MISMATCH`、`PICKUP_TIME_NOT_FEASIBLE`、`MENU_ITEM_UNAVAILABLE`、`ORDER_NOT_REVIEWABLE`、`IMAGE_PROCESSING_FAILED`、`PAYMENT_RAIL_UNAVAILABLE`、`RESERVATIONS_DISABLED`、`PARTY_SIZE_NOT_ALLOWED`、`RESERVATION_TOO_SOON`、`RESERVATION_TOO_FAR_AHEAD`、`RESERVATION_SLOT_MISALIGNED`、`RESERVATION_SLOT_UNAVAILABLE`、`MERCHANT_CLOSED`、`CLOSURE_DATE_IN_PAST`、`REFUND_REQUEST_NOT_ALLOWED`、`REFUND_SETTLEMENT_DETAILS_REQUIRED` |
| **429** | `OTP_RATE_LIMITED`（帶 `details.retryAfterSeconds`） |
| **501** | `FULFILMENT_MODE_NOT_IMPLEMENTED`（Phase 2 未開放） |
| **502** | `PAYMENT_INTENT_FAILED`（上游拒絕，可重試或換支付通道） |
| **503** | `NO_RIDER_AVAILABLE`（Phase 2，暫時無車手）、`STORAGE_UNAVAILABLE`（物件儲存掛了，修好後重試）、`WEBHOOK_NOT_CONFIGURED` |
| **422** | 其他未登記的 `DomainError` — 預設保守，寧可 422 也不要誤報系統故障 |
| **500** | 非 `DomainError` 的例外，需告警 |

幾個刻意的區分：

- `PICKUP_TIME_NOT_FEASIBLE` 獨立於 `VALIDATION_ERROR`。共用時前端分不出「你的 JSON 壞了」
  與「這個取餐時間做不到」。
- `PAYMENT_NOT_REQUIRED` 是 409 不是 400 — 請求本身完全合法，只是訂單已經不在那個狀態。
- `LAST_ADMIN` 與 `SELF_MODIFICATION` 是兩件事：前者是「不能把最後一位管理員移除」，
  後者是「不能改自己」。
- `RESERVATIONS_DISABLED`（422）與 `RESERVATIONS_PAUSED`（409）也是兩件事：
  前者是這間店從來沒開過訂位，是設定的問題；後者是開過但當下暫停接受，
  過一會再試就好。前端據此決定要不要顯示「前往設定」。
- `IMAGE_PROCESSING_FAILED` 是 422 不是 400：請求完全合法，是**內容**不可用
  （sharp 讀不出的 bytes）。訊息會帶 sharp 自己的診斷，因為「上傳失敗」對商戶毫無幫助。
- `MERCHANT_CLOSED`（422）與 `RESERVATION_SLOT_UNAVAILABLE`（422）是兩個不同的答案：
  前者是「這家店當天休息」，後者是「這個時段剛被別人訂走」。前端要顯示的下一步完全不同
  （找別天 vs 換時段）。同理 `PICKUP_TIME_NOT_FEASIBLE` 在休息日與在非營業時間都會出現，
  但 `details` 裡會帶 `serviceDate`。
- `CLOSURE_DATE_INVALID`（400）與 `CLOSURE_DATE_IN_PAST`（422）刻意分開：
  前者是路徑參數根本不是一個日期（`not-a-date`、`2026-02-31`），後者是格式對但語意上不合法。
  混在一起會讓「我打錯字」看起來像「我被規則擋住」。
- `CLOSURE_NOT_FOUND`（404）只出現在 `GET`/`DELETE` 單一休息日。
  `GET .../closures` 列表在沒有休息日時回 `{ data: [] }`，不是 404 ——
  「這間店還沒設過休息日」是**內容**，不是錯誤。
- `REFUND_REQUEST_NOT_FOUND`（404）同時代表「沒有這張單」與「不是你的單」。
  後者**不可以**回 403：403 等於向陌生人確認這個 id 存在。訂單、訂位、
  評價都做同一個選擇。
- `REFUND_REQUEST_NOT_ALLOWED`（422）與 `REFUND_REQUEST_ALREADY_OPEN`（409）分開：
  前者是「這張訂單的狀態根本不該有退款工單」（例如還沒付款），
  後者是「狀態可以，但已經有一張開著的」。前端要顯示的下一步完全不同
  （不能提 vs 去看現有的那張）。
- `REFUND_SETTLEMENT_DETAILS_REQUIRED`（422）是刻意的：把工單標記為
  `RESOLVED_OFFLINE` 卻不寫金額也不寫參考，等於記下一筆空白的「已解決」，
  跟「我們甚麼都沒做就關掉」無法區分。金額與參考**至少一項**。
- `REFUND_REQUEST_NOT_PERMITTED`（409）與 `REFUND_REQUEST_ALREADY_TERMINAL`（409）
  是兩件事：前者是「這個移動不是你的身分可以做的」（例如顧客想自己
  `RESOLVED_OFFLINE`），後者是「這張單已經結束了」。訊息措辭必須分得開 ——
  「這不是你該做的」與「沒有這個移動」是兩個不同的答案。

> `REFUND_*` 與既有的 `REFUND_*`（付款供應商的退款，例如 `REFUND_EXCEEDS_CAPTURE`）
> 是**兩套不同的東西**。前者是顧客與店家之間的工單（錢不經平台），
> 後者是線上付款路徑偶爾會記錄的實際退款。命名前綴刻意不同，別混用。

### 冪等性

建立訂單接受：

```
Idempotency-Key: <uuid-v4>
```

重放回傳原本的 response。建立付款意圖的冪等鍵是 `pi:<orderId>`，由伺服器推導，客戶端不需傳。

### 分頁

**三種**，不要混用：

- **cursor** — 顧客訂單列表、商戶廚房板。資料變動時不會漏資料。
  ```
  GET /orders?status=ACTIVE&limit=20&cursor=<opaque>
  → { "data": [...], "nextCursor": "…" | null, "hasMore": true }
  ```
- **cursor + summary** — 評價列表（`/me/reviews`、`/merchants/:id/reviews`、
  `/merchant/:id/reviews`、`/admin/reviews`）。除了 `data` 之外**每一頁都附同一份**
  `summary`（`average`、`count`、`distribution[5]`、`positiveShareBps`）。
  刻意讓摘要跟著分頁走：評價頁同時要畫「4.6 ★ · 128 則」與列表，
  兩次請求會讓兩塊數字在載入時互相矛盾。`average` 在沒有評價時是 `null`，不是 `0`。
  ```
  GET /merchants/:merchantId/reviews?limit=20&cursor=<opaque>
  → { "data": [...], "summary": {...}, "nextCursor": "…" | null, "hasMore": true }
  ```
- **limit / offset** — 探索頁與所有管理台列表，需要「共 N 筆」才能畫分頁器。
  ```
  GET /admin/orders?limit=25&offset=50
  → { "data": [...], "total": 137 }
  ```

> DTO 只放 `limit` / `offset`。**不要**在 DTO 上開 `get take()` 這類 getter：
> `class-transformer` 會把請求裡的每個 key 塞進 DTO 實例，客戶端很自然會猜 `?take=5`，
> 然後撞上 `Cannot set property take of #<Dto> which has only a getter`，變成 500。
> 轉換用自由函式 `paginate()`。

### 併發控制

需要樂觀鎖的狀態轉換走 `UPDATE ... WHERE status = <expected>`，受影響列數為 0 就回
`409 ILLEGAL_ORDER_TRANSITION`。呼叫端應重新拉取資源再決定。

---

## 2. 認證

| Method | Endpoint | Body | 說明 |
|---|---|---|---|
| `POST` | `/auth/otp/request` | `{ phone }` | 發送驗證碼。回 `{ phone, expiresInSeconds, retryAfterSeconds, devCode? }`。**`devCode` 只在非 production 回傳**，前端直接顯示（不自動填入，否則登入流程無法測試） |
| `POST` | `/auth/otp/verify` | `{ phone, code }` | → `{ accessToken, refreshToken, expiresIn, user }` |
| `POST` | `/auth/refresh` | `{ refreshToken }` | 輪替 token pair。重用舊 token → 整條鏈撤銷 |
| `POST` | `/auth/logout` | `{ refreshToken }` | → `{ revoked: boolean }` |
| `GET` | `/auth/me` | — | → `AuthProfile`（`id, displayName, phone, email, role, locale, merchantIds[]`） |

電話格式：`^\+?[0-9]{8,15}$`。驗證碼以雜湊儲存在 Postgres，不是記憶體。

---

## 3. 顧客端

### 3.1 探索

```
GET /merchants?latitude=22.2819&longitude=114.1582&radiusKm=3&q=點心&district=Central&acceptingOnly=true&limit=20&offset=0
```

| Query | 型別 | 預設 | 說明 |
|---|---|---|---|
| `latitude` / `longitude` | float | — | 兩者都帶才做距離排序與 `radiusKm` 過濾 |
| `radiusKm` | float | `3` | — |
| `q` | string | — | 店名／簡介模糊搜尋（`pg_trgm` GIN index） |
| `district` | string | — | 精確比對。可選值見 `GET /merchants/districts` |
| `acceptingOnly` | bool | `false` | 只回 `acceptsOrders = true` 的商戶 |

→ `{ data: MerchantSummary[], total }`

```
GET /merchants/districts        → [{ district, count }]      （只有 ACTIVE 商戶）
GET /merchants/:slug            → MerchantDetail（含 hours、categories、items）
GET /merchants/:slug/pickup-slots → PickupSlots
```

`MerchantSummary`：
`id, slug, name, nameEn, description, status, district, region, addressLine1, latitude,
longitude, logoKey, coverImageKey, prepTimeMinutes, pickupWindowMinutes, acceptsOrders,
ratingAvg, ratingCount, distanceKm`

> **商戶以 `slug` 查詢，不是 id。** 前台網址 `/m/:slug` 要能分享，id 不該出現在 URL。
> 商戶端的 `/merchant/:merchantId/*` 則用 id，因為那裡是已授權的上下文。

`PickupSlots`：
```json
{
  "merchantId": "…", "timezone": "Asia/Hong_Kong",
  "stepMinutes": 15, "windowMinutes": 60,
  "earliestAt": "2026-09-24T11:42:21.581Z",
  "latestAt": "2026-09-25T11:22:21.581Z",
  "acceptingNow": true,
  "closedReason": null,
  "closureDate": null,
  "slots": [{ "startAt": "…", "endAt": "…", "label": "19:45", "dayOffset": 0 }]
}
```
`label` 是**商戶時區**的 `HH:mm`；`dayOffset` 驅動前端分組（0 = 今日）。時間軸一律 ISO 8601 UTC。

`closedReason` / `closureDate` 是**為休息日而加的兩個合成欄位**（唯讀）：

- `closedReason` 是當下 `checkOpening()` 的 `reason`（`NO_HOURS_CONFIGURED` /
  `CLOSED_TODAY` / `CLOSED_FOR_CLOSURE` / `OUTSIDE_HOURS`），開店中為 `null`。
  前端據此決定要顯示「尚未設定營業時間」、「今日休息」還是「休息日」。
- `closureDate` 是視窗內**第一個**休息日（`YYYY-MM-DD`），沒有就 `null`。

> 這兩個欄位不是為了方便前端而回傳的「多餘資料」，而是因為**光看 `slots` 是空的
> 分不出原因**：售完、未設營業時間、公眾假期、休息日，四種都會回同一份空陣列。
> 顧客看到的文案必須不同，而這些理由只有伺服器知道。

> `closureDate` 只掃 **`MAX_ADVANCE_HOURS`（24 小時）視窗內**的休息日，
> 不是在資料庫裡找「下一個休息日」。顧客能選的時間本來就只有 24 小時，
> 回一個他根本訂不到的日期只會誤導。

`MenuItem.remainingToday` = `quota − sold − held`；`dailyQuota` 為 `null` 時
`remainingToday` 亦為 `null`（不限量）。顧客端只看到 `AVAILABLE` 的品項。

### 3.2 建立訂單

```
POST /orders
Idempotency-Key: 7f3c…
```

```json
{
  "merchantId": "…",
  "fulfilmentMode": "SELF_PICKUP",
  "scheduledPickupAt": "2026-09-24T12:30:00.000Z",
  "customerNote": "少飯",
  "contactPhone": "+85291234567",
  "items": [{ "menuItemId": "…", "quantity": 2 }]
}
```

| 欄位 | 規則 |
|---|---|
| `scheduledPickupAt` | 省略 = 即時製作。帶值必須落在 `GET /pickup-slots` 回傳的區間內 |
| `items` | 至少一項、`quantity ≥ 1`。**價格不由前端傳入**，一律以 DB 為準 |
| `fulfilmentMode` | MVP 只接受 `SELF_PICKUP`；`DELIVERY` 回 `501` |

> **休息日在這一支也會被擋。** `assertPickupSlotFeasible` 用**同一個**
> `checkOpening()`（帶入該服務日的休息日集合）與 `GET /pickup-slots` 判斷同一個問題。
> 這不是重複實作，而是刻意的：前端畫出的時段與這一支接受的下單必須來自同一個真相，
> 否則會出現「畫面上有位、送出卻被拒」——顧客會讀成系統壞了。
> 休息日被擋時回 `422 PICKUP_TIME_NOT_FEASIBLE`，`details.serviceDate` 帶該日期。

Response `201`：
```json
{
  "id": "…", "orderNo": "20260924-000137", "pickupCode": "A-07",
  "status": "PENDING_PAYMENT",
  "scheduledPickupAt": null, "estimatedReadyAt": "2026-09-24T12:15:00.000Z",
  "currency": "HKD",
  "items": [{ "menuItemId": "…", "nameSnapshot": "招牌叉燒飯", "imageKeySnapshot": null,
              "unitPriceMinor": 5800, "quantity": 2, "lineTotalMinor": 11600, "isMainItem": true }],
  "pricing": {
    "mainItemCount": 2,
    "subtotalMinor": 13400,
    "platformFeeMinor": 700,
    "paymentProcessingFeeMinor": 690,
    "customerServiceFeeMinor": 0,
    "totalMinor": 13400,
    "merchantPayoutMinor": 12010
  }
}
```

> `pricing` 是 `PricingEngine.calculate().toSnapshot()` 的輸出，一字不改地寫入
> `orders.pricingSnapshot`。**之後改平台設定不影響已建立的訂單** —— 這是計費可審計的基礎。

訂單建立時就以單一原子 UPDATE 扣減每日配額（`held`），不是先查再寫。

### 3.3 付款

```
POST /orders/:orderId/payment-intent     body: { returnUrl? }
POST /orders/:orderId/simulate-payment   （僅非 production）
```

`payment-intent` → `PaymentIntent`：
```json
{
  "orderId": "…", "orderNo": "20260924-000137",
  "provider": "SIMULATED", "providerRef": "sim_…",
  "clientSecret": "simulated_secret_…", "redirectUrl": null,
  "status": "REQUIRES_ACTION",
  "amountMinor": 13400, "currency": "HKD",
  "notice": "未接真實支付閘道…"
}
```

- **冪等**：`payments.idempotencyKey` 為 `pi:<orderId>`（unique）。已存在的意圖原樣回傳，
  不會再打一次上游。
- `notice` 只在沒有真的聯絡支付閘道時出現。**前端必須顯示，不可吞掉** ——
  把這個畫面當成「已付款」是錯的。
- `PAYMENT_LIVE_MODE` 預設只在 production 為 `true`，開發用的金鑰不可能動到真錢。
- `simulate-payment` 在 `PAYMENT_LIVE_MODE=true` 時回 **404**（不是 403：403 等於承認路由存在）。

真正的入帳由支付閘道的 webhook 驅動，見 §5。

### 3.4 訂單查詢

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/orders?status=ACTIVE\|ALL&limit=20&cursor=` | 自己的訂單，cursor 分頁 |
| `GET` | `/orders/:orderId` | 單筆 |
| `POST` | `/orders/:orderId/cancel` | `{ reason }`。`PREPARING` 之後回 `403 ACTOR_NOT_PERMITTED` |

顧客端回應**不含**佣金拆帳，只有 `totalMinor`。

### 3.5 預約訂位

> Phase 1.5. 以**座位數**（`seatsPerSlot`）計容量，不是桌數；一個訂位會佔用它
> 跨越的**每一個** start-slot。`reservation_slots.booked` 是以
> `(merchantId, slotStart)` 為鍵的計數器，沒有指向單筆訂位的 FK。

#### 查空位（公開）

```
GET /merchants/:merchantId/reservation-availability?from=2026-09-28&to=2026-10-05&partySize=4
```

| Query | 型別 | 必填 | 說明 |
|---|---|---|---|
| `from` | ISO instant 或 `YYYY-MM-DD` | ✅ | 只有日期時視為 **UTC 午夜**，伺服器再換算到商戶時區 |
| `to` | 同上 | — | 不帶就只回 `from` 當天 |
| `partySize` | int 1–50 | — | 用來判斷每個 slot 的剩餘座位夠不夠 |

**無需認證**（顧客未登入也要看得到空位）。參數是 **`merchantId`（UUID），不是 slug** ——
這裡刻意不查 slug，讓公開端點少一次資料庫往返，也避免 slug 改動影響已分享的連結。
商戶不存在 → `404 MERCHANT_NOT_FOUND`。

```json
{
  "timezone": "Asia/Hong_Kong",
  "enabled": true,
  "acceptingNew": true,
  "customerNotice": "最後點餐 21:30",
  "policy": { "slotMinutes": 30, "turnMinutes": 90, "minPartySize": 1,
              "maxPartySize": 8, "leadTimeMinutes": 60, "advanceDays": 14 },
  "windowStart": "2026-09-28T00:00:00.000Z",
  "windowEnd": "2026-10-05T00:00:00.000Z",
  "notice": null,
  "slots": [{ "startsAt": "2026-09-28T10:00:00.000Z", "remaining": 12, "bookable": true }],
  "bookableCount": 18,
  "closedDates": ["2026-10-01", "2026-10-02"]
}
```

`policy` 只回 **6 個**顧客需要的欄位（`autoConfirm`、`seatsPerSlot` 不外洩）。
`enabled: false` 時仍回 200 且帶 `notice` —— 「這間店不開放訂位」是**內容**，
不是錯誤，前端要畫提示而不是錯誤頁。

`closedDates` 是視窗內所有休息日的 `YYYY-MM-DD`，**升序**。休息日的時段是
**整格被移除**，不是回 `bookable: false`：

> 回 `bookable: false` 讀起來是「滿了」，而顧客需要的訊息是「這天不開」。
> 一個 `false` 的格子會讓前端畫成灰色的「已滿」，顧客就會一直換時段試 ——
> 但那天永遠不會有位。移除格子 + 明確列出 `closedDates` 才能講出真話。

`slots` 為空**不代表**休息 —— 也可能是還沒設定營業時間、或整個視窗都在 lead time 內。
判斷是不是休息日要看 `closedDates`。

#### 顧客端（需 `JwtAuthGuard`）

| Method | Endpoint | Body / Query | 說明 |
|---|---|---|---|
| `POST` | `/reservations` | `PlaceReservationDto` | 建立。`201`。可帶 `Idempotency-Key` |
| `GET` | `/reservations?status=ACTIVE\|ALL&limit=20` | — | 自己的訂位。`status` 預設 `ALL`，`limit` 預設 20、上限 100 |
| `GET` | `/reservations/:reservationId` | — | 單筆。不是自己的 → `404`（**不是 403**，不洩漏存在性） |
| `POST` | `/reservations/:reservationId/cancel` | — | `200`。先驗擁有權，再走狀態機（`actor = CUSTOMER`） |

`PlaceReservationDto`：

```json
{
  "merchantId": "…", "startsAt": "2026-09-28T10:00:00.000Z", "partySize": 4,
  "customerName": "陳大文", "contactPhone": "+85290000001",
  "customerNote": "靠窗", "merchantSlug": "cha-chaan-teng"
}
```

- `startsAt` 必須是**嚴格 ISO-8601**，且對齊 `slotMinutes` 的整點間隔 ——
  否則 `422 RESERVATION_SLOT_MISALIGNED`。
- `merchantSlug` 只是**宣告來被忽略的**：`forbidNonWhitelisted: true` 會把未知欄位
  變成 400，前端從商戶頁轉跳時很自然會把 slug 一起帶上。
- `contactPhone` 格式 `^[0-9+\-\s()]{5,32}$`。

> **`POST /reservations` 會自己再查一次休息日。** availability 端點會把休息日的
> 時段整格移除，但那是**查詢**；一個開著舊頁面的顧客、或一支自己接的客戶端，
> 可以繞過格子直接送出。所以這一支在下單前會 `merchantClosure.findUnique` 那個服務日，
> 命中就回 **`422 MERCHANT_CLOSED`**。
>
> 這是 e2e 抓出來的真缺陷：格子藏住了那一天，但直接 POST 仍然建立成功。
> 只在查詢端過濾的「擋」不是擋。

`ReservationCreatedView`：`{ id, reservationNo, merchantId, merchantName, status,
partySize, startsAt, serviceDate, timezone, customerNotice, autoConfirmed }`。
`autoConfirmed` 為 `false` 時訂位是 `PENDING`，要商戶確認。

`CustomerReservationView` 比建立回應多：`merchantSlug`、`merchantTimezone`、
`customerName`、`customerNote`、`merchantNote`、`statusReason`、
`confirmedAt`、`seatedAt`、`completedAt`、`cancelledAt`、`createdAt`、
以及 **`canCancel`**（伺服器算好，前端不要自己推）。

#### 訂位狀態機

`PENDING → CONFIRMED → SEATED → COMPLETED`，另有
`DECLINED`（商戶拒絕）/ `CANCELLED`（顧客或商戶取消）/ `NO_SHOW`（逾時未到）。

- **active** = `PENDING | CONFIRMED | SEATED`；**terminal** = 其餘四個。終態不能再轉。
- 兩個守衛：`RESERVATIONS_ACCEPTING`（只在 `PENDING → CONFIRMED`，且商戶已停收時擋下）
  與 `WITHIN_TURN_WINDOW`（只有訂位時間過後才准標 `NO_SHOW`）。
  **`ADMIN` 豁免兩個守衛** —— 平台要能救任何一張卡住的單。
- `RESERVATION_NOT_PERMITTED`（409）是樂觀鎖失敗：狀態被別的請求改走了，
  呼叫端應重新拉取。前端**不該**用 `if (status === ...)` 自己決定顯示哪些按鈕 ——
  改用回應中的 `allowedNextTransitions`（見 4.6）。

### 3.6 評價

評價寫在**訂單**上，不是商戶上。好處是所有規則只在一個地方：
前端問「我可以評嗎」，拿到答案與理由，而不是自己從訂單狀態推導、然後把時限算錯。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/orders/:orderId/review/eligibility` | 可否評價、為什麼不行、是否已有評價 |
| `POST` | `/orders/:orderId/review` | 建立。`201`。一單只能一則 → 重複 `409 REVIEW_ALREADY_EXISTS` |
| `GET` | `/me/reviews?limit=20&cursor=` | 自己所有評價，**cursor + summary** 分頁 |
| `PUT` | `/reviews/:reviewId` | 編輯自己的評價。不是自己的 → `403 REVIEW_NOT_OWNED` |
| `DELETE` | `/reviews/:reviewId` | 撤回（作者自己刪）。`204` |
| `GET` | `/merchants/:merchantId/reviews?limit=20&cursor=` | **公開**，無需認證。只回可見的 |

`ReviewEligibilityView`：`{ orderId, orderStatus, canReview, reason,
existingReviewId, reviewDeadline }`。`canReview` 為 `true` 時 `reason` 是空字串；
`existingReviewId` 有值時 UI 應改為提供「編輯」而不是「評分」。
**所有授權邏輯都在這一支**，前端不要重寫。

`CreateReviewDto` / `UpdateReviewDto`：

```json
{ "rating": 5, "comment": "叉燒夠腍", "tags": ["TASTY", "FAST"] }
```

- `rating` 1–5（`RATING_MIN` / `RATING_MAX`），`comment` ≤ 1000，`tags` 由 **domain 的
  `REVIEW_TAGS`** 驗證（不是 controller 再抄一份清單）。
- `UpdateReviewDto` 全部選填，省略的欄位保留原值；`comment: null` 清空。
- 可編輯窗口由 `eligible` / `editable` 決定，超過窗口 → `403`。

回應型別：`PublicReviewView`（無顧客身分，只有 `authorName` 顯示名）、
`CustomerReviewView`（+`orderId`/`orderNo`/`merchantId`/`merchantName`/`editable`）、
`MerchantReviewView`（+`hiddenAt`/`hiddenReason`）。

### 3.7 退款申請工單

> **平台不經手款項。** 這是一個「轉達」機制：顧客在平台提出申請，
> 店家收到後自行與顧客商議退款。平台不寫 `payments`、不改訂單狀態、
> 不呼叫任何支付供應商。**這個缺席就是功能本身**（見 `refund.repository.port.ts` 檔頭）。

| Method | Endpoint | 說明 |
|---|---|---|
| `POST` | `/orders/:orderId/refund-request` | 提出申請。`201`。body `FileRefundRequestDto` |
| `GET` | `/refund-requests?limit=20&offset=0` | 自己的申請，新的在前 |
| `GET` | `/refund-requests/:refundRequestId` | 單筆。不是自己的 → `404`（不是 `403`） |
| `POST` | `/refund-requests/:refundRequestId/cancel` | 顧客**撤回**。`200` |

`FileRefundRequestDto`：

```json
{ "reasonCode": "QUALITY", "requestedAmountMinor": 3800, "note": "點心到了是冷的" }
```

- `reasonCode` ∈ `NEVER_RECEIVED | WRONG_ITEM | QUALITY | LATE | DUPLICATE_CHARGE | OTHER`。
- `requestedAmountMinor` **選填且只是「要求」**：整數 minor units、`≥1`、不可大於 `orderTotalMinor`。
  省略 = 「全部，我們再談」。店家實際交還多少由雙方決定。
- `note` ≤1000。**`OTHER` 必須填**，否則 `400 REFUND_NOTE_REQUIRED` ——
  一張無法回應的工單比沒有工單更糟。

`CustomerRefundRequestView`：`{ id, orderId, orderNo, merchantId, status, reasonCode,
requestedAmountMinor, orderTotalMinor, currency, customerNote, merchantNote,
settledAmountMinor, settlementReference, resolvedAt, cancelledAt, createdAt, updatedAt,
allowedNextTransitions }`。

> `settledAmountMinor` / `settlementReference` 是**店家聲稱**交還了甚麼。
> 平台沒有核實、沒有經手。UI 必須渲染成「店家表示已線下處理」，
> **不可以**寫成「平台已退款」。

#### 五個檢查的順序是刻意的

1. 訂單存在**且是你的** → 否則 `404 ORDER_NOT_FOUND`（不是 `403`；
   `403` 等於向陌生人確認這個 id 存在）；
2. 訂單已付款 → 否則 `422 REFUND_REQUEST_NOT_ALLOWED`。可申請的狀態集合是
   `PAID | ACCEPTED | PREPARING | READY_FOR_PICKUP | COMPLETED | REJECTED | REFUNDED`
   （domain 的 `isOrderRefundRequestable`）；
3. `OTHER` 要 `note` → 否則 `400 REFUND_NOTE_REQUIRED`；
4. 金額合理 → 否則 `400 REFUND_AMOUNT_INVALID`；
5. **同一張訂單沒有進行中的工單** → 否則 `409 REFUND_REQUEST_ALREADY_OPEN`。

第 1–4 步在 transaction **之前**拒絕；第 5 步在 transaction **之內**檢查，
因為兩次同時提出會從外面都看到「沒有進行中的工單」。
工單結束後（已解決／已拒絕／已撤回）可以就同一張訂單**重新提出**。

#### 狀態機沒有 `REFUNDED`

`RefundRequestStatus` = `OPEN | IN_DISCUSSION | RESOLVED_OFFLINE | DECLINED | CANCELLED`。

`RESOLVED_OFFLINE` 記錄店家**聲稱**在線下交還了甚麼；它**必須**至少帶
`settledAmountMinor > 0` 或非空白的 `settlementReference`，否則狀態機回
`422 REFUND_SETTLEMENT_DETAILS_REQUIRED`，而不是記下一筆空白的「已解決」。

授權（`RefundRequestStateMachine`）：

- 顧客只能**撤回**（從 `OPEN` 或 `IN_DISCUSSION`），永遠不能自己 `RESOLVED_OFFLINE` / `DECLINED`；
- 店家驅動其餘所有移動；
- `IN_DISCUSSION` 的 side effect 是 `NOTIFY_CUSTOMER` + `NOTIFY_MERCHANT`；
- 三個終態都沒有出口。

> `RefundRequestSideEffect` 只有 `NOTIFY_CUSTOMER` / `NOTIFY_MERCHANT`，**沒有**任何
> 與錢有關的成員。這是刻意的：`packages/domain/tests/refund.spec.ts` 直接斷言
> 這個列舉等於那兩個值，任何「順手加一個 `REFUND_PAYMENT`」都會弄掛測試。

#### 訂單詳情頁的摘要

`CustomerOrderView` / `MerchantOrderView` 多了一個 `refundRequests` 陣列
（`OrderRefundSummaryView[]`，新的在前），欄位是
`{ id, status, reasonCode, requestedAmountMinor, createdAt }`。

用意是讓訂單頁**不必再發一次請求**就知道要不要顯示「申請退款」按鈕 ——
而且能分辨「還沒有工單」與「已有進行中的工單」。後者**不可以**顯示按鈕，
因為再提一次會回 `409`，顧客會讀成一個 bug。沒有工單的訂單回**空陣列**，
不是 `undefined`（契約檢查同時釘住兩種形狀）。

#### 顧客端的 WS

`subscribe:refund_request`（房間 `refund_request:{id}`），只有
`ticket.customerId === user.userId` 才訂得到。店家端有
`merchant:{id}:refund-requests` 隊列房間。

---

## 4. 商戶端

路徑前綴 `/merchant/:merchantId`（`POST /merchant/apply` 與 `GET /merchant/mine` 除外）。
`MerchantScopeGuard` 驗證 token 的 `merchantIds` 包含該 id。

### 4.1 入駐與檔案

| Method | Endpoint | Body | 說明 |
|---|---|---|---|
| `POST` | `/merchant/apply` | `CreateMerchantInput` | 申請入駐。呼叫者被提升為 `MERCHANT_OWNER`，商戶狀態為 `PENDING_REVIEW`，並在同一交易內建立 `merchant_staff` 擁有者列 |
| `GET` | `/merchant/mine` | — | 我可管理的商戶（含 `isOwner`） |
| `GET` | `/merchant/:merchantId` | — | 商戶檔案 |
| `PATCH` | `/merchant/:merchantId` | `UpdateMerchantDto` | 只寫入有帶的欄位，所以設定頁可以逐區儲存而不互相覆蓋 |
| `PUT` | `/merchant/:merchantId/hours` | `{ hours: [{ dayOfWeek, opensAtMinute, closesAtMinute, isClosed }] }` | 整批覆寫 7 天 |
| `POST` | `/merchant/:merchantId/intake` | `{ accepting: boolean }` | **接單 / 停單** |
| `GET` | `/merchant/:merchantId/pickup-slots` | — | 同顧客端，但走商戶授權 |

`slug` 不在 `UpdateMerchantDto` 內 —— 它是永久對外網址，改掉會讓所有分享連結失效。

### 4.2 菜單

前綴 `/merchant/:merchantId/menu`。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/menu` | → `OwnerMenu`（`serviceDate`、`categories[]`、`uncategorised[]`、`totals`） |
| `POST` | `/menu/categories` | 建立分類 |
| `PATCH` | `/menu/categories/:categoryId` | 改名、改排序、`isActive` |
| `DELETE` | `/menu/categories/:categoryId` | 分類內仍有菜式 → `409 CATEGORY_IN_USE` |
| `POST` | `/menu/items` | 建立菜式 |
| `PATCH` | `/menu/items/:itemId` | 改任何欄位；`categoryId: null` = 移出所有分類 |
| `PATCH` | `/menu/items/:itemId/availability` | `{ availability: AVAILABLE \| SOLD_OUT \| HIDDEN }` |
| `PUT` | `/menu/items/order` | `{ entries: [{ id, sortOrder }] }` 批次重排 |
| `DELETE` | `/menu/items/:itemId` | 刪除（歷史訂單靠 `nameSnapshot` 保存） |

`POST /menu/items` body：
```json
{
  "categoryId": "…", "name": "招牌叉燒飯", "nameEn": "Signature Char Siu Rice",
  "description": "自家製叉燒，炭燒", "priceMinor": 5800, "isMainItem": true,
  "availability": "AVAILABLE", "dailyQuota": 50, "prepTimeMinutes": 12, "sortOrder": 0
}
```

- `isMainItem` **直接決定平台費**：每件收 HK$3.50，同時從商戶入帳扣除。
  商戶端 UI 必須明確解釋這一點（`/merchant/menu` 頁有對應 banner）。
- `dailyQuota` 為 `null` 或 `0` 都代表不限量 —— `0` 在寫入時正規化為 `null`，
  不儲存第二種「無上限」。
- `priceMinor` 上限 1,000,000（HK$10,000）。把「元」當 minor units 傳（`58` 代表 HK$58）
  是很容易犯的錯，這個上限讓它變成 400 而不是帳單上的驚喜。
- **`availability` 才是下架的正確做法**。`HIDDEN` 保留菜式與分類關係，
  日後可以原樣恢復；`DELETE` 不行。

### 4.3 圖片（Cloudflare R2）

前綴 `/merchant/:merchantId/images`。**兩條上傳路徑，差別是刻意的**：

| Method | Endpoint | 說明 |
|---|---|---|
| `POST` | `/images/presign` | **生產路徑**。API 不經手 bytes，只簽一個短效 PUT |
| `POST` | `/images` | **multipart**，欄位 `file` + `scope`。API 收下 bytes、跑 pipeline、自己存 |
| `GET` | `/images?limit=60` | 列表 + `storage: { driver, configured }` |
| `GET` | `/images/:assetId` | 單筆 |
| `DELETE` | `/images/:assetId` | `204`。先刪物件再刪列 |

```
POST /merchant/:merchantId/images/presign
{ "contentType": "image/webp", "scope": "MENU_ITEM", "sizeBytes": 245000 }
→ { "uploadUrl": "https://…&X-Amz-Signature=…", "objectKey": "merchants/…/items/….webp",
    "expiresInSeconds": 900, "maxSizeBytes": 5242880 }
```

1. 前端 `PUT` 檔案到 `uploadUrl`（15 分鐘有效）。
2. 把 `objectKey` 放進 `POST/PATCH /menu/items`。
3. 讀取時由 CDN 網域組出 public URL（DB 只存 key）。

- `scope` 是 **`MENU_ITEM | MERCHANT_LOGO | MERCHANT_COVER`**（大寫 enum），
  物件鍵前綴因此是 `items/` 或 `branding/logo-`、`branding/cover-`。
- 只接受 `image/webp|jpeg|png`，≤ 5 MB。`sizeBytes` 超過 5 MB 在 DTO 就被擋。
- **presign 路徑留下 `status: PENDING`** —— 沒有東西處理過那個物件。
  **multipart 路徑同步處理完才回應**，回 `READY` 並帶三個 WebP 衍生圖與 BlurHash。
  5 MB 圖在單機部署不需要佇列；加 broker + worker 只為省幾百毫秒不划算。
- `GET /images` 的 `storage.configured` 是給 UI 解釋「為什麼上傳會失敗」用的，
  否則沒有 bucket 的部署只會顯示一個通用錯誤。

`ImageAssetView`：`{ id, merchantId, scope, status, contentType, sizeBytes, checksum,
width, height, blurhash, originalKey, originalUrl, variants[], failureReason, createdAt }`；
`variants` 固定順序 `THUMB, CARD, FULL`，`READY` 之前是空陣列。
`contentType` 是 **sharp 偵測出來的**，不是客戶端宣稱的那個。

#### 讀取（公開）

```
GET /media/:assetId/:variant      // thumb | card | full，大小寫不拘
GET /media/:assetId               // 原圖
```

**無需認證，且這不是洩漏**：平台要給每個顧客看的圖，定義上就是公開的，
而 assetId 是隨機 UUID。反面做法（每個衍生圖都簽 URL）什麼都買不到，
卻讓菜單列表的 `<img src>` 變得不可能。

- 有設定 CDN → `302` 到 CDN（生產環境 bytes 不經過 API）。
- 沒有 CDN → API 直接串流，本機跑起來才看得到真圖。
  `Cache-Control: public, max-age=31536000, immutable`。
- 未知 `variant`、不是 `READY`、或找不到 → `404 IMAGE_ASSET_NOT_FOUND`。

### 4.4 廚房看板

前綴 `/merchant/:merchantId/orders`。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/orders?status=ACTIVE\|ALL&limit=&cursor=` | `ACTIVE` 只回 `PAID/ACCEPTED/PREPARING/READY_FOR_PICKUP` |
| `GET` | `/orders/:orderId` | 詳情（含拆帳） |
| `POST` | `/orders/:orderId/accept` | `PAID → ACCEPTED`。商戶停單時被 `MERCHANT_ACCEPTING` 守衛擋下 |
| `POST` | `/orders/:orderId/reject` | `PAID → REJECTED`，body `{ reason }`，狀態機的 side effect 觸發退款 |
| `POST` | `/orders/:orderId/start-preparing` | `ACCEPTED → PREPARING` |
| `POST` | `/orders/:orderId/mark-ready` | `PREPARING → READY_FOR_PICKUP` |
| `POST` | `/orders/:orderId/complete` | `READY_FOR_PICKUP → COMPLETED`，寫入 payout ledger |

全部 `@HttpCode(200)`（不是 201 —— 沒有建立新資源）。

> 這五個是**具名動作**，不是通用的 `PATCH { status }`。通用端點會被迫重新推導
> 「誰在呼叫」，而狀態機對不同 actor 的授權不同。

`MerchantOrderView` 沒有 `allowedNextTransitions`（`AdminOrder` 有）。
商戶端的按鈕由前端的一張對照表決定；前端與狀態機不一致時 API 回 409，前端據此重新拉取。

### 4.5 結算

**商戶端沒有結算 API。** 入帳由平台產生與付款，商戶在 `/merchant` 看到的是自己訂單的
`merchantPayoutMinor` 加總。這是刻意的：讓商戶能自己「確認收款」會產生一套無法對帳的狀態。

### 4.6 訂位簿

前綴 `/merchant/:merchantId/reservations`。全部需
`JwtAuthGuard` + `MerchantScopeGuard`（`merchantIds` 內才准）。

#### 設定

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/settings` | → `ReservationSettingsView` |
| `PUT` | `/settings` | 合併進現有政策後整批寫回 |

**是 `PUT` 不是 `PATCH`**：語意是「這是我要的完整政策」，不是「改這幾個欄位」。
Controller 先 merge 進現有 policy，再驗 `minPartySize ≤ maxPartySize` 與
`turnMinutes ≥ slotMinutes`；不成立 → `422 PLATFORM_CONFIG_INVALID`。

```json
{ "enabled": true, "autoConfirm": true, "slotMinutes": 30, "turnMinutes": 90,
  "seatsPerSlot": 16, "minPartySize": 1, "maxPartySize": 8,
  "leadTimeMinutes": 60, "advanceDays": 14, "customerNotice": "最後點餐 21:30" }
```

`ReservationSettingsView`：`{ policy, customerNotice, acceptingNew }`。
`acceptingNew` 是**唯讀**的合成欄位 —— 訂位要開，還得整間店也在接單。
預設值 `DEFAULT_RESERVATION_POLICY` = `{ enabled:false, autoConfirm:true,
slotMinutes:30, turnMinutes:90, seatsPerSlot:16, minPartySize:1, maxPartySize:8,
leadTimeMinutes:60, advanceDays:14 }`。

#### 列表與單筆

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/reservations?date=YYYY-MM-DD&status=ACTIVE\|ALL&limit=100` | `date` 會**先經過商戶時區**再換算成服務日；`status` 預設 `ACTIVE`（只有 `PENDING/CONFIRMED/SEATED`）；`limit` 預設 100、上限 200 |
| `GET` | `/reservations/:reservationId` | 單筆 |

#### 狀態轉換（六個具名動作）

| Method | Endpoint | 轉換 | 備註 |
|---|---|---|---|
| `POST` | `/:id/confirm` | `PENDING → CONFIRMED` | 需 `RESERVATIONS_ACCEPTING` |
| `POST` | `/:id/decline` | `PENDING → DECLINED` | 可帶 `{ reason }` |
| `POST` | `/:id/seat` | `CONFIRMED → SEATED` | — |
| `POST` | `/:id/complete` | `SEATED → COMPLETED` | — |
| `POST` | `/:id/no-show` | `CONFIRMED → NO_SHOW` | 需 `WITHIN_TURN_WINDOW` |
| `POST` | `/:id/cancel` | active → `CANCELLED` | 可帶 `{ reason }` / `{ merchantNote }` |

全部 `@HttpCode(200)`。body 是 `ReservationReasonDto`：
`{ reason? ≤300, merchantNote? ≤1000 }`，兩個都可省略。

每個動作**先**驗商戶可訂位（否則 `MerchantNotBookableError`），**再**驗
`policy.enabled`（`false` → `409 RESERVATIONS_PAUSED`），**才**進狀態機。
順序有意義：回哪個錯誤碼決定了前端該顯示「去開啟訂位」還是「稍後再試」。

`MerchantReservationView` 在 `CustomerReservationView` 之上多了
`contactPhone`、`turnMinutes`、`version`，以及 **`allowedNextTransitions`**：

```json
{ "allowedNextTransitions": { "merchant": ["SEAT", "CANCEL"], "system": ["NO_SHOW"] } }
```

**這是伺服器提供的投影，商戶看板的按鈕直接照它畫。**
`system` 那一格列的是只有系統（排程器）會自動觸發的轉換，不要畫成按鈕。
這正是為了讓「前端畫得出 API 會拒絕的按鈕」這件事不可能發生 ——
`MerchantOrderView` 沒有這個欄位、改用前端對照表，是那裡的舊做法。

#### 回應中的 `reservationId`

所有轉換端點回 `ReservationTransitionView`：`{ reservationId, reservationNo,
fromStatus, toStatus, occurredAt, sideEffects, allowedNextTransitions, reservation }`。
`reservation` 是**轉換後**的完整 `MerchantReservationView`，所以呼叫端不必再拉一次。
欄位叫 `reservationId`（**不是 `id`**）—— controller 是 `return { ...result, reservation }`
展開的，不是重新 map 一次，展開時沿用了狀態機結果裡的名字。

`sideEffects` 是 `NOTIFY_CUSTOMER | NOTIFY_MERCHANT | RELEASE_TABLE_SLOT |
RECORD_NO_SHOW`。`RELEASE_TABLE_SLOT` 出現在**每一條離開 active 集合的路徑**上，
active 集合內部的轉換（例如 `PENDING → CONFIRMED`）**不會**釋放座位。

### 4.7 特別休息日

前綴 `/merchant/:merchantId/closures`，需 `JwtAuthGuard` + `MerchantScopeGuard`。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/closures?from=YYYY-MM-DD` | 休息日列表（升序）。`from` 省略 = 商戶時區的**今日** |
| `GET` | `/closures/:serviceDate` | 單筆。不存在 → `404 CLOSURE_NOT_FOUND` |
| `PUT` | `/closures/:serviceDate` | 設定休息日（upsert）。`200` |
| `DELETE` | `/closures/:serviceDate` | 取消休息日。`204` |

`PUT` body（`SetClosureDto`）：

```json
{ "reason": "PUBLIC_HOLIDAY", "note": "國慶日休市一天" }
```

`reason` 是 `PUBLIC_HOLIDAY | STAFF_HOLIDAY | PRIVATE_EVENT | MAINTENANCE | OTHER`。

`ClosureView`：`{ serviceDate, reason, note, createdAt, updatedAt,
cancelledReservationCount, cancelledReservationsAt }`。

`PUT` 回 `ClosureWriteResultView`：
`{ closure, cancelledReservations, alreadySwept, message, sweepComplete }`。

#### 為什麼「休息」是一個日期，不是一段時間

休息日**整天**生效，沒有 `opensAt` / `closesAt`。這不是偷懶：
「下午 2 點到 5 點休息」在商業上是一個**營業時間**問題（改 `PUT /hours`
或那天的例外），不是「今天不開」。把兩件事塞進同一個模型，
會讓前端要畫一個有時間範圍的休息日，而後端的 `pickup-slots` 還得為它
重新推導每個時段 —— 兩個真相，遲早不一致。

#### 固定的每週休息

「每個星期一定休」不用 `merchant_closures`，用既有的 `PUT /hours`：
把該天的 `isClosed` 設為 `true`。`merchant_closures` 只放**例外**（公眾假期、
員工旅遊、臨時維修）。這個分工讓「每週三休」是 7 筆固定設定中的一格，
而不是一筆一筆往下滾的日期。

#### 設定休息日會做什麼

`PUT` 是一個**有副作用**的動作，順序是刻意的：

1. 驗日期（格式 → 不可是過去 → upsert 該列 + 寫稽核）在同一個 transaction；
2. **交易提交之後**才掃描並取消該日既有的 active 訂位。

先提交才掃描，是因為反過來的話，掃描期間「休息日」對其他請求還不可見 ——
顧客可以在那個空窗裡訂到一張馬上會被取消的位子。而萬一中途崩潰，
那一列已經在資料庫裡，`cancelledReservationsAt` 仍為 `null`，
形成一個「已休息但還沒清乾淨」的耐久標記，看列表就知道要重跑一次。

掃描的行為：

- 只碰 `PENDING | CONFIRMED | SEATED`，每次最多 `SWEEP_LIMIT = 200` 筆；
- 每一筆都走 `ReservationStateMachine`（不是把計數器減掉），因此會經過
  `RELEASE_TABLE_SLOT` 歸還座位、並寫出 `reservation.cancelled` outbox 事件 ——
  **顧客會收到通知**，這是需求裡「訊息提示預定取消」的實作點；
- `statusReason` 是 `MERCHANT_CLOSED:<serviceDate>`。刻意**不是**一句人話，
  這樣之後店家把 `note` 改成「員工旅遊」也不會改寫稽核軌跡 ——
  取消的原因永遠是「店家當天休息」，附加說明是另一回事；
- **可重跑（idempotent）**：`cancelledReservationsAt` 有值就代表掃過了，
  重複 `PUT` 回 `alreadySwept: true` 且不再發第二次事件。

> `sweepComplete: false` 代表那 200 筆上限到了、可能還有剩下的。
> 這時回應仍帶 `cancelledReservations` 的實際數字，前端要提示再儲存一次。

`DELETE` **不會**把被取消的訂位復原。取消已經通知顧客、座位已經歸還、
事件已經發出 —— 復原等於憑空重訂一批人根本沒答應新時間的位子。
重新開放的那天要由店家自己決定還收不收。

### 4.8 退款申請隊列

前綴 `/merchant/:merchantId/refund-requests`，需 `JwtAuthGuard` + `MerchantScopeGuard`。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `?status=ACTIVE\|ALL\|<STATUS>&limit=50&offset=0` | 隊列 + `counts`。`status` 預設 `ACTIVE` |
| `GET` | `/:refundRequestId` | 單筆 |
| `POST` | `/:refundRequestId/transition` | 移動工單。`200`。body `TransitionRefundRequestDto` |

`TransitionRefundRequestDto`：

```json
{ "to": "RESOLVED_OFFLINE", "merchantNote": "已經喺櫃檯現金退回",
  "settledAmountMinor": 3800, "settlementReference": "CASH-2026-0001" }
```

一個端點而不是四個（`/agree`、`/resolve`…），因為這裡每個移動帶的欄位高度重疊，
而**判斷哪個組合合法的是狀態機**，不是路徑。`to` 是 `RefundRequestStatus`。

`MerchantRefundQueueView`：`{ data, total, counts }`，其中 `counts` 是
**完整的 `Record<RefundRequestStatus, number>`** —— 沒有的狀態是 `0`，不是缺席。
稀疏的 map 會讓隊列分頁顯示空白而不是 0，讀起來像壞掉。

`MerchantRefundRequestView` 比顧客多了 `customerId` / `customerName` /
`orderStatus` / `version`。`version` 供樂觀鎖；`orderStatus` 反正規化是為了
讓隊列不必 join 就能顯示訂單現況（店家要一眼看出這張單是不是已經取餐了）。

`RefundTransitionView`：`{ refundRequestId, orderId, orderNo, fromStatus,
toStatus, occurredAt, sideEffects, allowedNextTransitions, refundRequest }`。

> 欄位是 **`refundRequestId` 而不是 `id`** —— controller 直接展開 use case 的結果。
> `ReservationTransitionView` 第一版在這裡出過錯而兩邊都編譯得過，
> 所以契約檢查會比對一次真實的 transition 回應。

`MerchantScopeGuard` 證明的是呼叫者**任職於 `:merchantId`**，它保護的是**路徑**。
工單自己帶著 `merchantId`，所以單筆與 transition 兩條路由都**再檢查一次那一列** ——
保護路徑的 guard 保護不了列，改 URL 就能讀到別家店的工單。

#### 平台介入

`/admin/refund-requests`（`JwtAuthGuard` + `RolesGuard` + `@Roles('ADMIN')`）：

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `?status=&merchantId=&limit=&offset=` | 全平台，**依預設只讀** |
| `GET` | `/:refundRequestId` | 單筆 |
| `POST` | `/:refundRequestId/transition` | 同一支 use case，`actor: ADMIN` |

管理台唯一的寫入是 `transition`，只為了處理店家已停業、失聯等情況。
它走**同一套狀態機、同一支 use case**，所以管理員到不了一個店家到不了的狀態，
而且稽核軌跡記的是 `ADMIN`，不是假裝店家做的。

### 4.9 評價管理

前綴 `/merchant/:merchantId/reviews`，需 `JwtAuthGuard` + `MerchantScopeGuard`。

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/reviews?limit=20&cursor=&visibility=VISIBLE\|HIDDEN\|ALL` | 自己店的評價，cursor + summary 分頁 |
| `POST` | `/reviews/:reviewId/reply` | `200`。body `{ reply ≤600 }`。一則一次（改回覆 = 再送一次） |

`MerchantScopeGuard` 讀的是 **token 上的 merchantIds**，所以店主改 URL 也讀不到別家的評價，
而且不會被一列過期的資料騙到。`violation` 時 `visibility` **只影響商戶自己看得到什麼**，
公開端點 `/merchants/:id/reviews` 永遠只看得到可見的。

不能回覆的情況（例如已隱藏、非本店）→ `403 REVIEW_REPLY_NOT_ALLOWED`。

---

## 5. Webhook

### 5.1 支付供應商 → 平台

```
POST /webhooks/payments/:provider      (provider: stripe | payme | octopus | fpsqr)
```

- **必須**驗簽（`Stripe-Signature` header / 各家等價物），用 **raw body**。
- 以 `(provider, providerRef)` unique 做冪等；重複投遞回 `200` 且不改狀態。
- 處理成功回 `200`，其餘回 `5xx` 讓供應商指數退避重試。

```
驗簽 → 冪等檢查 → UPDATE payments(status=CAPTURED)
     → OrderStateMachine.transition(PENDING_PAYMENT → PAID)
     → 套用 sideEffects（outbox 與狀態變更同一個 transaction）
```

### 5.2 平台 → 商戶（選配）

商戶若有自己的 POS，事件類型與下方 WebSocket 相同，附 `X-Signature` HMAC-SHA256。

---

## 6. 管理台

全部需要 `role = ADMIN`。

### 6.1 總覽與維運

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/dashboard` | 一次回齊商戶 / 訂單 / 使用者 / 財務 / 維運 / 目前計費政策 |
| `GET` | `/admin/health` | `{ database, redis }` |
| `GET` | `/admin/outbox?status=&eventType=&aggregateId=&limit=&offset=` | 事件列表 |
| `GET` | `/admin/outbox/stats` | `{ byStatus, oldestPendingAt, oldestPendingAgeSeconds, deadLetterCount }` |
| `POST` | `/admin/outbox/:eventId/retry` | 隔離或失敗的事件重排。`PENDING` 重試回 `409 OUTBOX_NOT_RETRYABLE`（避免無意義的重試迴圈） |
| `POST` | `/admin/outbox/:eventId/dead-letter` | 手動隔離 |
| `GET` | `/admin/audit?actorId=&targetType=&action=&limit=&offset=` | 稽核記錄，含 `before` / `after` diff |

`oldestPendingAgeSeconds` 比「待發送 N 筆」有用得多：N 筆是雜訊，
**年齡持續上升**才是 relay 掛掉的症狀。

### 6.2 訂單

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/orders?status=&merchantId=&customerId=&from=&to=&q=&limit=&offset=` | 列表 |
| `GET` | `/admin/orders/:orderId` | 詳情，含 `pricingSnapshot`、`payments[]`、`refunds[]`、`statusEvents[]`、`allowedAdminTransitions[]` |
| `POST` | `/admin/orders/:orderId/transition` | `{ to, reason }` → `{ order, fromStatus, toStatus, sideEffects }` |
| `POST` | `/admin/orders/:orderId/refund` | `{ reason, amountMinor? }` → `{ order, refund, providerStatus, failureReason, orderTransition, notice }` |

管理員轉換走**同一個** `OrderStateMachine`，只是 `actor = ADMIN`，因此
`MERCHANT_ACCEPTING` 守衛被豁免（平台要能救一張卡在停單商戶手上的單）。

`allowedAdminTransitions` 由同一張表推導，所以管理台**不可能畫出 API 會拒絕的按鈕**。
空陣列 = 終態。

退款只記錄，**不會自動改變訂單狀態**；狀態要不要跟著走是操作者的另一個決定。

### 6.3 商戶

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/merchants?status=&district=&q=&limit=&offset=` | 列表，含 `stats` 與 `allowedActions` |
| `GET` | `/admin/merchants/:merchantId` | 詳情 |
| `POST` | `/admin/merchants/:merchantId/action` | `{ action: APPROVE \| SUSPEND \| REINSTATE \| CLOSE, reason? }` |
| `POST` | `/admin/merchants/:merchantId/intake` | `{ accepting: boolean }` — 平台可以直接關掉一間店的接單 |

- `reason` 是這個 DTO 的欄位名（**不是 `note`**）。`forbidNonWhitelisted: true` 會把未知欄位
  變成 400，所以傳錯名字不會被默默忽略。
- **`APPROVE` 與 `REINSTATE` 不會自動開啟接單**。商戶自己停單後被恢復營業，
  不該因此開始收單。
- `CLOSE` 是終態。`allowedActions` 變空陣列。

### 6.4 使用者

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/users?role=&isActive=&q=&limit=&offset=` | 列表，含擁有商戶數、訂單數、活躍 session 數 |
| `GET` | `/admin/users/:userId` | 詳情 |
| `PATCH` | `/admin/users/:userId` | `{ displayName?, role?, isActive?, locale? }` |
| `POST` | `/admin/users/:userId/revoke-sessions` | → `{ revoked: n }` |

兩條保護：

- **`SELF_MODIFICATION`（403）** —— 管理員不能改自己的角色或停用自己。
- **`LAST_ADMIN`（409）** —— 不能把最後一位啟用中的管理員降級或停用。

改角色後 access token 內的舊權限仍然有效直到過期，所以管理台在角色變更後會提示
撤銷該使用者的 session。

### 6.5 平台設定

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/config` | 所有可調參數，含 `fallback`（環境／預設）與 `effectiveValue`（實際生效） |
| `GET` | `/admin/config/pricing` | 計費引擎**現在載入**的政策 + `source` |
| `PUT` | `/admin/config/:key` | `{ value, description? }` |
| `DELETE` | `/admin/config/:key` | 移除覆寫，還原為環境／預設 |

三層解析：`platform_config`（資料庫）→ 環境變數 → 程式碼預設。

`PUT` 之後計費引擎會**原地換政策**（`PricingEngine.usePolicy()`），下一張單立即生效。
`effectiveValue` 與 `fallback` 並列，是為了讓操作者看得出「我改的值有沒有真的生效」。

計費參數的單位容易搞錯，管理台在編輯時會提示：
中介費是 minor units（HK$3.50 → `350`），手續費率是 basis points（3.40% → `340`）。

未知的 key → `422 PLATFORM_CONFIG_INVALID`（不是 404：key 不合法，不是路徑不存在）。

### 6.6 財務

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/payouts?status=&merchantId=&limit=&offset=` | → `{ data, total, totals: { pendingNetMinor, paidNetMinor } }` |
| `GET` | `/admin/payouts/:payoutId` | 批次明細 |
| `POST` | `/admin/payouts/:payoutId/mark-paid` | `{ reference? }` |
| `POST` | `/admin/payouts/:payoutId/mark-failed` | `{ reason }` |
| `GET` | `/admin/reconciliation?from=&to=&merchantId=&limit=` | → `{ from, to, rows[], totalDeltaMinor, mismatchedDays }` |

結算批次由訂單**完成時**的狀態機 side effect 產生，把同一商戶、同一服務日的分錄彙總。
標記付款只記錄結果，**不會真的轉帳**。

對帳逐商戶逐服務日比對「訂單上記錄的平台費」與「入帳分錄上的平台費」。
`totalDeltaMinor` 不為零代表有訂單已收款但分錄沒寫入 —— 通常是 outbox 事件失敗。

### 6.7 評價審核

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/reviews?limit=20&cursor=&visibility=VISIBLE\|HIDDEN\|ALL` | 佇列，`visibility` 預設 **`ALL`** |
| `GET` | `/admin/reviews/:reviewId` | 單筆 |
| `POST` | `/admin/reviews/:reviewId/hide` | `200`。body `{ reason ≤300 }`，**必填** |
| `POST` | `/admin/reviews/:reviewId/unhide` | `200`。可逆 |

**隱藏，不是刪除。** 操作者可以壓下一則評價再撤銷決定，但不能銷毀它。
刪除是承受壓力的商戶會想要的手段；可逆、有紀錄的隱藏才是市場平台能辯護的做法。
作者可以刪自己的評價 —— 那是另一件事，在 `ReviewAuthorController`。

`reason` **必填不是可選**：一則不解釋為什麼被藏起來的評價，跟一個 bug 無法區分，
而需要被交代的是商戶。`HideReviewDto` 因此沒有 `@IsOptional()`。

`unhide` 不帶 body、不帶 `reason` —— 撤銷決定不需要理由，而要求一個會讓人
乾脆不撤銷。

`AdminReviewView` 比商戶的多帶作者身分：`merchantId`、`merchantName`、
`customerId`、`hiddenById`、`updatedAt`。

### 6.8 退款申請

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/admin/refund-requests?status=&merchantId=&limit=&offset=` | 全平台工單。`status` 預設 **`ACTIVE`** |
| `GET` | `/admin/refund-requests/:refundRequestId` | 單筆 |
| `POST` | `/admin/refund-requests/:refundRequestId/transition` | 平台介入。同一支 use case，`actor: ADMIN` |

**讀為主，寫為例外。** 平台不是這個對話的其中一方，所以管理台存在的唯一理由，
是讓客服回答「訂單 X 到底發生了甚麼」而不必登入店家的帳號。

唯一的寫入是 `transition`，只為處理店家已停業、失聯等情況。它走店家的
**同一套狀態機與同一支 use case**，所以管理員到不了一個店家到不了的狀態，
而稽核軌跡記的是 `ADMIN`（`resolvedById`），不是假裝店家做的。

`AdminRefundPageView`：`{ data, total }`，`data` 的每一列是
`MerchantRefundRequestView`（含 `merchantId` / `customerName` / `orderStatus`）。

---

## 7. WebSocket

連線：`ws://127.0.0.1:3000/ws?token=<JWT>`（Socket.IO，不是原生 WebSocket）。

**連線時就會自動 join 的房間**：JWT 裡每個 `merchantIds` 對應的 `merchant:{id}`。
其餘房間要靠 `socket.emit` 明示訂閱，**伺服器會驗證擁有權**（客戶端只送 id，
授權判定在伺服器，不然任何登入者都能追蹤任何訂單）。

| Client emit | Body | 加入的 Room | 擁有權檢查 |
|---|---|---|---|
| `subscribe:order` | `{ orderId }` | `order:{orderId}` | `order.customerId === 自己` 或自己是該商戶職員 |
| `subscribe:reservation` | `{ reservationId }` | `reservation:{reservationId}` | **僅** `reservation.customerId === 自己` |
| `subscribe:refund_request` | `{ refundRequestId }` | `refund_request:{refundRequestId}` | **僅** `ticket.customerId === 自己` |

兩者都回 `{ ok: boolean, room?: string }`，失敗一律 `ok: false`（不洩漏資源是否存在）。

> **`subscribe:reservation` 刻意不讓商戶職員加入單筆房間。** 他們已經從
> `merchant:{id}` 收到該店的每一筆訂位事件；而訂位事件 payload 帶著顧客的
> `contactPhone`，不該進一個職員可以列舉 id 去訂閱的房間。

| Room | 誰在裡面 | 事件 |
|---|---|---|
| `merchant:{merchantId}` | 商戶端（自動） | `order.*` **與** `reservation.*` **與** `refund_request.*` 全部（見下方 fan-out 規則） |
| `order:{orderId}` | 顧客端（`subscribe:order`） | `order.paid`、`order.accepted`、`order.preparing`、`order.ready_for_pickup`、`order.completed`、`order.rejected`、`order.expired`、`order.refunded` |
| `reservation:{reservationId}` | 顧客端（`subscribe:reservation`） | `reservation.placed`、`reservation.confirmed`、`reservation.seated`、`reservation.completed`、`reservation.declined`、`reservation.cancelled`、`reservation.no_show` |
| `refund_request:{id}` | 顧客端（`subscribe:refund_request`） | `refund_request.opened`、`refund_request.in_discussion`、`refund_request.resolved_offline`、`refund_request.declined`、`refund_request.cancelled` |
| `merchant:{merchantId}:refund-requests` | 商戶端退款隊列 | 同上（`refund_request.*`） |
| `rider:{riderId}` | 車手 App（Phase 2） | `task.assigned`、`task.cancelled` |
| `order:{orderId}` | 顧客端（Phase 2） | `rider.position` |

### 房間是怎麼決定的

gateway 是 outbox relay 的訂閱者，收到事件後**依 `aggregateType` 分派**：

```
Order         → order:{aggregateId}
Reservation   → reservation:{aggregateId}
RefundRequest → refund_request:{aggregateId}
其他           → 不派送（warn 並丟棄）
```

**再由 `payload.merchantId` 加送一份到 `merchant:{merchantId}`。**

> 這裡曾經有一個 bug：所有事件都無條件送進 `order:{aggregateId}`，
> 於是訂位事件進到 `order:<reservationId>` —— 一個沒人能加入的房間。
> 事件有進 outbox、有被投遞、有被 emit，只是進了空房間。
> 判斷依據必須是 `aggregateType`，不是「反正 id 長得像 UUID」。
>
> 修法是把它寫成一個**窮盡的 switch，`default` 回 `null`**。
> 舊版的 `aggregateType === 'Reservation' ? … : orderRoom(…)` 會讓**任何**未來新增的
> aggregate（退款工單就是第一個）靜靜地掉進 `order:` 房間 —— 也就是再犯一次同一個錯。
> `default` 改成回 `null` 之後，漏掉一個型別是「沒有派送」，而不是「派送去錯的地方」。

事件 envelope（與 `outboxEvent` 同構）：

```json
{
  "eventId": "…",
  "type": "order.ready_for_pickup",
  "aggregateType": "Order",
  "aggregateId": "…",
  "version": 4,
  "occurredAt": "2026-09-24T04:14:03.000Z",
  "payload": {
    "orderId": "…", "orderNo": "20260924-000137", "pickupCode": "A-07",
    "status": "READY_FOR_PICKUP",
    "merchantId": "…",
    "itemSummary": [{ "menuItemId": "…", "name": "招牌叉燒飯", "quantity": 2 }]
  }
}
```

訂位事件是同一個形狀，`aggregateType` 為 `"Reservation"`，`payload` 帶
`reservationId` / `reservationNo` / `merchantId` / `customerId` / `status` /
`partySize` / `startsAt` / `serviceDate` / `customerName` / `contactPhone`。

`version` 是 **aggregate 自己的版本號**（訂單與訂位各自的 `version` 欄位，
每次轉換 +1），不是稽核列數 —— 兩者在同一個 `UPDATE` 裡寫入，所以不會不一致。
Client 必須以 `version` 丟棄亂序／過期事件（`version <= lastSeen` 直接忽略）。

**Redis 缺席時扇出會降級**：`onModuleInit` 不 await SUBSCRIBE（await 會讓
`app.listen()` 永遠不 bind），失敗只記警告。outbox 仍然完整記錄 ——
事件不會遺失，只是不會即時推送。

> **`apps/web` 目前沒有連 WebSocket**（沒有 `socket.io-client` 依賴）。
> 客戶端的「即時」全部是輪詢：廚房板 15 秒、訂位板 20 秒、訂單詳情 5 秒、
> 訂位詳情 15 秒。房間與事件都在後端就緒並在開機時註冊，等客戶端接上。

---

## 8. 健康檢查

| Method | Endpoint | 說明 |
|---|---|---|
| `GET` | `/health` | liveness，永遠 200 |
| `GET` | `/health/ready` | readiness：DB + Redis。**沒有 Redis 時回 503 且 `status: degraded`** —— 這是刻意的，讓 orchestrator 知道要降級而不是重啟 |
| `GET` | `/metrics` | Prometheus（內部網段限定） |

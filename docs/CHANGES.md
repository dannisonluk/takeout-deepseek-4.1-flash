# 本輪改動總結（2026-09-25）

需求：完整檢視專案後主動接手開發，自行迭代設計／撰寫／測試／除錯，一次交付。

店主的六項需求：

1. 店家更新訂單狀態（已收款 / 製作中 / 已完成）— **已完成**（`POST /confirm` + 廚房板具名動作）
2. 退款不經中間平台 — **完成**（本輪，見 §十；只做「退款申請」工單，絕不碰錢）
3. 特別休息日 — **完成**（見 §九）
4. 商戶營業報表（免費 Excel + 加值 BI dashboard）— **未開始**
5. 現場候位 — **未開始**
6. 店內點餐 — **未開始**（需求方自己也說「需要更多設計」）

已完成：需求 1、需求 3、需求 2。以下 §一 ～ §五 是前幾輪的紀錄，
§九 是「特別休息日」，§十 是「退款申請工單」。

---

## 一、外賣自取核心 ✅ 完成

### 1.1 核心概念：`PaymentMode` 是一等維度

到店付款不是「付款失敗的退路」。新增 `PaymentMode`：

| 值 | 結算方式 | 付款處理費 |
|---|---|---|
| `ONLINE` | PSP webhook 自動推進 `PENDING_PAYMENT → PAID` | 依政策計算 |
| `PAY_AT_STORE` | 店家在櫃檯確認後手動推進 | **0** |

到店付款不收 payment processing fee：沒有 PSP 經手那筆錢，收 3.40% + HK$2.35 等於平台默默抽一筆現金單的成，而且看不出來（payout 就是少了）。覆寫記在 `pricingSnapshot.appliedPolicy`，日後對帳可證明為何這單的 payout 與別人不同。

### 1.2 `MANUAL_SETTLEMENT_ALLOWED` guard — 安全的關鍵

`PENDING_PAYMENT → PAID` 對 `MERCHANT` 開放，但**只限 `PAY_AT_STORE`**。

沒有它，`confirm` 就變成通用的「把任何單標成已付款」按鈕。`SYSTEM`（webhook）與 `ADMIN`（人工修正）豁免 —— 前者代表線上渠道真的收到錢，後者是營運上的逃生門且會記進稽核軌跡。

### 1.3 `POST /merchant/:merchantId/orders/:orderId/confirm`

一個動作做三件事：**收款 → 接單 → 給取餐時間**。因為真實店家顧客走到櫃檯時就是一個動作，拆成三個按鈕是在為狀態機建模而不是為店家建模。

對線上付款單也適用（收款步驟會被跳過），所以廚房板只有一個主按鈕，而不是兩個只差付款方式的按鈕。

**部分成功是正確的結果**：若店家已暫停接單，款項仍會記錄（錢確實在他們手上），接單步驟回 409，讓他們去打開接單開關再試一次。把收款回滾等於讓系統否認一件已經發生的事。

### 1.4 `estimatedReadyAt` ≠ `scheduledPickupAt`

| 欄位 | 意義 |
|---|---|
| `scheduledPickupAt` | 顧客**要求**的時間 |
| `estimatedReadyAt` | 店家**承諾**的時間 |

兩者是不同欄位，永不互相覆寫。店家說「比你要求的晚 20 分鐘」是這功能存在的全部意義；合併兩者會讓顧客撲空還怪平台。

只有 `→ ACCEPTED` 會寫入承諾，且後續轉移（如 `PREPARING`）既不能清除也不能覆寫它 —— 顧客被告知 18:45，那就是他們會拿來要求店家的數字。

### 1.5 `pickupNotice` 由 API 產生

新增 `apps/api/src/modules/ordering/domain/pickup-notice.ts`（純函式），涵蓋所有狀態 × 兩種付款模式。前端**逐字渲染**，不自己造句 —— 它需要商戶時區、取餐窗口、訂單金額，前端重算一次就會漂移。tone 也是 API 決定的。

### 1.6 前端

| 頁面 | 改動 |
|---|---|
| `/checkout` | 付款方式選擇器（線上／到店），送到 `paymentMode` |
| `/orders/[orderId]` | 顯示預計取餐時間、約幾分鐘、店家訊息；**隱藏**到店付款單的「前往付款」 |
| `/merchant/orders` | 新增「待確認收款」分頁 + 確認彈窗（快速選 10/15/20/30/45/60 分鐘或自訂，加給顧客的訊息） |

隱藏付款按鈕這點很重要：留著它會把顧客推進一個 API 會用 `409 PAYMENT_NOT_REQUIRED` 擋掉的付款流程。

---

## 二、順手挖出並修掉的缺陷

### 2.1 ⚠️ 最嚴重：帶 `Idempotency-Key` 下單會 500 —— 顧客完全無法點餐

**症狀**：`POST /orders` 帶 `Idempotency-Key` header 時回 `500 INTERNAL_ERROR`。

**根因**：冪等只靠 controller 裡一個 Redis `SET NX` 鎖，而 `orders` 表**根本沒有** idempotency 欄位。`RedisService.acquire` 是刻意 fail-closed 的，所以 Redis 不可達時每一次結帳都 500 —— 而 Postgres 明明有能力分辨兩次提交。

**為什麼以前沒被發現**：`e2e-smoke` / `e2e-admin` / `e2e-payments` **沒有任何一支**在 `POST /orders` 上送過 `Idempotency-Key`。那條路徑從來沒被執行過。

**修法（三層）**：

1. `orders.idempotencyKey VARCHAR(120)` + UNIQUE index。欄位**可為 null**：呼叫方沒有義務送，API 只在有 key 時承諾冪等；NULL 在 Postgres unique index 不互相衝突。
2. `PrismaOrderRepository.insertOrder` 把 P2002 on `idempotencyKey` 翻成 `ConflictOnIdempotencyKey`（409）。**其他 P2002 刻意不翻** —— `orderNo` 撞號是序號產生器的 bug，吞成「重複的 idempotency key」會把真缺陷藏在一個叫呼叫方「不要再重試」的訊息後面。
3. 新增 `RedisService.tryAcquire`，回 `true | false | null`（`null` = Redis 答不了）。Controller 只在 `=== false` 時拒絕，`null` 就落到資料庫判斷。原本 fail-closed 的 `acquire` 保留給 daily-quota guard —— 那裡鎖本身就是保護。

> **教訓**：一個 fail-closed 的鎖若同時是唯一的保護，就是可用性單點。鎖只能是快路徑，耐久約束要在資料庫。

### 2.2 `MANUAL_SETTLEMENT_NOT_ALLOWED` 沒登記狀態碼

`domain-exception.filter.ts` 的狀態碼表少了這一項，落到預設 422。它是跟 `ILLEGAL_ORDER_TRANSITION` 同一類的拒絕，改為 **409**。

### 2.3 店家無法處理做不出來的到店付款單（設計漏洞）

原本店家**既不能結算也不能拒絕**一張還沒收款的到店付款單，只能等逾時。已開放：

```
PENDING_PAYMENT → CANCELLED   actors: [MERCHANT]   guards: [MANUAL_SETTLEMENT_ALLOWED]
```

同樣只限 `PAY_AT_STORE` —— 顧客可能正在 3-D Secure，取消會讓 capture webhook 打到終態訂單。

### 2.4 `transition()` 的規則選取邏輯

同一個 `to` 可以有多條規則、各自 guard 不同（店家可取消未收款的到店付款單，顧客可取消自己的未付款單）。原本 `rules.find(r => r.to === to)` 會拿到**第一條**，於是要嘛套錯 guard、要嘛直接拒絕一個表上允許的動作。改成優先挑「實際允許這個 actor」的規則。

### 2.5 ⚠️ `ReservationTransitionView` 宣告了 `id`，實際回傳 `reservationId`

**這是 `contract-check` 加訂位 shape 時當場抓到的**，也是這一節裡最值得記的一個，因為它展示了一種「兩邊都編譯得過」的錯誤形態。

根因：兩個 controller 都不是自己組裝轉換回應，而是 `return { ...result, reservation: view ?? owned }` —— 直接把 `TransitionReservationUseCase` 的 `TransitionReservationResult` 攤開。那份結果的欄位叫 `reservationId`。

而 `interface/reservation.view.ts` 裡的 `ReservationTransitionView` 宣告的是 `id`。**這個型別從來沒有被任何地方引用過**（`grep -rn ReservationTransitionView apps/api/src/` 只有宣告那一行），所以它寫錯不會有任何編譯錯誤；前端照著它寫 `transition.id`，執行期拿到 `undefined`。

為什麼以前沒被發現：轉換回應的 id 在前端兩個訂位頁面裡都只是拿來 toast 顯示，`undefined` 不會讓頁面壞掉 —— 它只會讓訊息少一段。這正是「靜默的資料缺漏」，跟 §2.1 的 idempotency 500 是同一個家族。

三層修法：
1. `reservation.view.ts` 的 `ReservationTransitionView` 改成 `reservationId` + `occurredAt`，並在檔頭寫明「這裡必須鏡射 use case 的形狀，因為 controller 是展開它、不是重新組裝」；
2. `apps/web/src/lib/types.ts` 的 `ReservationTransition` 同步改掉；
3. `contract-check.js` 加入 `ReservationTransition` 的雙向比對 —— **而且要用一次真實的轉換去比**，不是只宣告。這一條現在會在任何一邊改名時立刻變紅。

> 教訓：**「宣告了但沒引用」的型別是負資產。** 它給人一種「這個合約有型別保護」的錯覺，但因為組裝點沒有用它，TS 完全不會檢查。要嘛讓組裝點回傳那個型別（`const view: ReservationTransitionView = {...}`），要嘛刪掉它、只留一份真的會被檢查的東西。目前選了後者＋contract check。

### 二.4 訂位的 WebSocket 事件全部丟進錯的房間

`OrderGateway.fanOut()` 對**每一種** outbox 事件都做 `server.to(orderRoom(event.aggregateId))`。
訂位事件也被當成訂單事件處理，於是 `order:<reservationId>` —— 一個客戶端永遠連不到的房間
（`subscribe:order` 會拿這個 id 去查 `order` 表，查不到就回 `ok: false`）。
`packages/domain` 早就定義了 `reservationRoom()` 與 `merchantBookRoom()`，但**沒有任何地方引用**，
所以這個 bug 從頭到尾都不會有人發現：事件確實進了 outbox、relay 確實投遞了、
gateway 確實 emit 了 —— 只是進了一個空房間。

為什麼以前沒被發現：這個 app 的 `apps/web` **完全沒有連 WebSocket**（沒有
`socket.io-client` 依賴），所有即時性都靠輪詢。所以「事件進錯房間」在目前的產品裡
沒有任何可觀察的後果。它是真 bug，但也是潛在的。

兩層修法：
1. `fanOut()` 依 `event.aggregateType` 分派：`'Reservation'` → `reservationRoom()`，其餘 → `orderRoom()`；
2. 新增 `subscribe:reservation` 事件處理，擁有權檢查照 `subscribe:order` 的樣板
   （查 `reservation.customerId` 是否等於自己）。**刻意不讓商户職員訂閱單筆房間** ——
   他們已經從 `merchant:{id}` 收到每一筆訂位，而顧客的 `contactPhone` 不該進一個
   職員可以列舉的房間。

> 教訓：**domain 層宣告的 helper 沒被引用，就是「還沒接上」的意思。** 這跟二.3 的
> `ReservationTransitionView` 是同一個病：`reservationRoom` 有定義、有型別、有測試覆蓋，
> 但組裝點沒用它。domain 的 `index.ts` 用 `export *` 全量匯出，所以「多了一個沒人用的
> export」在 code review 裡看起來完全正常。

### 二.5 顧客端看不到商戶對訂單/訂位的動作

`/orders/[orderId]` 與 `/reservations/[reservationId]` 兩個顧客頁面**只在
「這個 tab 自己發出的動作」之後**才 `reload()`。商戶在後台接受訂單、確認訂位時，
顧客那邊的畫面停在掛載時的那一刻，直到手動重新整理。`useTicker(1000)` 只讓
「倒數計時」那行數字動，不會重新拉資料 —— 很容易誤讀成「已經有即時更新」。

修法：兩頁各加一個 `setInterval` 輪詢（訂單 5 秒、訂位 15 秒），並在狀態進入終態時停掉
（對一張已完成的單永遠輪詢只是無謂負載）。終態判斷收斂到 `format.ts` 的
`isTerminalOrder()`，取代原本硬寫在 render 裡的陣列字面值 —— 同一份清單本來在
訂單詳情頁出現兩次。

---

## 三、預約訂位系統 ✅ 完成（domain + schema + API + 前端）

### 3.1 設計決策

| # | 決策 | 理由 |
|---|---|---|
| 1 | 獨立模組，不共用 `OrderStatus` | 訂位沒有付款腿、沒有配額，終態也不是訂單終態的子集。共用 enum 會逼每個訂單狀態對一張桌位都有意義 |
| 2 | **容量算「座位」不算「桌」** | 數桌的話 4 張桌的店可以接 4 張 8 人訂位 —— 一個兌現不了的承諾 |
| 3 | **一筆訂位佔用它涵蓋的每一個起始時段** | 90 分鐘翻桌在 30 分鐘格子上吃掉 19:00 / 19:30 / 20:00 三格。只扣 19:00 就是「同一張桌賣兩次」，要等到某個週六晚上才現形 |
| 4 | `turnMinutes` 存在 reservation 上，釋放時不讀當下設定 | 店家改短翻桌時間後，已在簿上的訂位仍必須歸還當初拿走的那些格子。讀設定會把差額永遠留在 `reservation_slots`，簿子會慢慢看起來比實際滿 |
| 5 | `reservation_slots` 只存 `booked`，不存 capacity | capacity 從 settings 即時讀，調低 `seatsPerSlot` 立刻生效，而不是只對還沒被人訂過的格子生效 |
| 6 | `RELEASE_TABLE_SLOT` 只出現在離開 active 集合的路徑上 | 確認（CONFIRMED）不釋放 —— 釋放等於把桌子讓給別人而這組客人還拿著它 |
| 7 | `WITHIN_TURN_WINDOW` guard | 不能在訂位時間之前標記 no-show，否則店家中午就能把今晚的簿清掉，把位子讓給別人，而原本那組還打算來 |
| 8 | domain 不做時區換算 | `SlotGrid` 由呼叫端傳入**該時刻**的 `utcOffsetMinutes`（不是固定值，DST 才不會錯）。domain 保持零依賴 |
| 9 | **店家的按鈕由 `allowedNextTransitions` 投影出來，不是前端硬編生命週期** | `MerchantOrderView` 沒有這個欄位，所以廚房板只能鏡射一份 `ACTIONS_FROM` 表。訂位刻意回傳它 —— 規則改了不用重新部署前端，也永遠不會畫出一個伺服器會拒絕的按鈕 |
| 10 | **`canCancel` 由伺服器算，不由前端從 status 推** | 前端推出來的取消鍵遲早會在伺服器拒絕時被顧客讀成 bug |
| 11 | `reservation-availability` 是**公開無 guard** 的，且吃 **UUID 不吃 slug** | 訂位頁必須在知道「誰在看」之前就畫得出營業時間；把登入牆擋在「這家店幾點有位」前面是反的。吃 UUID 是因為顧客頁面本來就拿得到 merchant id |
| 12 | `ReservationTransitionView` 的 id 欄位叫 `reservationId`，不叫 `id` | 兩個 controller 都是 `{ ...result, reservation }` 展開 use case 的回傳，沒有重新映射。詳見 §二·2.5 —— 這裡踩過坑 |

### 3.2 生命週期

```
PENDING ──CONFIRMED── SEATED ──COMPLETED
   │          │          │
   │          └──CANCELLED / NO_SHOW
   └──CANCELLED / DECLINED / NO_SHOW
```

- active：`PENDING` / `CONFIRMED` / `SEATED`
- 終態：`COMPLETED` / `DECLINED` / `CANCELLED` / `NO_SHOW`
- 顧客只能**取消**，永遠不能確認或入座；店家三者皆可

### 3.3 已完成清單

**Domain / schema**
- ✅ `packages/domain/src/reservation/`（status / errors / policy / state-machine / events）
- ✅ 35 個新單元測試，`npm test` → **179/179**
- ✅ `prisma/schema.prisma`：`ReservationStatus` enum、`Reservation`、`ReservationSettings`、`ReservationSlot`
- ✅ migration `20260925060000_add_reservations` 已套用

**API**（`apps/api/src/modules/reservation/`）
- ✅ `application/`：`PlaceReservationUseCase`、`TransitionReservationUseCase`、`ReservationQueryService`
- ✅ `infrastructure/`：`PrismaReservationRepository`（slot 條件式 upsert、advisory lock、`version` 樂觀鎖、transactional outbox）
- ✅ `interface/`：顧客 controller（4 條）＋ 店家 controller（11 條），共 **15 條路由**
- ✅ `reservationNo` 格式 `R-YYYYMMDD-NNNN`；`POST /reservations` 吃 `idempotency-key`

**前端**（`apps/web/`）
- ✅ `lib/types.ts`：`ReservationStatus`、`ReservationPolicy`、`ReservationSlot`、`ReservationAvailability`、`CustomerReservation`、`MerchantReservation`、`ReservationSettings`、`ReservationCreated`、`ReservationTransition` + 3 個 request 型別
- ✅ `lib/api.ts`：`api.reservations`（5 個方法）＋ `api.bookings`（4 個方法）
- ✅ `lib/format.ts`：`RESERVATION_STATUS_LABEL` / `_TONE` / `RESERVATION_SHORT_LABEL` / `RESERVATION_ACTOR_LABEL` / `RESERVATION_PROGRESS` / `reservationProgressIndex` / `isActiveReservation`，加 4 個時區安全的日期工具（`localDateKey` / `localDateLabel` / `addDays` / `isPastDate`）
- ✅ 6 條新路由：

| 路由 | 內容 |
|---|---|
| `/m/[slug]/reserve` | 顧客訂位頁（server 殼 + client 互動）。日期籤、人數步進、時段格、表單、`autoConfirmed` 導向 |
| `/m/[slug]` | 側欄加「立即訂位」入口 |
| `/reservations` | 顧客訂位列表，**依 `serviceDate` 分組**（今天／已過去） |
| `/reservations/[reservationId]` | 顧客訂位詳情，進度條、取消 Modal（吃 `canCancel`） |
| `/merchant/reservations` | 商戶訂位簿，日期籤 + 分頁 + 輪詢，**按鈕全部由 `allowedNextTransitions` 產生** |
| `/merchant/reservations/settings` | 訂位設定，form 內先驗 `min<=max`、`turn>=slot` |

- ✅ nav：`navForRole` 加「訂位簿」（帶待確認 badge）與「我的訂位」；`CustomerNav` 加「我的訂位」

**驗證**
- ✅ `scripts/e2e-reservation.js`（**36 項**）
- ✅ `scripts/contract-check.js` 加 **18 個**訂位 shape 的雙向比對（39 → **56 agree**）
- ✅ README / 本文件的指令表同步

---

## 四、新增的永久資產

### `scripts/e2e-pay-at-store.js`（48 項檢查）

`npm run e2e:pay-at-store`。涵蓋完整跨 context 流程，並釘住三個拒絕：

| 檢查 | 預期 |
|---|---|
| 到店付款單 `POST /payment-intent` | `409 PAYMENT_NOT_REQUIRED` |
| 線上單 `POST /confirm` | `409 MANUAL_SETTLEMENT_NOT_ALLOWED`，且**沒留下**任何 payment row 或狀態變更（guard 必須在任何寫入之前被諮詢） |
| 線上單 `POST /cancel` | `409`（顧客可能正在 3-D Secure） |

另有兩條只在**沒有 Redis** 的機器上才有意義的斷言（重播的 key → 409、且沒有產生第二張單）—— 若 409 來自 Redis 快取就代表測不到耐久約束，所以這兩條是 DB 唯一索引的證明。

> 踩到的坑：**絕對值斷言是陷阱**。第一版寫 `assert.equal(held, 1)`，實際是 5 —— 前面的章節各自留下訂單佔著配額。改成量測 **delta**（下單前後 +1、取消後回到原值）。

### `scripts/contract-check.js` 強化

- 修正過期的 `MerchantOrder` / `PlatformConfigEntry` 期望欄位清單
- 新增 `CustomerOrder`、`CustomerOrder.items[0]`、`OrderCreated`、`OrderCreated.pricing`
- **表是空的時候自己造一張 probe 單**：`e2e-pay-at-store` 會 TRUNCATE `orders`，所以 `e2e:all` 之後跑 contract check 會靜默跳過 4 個最重要的 shape 還印 PASS。現在跑完**先取消再刪列** —— 先取消是為了讓 `RELEASE_DAILY_QUOTA` 把 `held` 還回去，直接刪單會留下虛高的 `held`（正是讓反覆執行逐漸逼近配額上限的陷阱）
- 新增 **18 個訂位 shape** 的雙向比對：`ReservationAvailability`（含其**窄版** `policy`）、`ReservationSlot`、`ReservationSettings`（含 `policy`）、`ReservationCreated`、`CustomerReservation`（同時從 list 與 detail 兩條不同的組裝路徑各驗一次）、`MerchantReservation`、`MerchantReservation.allowedNextTransitions`、`ReservationTransition`（店家與顧客各一次）
- 訂位段自己開書、下單、然後**在 `finally` 裡復原**：
  - 收尾用 **API 取消**、不是刪表 —— `reservation_slots` 的 `booked` 是 `(merchantId, slotStart)` 上的**計數器**，沒有指向單筆訂位的欄位。直接刪 reservation 列會留下虛高的 `booked`，下一次執行就從一本幽靈滿的簿子開始
  - `enabled` 還原成**進場時的值**，不是硬設 `false` —— 不然每個跑這支腳本的開發者都會被靜默改掉本機狀態
  - 下單前**把 `autoConfirm` 關掉**，這樣訂位會落在 `PENDING`：`autoConfirm` 預設 `true` 的話會直接變 `CONFIRMED`，而 `CONFIRMED` 的店家動作只剩 `SEATED / CANCELLED / NO_SHOW`，顧客取消那條路徑就測不到了

### `scripts/e2e-reservation.js`（36 項檢查）

`npm run e2e:reservation`。涵蓋完整訂位生命週期，並釘住容量與釋放的對稱性：

| 檢查 | 預期 |
|---|---|
| 未開書時 `GET …/reservation-availability` | 回 `enabled: false` + 一句 `notice`（不是 404、不是空洞） |
| 開書後下單 | `R-YYYYMMDD-NNNN`、`PENDING`、**恰好 3 個 slot 列 × 4 座位**（90 分鐘翻桌 / 30 分鐘格） |
| 容量剛好滿足 vs 超額 | 8 座位剛好 OK；再一筆 → `422 RESERVATION_SLOT_UNAVAILABLE` |
| `confirm` | **不釋放任何座位**（釋放＝把還在拿著的桌子讓給別人） |
| 訂位時間之前 `no-show` | `409`（`WITHIN_TURN_WINDOW`） |
| 顧客取消 | 對稱釋放，`booked` 回到原值 |
| `autoConfirm: true` | 下單即 `CONFIRMED` |
| 孤兒座位不變量 | 每個 slot 的 `booked` == 它涵蓋的 active 訂位座位數總和 |

> 這支腳本第一版有斷言 bug：檢查了**每一個** slot 列而不是「這筆訂位實際佔用的那幾格」。症狀是明明行為正確卻紅燈。

---

## 五、驗證結果（全綠）

| 項目 | 結果 |
|---|---|
| `npm test` | **179/179**（+35 訂位、+4 取消未收款單） |
| `npm run typecheck` | domain / api / web 三個 workspace 全乾淨 |
| `next build` | **26 條路由**成功（+6 訂位頁；**需在沙箱外跑**） |
| `e2e-smoke` | 48 |
| `e2e-admin` | 79 |
| `e2e-reservation` | **36** |
| `e2e-pay-at-store` | 48（連跑兩次都過） |
| `e2e-payments` / `e2e-feedback` / `e2e-timeouts` / `e2e-metrics` | 53 / 65 / 29 / 15 |
| `check:pricing` | PASS |
| `check:contract` | **56 agree** / 1 skipped（39 → 56，+18 個訂位 shape 的雙向比對） |

開機實測：API 啟妥後 **15 條**訂位路由全部 Mapped；`next start` 後 `/`、`/m/dim-sum-express`、`/m/dim-sum-express/reserve`、`/reservations`、`/login` 全部 200，訂位頁與店家頁的「立即訂位」入口都真的渲染出來。availability 端點回 670 格 / 14 日 / `Asia/Hong_Kong`。

### 本輪追加驗證

改完 gateway 與前端輪詢後重驗：

| 項目 | 結果 |
|---|---|
| `npm test` | **179/179** |
| `npm run typecheck` | domain / api / web 三個 workspace 全乾淨 |
| `npm run build -w @takeout/domain` + `-w @takeout/api` | 通過（`dist/main.js` 產生） |
| 開機實測 | `node apps/api/dist/main.js` 成功 bind 3000；log 見 `OrderGateway subscribed to the "subscribe:order"` **及** `"subscribe:reservation"`；`RoutesResolver` 列出 **170 條** route |
| `e2e` / `e2e:admin` / `e2e:reservation` / `e2e:pay-at-store` | 48 / 79 / 36 / 48，全部 PASS |
| `e2e:payments` / `e2e:feedback` / `e2e:timeouts` / `e2e:metrics` | 53 / 65 / 29 / 15，全部 PASS |
| `check:pricing` | PASS |
| `check:contract` | **56 agree** / 1 skipped |
| `next build` | **未能在沙箱內完成** —— 兩道 safe-delete 障礙，非程式碼問題（見 §七）。`apps/web` 的 `tsc --noEmit` 全量通過 |
---

## 六、Migrations

| 名稱 | 內容 |
|---|---|
| `20260924205427_add_order_eta_and_payment_mode` | `paymentMode`、`estimatedReadyAt`、`readyInMinutes`、`merchantNote` |
| `20260924210159_add_manual_payment_provider` | `PaymentProvider.MANUAL` |
| `20260924211500_add_order_idempotency_key` | `orders.idempotencyKey` + UNIQUE |
| `20260925060000_add_reservations` | 訂位三張表 + enum |
| `20260925090000_add_closures_waitlist_dining_refunds` | `merchant_closures`（本輪用到）＋ 候位 / 店內點餐 / 退款工單（後續需求預先建好） |

---

## 七、新的環境陷阱

- **`prisma generate` 在 API 還在跑時會 EPERM**（API 持有 `query_engine-windows.dll.node`）。要先停掉 API 再 generate。
- **`prisma migrate dev` 在非互動環境直接拒絕執行**（「non-interactive is not supported」）。改用：
  ```bash
  npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                          --to-schema-datamodel prisma/schema.prisma --script
  ```
  產生 SQL → 手寫進 `prisma/migrations/<ts>_<name>/migration.sql` → `npx prisma migrate deploy`。
- **`node apps/api/dist/main.js &` + `curl` 會讓 API 在 curl 那一刻死掉**。用 `nohup … &` 也一樣 —— 背景子行程跟著啟動它的那個 shell 一起被殺，症狀是 curl 回 `000`（連線失敗）而不是任何 HTTP 狀態。要跑「啟 API → 打它」的流程，API 必須用**受管理的背景任務**啟動（本工具的 `run_in_background`），不是 shell 的 `&`。
- **`contract-check` 的訂位段必須在「商戶後台」段之後**。`reservation-availability` 吃 **UUID**，不吃 slug，所以它得先從 `/merchant/mine` 或 `/merchants/<slug>` 拿到 id。拿 slug 去打會得到 `400 Validation failed (uuid is expected)`，看起來像路由寫錯、其實是參數型別。
- **`next build` 有兩道 safe-delete 障礙，不是一道**。第一道是已知的 `.next/trace` `EPERM`；第二道是 Next 在**同一個 turn 內**批次刪 `.next` 底下的既有檔案（`types/app/**`、`package.json` 等），超過 50 個就觸發 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 而中止。`rm -rf apps/web/.next` 先清乾淨可以讓第二道不出現，但第一道的 `EPERM` 只有真的在沙箱外跑才會過。`npm run typecheck` 對 `apps/web` 是 `tsc --noEmit` 全量，所以型別錯誤在沙箱內一定抓得到。
- **前端沒有 `socket.io-client`**。後端 `order:{id}` / `reservation:{id}` / `merchant:{id}` 三個房間與事件都實作好了，但 `apps/web` 從來沒連過 WebSocket —— 所有「即時」都是 `setInterval` 輪詢（廚房板 15 秒、訂位板 20 秒、訂單詳情 5 秒、訂位詳情 15 秒）。看到 `useTicker` 不要以為那是 push。
- **`check:contract` 的 `agree` 數字浮動，判準是「0 fail」不是某個固定值**。`AdminPayment`、`AdminRefund`、`AdminPayout`、`Reconciliation` 這四項都需要資料庫裡真的有付款資料；`e2e:pay-at-store` 會 TRUNCATE `orders`，所以 `npm run e2e:all` 之後跑 contract check 會看到 `53 agree / 5 skip`，而先跑 `npm run e2e` 再跑同一支會是 `56 agree / 2 skip`。**兩者都是 PASS。** 把 56 寫成期望值會在下一個人跑 `e2e:all` 時得到一個假的紅燈。

---

## 八、前幾輪的未完項（現況見 §十一）

前幾輪當時列出的未完項：

- 需求 4：
  - **特別休息日** —— 需同時影響取餐時段（`pickup-slots`）與訂位（`reservation-availability`）。目前兩者都會把「本週固定營業時間」當成唯一真相，所以公眾假期仍然會開放出時段 → **本輪已完成，見 §九**
  - **商戶營業報表** —— 真 SQL 聚合（現時 dashboard 的數字是逐筆讀出來在記憶體加總）
  - **現場候位（walk-in waitlist）** —— 目前只有預約，沒有「排隊等位」這一條路
- 訂位的前端**尚未做 browser 層的互動測試** —— 目前只驗到「路由 200 + server render 出正確的殼 + 打真實 API 的 availability 拿到正確 JSON」。按鈕真的按下去、Modal 真的開、`allowedNextTransitions` 真的畫出對的按鈕，都是靠型別與 contract check 保證，不是靠瀏覽器驅動

### 已在本輪補上

- ✅ `docs/API.md` 補上**訂位 15 條路由**（§3.5 顧客端、§4.6 商戶端）、**評價 12 條路由**
  （§3.6、§4.7、§6.7）、以及**圖片**的完整路由表與公開讀取端點（§4.3）。
- ✅ `docs/API.md` 的 `Domain code → HTTP status` 對照表補上 11 個訂位碼 +
  評價 5 個 + 圖片 3 個 + 支付 6 個，並補上「第三種分頁（cursor + summary）」。
- ✅ `README.md` §已驗證 的過期數字全部更正（61→**179** 個單測、127→**八支腳本**、
  37→**56** 個契約檢查、20→**26** 條路由），並列出 `e2e:reservation` / `e2e:pay-at-store` /
  `e2e:payments` / `e2e:feedback` / `e2e:timeouts` / `e2e:metrics`。
- ✅ **修好一個真的 bug**：`OrderGateway.fanOut()` 把訂位的 outbox 事件也丟進
  `orderRoom(event.aggregateId)`，也就是 `order:<reservationId>` —— 客戶端永遠連不到。
  改為依 `aggregateType` 分派到 `reservation:{id}`，並新增 `subscribe:reservation`
  事件處理（擁有權檢查與 `subscribe:order` 同款）。開機 log 已確認
  `OrderGateway subscribed to the "subscribe:reservation" message`。
- ✅ **顧客端兩個頁面補上輪詢**：`/orders/[orderId]` 每 5 秒、`/reservations/[reservationId]`
  每 15 秒（並在終態停止）。此前訂單狀態只有「這個 tab 自己做的動作」才會更新，
  商戶那邊接受訂單時顧客畫面完全不動。
- ✅ `format.ts` 新增 `isTerminalOrder` / `TERMINAL_ORDER_STATUSES`，把訂單詳情頁
  本來硬寫在 render 裡的終態陣列收斂到一處。

### 已記錄、刻意不做的

- **WebSocket 的客戶端**。房間與事件都在後端就緒了，但 `apps/web` 沒有
  `socket.io-client` 依賴。加它會動到 `package.json` 與部署設定，而 15 秒輪詢
  在 Phase 1 的規模完全夠用（商戶看板也是這樣做的）。要接的時候再接。
- **`next build` 在沙箱內跑完**。已知的兩個 safe-delete 障礙（見 `README.md`
  §環境注意事項）。`typecheck` 在沙箱內是全量的，所以型別一定驗得到；
  沙箱外的完整 build 由 owner 跑。

> 這一段的狀態數字在 §九（特別休息日）與 §十（退款申請工單）之後已全部過時：
> 單測 179→**219**、腳本八→**十**、契約檢查 56→**65–69（浮動）**。最新數字一律看 `README.md`。

### 同一個 WebSocket bug 又被踩了一次

上面第一條「已在本輪補上」修的 `OrderGateway.fanOut()` 缺陷，**在加入退款事件時以同一種方式復發**——
當時的修法是把三元運算子換成一個 `if/else` 鏈，而不是窮舉 switch。加入 `RefundRequest`
之後，退款事件同樣靜默地落進 `order:`。這次修成窮舉 switch + `default: null` + 大聲 warning，
理由與過程見 §10.5.1。

> **教訓：修一個「分類式缺陷」時，要修到「新增成員會編譯失敗或大聲吵」，不是只修好當下那一個成員。**
> 三元運算子的 `else` 分支和 `if/else` 鏈的尾端一樣，都是「什麼都吃」的預設值。

---

## 九、特別休息日 ✅ 完成（domain + schema + API + 前端）

店主原話：**「沒有甚麼特別休息，店家可以預先設定選擇休息又或者設定固定的每個星期休息時間」**。
選擇的實作方式：**擋新單 + 自動取消既有訂位 + 訊息提示預定取消**。

### 9.1 設計決策

| # | 決策 | 理由 |
|---|---|---|
| 1 | **休息是一個日期，不是一段時間** | 「下午 2–5 點休息」是**營業時間**問題（改 `/hours`），不是「今天不開」。硬塞進同一個模型會逼 `pickup-slots` 為它重新推導每個時段——兩個真相 |
| 2 | **每週固定休息用既有的 `PUT /hours`（`isClosed: true`），`merchant_closures` 只放例外** | 「每週三休」是 7 筆固定設定的一格；若用約會表，店家得每週新增一筆，漏一次就開錯門 |
| 3 | **沒有「特別 / 一般」的分類** | 那是內部的稅務語彙。店家心裡只有「這天不開」與「為什麼」——後者是 `reason` 標籤，不是規則 |
| 4 | **`reason` 是標籤，不是規則** | `describeClosure()` 優先顯示店家自己的 `note`。分類只影響一行預設文案，不影響任何授權判斷 |
| 5 | **`closureCancellationReason()` 與 `describeClosure()` 刻意分開** | 稽核軌跡寫 `MERCHANT_CLOSED:2026-10-01`，不是店家改得動的一句人話。`note` 換了，取消的原因不會跟著被改寫 |
| 6 | **先提交休息日，再掃描取消訂位** | 反過來的話，掃描期間休息日對其他請求還不可見，顧客能在空窗裡訂到一張馬上會被取消的位子 |
| 7 | **`cancelledReservationsAt` 是冪等閂** | 崩潰後留下「已休息但還沒清乾淨」的耐久標記；重複 `PUT` 靠它回 `alreadySwept`，不會發第二次事件 |
| 8 | **取消走 `ReservationStateMachine`，不是把計數器減掉** | 只有狀態機會產生 `RELEASE_TABLE_SLOT`（歸還座位）與 `reservation.cancelled`（通知顧客）。手動減計數會留下孤兒座位 |
| 9 | **`DELETE` 不復原已取消的訂位** | 取消已通知、座位已歸還、事件已發出。復原等於憑空重訂一批人沒答應新時間的位子 |
| 10 | **休息日的時段是「整格移除」，不是 `bookable: false`** | `false` 讀起來是「滿了」，顧客會一直換時段試；移除 + 明列 `closedDates` 才講得出「這天不開」 |
| 11 | **`closedReason` / `closureDate` 是伺服器算的合成欄位** | 光看 `slots: []` 分不出售完、未設營業時間、公眾假期、還是休息日——四種都要不同的顧客文案，而這些理由只有伺服器知道 |
| 12 | **`closureDate` 只掃 24 小時視窗** | 顧客能選的時間本來就只有 `MAX_ADVANCE_HOURS`。回一個他根本訂不到的日期只會誤導 |

### 9.2 一個真相：`pickup-policy.ts`

`checkOpening()` 加了第 4 個**可選**參數 `closures?: ReadonlySet<string>`：

```ts
if (closures && closures.size > 0) {
  const serviceDate = localDateString(timeZone, at);
  if (closures.has(serviceDate)) return { open: false, reason: 'CLOSED_FOR_CLOSURE', serviceDate };
}
if (hours.length === 0) return { open: false, reason: 'NO_HOURS_CONFIGURED' };
```

- 休息日**先於** `hours` 判斷，且與它**互相獨立**：一間還沒設定營業時間的店
  仍然可以被標記為休息，而「未設定營業時間」不等於休息（那是刻意的——
  否則新入駐的商戶永遠開不了店）。
- 參數是**可選**的，所以每一個既有呼叫端與測試**行為完全不變**。

三個呼叫端因此共用同一個真相：

| 呼叫端 | 效果 |
|---|---|
| `PickupSlotsService.build()` | 顧客看到的取餐時段 |
| `PlaceOrderUseCase.assertPickupSlotFeasible()` | `POST /orders` 實際接受的下單 |
| `planAvailability()`（訂位） | 訂位格子 |

### 9.3 兩個真的 bug（都是 e2e 抓到的，單元測試看不到）

#### ⚠️ 9.3.1 訂位寫入路徑**完全沒有**查休息日

**症狀**：休息日的時段在 `reservation-availability` 被整格移除，
但**直接 `POST /reservations` 仍然回 201**。

**根因**：`PlaceReservationUseCase` 從來沒問過 `MerchantClosure`。
格子藏住了那一天，但格子是**查詢**——一個開著舊頁面的顧客、
或任何一支自己接的客戶端（`e2e-closure.js` 就是），可以完全繞過它。

**為什麼單元測試抓不到**：`planAvailability` 的 15 個新測試全部在驗「格子怎麼算」，
而那個函式的輸入本來就沒有「現在幾點、這天開不開」之外的東西。
缺口在**另一個檔案**——use case 那條寫入路徑上。

**修法**：`PlaceReservationUseCase` 在下單前 `merchantClosure.findUnique`
該服務日，命中就丟新的 `MerchantClosedForReservationError`（`MERCHANT_CLOSED`，422）。

> 刻意**不重用** `RESERVATION_SLOT_UNAVAILABLE`：那個碼的意思是「這個時段剛被訂走」，
> 前端要顯示的是「換個時段」；店家休息時顧客該做的是「換一天」。
> 同一個 422 講兩件不同的事，前端就只能猜。

> **教訓：只在查詢端過濾的「擋」不是擋。** 任何「這個不能被建立」的規則，
> 都要在**建立它的那一支**再問一次。查詢端的過濾是 UX，寫入端的檢查才是規則。

#### 9.3.2 `closureDate` 永遠是 `null`

**症狀**：休息日明明存在，`GET /pickup-slots` 的 `closureDate` 仍是 `null`。

**根因**：第一版 `firstClosureDate()` 從**最早可取餐時間**起、逐小時走到
**最晚可取餐時間**，也就是只掃了 24 小時的地平線，而且把已經在
`ReadonlySet<string>` 裡的**日期**用時區換算**重新推導**一次。
兩個問題疊起來：掃不到，而且推出來的也不對。

**修法**：直接掃集合本身，取 `[today, localDate(latest)]` 內的最小值：

```ts
for (const date of closures) {
  if (date < from || date > to) continue;
  if (earliest === null || date < earliest) earliest = date;
}
```

> **教訓：手上已經有的值不要重新推導。** 這裡的 `closures` 就是一份
> `YYYY-MM-DD` 的集合，答案只需要一個 `min`；把它轉成時刻再轉回日期，
> 除了慢，還引入了一次時區往返可以出錯的機會。

### 9.4 已完成清單

**Domain / schema**
- ✅ `packages/domain/src/merchant/closure-policy.ts`（`ClosureReason`、`ClosureDay`、
  `isClosedOn`、`closuresWithin`、`describeClosure`、`closureCancellationReason`、
  `isClosureCancellationReason`）
- ✅ `AvailabilityQuery` 加 `isDateOpen` / `localDateOf` / `slotDates`（皆可選）
- ✅ **15 個新單元測試**`tests/closure.spec.ts`，`npm test` → **194/194**
- ✅ migration `20260925090000_add_closures_waitlist_dining_refunds` 已套用（同時建了
  候位 / 店內點餐 / 退款工單三組表，供後續需求使用）

**API**
- ✅ `MerchantClosureService`（`list` / `findOne` / `upsert` / `remove` / `sweep` /
  `cancelOne` / `timezoneOf`）
- ✅ 4 條路由：`GET /closures`、`GET /closures/:serviceDate`、
  `PUT /closures/:serviceDate`、`DELETE /closures/:serviceDate`
- ✅ `PickupSlotsService` 與 `PlaceOrderUseCase` 都改吃休息日
- ✅ `ReservationQueryService` 的 `closedDatesIn()` + `planAvailability` 的日期謂詞
- ✅ `PlaceReservationUseCase` 補上 `MERCHANT_CLOSED`（見 §9.3.1）
- ✅ `domain-exception.filter.ts`：`CLOSURE_NOT_FOUND`→404、
  `CLOSURE_DATE_IN_PAST`→422、`CLOSURE_DATE_INVALID`→400、`MERCHANT_CLOSED`→422

**前端**
- ✅ `/merchant/closures` 休息日管理頁：未來 / 過去兩張清單、
  選日期時**先顯示會影響幾筆訂位**再確認、原因選擇、備註、結果橫幅
- ✅ nav 加「特別休息日」
- ✅ `/m/[slug]` 取餐卡：`CLOSED_FOR_CLOSURE` 時顯示「店家於 {date} 休息，暫停接單」
- ✅ `/checkout` 徽章顯示「休息日」
- ✅ `/m/[slug]/reserve` 的 `ReservationNotice` 顯示「店家休息日」並列出 `closedDates`

### 9.5 驗證結果（全綠）

| 項目 | 結果 |
|---|---|
| `npm test` | **194/194**（+15 休息日） |
| `npm run typecheck` | domain / api / web 三個 workspace 全乾淨 |
| `npm run build -w @takeout/domain` + `-w @takeout/api` | 通過 |
| 開機實測 | 4 條休息日路由全部 Mapped；`subscribe:order` / `subscribe:reservation` 皆註冊 |
| `e2e-closure` | **PASS — 33 checks**（連跑兩次皆過，證明可重跑） |
| `e2e-reservation` | **PASS — 36 checks**（迴歸，未受影響） |
| `check:contract` | **PASS — 0 fail**（在付款資料存在時為 56 agree / 2 skip；`e2e:all` 後為 53 agree / 5 skip，皆為預期）+ `closedReason` / `closureDate` / `closedDates` / `MerchantClosure` |

`e2e-closure.js` 的九個段落：乾淨開場 → 開書並填滿休息日 → 關閉該日並觀察取消
（含 outbox `reservation.cancelled` 事件 + 座位歸還）→ 兩個入口都被擋
（直接 POST 得 `MERCHANT_CLOSED`、格子說 `CLOSED_FOR_CLOSURE`、
`POST /orders` 得 `PICKUP_TIME_NOT_FEASIBLE`）→ 冪等（`alreadySwept`、無第二次事件）
→ 重新開放（204、格子重開、**不復活**已取消的訂位、非休息日 404）
→ 驗證（過去日期、格式錯誤、不存在的日期、未知原因、列表升序且被 `from` 窗口化）
→ 顧客端效果與恢復 → 影響範圍（別的商戶、別的日子不受影響）。

### 9.6 休息日 vs 候位 / 店內點餐 / 退款工單

本輪的 migration 一併建好了後三者的表（`waitlist_settings`、`waitlist_entries`、
`dining_tables`、`dining_sessions`、`refund_requests`），但**尚未接上 API**。
這是刻意的：一次 migration 建三組表，換來後面三輪不必再碰 schema。

---

## 十、退款申請工單 ✅ 完成（domain + schema + API + 前端）

店主原話：**「因為這是一個負責預定而已的軟件，所以退款這些問題都是不經過我這個中間平台的。顧客可以經過平台提出退款，然後店家自行向顧客商議」**。

選擇的實作方式：**只做「退款申請」工單，不碰錢**。

### 10.1 設計決策

| # | 決策 | 理由 |
|---|---|---|
| 1 | **`RefundRequestSideEffect` 只有 `NOTIFY_CUSTOMER` / `NOTIFY_MERCHANT`** | **這個「缺失」就是設計本身。** 沒有 `REFUND_PAYMENT`、沒有 `MOVE_MONEY`。日後要加錢的路徑，就必須是一個刻意的動作，而不是「把 enum 加長」的副作用 |
| 2 | **狀態列裡沒有 `REFUNDED`** | `REFUNDED` 是平台在宣稱一件它從未經手、也無法查證的事。`RESOLVED_OFFLINE`（＝「店家**說**它在線下處理了」）是唯一誠實的講法 |
| 3 | **`ACTIVE = OPEN \| IN_DISCUSSION`，其餘 terminal** | 佇列過濾、按鈕、以及「一單一開」規則全部吃這一組定義。單元測試釘死「每個狀態不是 active 就是 terminal——不會兩者皆非，也不會兩者皆是」 |
| 4 | **`requestedAmountMinor` 是**建議值**，不是付款指令** | 平台不搬這筆錢，所以金額是顧客說「大概是這個數」的方式。省略＝「全部，我們談」 |
| 5 | **`reasonCode` 是封閉清單，`OTHER` 必須帶 `note`** | 店家要能分診；五十種拼法的「冷了」不是可處理的東西，但一封沒人答得出的工單比沒有更糟 |
| 6 | **一單同時只能有一張開著的工單（409）** | 兩張開著的工單＝同一件投訴有兩段對話，而店家最後回的那段看起來才像事實 |
| 7 | **顧客在兩個 active 狀態都能撤回** | 否則就是把人困在一段他想結束的對話裡——而投訴渠道恰恰最不該製造這種處境 |
| 8 | **顧客永遠不能 resolve 或 decline** | 只有店家能決定它交出了什麼，也只有店家能說「我們不退」 |
| 9 | **`RESOLVED_OFFLINE` 至少要有一個 amount 或 reference** | 一個沒有內容的「已處理」比沒有更糟——它關掉了佇列項目，而顧客還在等 |
| 10 | **`orderStatus` 的 `REFUNDED` 仍在可開單清單內** | 平台無權判斷投訴是否成立，所以它不判斷。唯一拒絕的是「從沒付過錢的單」——那沒東西可要 |
| 11 | **`RefundTransitionView.refundRequestId`，不叫 `id`** | controller 直接展開 use case 的結果，不再重新映射一次。`ReservationTransitionView` 曾在這裡出過錯而沒有東西擋住 |
| 12 | **管理台只讀 + `ADMIN` 可代為推進** | 平台不介入協商，但要能處理「店家掛單不管」的例外，且該動作會記進稽核軌跡（`resolvedById`） |
| 13 | **`REFUND_REQUEST_NOT_ALLOWED`（422）刻意不重用 `REFUND_NOT_AVAILABLE`** | 後者是舊管理台**錢路徑**的碼。同一個 422 講兩件不同的事，前端就只能猜 |

### 10.2 一個真相：`RefundRequestStateMachine`

與 `OrderStateMachine` / `ReservationStateMachine` **刻意同形**：同一張 `TRANSITIONS` 表、同一個 `tryTransition` 探針、同樣「除了注入的 `Clock` 之外不讀時鐘、不做持久化」的紀律。三部行為一致的機器比三部各自發明契約的機器好記。

```
OPEN ──┬── IN_DISCUSSION ──┬── RESOLVED_OFFLINE   （terminal）
       │                    ├── DECLINED           （terminal）
       │                    └── CANCELLED          （terminal，僅顧客 / ADMIN）
       ├── RESOLVED_OFFLINE （terminal）
       ├── DECLINED         （terminal）
       └── CANCELLED        （terminal，僅顧客 / ADMIN）
```

`transition()` 的規則選擇有一個關鍵細節：

```ts
const matching =
  rules.find((rule) => rule.to === to && rule.actors.includes(actor)) ??
  rules.find((rule) => rule.to === to);
```

**先找「承認這個 actor」的規則**。同一個 `to` 可能被多個 actor 觸及，若只取第一個 `to` 相符的規則，就會套用到錯的那條。fallback 到「只比對 `to`」是為了讓錯誤訊息能分辨兩種失敗：

- 掉進 `!matching` → 「沒有這個動作」，訊息列出**這個狀態能去的所有目標**；
- 掉進 `!matching.actors.includes(actor)` → 「這不是你能做的動作」，訊息列出**誰能做**。

### 10.3 五個檢查，順序有意義

`FileRefundRequestUseCase.execute()` 依序問五件事，因為每個答案對應不同的 UI：

| # | 檢查 | 失敗碼 | HTTP | 備註 |
|---|---|---|---|---|
| 1 | 訂單存在**且是他的** | `ORDER_NOT_FOUND` | **404** | 刻意**不**回 403——403 等於確認這個 id 存在，陌生人就能探測 |
| 2 | 這單付過錢 | `REFUND_REQUEST_NOT_ALLOWED` | 422 | 沒付過錢的單沒東西可要 |
| 3 | `OTHER` 有 `note` | `REFUND_NOTE_REQUIRED` | 400 | |
| 4 | 金額是合理的要價 | `REFUND_AMOUNT_INVALID` | 400 | 形狀檢查，fat-finger 的 `1000000` 是 400 帶欄位名，不是交易內的 422 |
| 5 | 這單沒有開著的工單 | `REFUND_REQUEST_ALREADY_OPEN` | 409 | **在交易內**檢查——外面查的話兩個同時提交都會看到「沒有開著的」 |

第 1–4 項在交易開啟**前**就拒絕；第 5 項必須在交易**內**。

`TransitionRefundRequestUseCase` 則是四步，且**刻意沒有第五步**：

1. 交易內加鎖讀取；
2. `stateMachine.transition()` —— 授權並推導義務；
3. `UPDATE ... WHERE status = expected` —— 有別的寫入者插隊就大聲失敗，而不是重複套用；
4. outbox 列，同一個交易。

訂位路徑在狀態變更後會釋放座位；這條路徑**沒有東西要釋放**，因為工單不佔容量、也不搬錢。

### 10.4 `OrderRefundSummaryView`：讓訂單頁不必再打一次

`CustomerOrderView` 新增 `refundRequests: readonly OrderRefundSummaryView[]`（`id`、`status`、`reasonCode`、`requestedAmountMinor`、`createdAt`，新到舊）。

```ts
export interface OrderRefundSummaryView {
  readonly id: string;
  readonly status: RefundRequestStatus;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor: number | null;
  readonly createdAt: Date;
}
```

這一個欄位同時解掉兩件事：訂單頁要知道**該不該**顯示「申請退款」按鈕，以及要能分辨「一張都沒有」與「有一張還開著」。少了它，`/orders/[orderId]` 得為了畫一顆按鈕多打一支 API，而且還是會在中間那幾百毫秒顯示錯的按鈕。

### 10.5 順手挖出並修掉的缺陷

#### ⚠️ 10.5.1 WebSocket 的 aggregate 路由是三元運算子 —— 訂位事件被送進 `order:` 房間

**症狀**：`reservation.cancelled` 事件被 emit 到 `order:{reservationId}`，而**沒有任何客戶端進得了那個房間**——`subscribe:order` 會拿這個 id 去 `orders` 表查。

**根因**：

```ts
// 之前
return event.aggregateType === 'Reservation'
  ? reservationRoom(event.aggregateId)
  : orderRoom(event.aggregateId);
```

任何**不是** `Reservation` 的東西都落進 `order:`。加入 `RefundRequest` 之後，退款事件會靜默地流入 `order:`——一個 `RefundRequest.id` 在 `orders` 表裡查不到的房間。**「靜默」是這裡最糟的部分**：outbox 一切正常，事件確實送出了，只是送到沒人聽的地方。

**修法**：改成窮舉 switch 並回傳 `null`，且**大聲記錄**：

```ts
switch (event.aggregateType) {
  case 'Order':         return orderRoom(event.aggregateId);
  case 'Reservation':   return reservationRoom(event.aggregateId);
  case 'RefundRequest': return refundRequestRoom(event.aggregateId);
  default:              return null;
}
```

```ts
const room = aggregateRoom(event);
if (!room) {
  this.logger.warn(`No Socket.IO room for aggregateType="${event.aggregateType}"`);
  return;
}
```

> **教訓：預設分支不該是一個看起來很合理的房間名。** `default: orderRoom(...)` 讓「新 aggregate 沒被路由」表現成「一切正常」；`default: null` 讓它表現成一行 warning。新增第四個 aggregate 的人現在會看到它。

#### ⚠️ 10.5.2 `CustomerOrder.refundRequests` 的契約檢查被靜默跳過

**症狀**：`check:contract` 當時回報「67 agree / 5 skipped」，其中 `CustomerOrder.refundRequests` 是 *skipped* 而不是 *agree*——它跑在任何工單存在之前，取樣列裡當然沒有欄位可比。

**根因**：契約檢查的設計是「拿一個真實的 sample row，逐一比對兩邊聲明的欄位」。它**只會跳過缺的資料**，不會跳過缺的**宣告**——所以這是一個資料時序問題，不是斷言問題。而「靜默跳過」正是這個工具最不該做的事：一個新欄位永遠沒被驗到，數字看起來卻很健康。

**修法**：把 `CustomerOrder.refundRequests` 的比對**搬進退款段落、開單之後**，另外補一個 `CustomerOrder.refundRequests (empty)` 的比對——在一張沒有工單的單上確認它回 `[]`。

> **教訓：`check:contract` 的數字是資料相依的，判斷標準是「0 fail」，不是某個固定數字。** 67→69 是加了覆蓋（多兩項取到了 sample row），不是修了回歸；而「skipped」比「fail」更危險，因為它長得像成功。

#### ⚠️ 10.5.3 `e2e-closure.js` 的清理會刪到別的腳本的訂單 —— P2003

**症狀**：全套迴歸時 `e2e-closure` 的段落全部 ✓、也印出 `PASS — 33 checks`，但尾端夾著一段 Prisma 錯誤：

```
modelName: 'Order',
field_name: 'merchant_payout_lines_orderId_fkey (index)'
```

**根因**：`e2e-closure.js` 的清理用了一個**未收斂的過濾條件**：

```js
// 之前
await prisma.order.deleteMany({ where: { customerId: customer.id, merchantId: MID } });
```

每一個 e2e 腳本都用**同一組種子帳號**（顧客 `+85290000001`、`dim-sum-express`），所以這個過濾條件會撈到**其他腳本留下來的訂單**。而 `MerchantPayoutLine.orderId` 是 `onDelete: Restrict`：

```prisma
order Order @relation(fields: [orderId], references: [id], onDelete: Restrict)
```

只要其中任何一張單已經被結算（有 payout line），刪除就丟 `P2003`，**整個清理的後半段全部不執行**。實測：跑完 `e2e:smoke` 之後，`customerId + merchantId` 的範圍內正好有一張 `COMPLETED` + 1 筆 payout line 的單。

**為什麼它一直沒被發現**：錯誤發生在 `PASS` 之後，`process.exitCode` 已經由 `failures.length` 決定（0 → 不設），所以**退出碼仍是 0**，CI 不會紅。而且它是資料相依的 —— 只有在「別的腳本先結算過一張單」時才會炸，單獨跑 `e2e-closure` 永遠看不到。

**修法**：改成追蹤**這次執行**建立的訂單 id：

```js
const createdOrderIds = [];          // run-scoped
// ...建立訂單處
createdOrderIds.push(res.body.id);
// ...清理
if (createdOrderIds.length > 0) {
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
}
```

> **教訓：清理的過濾條件必須是「這次執行」的，不是「看起來像我的」。** `(customerId, merchantId)` 讀起來很像在描述「我的資料」，但它其實是「所有用同一組種子帳號的腳本的資料」。**用 id 追蹤，不要用屬性猜。**
>
> **教訓：`PASS` 之後的錯誤不會讓 CI 變紅。** 驗證腳本的清理段落必須自己 `await` 在 `try` 裡，否則它就是一段「只在 log 裡出聲、對退出碼無影響」的程式碼 —— 比沒有更糟，因為它看起來有在做事。

### 10.6 已完成清單

**Domain / schema**
- ✅ `packages/domain/src/refund/refund-status.ts`（`RefundRequestStatus`、`RefundRequestActor`、`RefundReasonCode`、`isTerminalRefundRequestStatus`、`isActiveRefundRequestStatus`、`isOrderRefundRequestable`、`REFUND_REASON_LABEL`、`REFUND_STATUS_LABEL`）
- ✅ `packages/domain/src/refund/refund-state-machine.ts`（`RefundRequestSideEffect`、`TRANSITIONS`、`transition()`、`allowedTransitions()`、`can()`、`tryTransition()`）
- ✅ `packages/domain/src/refund/refund.errors.ts` + `assertNoteSupplied()` / `validateRequestedAmount()`
- ✅ **25 個新單元測試**`tests/refund.spec.ts`，`npm test` → **219/219**
- ✅ migration `20260925090000_add_closures_waitlist_dining_refunds` 內的 `refund_requests` 表（上輪已一併建好）

**API**
- ✅ `refund/` 模組 12 個檔案（domain / application / infrastructure / interface 四層齊全）
- ✅ `FileRefundRequestUseCase`（五個有序檢查）
- ✅ `TransitionRefundRequestUseCase`（四步，無第五步）
- ✅ `PrismaRefundRepository`（`findOrder`、`findOpenForOrder`、`findByIdForUpdate`、`insert`、`updateStatus`、`listForMerchant`、`listForCustomer`、`countsForMerchant`）
- ✅ **10 條路由**：
  - 顧客：`POST /orders/:orderId/refund-request`、`GET /refund-requests`、`GET /refund-requests/:id`、`POST /refund-requests/:id/cancel`
  - 商戶：`GET /merchant/:merchantId/refund-requests`（含 `counts`）、`GET /merchant/:merchantId/refund-requests/:id`、`POST /merchant/:merchantId/refund-requests/:id/transition`
  - 管理台：`GET /admin/refund-requests`、`GET /admin/refund-requests/:id`、`POST /admin/refund-requests/:id/transition`
- ✅ `OutboxService.buildRefundRequestEvent()`：`aggregateType: 'RefundRequest'`，事件型別小寫（`refund_request.opened` / `.in_discussion` / `.resolved_offline` / `.declined` / `.cancelled`）
- ✅ `OrderGateway` 窮舉路由 + `subscribe:refund_request`（見 §10.5.1）
- ✅ `domain-exception.filter.ts`：`REFUND_REQUEST_NOT_FOUND`→404、`REFUND_REQUEST_NOT_PERMITTED`→409、`REFUND_REQUEST_ALREADY_TERMINAL`→409、`REFUND_REQUEST_ALREADY_OPEN`→409、`REFUND_REQUEST_NOT_ALLOWED`→422、`REFUND_SETTLEMENT_DETAILS_REQUIRED`→422、`REFUND_NOTE_REQUIRED`→400、`REFUND_AMOUNT_INVALID`→400
- ✅ `CustomerOrderView.refundRequests`（§10.4）

**順手修掉的既有缺陷**
- ✅ `OrderGateway.aggregateRoom()` 改窮舉 switch + `default: null` + `logger.warn`（§10.5.1）
- ✅ `contract-check.js` 的 `CustomerOrder.refundRequests` 比對移到開單之後 + 補空陣列比對（§10.5.2）
- ✅ `scripts/e2e-closure.js` 的清理改用 run-scoped `createdOrderIds`，不再刪到別的腳本已結算的訂單（§10.5.3）

**前端**
- ✅ `/refunds` 顧客清單（ACTIVE / ALL 分頁、逐張卡片）
- ✅ `/refunds/[refundRequestId]` 顧客詳情 —— `RESOLVED_OFFLINE` 渲染成「店家表示已線下處理」並明示「平台未經核實」；撤回彈窗
- ✅ `/orders/[orderId]` 內嵌 `RefundRequestCard` —— 可開單且無開著工單時才給按鈕；金額選填（預填訂單總額）；`OTHER` 需說明；文案明講平台不經手這筆錢
- ✅ `/merchant/refunds` 店家用佇列 —— 分頁數字來自 `counts`、按鈕來自 `allowedNextTransitions`、`RESOLVED_OFFLINE` 需金額或憑證
- ✅ `/admin/refunds` 管理台只讀 + 解封轉移
- ✅ nav：商戶 `/merchant/refunds`（badge `openRefunds`）、管理台 `/admin/refunds`（歸在財務）、顧客 `/refunds`
- ✅ `lib/types.ts` / `lib/format.ts` / `lib/api.ts` 補齊（`REFUND_REQUEST_STATUS_LABEL` 的 `RESOLVED_OFFLINE` 是 **「已線下處理」**，不是「已退款」）

### 10.7 驗證結果（全綠）

| 項目 | 結果 |
|---|---|
| `npm test` | **219/219**（+25 退款工單） |
| `npm run typecheck` | domain / api / web 三個 workspace 全乾淨 |
| `npm run build -w @takeout/domain` + `-w @takeout/api` | 通過 |
| 開機實測 | 10 條退款路由全部 Mapped；`subscribe:refund_request` 已註冊 |
| `e2e-refund` | **PASS — 40 checks**（連跑三次皆過，證明可重跑） |
| 全套迴歸（循序） | `e2e-smoke` 48、`e2e-admin` 79、`e2e-pay-at-store` 48、`e2e-reservation` 36、`e2e-closure` 33、`e2e-payments` 53、`e2e-feedback` 65、`e2e-timeouts` 29、`e2e-metrics` 15 —— 全部 PASS |
| `e2e-closure` 清理（§10.5.3 的修法） | 先在 `e2e` 種出一張已結算的單，再跑 `e2e-closure` 兩次：**修前 `P2003`、修後不炸且該結算單完好**（跑前 1 張 → 跑後 1 張，payout line 1 筆不變） |
| `check:pricing` | PASS |
| `check:contract` | **PASS — 0 fail**（實測同一份程式碼跑出 65 / 67 / 69 agree；5 skip 固定，數字隨資料浮動） |

`e2e-refund.js` 的九個段落：乾淨開場 → 一張已付款 + 一張未付款的單 →
開單（201 OPEN、只給撤回按鈕、陌生人 404、第二張 409、未付款 422、
`OTHER` 無說明 400、金額超過總額 400、未知原因 400、outbox `refund_request.opened`）→
店家佇列 + 數字 + 403 → 店家推進（`OPEN→IN_DISCUSSION` 通知雙方、顧客 403、
`RESOLVED_OFFLINE` 沒金額沒憑證 422、有憑證則記錄該宣稱、**沒有 `refunded` 事件**、
terminal 再推 409）→ 撤回 + 跨店 404 → 管理台只讀 + `ADMIN` actor →
**§8 錢路徑完全未被觸碰**（訂單仍是 `PAID`、仍只有一筆 `CAPTURED` 付款、
系統中任何地方都找不到 `"refunded"`）→ 影響範圍。

### 10.8 退款工單 vs 候位 / 店內點餐

上輪的 migration 已建好 `waitlist_settings` / `waitlist_entries` / `dining_tables` /
`dining_sessions`，**仍尚未接上 API**。本輪只接了 `refund_requests`。

---

## 十一、現場候位 ✅ 完成（domain + schema + API + 顧客取號頁 + 店家帶位板）

### 11.1 設計決策：兩個形狀，不是一個形狀加 `role` flag

`CustomerQueueView` 與 `MerchantQueueView` 是**兩個獨立的 interface**，而不是
一個物件加 `role` 欄位。這不是潔癖，是安全：

顧客的 ticket 回應**刻意不含** `contactPhone`、`allowedNextTransitions`、
`version`、`note`、`waitedMinutes`。如果兩者共用一個 type，這五個欄位會出現在
顧客的 response 裡——包括**排在他前面的八組客人的電話號碼**。
contract check 現在有一條**否定斷言**（`options.absent`）專門守這件事：
顧客 ticket 出現 `contactPhone` 就 FAIL。

UI 重點也不同，所以資料形狀不同：

| | 顧客取號頁 | 店家帶位板 |
|---|---|---|
| 裝置 | 手機、單手、日光下、可能在走路 | 櫃檯平板、暗店裡 |
| 問題 | 「我排第幾、幾時到我」 | 「下一個是誰、我叫過誰」 |
| 需要 | 一張票、倒數、一顆取消 | 全隊列、電話、每個動作的按鈕 |

### 11.2 `WaitlistStateMachine`：`CALLED` 不是終點，也不是「叫了就走」

```
WAITING → CALLED / SEATED / CANCELLED / NO_SHOW
CALLED  → SEATED / NO_SHOW / CANCELLED      (CANCELLED 僅店家)
SEATED / NO_SHOW / CANCELLED                (terminal)
```

兩個不明顯但重要的性質：

- **`CALLED` 的客人保留原本的 `position`**。叫號不是把她踢出隊列——她還在門口，
  只是被叫到了。若 `CALLED` 就讓她跳到隊尾，店家叫第二次號會叫到一個剛被叫過的
  人後面，畫面上的「下一個」就錯了。
- **取號本身不發 outbox event**。第一筆事件（`waitlist.called`）帶著
  `version: 2`。這是有意的：取號是店內行為、不通知任何人；第一次通知發生在
  叫號。`version` 因此證明「取號確實寫了一筆，且沒有發出事件」。

帶位板上的 `allowedNextTransitions` **由寫入路徑用的同一個狀態機算出來**，
actor 傳 `MERCHANT`。一塊畫出伺服器會拒絕的按鈕的板子，正是這個欄位要防的缺陷。

### 11.3 一個真相：`pickup-policy.ts` 的休息日判斷被候位重用

候位與休息日共用同一個「現在開不開」判斷。取號頁的 `closedReason` 有**兩個值**，
不是一個 boolean：

- `'CLOSED'` —— 店現在休息 → 客人該做的動作是「11 點再來」
- `'DISABLED'` —— 這家店不做候位 → 客人該做的動作是「換一家」

一個 boolean 會讓 UI 沒辦法給出正確的下一步。同樣地，`acceptWhenClosed`
預設 `false`：開店前就開始排隊，會讓開店第一個到的客人排在六個還在睡的人後面。

### 11.4 已完成清單

- `packages/domain/src/waitlist/` —— 狀態機、`WaitlistPolicy`、`normalizeTableCode`
  之外的票號產生（`dayLetterFor` + 每日重編）
- `WaitlistSettings` / `WaitlistEntry` 接上 API（上輪已有表，本輪接線）
- 顧客：`GET /merchants/:id/queue`、`POST /merchants/:id/queue`、
  `GET /merchants/:id/queue/mine`、`POST /merchants/:id/queue/mine/cancel`
- 店家：`GET /merchant/:id/queue`、`PATCH /merchant/:id/queue/settings`、
  `POST /merchant/:id/queue/:entryId/transition`、`POST /merchant/:id/queue/sweep`
- 前端：`/m/[slug]/queue`（顧客，手機優先）、`/merchant/queue`（帶位板）+
  `/merchant/queue/settings`
- `scripts/e2e-waitlist.js`（44 項檢查，可連跑兩次）

### 11.5 驗證結果

```
e2e-waitlist   PASS — 44 checks   (連跑兩次結果一致)
contract       WaitlistSettingsView / .policy / CustomerQueueEntryPointView /
               .policy / TakeNumberResultView / CustomerQueueTicketView /
               CustomerQueueTicketView (public: no phone, no host moves) /
               MerchantQueueView / .counts / MerchantQueueEntryView
```

---

## 十二、店內點餐 ✅ 完成（domain + schema + API + 掃碼點餐 + 桌況板）

### 12.1 設計決策：兩段 token，不是一段

匿名點餐的最大難點是**授權**。掃牆上的 QR code 走下去，如果那張 code 就能下單，
那麼任何人在任何時候拍下那張 code，就能在店外替這張桌子點單。

所以拆成兩段：

| token | 存在哪 | 壽命 | 能做的事 |
|---|---|---|---|
| `dining_tables.qrToken` | 靜態，印在桌上 | 永久 | **只能開一桌**（開 session） |
| `dining_sessions.guestToken` | 動態，開桌時產生 | 這一餐 | **下單的授權** |

`POST /dine/table/:qrToken/session` 用第一段換第二段，回傳的 `guestToken`
放在手機上。隔壁桌拍到你的 code 只能開一個**新的** session，動不了你這一桌。
這也是為什麼入座時 assign 一次性 QR code 是對的：**開桌是一次性的，
授權才是持續的**。

### 12.2 店內單仍是 `Order`，不是新的東西

店內點餐**沒有**新的訂單型別。它是一張普通的 `Order`：

- `paymentMode: PAY_AT_STORE`（顧客離店前付）
- `customerServiceFeeMinor: 0`
- `diningSessionId` 指向所屬的一桌

**不得污染 `OrderStatus`**。店內單與外賣單走同一個 `OrderStateMachine`，
同一個計費引擎。`DiningSessionStatus` 是獨立的三態：`OPEN | CLOSED | ABANDONED`。

第二次 `close` 回 **422 `DINING_SESSION_CLOSED`**——手機鎖屏後回到頁面又按了一次
結帳，不該變成 500，也不該把單結兩次。

### 12.3 已完成清單

- `DiningSessionMachine`（`OPEN → CLOSED/ABANDONED`，無其他）
- `DiningTable` / `DiningSession` 接上 API（`@@unique([merchantId, code])` 是真正的防線，
  `normalizeTableCode` 只負責 strip 分隔符 + 大寫）
- 店家：`GET /merchant/:id/dining`（桌況板）、`POST /merchant/:id/dining/tables`、
  `POST /merchant/:id/dining/sessions/:id/close`
- 顧客：`GET /dine/table/:qrToken`、`POST /dine/table/:qrToken/session`、
  `GET /dine/s/:guestToken/tab`、`POST /dine/s/:guestToken/orders`
- 前端：`/dine/table/[qrToken]`（掃碼後，手機優先）、`/merchant/dining`（桌況板）
- `scripts/e2e-dining.js`（38 項檢查，可連跑兩次）

### 12.4 驗證結果

```
e2e-dining     PASS — 38 checks   (連跑兩次結果一致)
contract       MerchantTableBoardView / .counts / DiningTableView /
               ScannedTableView / OpenSessionResultView /
               DiningSessionSummaryView / DiningSessionTabView
```

---

## 十三、商戶營業報表 ✅ 完成（Excel 免費 + 分層 BI dashboard）

### 13.1 設計決策：`tier` 決定畫什麼面板，不決定數字存不存在

店主說「免費導出 excel，BI dashboard 服務要加錢」。實作成 `AnalyticsTier`：

| tier | 標籤 | capabilities | 收費 |
|---|---|---|---|
| `NONE` | 標準 | `[]` | 免費 |
| `BASIC` | 進階報表 | `DAILY_ROLLUP`, `ITEM_MIX`, `HOUR_OF_DAY`, `CHANNEL_MIX` | 收費 |
| `PRO` | 專業報表 | 全部 5 個（+ `COMPARISON`） | 收費 |

三條不變性質，寫在 `e2e-analytics.js` 檔頭，也寫在 domain 的型別註解：

1. **匯出永遠不分層**。`canExportRawData` 恆為 `true`，任何 tier 都能拿到 CSV。
   把店自己的資料鎖在付費牆後面是收不到錢的——只會讓店家離開。
2. **tier 決定哪些面板「畫得出來」，不決定哪些數字「算得出來」**。API 一律回
   完整數字，由前端決定渲染幾塊。降級時使用者看到的差別是「面板少了」，
   而不是「數字變了」。
3. **tier 是店的屬性，不是看的人的屬性**。同一個 tier 不論 OWNER 或 STAFF
   token 進來都一樣。`UPDATE merchants SET "analyticsTier"='PLATINUM'` 會被
   **Postgres 拒絕**——它是真正的 enum，"fail-closed" 由資料庫保證。

### 13.2 ⚠️ 本輪最嚴重的缺陷：報表把「分組列」當成「訂單數」

**症狀**：e2e 播了 6 筆訂單，CSV 的營收對（32400），但 `orderCount` 是 4。

**根因**：報表的 SQL 是

```sql
GROUP BY serviceDate, hourOfDay, status, fulfilmentMode, paymentMode
```

所以**一列不等於一張單**——兩筆同一天、同一小時、同狀態的單會**併成一列**，
`SUM(...)` 把金額加對了，但 `buildAnalyticsReport` 用 `rows.length` 當訂單數。

**為什麼開發時看不出來**：開發資料很少，分組通常只裝一筆單，`length` 剛好等於
`COUNT(*)`。這在真實店家身上才會現形——而且症狀是**店家的營業額筆數比實際少**，
一個看起來「只是顯示怪怪的」但其實是帳目錯誤的 bug。

**修法**（四個檔案 + 兩個新測試）：

- `aggregateOrders` 加 `COUNT(*)::int AS "orderCount"`，`GROUP BY` 改 `1, 2, 3, 8, 9`
- `aggregateVoids` 也把 `orderCount: row.voidCount`
- domain 的 `ReportableOrder` 新增**必填** `orderCount`，附長註解說明「這一列可能
  代表多張單」。型別系統從此擋住「用 `.length` 數訂單」這個寫法
- `totals.orderCount` / `totals.voidCount` / **AOV 分母** / 每日彙總 / 小時桶 /
  通路拆分，全部改成 `sum(rows, r => r.orderCount)`

**新測試**（`packages/domain/tests/analytics.spec.ts`）：

- *"counts ORDERS in a grouped row, not rows"* —— 兩列裝三張單 → `orderCount === 3`，
  AOV 除以訂單數而非列數
- *"a grouped row is reflected in the daily rollup and the hour buckets too"* ——
  斷言 totals / daily / hours / channels **四個視圖對同一個數字一致**。
  同一個數字在不同面板上不一致，就是頁面自己打自己

### 13.3 順手修掉的第二個契約缺陷：`InvalidAnalyticsWindowError` 變成 500

視窗反轉或超過 366 天時，domain 丟 `InvalidAnalyticsWindowError`，但
`domain-exception.filter.ts` 沒有對應分支，於是**一個使用者輸入錯誤回 500**。
已加上 BAD_REQUEST 分支，code `ANALYTICS_INVALID_WINDOW`，`details: { from, to }`。

（還原時我把這個分支重複貼了兩次，已移除——最終檔只有一個。）

### 13.4 CSV 匯出的載重細節

免費匯出看起來簡單，但這幾個細節錯了就是「Excel 打開是亂碼」或「公式被執行」：

- **UTF-8 BOM `EF BB BF`** —— 沒有它 Excel 會把中文 header 讀成亂碼。
  注意 `response.text()` 依定義會 strip BOM，所以 e2e 只能讀 `arrayBuffer()`
  再斷言原始 bytes
- **CRLF** 換行、**結尾也有 CRLF**
- 金額是**十進位字串**，不是 minor units
- **CSV injection 防護**：以 `= + @ -` 開頭的值前面加 `'`。
  e2e 有一條 probe：訂單備註 `=1+1`，匯出必須是 `'=1+1`
- 空視窗**仍匯出**，只有 header，`X-Row-Count: 0`

### 13.5 已完成清單

- `packages/domain/src/merchant/analytics-tier.ts`、`analytics-report.ts`、
  `analytics-export.ts`
- `AnalyticsService.MAX_WINDOW_DAYS = 366`；視窗由**伺服器**在店家時區解析
- 店家：`GET /merchant/:id/analytics`、`GET /merchant/:id/analytics/export`
- 管理台：`POST /admin/merchants/:id/analytics-tier`（含降級警告）
- 前端：`/merchant/analytics` + 匯出按鈕、`/admin/merchants` 的 tier 編輯；
  `AdminMerchant.analytics` 標記
- `scripts/e2e-analytics.js`（46 項檢查，可連跑兩次）

### 13.6 驗證結果

```
e2e-analytics  PASS — 46 checks   (連跑兩次結果一致)
contract       AnalyticsTierView / MerchantAnalyticsView / .window / .totals /
               AnalyticsTierWriteView
```

---

## 十四、本輪的 contract check 拓寬

`scripts/contract-check.js` 由 **69 → 92** 項：

- `compare()` 新增第四個參數 `options.absent` —— **否定斷言**。
  用來證明顧客自己的票**不帶** `contactPhone` / `allowedNextTransitions` /
  `version` / `note` / `waitedMinutes`。「多送了欄位」過去是查不到的
- `AdminMerchant` 補上 `analytics`，並新增 tier 區塊檢查
- 三組新 shape：現場候位、店內點餐、商戶營業報表

> **判斷標準是「0 fail」，不是固定數字。** 檢查數會隨資料變動
> （沒有樣本列時會 skip），把它當常數寫進 CI 會產生假警報。

---

## 十五、全套迴歸（連跑兩次，兩次一致）

```
                     run 1   run 2
domain unit (vitest) 285     285     (14 files)
e2e-smoke             48      48
e2e-reservation       36      36
e2e-refund            40      40
e2e-waitlist          44      44
e2e-dining            38      38
e2e-analytics         46      46
e2e-admin             79      79
contract-check        92/92   92/92   (0 fail)
check:pricing         PASS    PASS
```

---

## 十六、還沒做

- **前端仍缺 browser 層互動測試**。目前只驗到「路由 200 + SSR 出正確的殼 +
  打真實 API 拿到正確 JSON」。按鈕真的按下去、Modal 真的開、
  `allowedNextTransitions` 真的畫出對的按鈕，都是靠型別與 contract check 保證，
  不是靠瀏覽器驅動。候位與店內點的**手機端**尤其如此——`UI 佈局在窄螢幕下
  會不會爆掉，現在沒有自動化的答案**
- 訂位、休息日、退款工單、候位、店內點餐、報表六條線的**排班整合**（店家在
  同一個頁面看到今天所有的單：外賣、訂位、候位、店內）尚未設計
- 階段二（車隊派單）未動


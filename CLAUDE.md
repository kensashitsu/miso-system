# 味噌熟成・仕込み計画管理システム

## プロジェクト概要

山口県防府市の味噌蔵向け生産管理システム。Excel・紙帳簿からの移行。
社内LAN上の1台のサーバーPCで `next start` を常時起動し、PC・スマホ（同一Wi-Fi）から2〜3人が使用。認証不要。

既存システム（zaiko.mitsuura.jp / seizou.mitsuura.jp）と役割分担：
- **既存**: 在庫数量・出荷記録・販売管理・取引先別引き当て
- **本システム**: 仕込みロットの熟成進捗・着色リスク・場所履歴・仕込み計画・ロットトレース・袋詰めロット

---

## 技術スタック

| ライブラリ | バージョン | 備考 |
|-----------|-----------|------|
| Next.js | 16.2.6 | App Router / Server Components / Server Actions |
| React | 19.2.4 | |
| Prisma | **6.19.3** | SQLite。v7はSQLiteのdriver adapter問題のため使用不可 |
| SQLite | — | DATABASE_URL: `file:./dev.db`（実体は `prisma/dev.db`） |
| Tailwind CSS | v4 | |
| shadcn/ui | @base-ui/react ^1.4.1 | |
| Zod | **4.4.3** | v3と構文が異なる（後述） |
| date-fns | v4.1.0 | |
| Recharts | 3.8.1 | 積算温度グラフ・需要グラフ・シミュレーションモーダル |
| xlsx (SheetJS) | 0.18.5 | /importでclient側動的import |
| tsx | ^4.21.0 | シードスクリプト実行用 |
| lucide-react | 1.14.0 | |
| @tanstack/react-query | ^5.100.10 | |

---

## 環境・デプロイ方針

```
next start を社内PC1台で常時起動
192.168.11.19:3000 → 社内Wi-Fi経由でPC・スマホ両方からアクセス
```

### 環境変数（`.env.local`）

| 変数名 | 用途 |
|--------|------|
| `DATABASE_URL` | `file:./dev.db`（Prismaが`prisma/`基準で解決） |
| `STOCK_API_URL` | 熟成済在庫取得エンドポイント |
| `SALES_API_URL` | 月別出荷実績取得エンドポイント |
| `EXTERNAL_API_KEY` | 上記APIの認証キー（`X-API-Key`ヘッダー） |
| `PYTHON_PATH` | SARIMAXスクリプト実行用Python3パス（省略時はシステムデフォルト） |

---

## 場所定義（最新版）

場所は `LocationHistory.location` に文字列として保存。

### 現在の有効な場所

| 場所名 | 表記例 | 日次有効積算温度 | 説明 |
|--------|--------|-----------------|------|
| 暖房 | `暖房25℃` | `設定温度 − 10` ℃/日 | ヒーター。設定温度は移動時に任意入力。保存形式: `暖房XX℃` |
| 冷房 | `冷房20℃` | `max(設定温度 − 10, 0)` ℃/日 | クーラー。設定温度は移動時に任意入力。保存形式: `冷房XX℃` |
| 常温 | `常温` | Q10補正済み値（後述） | WeatherCache（防府アメダス）使用。データなし日は14℃/日で補完してQ10適用 |
| 冷蔵庫 | `冷蔵庫` | `max(fridgeTemp − 10, 0)` ≒ 0℃/日 | 設定値`fridgeTemp`（デフォルト6℃）。実質積算停止 |

### ⚠️「温調室」は廃止済み

`温調室24℃`・`温調室20℃` は**廃止済み**。新規登録・場所移動では使用不可。
後方互換のため `TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/` でパースのみ継続。


---

## Q10補正（常温熟成）

### 概要

常温熟成時の温度感受性を補正する係数。**現行 q10=2.0**。

> **較正履歴**：当初は理論ベースで q10=5.5 としていたが、2026-06に原票仕込帳の**実「熟成日数」**（田舎・無添加219件。DBの`completedAt`は出荷済で使用開始日のため不可。[[project_completedat_is_usestart]]）と照合したところ、6〜9月仕込み（常温）の実熟成は**中央値29日**（盛夏26-27 / 9月33）。q10=5.5は夏を速くしすぎ（≈22日）、補正なし(q10=1)は遅すぎ（≈34日）。夏の実効レート23/日 vs 冬12/日（約1.9倍）から逆算した適正値 **q10≈2.0** に変更。Q10で夏を加速する方向自体は実データで正しいと確認済み。

### 計算式（`lib/tempCalc.ts` の `applyQ10()`）

```typescript
// effectiveTemp = max(avgTempC - 10, 0)（WeatherCacheに保存済みの値）
// avgTempC は effectiveTemp > 0 のとき effectiveTemp + 10 として逆算可能
function applyQ10(effectiveTemp, q10Value, heatingBaseTemp):
  if effectiveTemp <= 0 || q10Value === 1: return effectiveTemp
  avgTempC  = effectiveTemp + 10
  q10Factor = q10Value ^ ((avgTempC - heatingBaseTemp) / 10)
  return effectiveTemp * q10Factor
```

**基準温度（heatingBaseTemp）** = `heatingDefaultTemp`（暖房デフォルト温度。デフォルト25℃）
→ 基準温度では補正係数が1.0となり、暖房と常温の積算が連続する

### 適用箇所

- **常温のみ**（暖房・冷房・冷蔵庫には適用しない）
- `calcAccumulatedTemp()`・`calcDailyAccumulation()`・`calcPeriodAccumulations()` の常温パス
- `calcEstimatedCompletion()` の常温推計（直近30日の補正済み平均を使用）
- `lib/brewSimulation.ts` の `simulateLotForModal()` でも適用

### 検証値（q10=2.0、heatingBaseTemp=25℃）

| 条件 | 補正前（℃/日） | 補正後（℃/日） |
|------|--------------|--------------|
| 暖房25℃ | 15.0 | 15.0（変化なし: 2.0^0 = 1.0） |
| 常温27.5℃（7月平均） | 17.5 | 20.1（2.0^0.25 = 1.19） |
| 常温15℃（春・秋） | 5.0 | 2.5（2.0^-1.0 = 0.5） |

→ 夏は適度に加速・低温は減速（実熟成日数に整合）

### SystemSetting キー

| キー | デフォルト | 範囲 |
|------|---------|------|
| `moisture_q10Value` | 2.0 | 1.0〜10.0（1.0 = 補正なし） |

---

## ビジネスルール

### 品種と目標積算温度（実績データ233件より算出・設定画面で変更可能）

| 品種 | 穀物 | 仕込み単位 | 目標積算温度 |
|------|------|-----------|-------------|
| 無添加麦みそ | 裸麦 | 約1,600kg | **600℃・日** |
| 田舎みそ | 裸麦 | 約1,600kg | **600℃・日** |
| 山吹みそ | 砕米 | 約1,300kg | **550℃・日** |
| 白みそ | 無洗米 | 約150kg | **70℃・日** |

※ ダッシュボード・ロット詳細は常に `MisoRecipe.targetTempSum` の現在値を参照（レシピ変更が即反映）

### 着色リスク判定（`calcColoringRisk`）

| 積算温度 ÷ 目標 | 判定 | 色 |
|--------------|------|---|
| 〜120% | normal | 緑（emerald） |
| 120〜150% | warning | 黄（amber） |
| 150%〜 | danger | 赤（rose） |

### ロット番号

`YYYYMM-001`（例: 202506-001）。同月内件数+1で自動採番。

### ステータス遷移

```
熟成中 → 完成 / 品質低下出荷 / 種みそ転用 / 出荷済
（いずれも熟成中に戻せる）
```

### 桶（Bucket）管理

**ステータス**: `待機中`（残量 = 初期重量）→ `使用中`（減少・0超）→ `空`（= 0）

**ロット登録時の生成**:
- 白みそ: 1桶、初期重量 = `floor(仕立量 × yieldRate)`
- 非白みそ: 2桶ペア、各初期重量 = `floor(仕立量 × yieldRate / 2)`
- 全桶ステータスは **「待機中」**（SQLite制限のためトランザクション外で `create`）

**使用記録（BucketUsage）**:
- 桶ごとに使用量と日付を記録できる（袋詰め・出荷先メモ付き）
- ロット詳細画面の桶パネルから追加・削除可能

---

## 積算温度の計算方式（`lib/tempCalc.ts`）

有効積算温度の基準温度は **10℃**。`TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/`

| 場所 | 日次加算値 |
|------|-----------|
| `暖房XX℃` | `設定温度 - 10` ℃/日 |
| `冷房XX℃` | `max(設定温度 - 10, 0)` ℃/日 |
| `常温` | `applyQ10(max(avgTempC-10,0), q10Value, heatingBaseTemp)` |
| `冷蔵庫` | `max(fridgeTemp - 10, 0)` ≒ 0℃/日 |
| `温調室XX℃`（旧） | `設定温度 - 10` ℃/日（後方互換のみ） |

### RoomTemps 型

```typescript
type RoomTemps = {
  room1Temp:        number   // 仕込み計画用参照温度（暖房）
  room2Temp:        number   // 仕込み計画用参照温度（冷房）
  fridgeTemp:       number   // 冷蔵庫温度
  heatingBaseTemp?: number   // Q10基準温度（= heatingDefaultTemp）。省略時25℃
  q10Value?:        number   // Q10補正係数。省略または1.0で補正なし
}
```

### 完成予定日の推計（`calcEstimatedCompletion`）

- 暖房・冷房: `ceil(残り ÷ 日次値)` 日後
- 常温: 直近30日の**Q10補正済み**平均で除算
- 冷蔵庫（日次値≦0）: `null`（完了予定日なし）

---

## 外部API連携（`lib/externalApi.ts`）

**認証**: `X-API-Key: ${EXTERNAL_API_KEY}` ヘッダー。サーバーサイドのみ（`NEXT_PUBLIC_` なし）。

### 熟成済在庫 API（`STOCK_API_URL`）

```typescript
interface AgedStockItem {
  misoType:         string
  stockKg:          number   // 旧フィールド（agedStockKgへ改名予定、両対応済み）
  packagedStockKg?: number   // 小分け製品在庫（APIへの追加対応待ち）
}
```

**packagedStockKg の品種マッピング**（外部システム開発者向け）:
- 無添加麦みそ: 光うらの麦みそ（粒）1kg/500g・（すり）1kg・一番掘り出し1kg・10K桶/バラ・芳麦味噌500g
- 田舎みそ: 田舎みそ（ｽﾘ/粒）各サイズ・各取引先別
- 山吹みそ: 山吹みそ各サイズ
- 白みそ: 「西京みそ バラ」として`stockKg`に含む（`packagedStockKg`不要）

### 月別出荷実績 API（`SALES_API_URL`）

```typescript
interface MonthlySalesItem { yearMonth: string; misoType: string; weightKg: number }
```

**マージルール**: `2026-01` 以降のデータは外部APIを優先してShipmentHistoryに上書き。

### 在庫サマリー構成（ダッシュボード）

| 列 | 取得元 |
|----|--------|
| 熟成中ロット | 本システム（Bucket残量ベースで品種別集計） |
| 熟成済在庫 | 外部API（stockKg） |
| 小分け製品在庫 | 外部API（packagedStockKg・追加対応待ち） |
| 工場内合計 | 上記3列の合計 |

---

## 需要予測

### ホルト・ウィンタース法（`lib/forecast.ts`）

- 加法モデル・季節周期12ヶ月
- パラメータ固定: **α=0.3, β=0.1, γ=0.3**
- 最低必要データ: **12ヶ月**（不足時は自動的に3年平均にフォールバック）
- UI上で「AI予測 / 3年平均」をトグルで切り替え可能

### SARIMAX予測（`app/planning/forecast-actions.ts`）

- Pythonスクリプト `scripts/forecast_sarimax.py` を呼び出して予測を実行
- 結果は `ForecastCache` テーブルにキャッシュ（`misoType + yearMonth` をキー）
- MAPE（予測誤差）は `SystemSetting`（キー: `forecast_mape_{misoType}`）に保存
- `ForecastUpdater` コンポーネントのボタンから手動実行
- 環境変数 `PYTHON_PATH` でPythonパスを指定可能

### 品種別データ補完（BRAND_RATIOS）

品種別データがない月は「全品種合計」から比率で補完:

```
無添加麦みそ: 57.3%（33347/58210）
田舎みそ:    37.0%（21566/58210）
山吹みそ:     5.0%（2883/58210）
白みそ:       残り約0.7%
```

---

## 気象データ取得（防府アメダス）

- **prec_no: 81**（山口県）・**block_no: 0775**（防府内部コード、WMO番号47835とは別）
- URL: `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=81&block_no=0775&year=YYYY&month=MM`
- HTMLパース: データ行 `<tr class="mtx" style="text-align:right;">`、**列3（0始まり）が平均気温**
- WeatherCache保存: `date` はUTC midnight（`new Date(Date.UTC(year, month-1, day))`）
- `effectiveTemp = max(avgTempC - 10, 0)` を保存済み
- 取込間隔: 0.7秒/月（気象庁サーバー負荷軽減）

---

## DBスキーマ（prisma/schema.prisma）

15テーブル構成。

```prisma
model Lot {
  id             String    @id @default(cuid())
  lotNumber      String    @unique        // YYYYMM-001
  misoType       String
  brewedAt       DateTime
  totalWeightKg  Float
  targetTempSum  Float                    // ※表示はMisoRecipe.targetTempSumの現在値を優先
  status         String    @default("熟成中")  // 熟成中・完成・品質低下出荷・種みそ転用・出荷済
  completedAt    DateTime?
  bucketNumbers  String?
  finalYieldKg   Float?
  yieldRate      Float?
  notes          String?
  isPrototype    Boolean   @default(false)  // 試作品フラグ（試作モードで登録したロット）
  createdAt      DateTime  @default(now())
  brewRecord       BrewRecord?
  locationHistory  LocationHistory[]
  agingNotes       AgingNote[]
  brewDiaries      BrewDiary[]
  packagingLots    PackagingLot[]
  buckets          Bucket[]
  seedMisoUsed     SeedMisoUsage[]  @relation("FromLot")
  seedMisoReceived SeedMisoUsage[]  @relation("ToLot")
}

model BrewRecord {
  id               String   @id @default(cuid())
  lotId            String   @unique
  mugiOrKomeKg     Float
  kojiKg           Float
  soybeanKg        Float
  saltKg           Float
  mizuameKg        Float    @default(0)
  seedWaterL       Float    @default(0)
  shikomiKg        Float
  seedMisoKg       Float    @default(0)
  taneKojiG        Float    @default(0)
  soybeanOrigin         String?
  soybeanOriginDetail   String?
  soybeanArrivalDate    DateTime?
  soybeanSupplier       String?
  soybeanLotNo          String?
  kojiMadeAt            DateTime?
  kojiSupplier          String?
  saltBrand             String?
  saltLotNo             String?
  mizuameBrand          String?
  mizuameLotNo          String?
  kojiCondition    Int?     // 出麹評価（3〜9）
  soybeanHardness  String?
  airTempC         Float?
  productTempC     Float?
  steamingPressure String?
  coolingMin       String?
  memo             String?
}

model LocationHistory {
  id        String    @id @default(cuid())
  lotId     String
  startDate DateTime
  endDate   DateTime?
  location  String    // 暖房XX℃・冷房XX℃・常温・冷蔵庫（旧: 温調室XX℃）
}

model AgingNote {
  id           String   @id @default(cuid())
  lotId        String
  recordedAt   DateTime @default(now())
  memo         String
  airTempC     Float?
  productTempC Float?
}

model BrewDiary {
  id         String   @id @default(cuid())
  lotId      String
  recordedAt DateTime @default(now())
  categories String   // カンマ区切り
  tags       String   // カンマ区切り
  memo       String
}

model SeedMisoUsage {
  id        String   @id @default(cuid())
  fromLotId String
  toLotId   String
  usedKg    Float
  usedAt    DateTime
}

model PackagingLot {
  id                String   @id @default(cuid())
  lotId             String
  packagedLotNumber String   @unique  // 賞味期限年月日8桁
  expiryDate        DateTime
  alcoholAddedAt    DateTime?
  filledAt          DateTime?
  bucketId          String?
  textureType       String   // 粒・すり
  shikomiKg         Float?
  filled1kgCount    Int      @default(0)
  filled500gCount   Int      @default(0)
  orderNo           String?
  notes             String?
  createdAt         DateTime @default(now())
}

model Bucket {
  id                String       @id @default(cuid())
  lotId             String
  bucketNumber      Int
  initialWeightKg   Float
  remainingWeightKg Float?
  status            String       @default("待機中")  // 待機中・使用中・空
  notes             String?
  createdAt         DateTime     @default(now())
  usages            BucketUsage[]
}

model BucketUsage {
  id        String   @id @default(cuid())
  bucketId  String
  bucket    Bucket   @relation(fields: [bucketId], references: [id])
  usedAt    DateTime
  usedKg    Float
  notes     String?
  createdAt DateTime @default(now())
}

model WeatherCache {
  date          DateTime @id  // UTC midnight
  avgTempC      Float
  effectiveTemp Float         // max(avgTempC - 10, 0)
}

model ShipmentHistory {
  id         String   @id @default(cuid())
  yearMonth  String
  misoType   String
  weightKg   Float
  importedAt DateTime @default(now())
  @@unique([yearMonth, misoType])
}

model MisoRecipe {
  id              String   @id @default(cuid())
  name            String   @unique
  grainLabel      String   // 裸麦・砕米・無洗米
  grainKg         Float
  soybeanKg       Float
  saltKg          Float
  mizuameKg       Float    @default(0)
  totalWeightKg   Float
  targetTempSum   Float
  defaultLocation String   @default("暖房24℃")    // 移行済み。旧形式「温調室XX℃」はDB・コードから除去済み
  soybeanOrigin   String?
  taneKojiG       Float    @default(0)
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model SystemSetting {
  key       String   @id  // moisture_* / forecast_mape_* プレフィックス
  value     String
  updatedAt DateTime @updatedAt
}

model ForecastCache {
  misoType   String
  yearMonth  String
  forecastKg Float
  lower90    Float
  upper90    Float
  updatedAt  DateTime @updatedAt
  @@id([misoType, yearMonth])
}

model IngredientAlert {
  id             String   @id @default(cuid())
  triggerLotId   String
  affectedLotId  String
  ingredientType String
  lotNo          String?
  createdAt      DateTime @default(now())
  resolved       Boolean  @default(false)
}
```

---

## lib/ ユーティリティ

| ファイル | 主要エクスポート | 役割 |
|---------|--------------|------|
| `lib/prisma.ts` | `prisma` | PrismaClientシングルトン |
| `lib/settings.ts` | `getMoistureSettings()`, `saveMoistureSettings()`, `MoistureSettings`, `DEFAULT_MOISTURE` | SystemSettingの読み書き |
| `lib/recipes.ts` | `getMisoRecipes()` | MisoRecipe一覧取得 |
| `lib/tempCalc.ts` | `calcAccumulatedTemp()`, `calcEstimatedCompletion()`, `calcColoringRisk()`, `calcDailyAccumulation()`, `calcPeriodAccumulations()`, `getCurrentLocation()`, `RoomTemps` | 積算温度計算全般（Q10補正含む） |
| `lib/brewSimulation.ts` | `simulateLotForModal()`, `calcSimulatedCompletionDate()`, `ModalSimDay` | シミュレーションモーダル用の将来予測（月日平均ベース） |
| `lib/forecast.ts` | `holtWinters()`, `getTimeSeries()` | ホルト・ウィンタース法 |
| `lib/backtest.ts` | `computeBacktest()`, `pickAutoMethods()`, `ForecastMethodKey`, `TypeBacktest` | 予測vs実績バックテスト（偏り・MAPE・最良方式）。④パネル表示と品種別自動方式選択で共有 |
| `lib/weatherFetch.ts` | `fetchMonthlyWeather()` | 気象庁HTMLスクレイピング |
| `lib/externalApi.ts` | `fetchAgedStock()`, `fetchMonthlySales()`, `testApiConnection()` | 外部システムAPI連携 |
| `lib/misoTypeColor.ts` | `getMisoTypeBadgeStyle()` | 品種バッジのCSSスタイル（inline style） |
| `lib/utils.ts` | `cn()` | shadcn/ui用クラスマージ |

### MoistureSettings 型（全フィールド）

```typescript
type MoistureSettings = {
  // 含水量（小数: 0.13 = 13%）
  hadakaMugi:    number   // 裸麦
  mugiKoji:      number   // 麦麹（実測値）
  kome:          number   // 砕米・無洗米
  komeKoji:      number   // 米麹（実測値）
  soybean:       number   // 大豆
  mizuame:       number   // 水飴
  seedMiso:      number   // 種味噌
  // 処理比率（as-is）
  kojiRatio:     number   // 裸麦→麦麹（デフォルト1.2）
  komeKojiRatio: number   // 砕米→米麹（デフォルト1.1）
  soybeanRatio:  number   // 大豆→蒸煮大豆（デフォルト2.3）
  // 温度（℃、as-is）
  room1Temp:          number  // 仕込み計画用参照温度: 暖房（デフォルト24）
  room2Temp:          number  // 仕込み計画用参照温度: 冷房（デフォルト20）
  fridgeTemp:         number  // 冷蔵庫（デフォルト6）
  heatingDefaultTemp: number  // 場所移動時の暖房デフォルト・Q10基準温度（デフォルト25）
  coolingDefaultTemp: number  // 場所移動時の冷房デフォルト（デフォルト20）
  q10Value:           number  // 常温Q10補正係数（デフォルト2.0）
  // 仕込み計画
  brewBufferDays: number  // 在庫切れ予測日から仕込み日までのバッファ日数（デフォルト14）
  // 歩留まり
  yieldRate:     number   // 小数（0.95 = 95%）
}
```

SystemSettingキー: `moisture_` プレフィックス（例: `moisture_q10Value`）

%表記フィールド（hadakaMugi〜seedMiso, yieldRate）はUI表示時に×100、DB保存時に÷100変換。
温度・比率・q10Value・brewBufferDaysはas-is。

### lib/brewSimulation.ts の詳細

`simulateLotForModal()` の動作:
- **室内期間**（10〜5月）: `dailyRoomAccum`（= room1Temp - 10）を使用
- **屋外期間**（6〜9月）: `weatherAvg`（月日平均 `MM-dd` キー）を使用
- Q10補正を全期間に適用
- `futureFixedRate` 指定時はその固定値で計算（ユーザーが将来の場所を選んだ場合）
- 730日先まで最大シミュレーション・200%で打ち切り

`calcSimulatedCompletionDate()` は `simulateLotForModal()` の簡易版（完成日のみ返す）。

---

## 設定画面（`/settings`）の構成

### 1. API接続状態（ApiStatusCard）
STOCK_API・SALES_API それぞれの疎通確認・レイテンシ表示

### 2. 品種・配合レシピ（RecipeSettings）
- MisoRecipeCRUD（追加・編集・削除）
- 麹歩合・塩分・水分を自動計算して一覧表示
- **targetTempSum変更 → ダッシュボード・ロット詳細に即反映**

### 3. 水分計算用の含水量・処理比率設定（MoistureSettingsForm）
- 裸麦/麦麹、砕米/米麹、大豆/蒸煮大豆の比率・含水量
- 乾物量変化テーブル表示（理論値との比較）
- **温度管理設定セクション**:
  - 暖房デフォルト温度（`heatingDefaultTemp`、10〜40℃）＋有効積算温度表示
  - 冷房デフォルト温度（`coolingDefaultTemp`、10〜40℃）＋有効積算温度表示
  - 冷蔵庫温度（`fridgeTemp`、1〜15℃）
  - **Q10値（`q10Value`、1.0〜10.0、0.1刻み）＋説明文**
  - 仕込み計画用参照温度（`room1Temp`/`room2Temp`、点線枠内サブセクション）
- 歩留まり率・仕込み計画バッファ日数（`brewBufferDays`）

### 4. 場所履歴温度一括変更
- 暖房・冷房・常温の場所履歴レコードを全ロット横断で一括変更可能
- 「暖房XX℃の全レコードをYY℃に変更」など温度変更時に個別操作不要

### 5. 気象データ取り込み（WeatherImportCard）
- 年範囲を指定して手動取り込み（0.7秒/月のディレイ）
- `app/settings/weather-actions.ts` の Server Action

---

## 画面一覧

| # | 画面名 | パス | 実装状況 |
|---|--------|------|---------|
| 1 | ダッシュボード | `/` | ✅ |
| 2 | ロット登録 | `/lots/new` | ✅ |
| 3 | ロット詳細 | `/lots/[id]` | ✅ |
| 4 | 場所移動の記録 | `/lots/[id]/move` | ✅ |
| 5 | 仕込み計画 | `/planning` | ✅ |
| 6 | データインポート | `/import` | ✅（出荷実績・仕込帳。袋詰め記録は未実装） |
| 7 | 設定 | `/settings` | ✅ |
| 8 | トレース検索 | `/trace` | ✅ |
| 9 | 試作シミュレーター | `/simulation` | ✅ |

---

## 各画面の詳細

### ダッシュボード（`/`）
- 品種別在庫サマリー（熟成中ロット / 熟成済在庫 / 小分け製品在庫 / 工場内合計）
- ロットをステータス別グループ表示（`DashboardLotGroups`コンポーネント）
  - 熟成中: 完成予定日昇順→仕込み日降順
  - 完成済み: 仕込み日降順
  - 要対応（着色リスク高・完成間近）
- アラートバナー：着色リスク高（150%超）・完成間近（7日以内）
- ロットカード（`lot-card.tsx`）：積算温度・進捗バー・現在地・桶別残量・完成予定日
- **熟成シミュレーションボタン**（熟成中ロットのみ）→ `LotSimulationModal` を開く
- **目標積算温度は常にMisoRecipeの現在値を参照**（`recipeTargetMap[lot.misoType] ?? lot.targetTempSum`）

### ロット登録（`/lots/new`）
4セクション構成：
- ① 基本情報（品種・仕込み日・目標積算温度・場所・桶番号）＋自動計算サマリー
- ② 原料配合（穀物・麹・大豆・塩・水飴・種水・種味噌・種麹）
- ③ 製造記録（出麹評価・大豆硬度・気温・品温・蒸煮条件・冷却時間・メモ）
- ④ 原料ロット（大豆・麹・塩・水飴の入荷日・仕入先・ロット番号）

初期場所のバリデーション: `LOCATION_RE = /^(?:暖房|冷房|温調室)\d+(?:\.\d+)?℃$/` または `['常温', '冷蔵庫']`

### ロット詳細（`/lots/[id]`）
- ヘッダー：ロット番号・品種バッジ・ステータス・着色リスク・積算温度進捗バー・**熟成日数**（completedAtがあればcompletedAt−brewedAt、なければ今日−brewedAt）
- **completedAt手動編集**: インライン鉛筆アイコンで直接編集。編集時は最後のLocationHistory.endDateも自動同期
- 積算温度グラフ（`LotSimChart`）:
  - 完成予定日は WeatherCache 積み上げ方式（`calcCompletionFromBrew`）で計算
  - completedAt設定済みロット: グラフ範囲を completedAt+14日で終了、実際の完成日（緑縦線）表示、完成予定日は非表示
  - 場所移動ごとにグラフの傾きが変化
  - 縦線ラベル（完成日・場所移動・今日・予測）の重なり解消: 3日以内は結合、上下交互配置
  - X軸ラベル間引き（30日以内: 毎日、90日以内: 2日ごと、それ以上: 週1）
  - **「Q10補正あり（係数：X.X）」アノテーション**（q10≠1のとき）
- 場所履歴タイムライン（各期間の積算加算量付き）・**暖房/冷房温度の後から編集機能**（鉛筆アイコン）
- **桶別残量管理**:
  - blur/Enter で保存 → ステータス自動変更（0以下で「空」、0超で「使用中」）
  - 全桶が空になると「出荷済みにする」プロンプト表示
  - 桶ごとに使用記録（BucketUsage）をトグル展開して追加・削除
- 桶の後から追加フォーム
- 仕込み記録（折りたたみ）
- 熟成メモ追加・一覧
- ステータス変更（2ステップ確認）・熟成中に戻す機能
- ロット削除（2ステップ確認・全関連データ削除）

#### Server Actions（`app/lots/[id]/actions.ts`）
| アクション | 引数 | 説明 |
|-----------|------|------|
| `addAgingNote` | `(lotId, {recordedAt, memo, airTempC, productTempC})` | 熟成メモ追加 |
| `changeLotStatus` | `(lotId, newStatus, completedAtStr?)` | ステータス変更 |
| `revertLotStatus` | `(lotId)` | 熟成中に戻す・completedAt クリア |
| `updateBucketNumbers` | `(lotId, bucketNumbers)` | 桶番号文字列の更新 |
| `updateBucketRemaining` | `(bucketId, kg)` | 残量更新・ステータス自動判定・`allEmpty`フラグ返却 |
| `addBucketToLot` | `(lotId, bucketNumber, initialWeightKg)` | 既存ロットへ桶を追加 |
| `addBucketUsage` | `(bucketId, {usedAt, usedKg, notes})` | 使用記録を追加 |
| `deleteBucketUsage` | `(usageId)` | 使用記録を削除 |
| `deleteLot` | `(lotId)` | ロットと全関連データを削除 |

### 場所移動（`/lots/[id]/move`）
- 移動先を大きなボタンで選択: **暖房 / 冷房 / 常温 / 冷蔵庫**
- 暖房/冷房を選択すると温度入力欄を表示（初期値: `heatingDefaultTemp`/`coolingDefaultTemp`）
- 有効積算温度をリアルタイム表示（例: `有効積算：15℃/日`）
- 「移動と同時に熟成完了にする」チェックボックス（熟成中のみ）
- 保存文字列: `暖房25℃`・`冷房20℃`・`常温`・`冷蔵庫`

### 仕込み計画（`/planning`）

#### ① AI仕込み提案（BrewSuggestions）
テンプレート方式（Claude API不使用）:
```
在庫切れ予測日 = 今日 + (有効在庫 ÷ 1日消費量)
推奨仕込み日   = 在庫切れ予測日 − 熟成日数 − brewBufferDays（デフォルト14日）
原料手配締切   = 推奨仕込み日 − リードタイム（通常21日、白みそ7日）
```

UI機能:
- **予測方式**: SARIMAX / HW（ホルト・ウィンタース・12ヶ月以上必要）/ 3年平均 をトグル切り替え
- **需要見積りトグル（標準／保守的）**: **常時表示・全方式で有効**。「保守的」で需要を多めに見積もり、在庫切れ日が早まり推奨仕込み日を安全側に前倒し。方式別の保守値：**SARIMAX→`upper90`**（90%上限）／**HW→`holtWinters().upperBound`**（平均+σ）／**3年平均→`get3YearConservative`**（平均+標準偏差、1点のみは×1.1）。`buildDailyRateFn(..., conservative)` と月次推計（`sarimaxMonthlyEst`/`hwMonthlyEst`/`avg3`）の両方に適用。localStorage: `planning_conservativeDemand`
- **予測信頼度バッジ（MAPE表示）**: **SARIMAX使用時のみ**、カードヘッダーに「予測誤差 ±XX%」を表示（`sarimaxMape` prop ← `SystemSetting` の `forecast_mape_<品種>`）。色分け：≤15%緑（信頼度高）／15〜30%黄／>30%灰（目安程度）。ホバーで解釈の説明。提案日をどこまで信じるかの判断材料
- **品種別の自動方式選択トグル（手動／自動）**: 「自動（実績ベスト）」で、バックテスト（`lib/backtest.ts` の `pickAutoMethods`）が品種ごとに最も的中する方式を採用（`autoMethodByType` prop ← page.tsxで`computeBacktest`→`pickAutoMethods`、MAPE≤30%の品種のみ・白みそ等低精度品種は除外しグローバル選択にフォールバック）。品種ごとに `effMethod = autoMethodByType[name] ?? forecastMethod` を使い `monthlyAvg`・`buildDailyRateFn`・`usingSarimax` 等を切替。採用品種は紫の「自動：SARIMAX/AI予測/3年平均」バッジを表示。トグルは信頼できるベストが1品種以上あるときのみ表示。localStorage: `planning_autoMethod`
- **表示回数**: 1/3/5回分（品種ごとに個別設定も可能）
- **仕込み場所セレクタ**: 品種ごとに選択（`暖房{heatingDefaultTemp}℃` / `冷房{coolingDefaultTemp}℃` / `常温` / `冷蔵庫`）→ `simulateFermentationDays()` でQ10補正あり・なし両方の熟成日数を計算
  - **デフォルト選択ロジック**: localStorage未保存の場合、`plans`確定後に`locationInitializedRef`（`useRef`）で1回だけ1回目仕込み日の月を参照し季節判定（6〜9月→常温 / 10〜5月→暖房）。localStorage保存済み（ユーザーが手動変更）は上書きしない。
- **Q10補正あり・なし両方を表示**: 仕込み日・完成日・手配締切をそれぞれ表示
- **Q10補正基準の切替トグル**（localStorageで永続化）
- **予定出荷（大口）入力**: 品種ごとに「出荷予定日＋kg」を登録（`localStorage`: `planning_scheduledOrders_{name}`、JSON配列）。**未来分のみ**を負の補充イベント（`{date, kg: -kg}`）として既存の `supplyEvents` パイプライン（`findStockOutDate`・`computeSupplyReceived`）に合流し、在庫切れ日を前倒し→推奨仕込み日を前倒し。過去日（≦今日）は現在庫に織り込み済みとみなし反映外。統計予測が知り得ない確定受注を人手で注入する用途（大口は実質無添加麦みそのみ）
  - **反映効果バナー（全回分）**: 予定出荷を入れると、入力欄の直下に「反映前→反映後」の比較を表示（`orderImpact`）。在庫切れ予測日は `computeIdeal()` で、各回（表示回数分）の仕込み日は予定出荷あり／なしの `calcBatches` を同一条件で2本走らせて同インデックス同士を比較し、回ごとに before→after と前倒し日数を表示。予定出荷なし側の1回目起点は手動指定のみ引き継ぐ（自動補正は渡さず1回目の真の前倒しも見えるように）
- **仮登録（確定）分の算入と確定行表示**: `registeredPlansByType` prop（page.tsxで status=`仮登録`・lotId無し・完成日>今日 の BrewPlan を品種別に整理）。**完成日に生産量(`totalWeightKg`)が入る確定供給**として `supplyEvents` に合流→AI提案を後ろ倒し。表は「確定行（緑・`isFixed`・手配列は『確定済』・**常に全行表示**）＋新規提案行（`shownGenerated = generatedDeduped.slice(0, recipeBatches)`・**表示回数は新規提案のみに効かせる**）」を仕込み日順に並べる。新規提案分のみ `calcBatches` で生成（確定分と二重計上しない）。**※表示回数の打ち切りを確定行＋新規提案の合算にかけると、表示1回＋確定行ありのとき本当の次提案が消えて最優先判定（③）から漏れるため、確定行は枠を消費しない**。**本登録済（ロット化済み）は熟成中ロットで算入済みのため対象外**。手動調整の鉛筆・在庫切れ警告・手配緊急度バッジは「最初の新規提案行」基準。旧 `initialManualBrewDates` による1回目固定は廃止（確定行として明示するため）
- **今週やるべきこと／最優先品種バナー（③・APIコストなし）**: カード一覧の直上に、全品種を横断して最も急ぐ1件を強調表示（`topPriority`）。ランキングは「過去超過を最優先（超過日数が大きいほど上位）→ 手配締切までの日数が短い順」。超過 or 締切30日以内のときは⚠️赤/黄バナー（超過 or 14日以内=赤・15〜30日=黄）、それ以外は✅緑で「直近の候補」を提示。`useRawAsBase`に追従。品種バッジ付き
- **根拠の自然文サマリー（①・APIコストなし）**: 各品種カード先頭に、有効在庫・消費ペース・在庫切れ予測日・熟成日数・推奨仕込み日・手配締切を1段落の日本語に要約したバナー（`summary`）。緊急度で3トーン（超過=⚠️赤／締切14日以内 or 仕込み7日以内=🟡黄／余裕=✅緑）。Q10基準トグル（`useRawAsBase`）に追従。**熟成中ロットの扱いを明示**（悲観的モード=「熟成中ロット X kg が順次完成する分を見込んでも」／楽観的モード=「有効在庫（うち熟成中 X kg を算入）」）。「最初の新規提案」基準。Claude API不使用（計算済み数値をテンプレに差し込むだけ）
- **What-if もしもの試算（②・全回分・APIコストなし）**: 各品種カードの折りたたみパネル（`plan.whatIf`・state: `whatIfOpen`/`whatIfPct`/`whatIfDelay`/`whatIfTemp`、品種別・非永続）。ステッパー（`WhatIfStepper`）で値を変えると即再計算。**表示中の各回（`shownNew = generatedDeduped.slice(0, shownGenCount)`）を起点に全回分**を試算（表示回数2回以上で「N回目」ラベル付きリスト、1回なら単一行）。3シナリオ：(1)**需要が±X%**変わったら→在庫切れ日（`findStockOutDate`にスケール済みレート）＋各回の仕込み日の動き（`calcBatches`をスケール済みレートで全回再計算し同インデックス比較）(2)**仕込みがN日遅れたら**→各回が**その回の在庫切れ日（`BatchPlan.stockOutDate`）**に間に合うか判定（余裕/不足日数）(3)**気温が±X℃違ったら**（常温のみ）→各回の仕込み日で`simulateFermentationDays`に補正済み気象を渡し熟成日数・完成日（夏仕込みは影響大・冬仕込みは影響なしと回ごとに差が出る）。増減は`DeltaTag`で色付き（日付:後ろ倒し緑/前倒し赤、熟成日数は`invertColor`で延長赤/短縮緑）
- **在庫切れリスク警告バナー**: 1回目推奨日が過去の場合、超過日数・有効在庫・消費ペース・推定在庫切れまでの日数を表示（予定出荷・仮登録の確定供給も反映済み）
- **1回目推奨仕込み日が過去の場合は今日以降に自動修正**（表示回数1〜5回で共通ロジック。後続バッチは修正後の完成日を起点に連鎖計算し昇順を保証。警告バナーは元の推奨日を表示）
- **1回目仕込み日の手動微調整機能**（鉛筆アイコン・日付入力ポップオーバー）
- **計算の根拠**: 全回分を折りたたみ表示（①消費量推計 ②有効在庫 ③在庫切れ日〜仕込み日 ④手配締切）
- **仕込みカレンダー**: 仕込み日・完成日を月カレンダー上に色分け・凡例付き表示
- バッファ日数トグル（あり/なし）・仕込み曜日トグル（水・木のみ/制限なし）
- 完成日に熟成日数を併記（例: `6/15 (50日)`）
- CSVエクスポート・印刷
- 仕込み場所の選択はブランドごとに `localStorage` で永続化

**熟成日数の収束**: 常温の推奨仕込み日は `refineBrewDateToStockOut()` の不動点反復で「仕込み日 ＝ 在庫切れ日 −（その日に仕込んだ場合の実熟成日数＋バッファ）」を収束させる。年間平均ベースの静的推定だと初回の仮仕込み日が別の季節（春＝遅い）に落ち、1回だけの補正では夏仕込みなのに2〜3週間前倒し過ぎる不具合があったため、`calcBatches`（Q10あり／なし両チェーン）・`computeIdeal` の全箇所で反復補正に統一済み。

#### ② 需要グラフ（DemandChart）
Recharts棒グラフ・月別出荷実績

#### ②' 予測精度・傾向（ForecastBacktest）
過去の予測と実績を突き合わせ、品種ごとに**3方式（SARIMAX / AI予測(HW) / 3年平均）の偏り(bias)・平均誤差(MAPE)・的中度**を表示する折りたたみパネル。
- 評価窓：直近 `WINDOW=24` ヶ月。各対象月より**前の実績のみ**で予測（先読み防止）。SARIMAXは `sarimaxPastForecast`（ForecastCacheの過去LOO）、HWは `calcHWHistorical`、3年平均は同月実績から都度算出
- **偏り** = (予測−実績)÷実績の平均。マイナス＝予測が少なめ（欠品リスク側・赤）／プラス＝多め（過剰在庫側・青）／±3%未満はほぼ偏りなし
- **平均誤差(MAPE)** 最小の方式を「最も的中」として✓ハイライト（`MIN_N=3` ヶ月以上で判定）
- 偏りが続く品種は保守モード（90%）や在庫手動調整で補正、という運用ヒントを併記
- `app/planning/ForecastBacktest.tsx`（client）。propsは `shipmentMap`・`sarimaxPastForecast` のみ

#### ③ 気象シミュレーター（WeatherSimulator）
品種×仕込み日→熟成完了予定日推計。6〜9月は常温（気象データ）、10〜5月は `room1Temp`。Q10補正あり・なし両方の完成日縦線を表示。

#### ④ SARIMAX予測更新（ForecastUpdater）
- Pythonスクリプトを実行してForecastCacheを更新するボタン
- `forecast-actions.ts` の `runSarimaxForecast()` Server Action が呼ばれる

### データインポート（`/import`）
タブ構成:

**Tab 1: 出荷実績** ✅
- xlsx「月間集計」シート（列A: 年月ラベル、列B: 全品種合計kg）
- 元号パターン: `H27.3月`・`H.30.2月`・`2019.01月`（M=1867, T=1911, S=1925, H=1988, R=2018）
- `@@unique([yearMonth, misoType])` でupsert

**Tab 2: 仕込帳** ✅ バックエンド実装済み（UIはShikomiImport.tsx・アクションはshikomi-actions.ts）
- UTF-8 CSVファイルをアップロード
- フィールド: brewedAt, misoType, bucketNumbers, mugiKg, kojiKg, daizuKg, shioKg, shikomiKg, daizuOrigin, 等
- ステータス判定: useStartAt記録あり→「出荷済」、なし→「完成」
- `importShikomiData()` Server Action: Lot + BrewRecord を作成（lotNumber重複はスキップ）

**Tab 3: 袋詰め記録** 🚧 未実装
- UIのプレースホルダーのみ（「準備中」表示）

### トレース検索（`/trace`）
URLパラメータでサーバーサイドフィルタ:
- ロット番号（部分一致）・品種・仕込み日範囲・ステータス
- 大豆産地・大豆ロット番号・麹仕入れ先・塩ロット番号・桶番号

結果: 積算温度・着色リスク・現在地・桶番号・大豆産地・**熟成日数・目標積算温度**
原料アラートバナー: 大豆ロット番号/麹仕入れ先検索時にヒット件数を警告表示
**completedAt手動編集**: 結果一覧からインライン編集可能

---

## ロット登録の自動計算

```
麹処理後(kg)    = 穀物(kg) × kojiRatio         （麦: ×1.2, 米: ×1.1）
蒸煮大豆(kg)   = 大豆(kg) × soybeanRatio       （×2.3）
仕立量(kg)     = 麹処理後 + 蒸煮大豆 + 塩 + 種水 + 水飴 + 種味噌
塩分(%)        = 塩 ÷ 仕立量 × 100
麹歩合(割)     = 穀物原料 ÷ 大豆原料 × 10
蒸煮大豆水分率  = ((soybeanRatio - 1) + 大豆含水量) ÷ soybeanRatio
水分(%)        = (麹処理後×麹水分率 + 蒸煮大豆×蒸煮大豆水分率 + 種水×1.0 + 水飴×mizuame水分率 + 種味噌×seedMiso水分率) ÷ 仕立量 × 100
```

白みそのアルコール添加量 = 仕立量 × 2.5%

---

## コンポーネント一覧

### `components/NavBar.tsx`
`'use client'` — `usePathname()` でアクティブリンクをアンダーライン表示。sticky top / backdrop blur。

### `components/dashboard/DashboardLotGroups.tsx`
ステータス別グループ（熟成中・完成・要対応）を3セクションで表示。

### `components/dashboard/lot-card.tsx`
ロットカード。LotCardProps を受け取り、熟成度バー・現在地・桶残量（折りたたみ）を表示。
熟成中 + `simConfig` があれば「熟成シミュレーション」ボタンを表示。

### `app/planning/BrewPlanList.tsx`
仮登録リストのテーブルコンポーネント。`BrewPlanItem` 型を export。現在は `BrewPlanDrawer` にインポートして使用。

### `app/planning/BrewPlanDrawer.tsx`
画面下部に固定追従する仮登録リストドロワー（`'use client'`）。
- 仮登録が1件以上あるときのみ表示（`fixed bottom-0`）
- 折りたたみバー: 件数バッジ（仮登録/本登録済）を常時表示
- 展開時: テーブルを上方向に表示（最大55vh・スクロール対応）
- ロット登録リンク・削除ボタンを含む

### `components/dashboard/LotSimulationModal.tsx`
将来の場所を選択してインタラクティブに熟成完了日を予測するモーダル。
- Recharts ComposedChart: Q10補正ライン（青）＋補正なしライン（グレー点線）
- 参照線: 100%完了・現在日・場所移動イベント・完成予定日
- 場所選択（暖房/冷房/常温/冷蔵庫）で再計算
- `lib/brewSimulation.ts` の `simulateLotForModal()` を使用

---

## 品種バッジカラー（lib/misoTypeColor.ts）

| 品種 | background | color | border |
|------|-----------|-------|--------|
| 無添加麦みそ | #E1F5EE | #0F6E56 | #5DCAA5 |
| 田舎みそ | #FAEEDA | #854F0B | #EF9F27 |
| 山吹みそ | #EEEDFE | #3C3489 | #AFA9EC |
| 白みそ | #E6F1FB | #185FA5 | #85B7EB |

---

## 重要な実装上の注意点

### Zod v4 構文
```typescript
// ✅ 正しい（v4）
z.number({ error: 'メッセージ' })
z.enum(VALUES, { error: 'メッセージ' })
// ❌ 間違い（v3の書き方）
z.number({ errorMap: ..., invalid_type_error: ... })
```

### `redirect()` を `startTransition` 内で使わない
```typescript
// ❌ ReactがredirectをSwallowする
startTransition(async () => { await action(); redirect('/path') })
// ✅ actionはresultを返し、クライアント側でrouter.push()する
startTransition(async () => {
  const result = await action()
  if (result.success) router.push('/path')
})
```

### Tailwind v4 の動的クラス検出
- `STYLE_MAP[key]` のような動的参照はビルド時に消える可能性がある
- 解決策: if-else で静的文字列を返す関数に書き直す

### SQLite の `createMany` 制限
- interactive transaction内で `createMany` はSQLiteで動作しない（エラーなく0件）
- トランザクション外で `create` を個別に呼ぶこと

### Prisma migrate のドリフト対策
- スキーマとDBが乖離した場合: `npx prisma migrate resolve --applied <migration_name>` でベースラインとして登録
- `npx prisma generate` はdev serverが起動中だとDLLロックでEPERM。必ずサーバーを停止してから実行

### allowedDevOrigins（スマホ開発アクセス）
```typescript
// next.config.ts
const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.11.19'],
}
```
これがないとスマホ（192.168.11.19経由）からのHMR WebSocketがブロックされ、クライアントサイドJSが動作しない。

### その他
- `useTransition` で Server Action を呼ぶ（`<form>` タグ不使用）
- shadcn Select の `onValueChange: (value: string | null) => void`
- Prisma クライアント出力先: `lib/generated/prisma`
- コメント・エラーメッセージは全て**日本語**
- 日付はJST基準（WeatherCacheのみUTC midnight）
- 品種名は必ず正規化: 「無添加麦みそ」「田舎みそ」「山吹みそ」「白みそ」

---

## 未実装・課題

- [ ] 袋詰め記録インポート（/import?tab=packaging）: 未実装（UIプレースホルダーのみ）
- [ ] PackagingLot管理画面・SeedMisoUsage記録UI
- [ ] 外部API `packagedStockKg` フィールド追加（外部システム側対応待ち）
- [ ] SarimaxスクリプトのPythonパス・依存関係のセットアップ手順整備
- [ ] 試作シミュレーター：配合設定とグラフをスクロールなしで同時確認できるレイアウト改善

---

## 試作シミュレーター（`/simulation`）

### 概要

裸麦・大豆・塩・水の配合から熟成挙動を理論的に推計するシミュレーター。
実測データ蓄積なしで一回性の試作品に使用する。精度目安±30〜50%。

**対象**: 裸麦・砕米・無洗米・普通米使用・水飴なし・アルコール添加なしの試作品のみ
**キャリブレーション基準**: 無添加麦みそ（麹歩合24.1割・塩分10.9%・目標600℃・日）

### 反応モデル（A→B→C 連続反応）

```
デンプン(A) →[k_amy]→ 糖(B) →[k_mic]→ 酸・アルコール(C)
タンパク質  →[k_pro]→ アミノ酸（並行反応）
```

保存則: `A(T) + B(T) + C(T) = 1`（A₀ = 1 に正規化）

### キャリブレーション定数

| 定数 | 値 | 根拠 |
|------|-----|------|
| `K_AMY_BASE` | 0.00420 / (℃・日) | 拘束①②を満たすr=2.0から逆算 |
| `K_MIC_BASE` | 0.00840 / (℃・日) | 同上（aw=0.83・塩分10.9%時点） |
| `T_PEAK_BASE` | 165 ℃・日 | 文献値：完成積算温度の約28% |
| `Q10_ENZ` | 2.0 | アミラーゼの温度感受性 |
| `Q10_MIC` | 4.0 | 微生物（糖消費）の温度感受性 |
| `T_REF` | 25 ℃ | キャリブレーション基準温度（暖房デフォルト） |
| `KOJI_HO_BASE` | 24.1 割 | 無添加麦みそ基準麹歩合 |
| `SALT_KOJI_RATE` | 0.175 %/割 | 塩分自動連動の傾き（麹歩合1割↑→塩分0.175%↓） |
| `SOKKO_BA_CLOSE` | 0.75 | 速醸収穫窓の閉じ条件（B×AA積のしきい値） |
| `R_BITTER` | 2.0 | 苦味ペプチド→アミノ酸の分解レート比（kPeptidase = kPro × 2） |
| `F_YEAST_BASE` | 0.40 | 塩分5%・35℃以下での最大酵母比率 |
| `F_YEAST_SALT_RATE` | 0.020 /% | 塩分1%↑あたりの酵母比率低下量 |
| `YEAST_SUPPRESS_TEMP` | 35 ℃ | 酵母抑制開始温度 |
| `YEAST_DEATH_TEMP` | 50 ℃ | 酵母死滅温度（速醸領域） |
| `FRUIT_OPT_TEMP` | 28 ℃ | 花果様香（エステル）生成の最適温度 |
| `KOME_KOJI_HO_BASE` | 10.9 割 | 普通米（米みそ）の暫定基準麹歩合。自社実績データなし。一般的な信州味噌型（10〜12割）の目安として仮置き |
| `KOME_SALT_PCT_BASE` | 10.9 % | 普通米（米みそ）の暫定基準塩分。同上、仮置き |
| `KOME_T_COMPLETE` | 800 ℃・日 | 普通米（米みそ）の暫定目標積算温度。「麦みそと同日数（600℃・日）ではまだ米麹の芯が残る」という経験的フィードバックに基づき、デンプン残存率を麦みそ完成時点（約8%）の半分弱（約3.5%）まで下げる値として仮置き |

**キャリブレーション拘束条件**:
- ① `T_peak = 165 ℃・日`（r=2.0 → `ln(2)/(kAmy×1) = 165`）
- ② `B(600) / B_max = 0.30`（完成時点で糖は最大値の30%）

### コアモデル式（T = 積算温度 ℃・日）

#### 通常熟成モード（暖房・冷房・常温）

```
aw(塩分%)      = 0.99 − 0.015 × 塩分%
k_amy          = 0.00420 × (kojiQ / 6.0) × (麹歩合 / 24.1)   ← 麹歩合で酵素量を反映
k_mic(aw)      = 0.00840 × (aw − 0.75) / 0.08                 ← aw=0.75未満は微生物ほぼ停止
k_pro          = 0.5 × k_amy
k_peptidase    = k_pro × R_BITTER                              ← 苦味ペプチド→アミノ酸の分解レート
pH_final       = 4.5 + 0.05 × 塩分%

# Q10差分補正（B計算用の有効微生物レート。r<1でもB≥0を保証）
r       = (k_mic / k_amy) × (Q10_MIC / Q10_ENZ) ^ ((locTemp − T_REF) / 10)
kMicEff = k_amy × r    ← ループ内のB計算に使用（raw k_micは r 算出のみ）

A(T)        = exp(−k_amy × T)
B(T)        = 1/(r−1) × (exp(−k_amy×T) − exp(−kMicEff×T))   ※r≈1はL'Hôpital適用
C(T)        = 1 − A(T) − B(T)
protein(T)  = exp(−k_pro × T)                           （タンパク質残存）
bitter(T)   = 1/(R_BITTER−1) × (protein(T) − exp(−k_peptidase×T))  （苦味ペプチド中間体）
AA(T)       = 1 − protein(T) − bitter(T)                （= (1−exp(−k_pro×T))²  R_BITTER=2のとき）
C_alcohol   = C(T) × fYeast                             （アルコール成分）
C_acid      = C(T) × (1 − fYeast)                       （酸成分）
pH(T)       = 6.8 − (6.8 − pH_final) × C(T)

# 酵母比率（塩分・温度依存）
fYeast_base = clamp(0.40 − 0.020 × (塩分% − 5), 0.05, 0.40)
fYeast_temp = clamp((50 − locTemp) / (50 − 35), 0, 1)   ← 35℃超で抑制・50℃で0
fYeast      = fYeast_base × fYeast_temp                  ← 速醸時は強制0

# 収穫窓：旨味条件は protein(T) < 0.70（苦味ペプチドを含む総分解量≥30%）
T_peak   = ln(r) / (k_amy × (r−1))          （糖ピーク）
T_bitter = ln(R_BITTER) / (k_pro × (R_BITTER−1)) = ln(2)/k_pro  （苦味ピーク）
T_AApeak = −ln(1 − √0.9) / k_pro            （AA=90%・二段階モデル）

# 着色指数（不可逆・累積積分）
maillard_rate(T) = (B/bMax) × AA(T) × f_aw_maillard(aw)
maillard(T) = ∫₀ᵀ maillard_rate(t) dt × 100 / T_MAX   （単調増加・グラフ表示）

# 香気傾向（収穫窓中央 or T_COMPLETE での瞬間評価）
香気_焦香     = B(evalT)/bMax × AA(evalT) × f_aw_maillard(aw) × 100 × 3  （精度±100%）
香気_花果様香 = C_alcohol(evalT) × fruitFactor × 100 × 2.5  （fruitFactor: 28℃最大）
香気_酸香     = C_acid(evalT) × 100 × (100/70)
```

#### 速醸モード（50〜65℃の加温熟成）

```
# 高温でアミラーゼを活性化・微生物を死滅させる手法（西京みそ等）
k_amy_sokko = K_AMY_BASE × (kojiQ/6.0) × (麹歩合/24.1) × Q10_ENZ^((locTemp−T_REF)/10)
k_mic       = 0（微生物死滅）
k_pro_sokko = 0.5 × k_amy_sokko

A(T)    = exp(−k_amy_sokko × T)
B(T)    = 1 − A(T)    （単調増加、ピークなし）
C(T)    = 0
AA(T)   = 1 − exp(−k_pro_sokko × T)
pH(T)   = 6.8（一定・酸生成なし）
bMax    = 1（全デンプンが糖に変換）
```

### 着色指数（Maillard）

```
f_aw_maillard(aw) = max(0, 1 − |aw − 0.77| / 0.15)   ← aw≈0.77で最大・釣り鐘型
着色指数(T) = (B/bMax) × (AA/100%) × f_aw_maillard(aw) × 100
```

### 収穫窓の定義

**モード切替可能**（UIのトグルで切替、グラフの緑エリアがアニメーション）：

| モード | 糖の閾値 | 用途 |
|--------|---------|------|
| **品質バランス**（デフォルト） | B ≥ 25% of B_max | 無添加麦みそ等の実際の仕上がり（600℃・日付近）に対応 |
| **甘味重視** | B ≥ 50% of B_max | 甘味のピーク付近を狙う仕込み |

**共通条件**: protein(T) < 70%（苦味ペプチドを含む総分解量 ≥ 30%） かつ pH ≥ 4.8

※ 旧条件「AA > 30%」は二段階モデル導入後に低麹歩合で未達になるため `protein < 70%` に変更。

**速醸モードの追加条件**: B × AA > 0.75 で収穫窓を閉じる（高温でのMaillard基質過剰＝着色リスク）

### 甘味ポテンシャル（サマリーカード）

```
甘味ポテンシャル = (result.bMax × ingredients.grainKg)
                ÷ (base.bMax   × baseIngredients.grainKg)
```

- `bMax`：デンプンのうちピーク時に糖になる割合（効率）
- `grainKg`：仕立量あたりの穀物量（デンプン絶対量の代理）
- 両方を掛け合わせることで「麹歩合が高いほど甘い」を正しく反映
- `base` は同じ温度・同じモードでの基準配合（無添加麦みそ）との比較

### 麹歩合と塩分の役割

| 変数 | 主な効果 |
|------|---------|
| 麹歩合↑ | k_amy↑（酵素量増）→ 糖生産速度↑・甘味ポテンシャル↑ |
| 麹歩合↑ | 塩分が自動連動で低下（0.175%/割）→ aw↑ → k_mic↑（相殺） |
| 塩分↑ | aw↓ → k_mic↓（糖消費が遅い）→ 収穫窓が広くなる |
| 低温仕込み | Q10差分でk_micがk_amyより大きく減速 → r低下 → 糖が長く残る |
| 出麹評価 | UIから削除・内部で6固定（標準） |

### 塩分自動連動

```
塩分% = baseSaltPct + (baseKojiHo − kojiHo) × 0.175
```

- 麹歩合変更時に自動計算（高麹歩合ほど低塩の一般論を反映）
- UIの「連動」トグルでOFF可能（手動調整したい場合）

### 場所セレクタと温度効果

| 選択肢 | locTemp | dailyAccum | 特記 |
|--------|---------|-----------|------|
| 暖房 | room1Temp | room1Temp − 10 | 設定画面の暖房温度 |
| 冷房 | room2Temp | max(room2Temp − 10, 0) | 設定画面の冷房温度 |
| 常温 | 月平均気温（WeatherCache） | 月平均Q10補正済み | **仕込み開始月**を1〜12月で選択 |
| 速醸 | sokkoTemp（45〜65℃） | sokkoTemp − 10 | 特別モデル（kMic=0）を使用 |

`locTemp` は `r` の Q10差分補正に使用。グラフ説明文に温度・℃/日換算を表示。
速醸時はグラフ X軸を 0〜300 ℃・日に縮小（約2〜7日相当）。

### 除外した例外パラメータ（対象外の品種への対応）

| 品種 | 除外理由 |
|------|---------|
| 田舎みそ | 水飴（B₀オフセット）がA→B→Cの出発点を変える |
| 山吹みそ | 砕米の表面積効果でk_amyが実態と乖離 |
| 白みそ（通常熟成） | アルコール添加でk_mic≈0 → 速醸モードで代替可 |

### 原料逆算（仕立量から全原料を計算）

配合設定（仕立量・麹歩合・塩分%・目標水分%）から全原料量を連立方程式で解く：

```
R = 麹歩合/10、P = 塩分%/100、M = 目標水分率

soybeanKg    = 仕立量 × (1 − P − M) / (R×1.2×(1−mugiKoji) + 2.3×(1−steamedSoyMoisture))
grainKg      = R × soybeanKg
saltKg       = P × 仕立量
kojiKg       = grainKg × kojiRatio
mushiDaizuKg = soybeanKg × soybeanRatio
seedWaterL   = M × 仕立量 − (grainKg×1.2×mugiKoji + soybeanKg×2.3×steamedSoyMoisture)
```

**目標水分率（M）の決定**：過去の無添加麦みそBrewRecord（直近20件）から実測平均で算出。
データがない場合はレシピ計算値（種水なし）にフォールバック。

仕立量≤10kgのとき原料表示を kg→g・L→mL に自動切り替え。

### 対水食塩濃度

```
対水食塩濃度(%) = 塩分% / 目標水分% × 100
```

配合設定カードにリアルタイム表示。水分活性awと並べて表示。

### 試作品ロット登録との連携

シミュレーター内「この配合でロット登録へ →」ボタンで `/lots/new` に以下をURLパラメータで渡す：

```
?prototype=true&targetTempSum=XXX&grainKg=XX&kojiKg=XX&soybeanKg=XX&saltKg=XX&seedWaterL=XX&shikomiKg=XX
```

- `prototype=true` のとき品種名フィールドが **自由テキスト入力** に切り替わる（既存レシピ選択なし）
- 原料量・目標積算温度が自動セット済み
- `Lot.isPrototype = true` で登録される
- ダッシュボード・ロット詳細に **紫の「試作」バッジ** を表示

目標積算温度 = 収穫窓の中央値 `(windowStart + windowEnd) / 2`

### グラフ仕様（Recharts ComposedChart）

- **X軸**：積算温度（℃・日）の絶対値（通常 0〜900、速醸 0〜300）
- **左Y軸**：0〜110%（各反応の進行度）
- **右Y軸**：pH 4.0〜7.2

| ライン | 色 | 太さ | マーカー | 内容 |
|--------|-----|------|---------|------|
| デンプン残存 | グレー | 1.2px | なし | A(T) × 100% |
| タンパク質残存 | ティール | 1.2px | なし | protein(T) × 100% |
| 苦味ペプチド（中間体） | 茶色 | 1.5px | ◆ | bitter(T) × 100% |
| 糖（甘味源） | オレンジ | 2.5px | ● | B正規化（B_max=100%） |
| アミノ酸（旨味源） | エメラルド | 2.5px | ▲ | AA(T) × 100%（二段階モデル） |
| アルコール（推定） | 青 | 1.5px | ■ | C×fYeast×100%（精度±50-80%） |
| 着色指数 | ピンク | 1.2px | なし | 累積Maillard（単調増加） |
| pH（右軸） | 紫 | 1.5px | なし | pH(T) |

**X軸（二軸）**：下軸=積算温度（℃・日）、上軸=日数換算（常温は≈表記で近似）
**縦線**：糖ピーク（オレンジ）・苦味ピーク（茶色・破線）・アミノ酸ピーク（エメラルド）・基準完成600℃・日（グレー）
**収穫窓ハイライト**：緑のReferenceArea。モード切替時にx1/x2を400ms ease-outでアニメーション（requestAnimationFrame補間）。
**凡例クリック**：各ラインを個別に表示/非表示切替可能。「全て表示」ボタンで一括復元。
**マーカー間隔**：通常モードはX軸ticごと（30点間隔=150℃・日）、速醸モードは10点間隔。

**香気傾向（グラフカード下部に統合）**：
- 焦香（カラメル・焦げ）・花果様香（フルーティー）・酸香の3バーを横並び表示
- 収穫窓中央 or T_COMPLETE での瞬間評価。縦線=基準配合値との比較
- 精度±100%の定性的傾向把握のみ

### UI構成（BrewSimulator.tsx）

- **Stepper入力**：[−] 数値 [+] 形式。フォーカス時に全選択・blur/Enterで確定
- **麹歩合範囲**：5〜100割（旧10〜50から拡張）
- **2カラムカード**：左=配合設定（仕立量→麹歩合→塩分[連動]→目標水分）、右=原料逆算テーブル
- **場所セレクタ**：暖房/冷房/常温（月セレクト）/速醸（温度セレクト）
- **収穫窓モード**：品質バランス / 甘味重視 切替トグル
- **グラフアニメーション**：ライン 400ms ease-out、収穫窓エリア requestAnimationFrame補間
- **ページ順序**：配合設定カード→グラフ（香気傾向含む）→収穫窓モード+アラート→サマリーカード→モデル注記

### ファイル構成

| ファイル | 役割 |
|---------|------|
| `app/simulation/page.tsx` | サーバー：レシピ・MoistureSettings・BrewRecord直近20件・WeatherCache月別平均を取得 |
| `app/simulation/BrewSimulator.tsx` | クライアント：Stepper UI・モデル計算（通常/速醸）・原料逆算・Rechartsグラフ・試作登録ボタン |

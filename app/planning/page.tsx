import { format, startOfDay } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { getMisoRecipes } from '@/lib/recipes'
import { fetchAgedStock, fetchMonthlySales } from '@/lib/externalApi'
import { calcCompletionFromBrew } from '@/lib/brewSimulation'
import { computeBacktest, pickAutoMethods } from '@/lib/backtest'
import BrewSuggestions from './BrewSuggestions'
import DemandChart from './DemandChart'
import ForecastBacktest from './ForecastBacktest'
import WeatherSimulator from './WeatherSimulator'
import ForecastUpdater from './ForecastUpdater'
import BufferDaySuggestion from './BufferDaySuggestion'

export const dynamic = 'force-dynamic'

// SARIMAX予測マップの型定義
// misoType → { months, forecast, lower90, upper90, updatedAt }
type SarimaxEntry = {
  months:    string[]
  forecast:  number[]
  lower90:   number[]
  upper90:   number[]
  updatedAt: string | null
}
type SarimaxMap = Record<string, SarimaxEntry>

// 全品種合計から品種別を推計する比率（将来は設定画面で変更可能）
// 根拠：33347:21566:2883:残り = 57.3%:37.0%:5.0%:0.7%
const BRAND_RATIOS: Record<string, number> = {
  '無添加麦みそ': 33347 / 58210,
  '田舎みそ':     21566 / 58210,
  '山吹みそ':     2883  / 58210,
  '白みそ':       1 - 33347 / 58210 - 21566 / 58210 - 2883 / 58210,
}

// 確認済み大口注文（SystemSetting: forecast_largeOrders）を実績から差し引く。
// SARIMAX予測はPython側で差し引き済みのベース需要を返すため、TS側の需要推計
// （HW・3年平均）とバックテストも同じベース需要に揃えないと、
// 大口混入月（例: 2024-05は+22%過大）の消費推計・方式選択が歪む。
// 生実績のまま使うもの：DemandChart（出荷実績の表示）・BufferDaySuggestion
// （バッファは予定外の需要変動への備えなので、大口込みの変動係数が適切）。
function subtractLargeOrders(
  map:    Record<string, Record<string, number>>,
  orders: { yearMonth: string; misoType: string; kg: number }[],
): Record<string, Record<string, number>> {
  if (orders.length === 0) return map
  const result: Record<string, Record<string, number>> = {}
  for (const [type, data] of Object.entries(map)) result[type] = { ...data }
  for (const o of orders) {
    if (!o.yearMonth || !o.misoType || !(o.kg > 0)) continue
    // 品種別と全品種合計の両方から差し引く
    for (const type of [o.misoType, '全品種合計']) {
      const kg = result[type]?.[o.yearMonth]
      if (kg != null) result[type][o.yearMonth] = Math.max(0, kg - o.kg)
    }
  }
  return result
}

// 全品種合計から比率で品種別データを補完する
// 月単位でマージ：明示的データ（API・インポート）を優先し、ない月は全品種合計から補完
function enrichShipmentMap(
  map: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = { ...map }
  const total = map['全品種合計'] ?? {}
  if (Object.keys(total).length === 0) return result

  for (const [brand, ratio] of Object.entries(BRAND_RATIOS)) {
    const existing = result[brand] ?? {}
    const merged: Record<string, number> = {}

    // 全品種合計の全月を比率で補完（ベース）
    for (const [ym, kg] of Object.entries(total)) {
      merged[ym] = Math.round(kg * ratio)
    }

    // 明示的データ（API・インポート）で上書き
    for (const [ym, kg] of Object.entries(existing)) {
      merged[ym] = kg
    }

    result[brand] = merged
  }
  return result
}

export default async function PlanningPage() {
  const [moisture, recipes, shipmentHistory, weatherData, fermentingLotRows, apiSales, apiStock, forecastRows, mapeRows, brewPlans, snapshotCount, largeOrderSetting] = await Promise.all([
    getMoistureSettings(),
    getMisoRecipes(),
    prisma.shipmentHistory.findMany({ orderBy: { yearMonth: 'asc' } }),
    prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
    prisma.lot.findMany({
      where:  { status: '熟成中' },
      select: {
        misoType:      true,
        totalWeightKg: true,
        brewedAt:      true,
        targetTempSum: true,
        lotNumber:     true,
        bucketNumbers: true,
        buckets:         { select: { status: true, remainingWeightKg: true, initialWeightKg: true } },
        locationHistory: { select: { location: true, endDate: true }, orderBy: { startDate: 'desc' }, take: 1 },
      },
    }),
    fetchMonthlySales(),
    fetchAgedStock(),
    // ForecastCacheからSARIMAX予測を取得
    prisma.forecastCache.findMany({ orderBy: { yearMonth: 'asc' } }),
    // SARIMAXのMAPEをSystemSettingから取得
    prisma.systemSetting.findMany({ where: { key: { startsWith: 'forecast_mape_' } } }),
    // 仮登録リスト（仮登録・本登録済の両方を取得）
    prisma.brewPlan.findMany({ orderBy: { brewDate: 'asc' } }),
    // 月末在庫スナップショットの蓄積数
    prisma.monthlyInventorySnapshot.count(),
    // 確認済み大口注文リスト（forecast_largeOrders）
    prisma.systemSetting.findUnique({ where: { key: 'forecast_largeOrders' } }),
  ])

  // 確認済み大口注文をパース（不正JSONは空扱い）
  let largeOrders: { yearMonth: string; misoType: string; kg: number }[] = []
  try {
    const parsed = JSON.parse(largeOrderSetting?.value ?? '[]')
    if (Array.isArray(parsed)) largeOrders = parsed
  } catch {
    largeOrders = []
  }

  // 熟成中ロットを品種別に集計（Bucketがある場合は残量で計算）
  const fermentingByType: Record<string, { totalKg: number; count: number }> = {}
  for (const lot of fermentingLotRows) {
    const nonEmptyBuckets = lot.buckets.filter(b => b.status !== '空')
    const effectiveKg = lot.buckets.length > 0
      ? nonEmptyBuckets.reduce((sum, b) => sum + (b.remainingWeightKg ?? b.initialWeightKg), 0)
      : lot.totalWeightKg
    const entry = fermentingByType[lot.misoType] ?? { totalKg: 0, count: 0 }
    entry.totalKg += effectiveKg
    entry.count   += 1
    fermentingByType[lot.misoType] = entry
  }

  // MM-dd別の有効積算温度平均（気象シミュレーター・完了予定日推計用）
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weatherData) {
    const key = format(w.date, 'MM-dd')
    const entry = totals.get(key) ?? { sum: 0, count: 0 }
    entry.sum += w.effectiveTemp
    entry.count += 1
    totals.set(key, entry)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of totals) {
    weatherAvg[key] = Math.round((sum / count) * 100) / 100
  }

  // 熟成中ロットの完成予定日スケジュール（品種別・仕込み計画の在庫補充タイミング用）
  const recipeTargetMap = Object.fromEntries(recipes.map(r => [r.name, r.targetTempSum]))
  const dailyRoomAccum  = moisture.heatingDefaultTemp - 10
  const fermentingScheduleByType: Record<string, { completionDateStr: string; yieldKg: number; label?: string }[]> = {}
  for (const lot of fermentingLotRows) {
    const nonEmptyBuckets = lot.buckets.filter(b => b.status !== '空')
    const yieldKg = lot.buckets.length > 0
      ? nonEmptyBuckets.reduce((sum, b) => sum + (b.remainingWeightKg ?? b.initialWeightKg), 0)
      : lot.totalWeightKg
    if (yieldKg <= 0) continue

    const currentLocation = lot.locationHistory[0]?.location ?? '常温'
    const targetTempSum   = recipeTargetMap[lot.misoType] ?? lot.targetTempSum

    const completionDate = calcCompletionFromBrew(
      lot.brewedAt,
      targetTempSum,
      currentLocation,
      weatherAvg,
      dailyRoomAccum,
      moisture.q10Value,
      moisture.heatingDefaultTemp,
      moisture.fridgeTemp,
    )
    if (!completionDate) continue

    if (!fermentingScheduleByType[lot.misoType]) fermentingScheduleByType[lot.misoType] = []
    fermentingScheduleByType[lot.misoType].push({
      completionDateStr: format(startOfDay(completionDate), 'yyyy-MM-dd'),
      yieldKg,
      // 在庫推移グラフの補充ジャンプに表示するラベル（桶番号がなければロット番号）
      label: lot.bucketNumbers ? `桶${lot.bucketNumbers}` : lot.lotNumber,
    })
  }

  // 出荷実績を { misoType: { 'YYYY-MM': kg } } に集約（ShipmentHistory ベース）
  const rawShipmentMap: Record<string, Record<string, number>> = {}
  for (const h of shipmentHistory) {
    if (!rawShipmentMap[h.misoType]) rawShipmentMap[h.misoType] = {}
    rawShipmentMap[h.misoType][h.yearMonth] = h.weightKg
  }

  // 外部API（2026-01〜）のデータを優先してマージ
  if (apiSales) {
    for (const item of apiSales) {
      if (item.yearMonth >= '2026-01') {
        if (!rawShipmentMap[item.misoType]) rawShipmentMap[item.misoType] = {}
        rawShipmentMap[item.misoType][item.yearMonth] = item.weightKg
      }
    }
  }

  // 品種別データがなければ「全品種合計」から比率で補完
  const shipmentMap = enrichShipmentMap(rawShipmentMap)

  // 需要推計・バックテスト用のベース需要マップ（確認済み大口を差し引き）
  const baseShipmentMap = subtractLargeOrders(shipmentMap, largeOrders)

  // API在庫を品種別Mapに変換（熟成済 + 小分け製品の合計）
  const apiStockByType: Record<string, number> = {}
  for (const item of apiStock ?? []) {
    apiStockByType[item.misoType] = item.stockKg + (item.packagedStockKg ?? 0)
  }

  // ForecastCacheを未来予測（sarimaxMap）と過去LOO予測（sarimaxPastForecast）に分離
  // 過去：yearMonth <= 今月、未来：yearMonth > 今月
  const currentYM = format(new Date(), 'yyyy-MM')
  const sarimaxMap: SarimaxMap = {}
  const sarimaxPastForecast: Record<string, Record<string, number>> = {}

  for (const row of forecastRows) {
    if (row.yearMonth < currentYM) {
      // 過去LOO予測（グラフ表示用・確定済み月のみ）
      if (!sarimaxPastForecast[row.misoType]) sarimaxPastForecast[row.misoType] = {}
      sarimaxPastForecast[row.misoType][row.yearMonth] = row.forecastKg
    } else {
      // 未来予測（BrewSuggestions・DemandChart未来期間用）
      if (!sarimaxMap[row.misoType]) {
        sarimaxMap[row.misoType] = {
          months:    [],
          forecast:  [],
          lower90:   [],
          upper90:   [],
          updatedAt: row.updatedAt
            ? row.updatedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
            : null,
        }
      }
      sarimaxMap[row.misoType].months.push(row.yearMonth)
      sarimaxMap[row.misoType].forecast.push(row.forecastKg)
      sarimaxMap[row.misoType].lower90.push(row.lower90)
      sarimaxMap[row.misoType].upper90.push(row.upper90)
    }
  }

  // SARIMAX MAPEをマップに変換（forecast_mape_<品種> → { 品種: mape }）
  const sarimaxMape: Record<string, number> = {}
  for (const row of mapeRows) {
    const misoType = row.key.replace('forecast_mape_', '')
    const val = parseFloat(row.value)
    if (!isNaN(val)) sarimaxMape[misoType] = val
  }

  // 最終更新日時（全品種で最も新しいもの）
  const latestUpdatedAt = forecastRows.length > 0
    ? forecastRows
        .map(r => r.updatedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0]
        .toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : null

  const recipeList = recipes.map(r => ({
    name:            r.name,
    targetTempSum:   r.targetTempSum,
    defaultLocation: r.defaultLocation,
    totalWeightKg:   r.totalWeightKg,
    safetyStockKg:   r.safetyStockKg,
    winterSafetyStockKg: r.winterSafetyStockKg,
    summerSafetyStockKg: r.summerSafetyStockKg,
  }))

  // 品種別の自動方式選択：バックテストで最も的中する方式（精度しきい値以下のみ採用）
  // ベース需要で評価（大口混入月でSARIMAXが不当に不利にならないように）
  const backtest        = computeBacktest(recipeList.map(r => r.name), baseShipmentMap, sarimaxPastForecast)
  const autoMethodByType = pickAutoMethods(backtest)

  // 仮登録済み（確定）の未来の仕込み予定（ロット化前のみ）を品種別に整理。
  // 完成日に生産量が入る確定供給として、AI提案に織り込む。
  const today0 = startOfDay(new Date())
  const registeredPlansByType: Record<string, { brewDateStr: string; completionDateStr: string; materialOrderDeadlineStr: string; fermentationDays: number; bucketNumbers?: string | null }[]> = {}
  // 本登録済み（ロット化済み）の仕込み日（品種別）。同じ日付の手動調整ピンを自動解除するために渡す。
  const registeredDoneDatesByType: Record<string, string[]> = {}
  for (const p of brewPlans) {
    if (p.status === '本登録済' || p.lotId) {
      ;(registeredDoneDatesByType[p.misoType] ??= []).push(format(p.brewDate, 'yyyy-MM-dd'))
      continue
    }
    if (p.status !== '仮登録') continue
    if (p.completionDate <= today0) continue
    ;(registeredPlansByType[p.misoType] ??= []).push({
      brewDateStr:              format(p.brewDate, 'yyyy-MM-dd'),
      completionDateStr:        format(p.completionDate, 'yyyy-MM-dd'),
      materialOrderDeadlineStr: format(p.materialOrderDeadline, 'yyyy-MM-dd'),
      fermentationDays:         p.fermentationDays,
      bucketNumbers:            p.bucketNumbers,
    })
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-16 space-y-6 sm:space-y-8">
      {/* タイトルとSARIMAX更新ボタン */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="hidden sm:block text-2xl font-bold text-gray-900 tracking-tight print:text-2xl">仕込み計画</h1>
        <div className="no-print">
          <ForecastUpdater updatedAt={latestUpdatedAt} />
        </div>
      </div>

      <div className="no-print">
        <DemandChart
          shipmentMap={shipmentMap}
          sarimaxForecast={Object.keys(sarimaxMap).length > 0 ? sarimaxMap : undefined}
          sarimaxPastForecast={Object.keys(sarimaxPastForecast).length > 0 ? sarimaxPastForecast : undefined}
          sarimaxMape={Object.keys(sarimaxMape).length > 0 ? sarimaxMape : undefined}
        />
      </div>

      <div className="no-print">
        <ForecastBacktest
          shipmentMap={baseShipmentMap}
          sarimaxPastForecast={Object.keys(sarimaxPastForecast).length > 0 ? sarimaxPastForecast : undefined}
          largeOrderCount={largeOrders.length}
        />
      </div>

      <div className="no-print">
        <WeatherSimulator
          recipes={recipeList}
          weatherAvg={weatherAvg}
          q10Value={moisture.q10Value}
          heatingBaseTemp={moisture.heatingDefaultTemp}
          coolingDefaultTemp={moisture.coolingDefaultTemp}
          fridgeTemp={moisture.fridgeTemp}
        />
      </div>

      <BufferDaySuggestion
        currentBufferDays={moisture.brewBufferDays}
        shipmentMap={shipmentMap}
        snapshotCount={snapshotCount}
      />

      <BrewSuggestions
        recipes={recipeList}
        shipmentMap={baseShipmentMap}
        heatingDefaultTemp={moisture.heatingDefaultTemp}
        coolingDefaultTemp={moisture.coolingDefaultTemp}
        fridgeTemp={moisture.fridgeTemp}
        q10Value={moisture.q10Value}
        brewBufferDays={moisture.brewBufferDays}
        weatherAvg={weatherAvg}
        fermentingByType={fermentingByType}
        apiStockByType={Object.keys(apiStockByType).length > 0 ? apiStockByType : undefined}
        sarimaxForecast={Object.keys(sarimaxMap).length > 0 ? sarimaxMap : undefined}
        sarimaxMape={Object.keys(sarimaxMape).length > 0 ? sarimaxMape : undefined}
        autoMethodByType={Object.keys(autoMethodByType).length > 0 ? autoMethodByType : undefined}
        fermentingScheduleByType={Object.keys(fermentingScheduleByType).length > 0 ? fermentingScheduleByType : undefined}
        existingBrewPlanKeys={brewPlans
          .filter(p => p.status === '仮登録')
          .map(p => `${p.misoType}::${format(p.brewDate, 'yyyy-MM-dd')}`)}
        registeredPlansByType={Object.keys(registeredPlansByType).length > 0 ? registeredPlansByType : undefined}
        registeredDoneDatesByType={Object.keys(registeredDoneDatesByType).length > 0 ? registeredDoneDatesByType : undefined}
      />

    </div>
  )
}

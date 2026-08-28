import { differenceInDays, format, startOfDay } from 'date-fns'
import { AlertTriangle, Clock } from 'lucide-react'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import {
  calcAccumulatedTempSplit,
  calcColoringRisk,
  getCurrentLocation,
} from '@/lib/tempCalc'
import { calcCompletionFromBrew } from '@/lib/brewSimulation'
import { fetchAgedStock } from '@/lib/externalApi'
import { getMisoRecipes } from '@/lib/recipes'
import { makeSafetyLineFn } from '@/lib/brewPlanCalc'
import { fermentingKgOfLot } from '@/lib/lotStock'
import DashboardLotGroups from '@/components/dashboard/DashboardLotGroups'
import { type LotCardProps, type LotSimConfig } from '@/components/dashboard/lot-card'
import StockSummary from '@/components/dashboard/StockSummary'
import InventoryTrendChart from '@/components/dashboard/InventoryTrendChart'

// 常にサーバー側で最新データを取得する
export const dynamic = 'force-dynamic'


export default async function DashboardPage() {
  // weatherData は全期間取得（oldestBrewDate フィルタだと過去年の夏季データが欠落し
  // weatherAvg が空になるため、ロット積算計算・シミュレーター両方が正常に動作しない）
  const [moisture, agedStockData, recipes, weatherData, inventorySnapshots] = await Promise.all([
    getMoistureSettings(),
    fetchAgedStock(),
    getMisoRecipes(),
    prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
    prisma.monthlyInventorySnapshot.findMany({
      orderBy: [{ yearMonth: 'asc' }, { misoType: 'asc' }],
    }),
  ])

  // レシピの現在の目標積算温度を品種名でルックアップ
  const recipeTargetMap: Record<string, number> = {}
  for (const r of recipes) recipeTargetMap[r.name] = r.targetTempSum
  // 安全在庫ライン（熟成済バラ在庫、kg）。未設定の品種は含めない
  const safetyStockMap: Record<string, number> = {}
  // 季節でラインが変わる（冬季11〜2月は厚め・夏季5〜8月は薄め）。未設定の季節は通年ライン
  const now = new Date()
  for (const r of recipes) {
    // 通年が未設定でも季節ラインだけ設定されている品種（例: 山吹みそ＝冬季300kg）がある
    if (r.safetyStockKg == null && r.winterSafetyStockKg == null && r.summerSafetyStockKg == null) continue
    const line = makeSafetyLineFn(r.safetyStockKg ?? 0, r.winterSafetyStockKg, r.summerSafetyStockKg)(now)
    if (line > 0) safetyStockMap[r.name] = line
  }
  // 表示する品種はレシピ（有効なもの）から。ハードコードすると品種追加時に
  // サマリー・グラフから無言で抜け落ちる
  const misoTypes = recipes.map(r => r.name)
  const roomTemps = { room1Temp: moisture.room1Temp, room2Temp: moisture.room2Temp, fridgeTemp: moisture.fridgeTemp, heatingBaseTemp: moisture.heatingDefaultTemp, q10Value: moisture.q10Value }

  // API在庫を品種別Mapに変換
  const agedStockMap: Record<string, { agedKg: number; packagedKg: number | null }> = {}
  for (const item of agedStockData ?? []) {
    agedStockMap[item.misoType] = {
      agedKg:    item.stockKg,
      packagedKg: item.packagedStockKg ?? null,
    }
  }

  // 出荷済を除くロットを取得
  const lots = await prisma.lot.findMany({
    where: { status: { notIn: ['出荷済'] } },
    include: {
      locationHistory: { orderBy: { startDate: 'asc' } },
      buckets: { orderBy: { bucketNumber: 'asc' } },
    },
  })

  // 日付文字列 → 有効積算温度のMap
  const weatherMap = new Map<string, number>(
    weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
  )

  // MM-dd別の有効積算温度平均（シミュレーター用）
  const wmTotals = new Map<string, { sum: number; count: number }>()
  for (const w of weatherData) {
    const key = format(w.date, 'MM-dd')
    const entry = wmTotals.get(key) ?? { sum: 0, count: 0 }
    entry.sum += w.effectiveTemp
    entry.count += 1
    wmTotals.set(key, entry)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of wmTotals) {
    weatherAvg[key] = Math.round((sum / count) * 100) / 100
  }

  const simConfig: LotSimConfig = {
    weatherAvg,
    q10Value:           moisture.q10Value,
    heatingBaseTemp:    moisture.heatingDefaultTemp,
    room1Temp:          moisture.room1Temp,
    heatingDefaultTemp: moisture.heatingDefaultTemp,
    coolingDefaultTemp: moisture.coolingDefaultTemp,
    fridgeTemp:         moisture.fridgeTemp,
  }

  const today = startOfDay(new Date())

  // 各ロットの積算温度・リスク・完成予定日を計算
  const lotData: LotCardProps[] = lots.map(lot => {
    const targetTempSum   = recipeTargetMap[lot.misoType] ?? lot.targetTempSum
    // 「完成までの熟成度」と「完成後に進んだ分」を分けて出す。
    // 完成後も置き場の温度に応じて熟成は進むため、着色リスクは累計で判定する
    const accumUntil      = lot.status === '熟成中' ? null : lot.completedAt
    const accum           = calcAccumulatedTempSplit(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps, accumUntil)
    const accumulated     = accum.untilCompletion
    const currentLocation = getCurrentLocation(lot.locationHistory)
    const coloringRisk    = calcColoringRisk(accum.total, targetTempSum)
    // 仕込み日起点シミュレーション（simulateLotForModal準拠）→ ロット詳細モーダルと完成予定日を統一。
    // 今日時点の実績積算（accumulated）を渡して較正するため、カードの熟成度%と同じ点を通る
    const estimatedCompletion =
      lot.status === '熟成中'
        ? calcCompletionFromBrew(
            lot.brewedAt, targetTempSum, currentLocation,
            weatherAvg, moisture.heatingDefaultTemp - 10, moisture.q10Value, moisture.heatingDefaultTemp, moisture.fridgeTemp,
            accumulated,
          )
        : null
    const elapsedDays = differenceInDays(today, startOfDay(lot.brewedAt))
    const locationTransitions = lot.locationHistory.slice(1).map((h, i) => ({
      date: format(h.startDate, 'yyyy-MM-dd'),
      from: lot.locationHistory[i].location,
      to:   h.location,
    }))

    return {
      id: lot.id,
      lotNumber: lot.lotNumber,
      misoType: lot.misoType,
      brewedAtISO: lot.brewedAt.toISOString(),
      elapsedDays,
      accumulatedTemp: accumulated,
      postCompletionTemp: accum.afterCompletion > 0 ? accum.afterCompletion : null,
      targetTempSum,
      currentLocation,
      estimatedCompletionISO: estimatedCompletion?.toISOString() ?? null,
      completedAtISO: lot.completedAt?.toISOString() ?? null,
      coloringRisk,
      status: lot.status,
      isPrototype: lot.isPrototype,
      bucketNumbers: lot.bucketNumbers ?? null,
      buckets: lot.buckets.map(b => ({
        bucketNumber: b.bucketNumber,
        initialKg:    b.initialWeightKg,
        remainingKg:  b.remainingWeightKg,
        status:       b.status,
      })),
      locationTransitions,
    }
  })

  // グループ分け
  const agingLots       = lotData.filter(l => l.status === '熟成中')
  const completedLots   = lotData.filter(l => l.status === '完成')
  const needsActionLots = lotData.filter(l => ['種みそ転用', '品質低下出荷'].includes(l.status))

  // 各グループを完成予定日昇順（null は末尾）→ 仕込み日降順 でソート
  const sortGroup = (arr: typeof lotData) =>
    arr.sort((a, b) => {
      if (a.estimatedCompletionISO && b.estimatedCompletionISO) {
        return new Date(a.estimatedCompletionISO).getTime() - new Date(b.estimatedCompletionISO).getTime()
      }
      if (a.estimatedCompletionISO) return -1
      if (b.estimatedCompletionISO) return 1
      return new Date(b.brewedAtISO).getTime() - new Date(a.brewedAtISO).getTime()
    })

  sortGroup(agingLots)
  sortGroup(completedLots)
  sortGroup(needsActionLots)

  // 熟成中ロットを品種別に集計（桶残量ベース。数え方は lib/lotStock.ts に集約）
  const fermentingKgByType: Record<string, number> = {}
  for (const lot of lots) {
    if (lot.status !== '熟成中') continue
    const kg = fermentingKgOfLot(lot, moisture.yieldRate)
    fermentingKgByType[lot.misoType] = (fermentingKgByType[lot.misoType] ?? 0) + kg
  }

  // アラート条件（熟成中のみ対象）
  const dangerLots = agingLots.filter(l => l.coloringRisk === 'danger')
  const nearCompletionLots = agingLots.filter(l => {
    if (!l.estimatedCompletionISO) return false
    const days = differenceInDays(new Date(l.estimatedCompletionISO), today)
    return days >= 0 && days <= 7
  })
  // 安全在庫ラインを下回っている品種（熟成済バラ在庫のみで判定。小分け製品は含めない）
  const lowSafetyStockTypes = Object.entries(safetyStockMap)
    .map(([type, line]) => ({ type, line, agedKg: agedStockMap[type]?.agedKg ?? null }))
    .filter(t => t.agedKg != null && t.agedKg < t.line)

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-16 space-y-4 sm:space-y-6">
      <h1 className="hidden sm:block text-2xl font-bold text-gray-900 tracking-tight">ダッシュボード</h1>

      {/* 品種別在庫サマリー */}
      <StockSummary
        misoTypes={misoTypes}
        agedStockMap={agedStockMap}
        fermentingKgByType={fermentingKgByType}
        hasApiData={agedStockData != null}
        hasApiError={agedStockData == null && !!process.env.STOCK_API_URL}
        safetyStockMap={safetyStockMap}
      />

      {/* 在庫推移グラフ */}
      <InventoryTrendChart snapshots={inventorySnapshots} misoTypes={misoTypes} />

      {/* アラートバナー */}
      {(dangerLots.length > 0 || nearCompletionLots.length > 0 || lowSafetyStockTypes.length > 0) && (
        <div className="space-y-2">
          {lowSafetyStockTypes.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-orange-200 bg-orange-50/70 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm text-orange-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <span className="font-semibold">安全在庫ライン割れ（熟成済バラ在庫）：</span>
                {lowSafetyStockTypes
                  .map(t => `${t.type}（${Math.round(t.agedKg!).toLocaleString()}kg／ライン${t.line.toLocaleString()}kg）`)
                  .join('、')}
              </div>
            </div>
          )}
          {dangerLots.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <span className="font-semibold">着色リスク高（150%超）：</span>
                {dangerLots.map(l => `${l.lotNumber}（${l.misoType}）`).join('、')}
              </div>
            </div>
          )}
          {nearCompletionLots.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm text-amber-700">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <span className="font-semibold">完成間近（7日以内）：</span>
                {nearCompletionLots
                  .map(l => {
                    const days = differenceInDays(new Date(l.estimatedCompletionISO!), today)
                    return `${l.lotNumber}（${l.misoType}・あと${days}日）`
                  })
                  .join('、')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ロット一覧（グループ別） */}
      <DashboardLotGroups
        misoTypes={misoTypes}
        agingLots={agingLots}
        completedLots={completedLots}
        needsActionLots={needsActionLots}
        simConfig={simConfig}
      />
    </div>
  )
}

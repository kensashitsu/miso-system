import { differenceInDays, format, startOfDay } from 'date-fns'
import { AlertTriangle, Clock } from 'lucide-react'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import {
  calcAccumulatedTemp,
  calcColoringRisk,
  getCurrentLocation,
} from '@/lib/tempCalc'
import { calcCompletionFromBrew } from '@/lib/brewSimulation'
import { fetchAgedStock } from '@/lib/externalApi'
import { getMisoRecipes } from '@/lib/recipes'
import DashboardLotGroups from '@/components/dashboard/DashboardLotGroups'
import { type LotCardProps, type LotSimConfig } from '@/components/dashboard/lot-card'

// 常にサーバー側で最新データを取得する
export const dynamic = 'force-dynamic'

const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const

export default async function DashboardPage() {
  // weatherData は全期間取得（oldestBrewDate フィルタだと過去年の夏季データが欠落し
  // weatherAvg が空になるため、ロット積算計算・シミュレーター両方が正常に動作しない）
  const [moisture, agedStockData, recipes, weatherData] = await Promise.all([
    getMoistureSettings(),
    fetchAgedStock(),
    getMisoRecipes(),
    prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
  ])

  // レシピの現在の目標積算温度を品種名でルックアップ
  const recipeTargetMap: Record<string, number> = {}
  for (const r of recipes) recipeTargetMap[r.name] = r.targetTempSum
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
    const accumulated     = calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps)
    const currentLocation = getCurrentLocation(lot.locationHistory)
    const coloringRisk    = calcColoringRisk(accumulated, targetTempSum)
    // 仕込み日起点シミュレーション（simulateLotForModal準拠）→ ロット詳細モーダルと完成予定日を統一
    const estimatedCompletion =
      lot.status === '熟成中'
        ? calcCompletionFromBrew(
            lot.brewedAt, targetTempSum, currentLocation,
            weatherAvg, moisture.room1Temp - 10, moisture.q10Value, moisture.heatingDefaultTemp, moisture.fridgeTemp,
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
      targetTempSum,
      currentLocation,
      estimatedCompletionISO: estimatedCompletion?.toISOString() ?? null,
      completedAtISO: lot.completedAt?.toISOString() ?? null,
      coloringRisk,
      status: lot.status,
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

  // 熟成中ロットを品種別に集計（桶残量ベース）
  const fermentingKgByType: Record<string, number> = {}
  for (const lot of agingLots) {
    const nonEmpty = lot.buckets.filter(b => b.status !== '空')
    const kg = lot.buckets.length > 0
      ? nonEmpty.reduce((sum, b) => sum + (b.remainingKg ?? b.initialKg), 0)
      : 0
    fermentingKgByType[lot.misoType] = (fermentingKgByType[lot.misoType] ?? 0) + kg
  }

  // アラート条件（熟成中のみ対象）
  const dangerLots = agingLots.filter(l => l.coloringRisk === 'danger')
  const nearCompletionLots = agingLots.filter(l => {
    if (!l.estimatedCompletionISO) return false
    const days = differenceInDays(new Date(l.estimatedCompletionISO), today)
    return days >= 0 && days <= 7
  })

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 pb-16 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">ダッシュボード</h1>

      {/* 品種別在庫サマリー */}
      <section>
        <h2 className="text-base font-semibold text-gray-700 mb-3">品種別在庫サマリー</h2>
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            {agedStockData ? (
              <span className="inline-flex items-center rounded-full border border-emerald-200/60 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                在庫API連携中
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-dashed border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-400">
                {process.env.STOCK_API_URL ? 'データ取得エラー' : '在庫API未設定'}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2.5 pr-3 text-gray-400 font-medium text-xs tracking-wider uppercase">品種</th>
                  <th className="text-right py-2.5 px-3 text-gray-400 font-medium text-xs tracking-wider uppercase">熟成中ロット</th>
                  <th className="text-right py-2.5 px-3 text-gray-400 font-medium text-xs tracking-wider uppercase">熟成済在庫</th>
                  <th className="text-right py-2.5 px-3 text-gray-400 font-medium text-xs tracking-wider uppercase">小分け製品在庫</th>
                  <th className="text-right py-2.5 pl-3 text-gray-400 font-medium text-xs tracking-wider uppercase">工場内合計</th>
                </tr>
              </thead>
              <tbody>
                {MISO_TYPES.map(type => {
                  const stock      = agedStockMap[type] ?? null
                  const aged       = stock?.agedKg ?? null
                  const packaged   = stock?.packagedKg ?? null
                  const fermenting = Math.round(fermentingKgByType[type] ?? 0)
                  const total      = aged != null
                    ? aged + (packaged ?? 0) + fermenting
                    : null
                  return (
                    <tr key={type} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                      <td className="py-2.5 pr-3 text-sm font-medium text-gray-700">{type}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {fermenting > 0
                          ? <><span className="font-semibold text-gray-900">{fermenting.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {aged != null
                          ? <><span className="font-semibold text-gray-900">{aged.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {packaged != null
                          ? <><span className="font-semibold text-gray-900">{packaged.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">
                        {total != null
                          ? <><span className="font-semibold text-gray-900">{total.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                {(() => {
                  const rows = MISO_TYPES.map(type => {
                    const stock      = agedStockMap[type] ?? null
                    const aged       = stock?.agedKg ?? null
                    const packaged   = stock?.packagedKg ?? null
                    const fermenting = Math.round(fermentingKgByType[type] ?? 0)
                    return { aged, packaged, fermenting }
                  })
                  const hasAnyAged     = rows.some(r => r.aged != null)
                  const hasAnyPackaged = rows.some(r => r.packaged != null)
                  const sumFermenting = rows.reduce((s, r) => s + r.fermenting, 0)
                  const sumAged       = hasAnyAged     ? rows.reduce((s, r) => s + (r.aged     ?? 0), 0) : null
                  const sumPackaged   = hasAnyPackaged ? rows.reduce((s, r) => s + (r.packaged ?? 0), 0) : null
                  const sumTotal      = sumAged != null
                    ? sumAged + (sumPackaged ?? 0) + sumFermenting
                    : null
                  return (
                    <tr className="border-t-2 border-gray-100 bg-gray-50/60">
                      <td className="py-2.5 pr-3 text-sm font-semibold text-gray-700">合計</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-sm">
                        {sumFermenting > 0
                          ? <><span className="font-semibold text-gray-900">{sumFermenting.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-sm">
                        {sumAged != null
                          ? <><span className="font-semibold text-gray-900">{sumAged.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-sm">
                        {sumPackaged != null
                          ? <><span className="font-semibold text-gray-900">{sumPackaged.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-sm">
                        {sumTotal != null
                          ? <><span className="font-semibold text-gray-900">{sumTotal.toLocaleString()}</span><span className="text-gray-400 font-normal text-xs ml-0.5">kg</span></>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  )
                })()}
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {/* アラートバナー */}
      {(dangerLots.length > 0 || nearCompletionLots.length > 0) && (
        <div className="space-y-2">
          {dangerLots.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <span className="font-semibold">着色リスク高（150%超）：</span>
                {dangerLots.map(l => `${l.lotNumber}（${l.misoType}）`).join('、')}
              </div>
            </div>
          )}
          {nearCompletionLots.length > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-700">
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
        agingLots={agingLots}
        completedLots={completedLots}
        needsActionLots={needsActionLots}
        simConfig={simConfig}
      />
    </div>
  )
}

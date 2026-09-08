'use server'

import { addMonths, format, getDaysInMonth, startOfDay } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { simulateFermentationDays, makeSafetyLineFn } from '@/lib/brewPlanCalc'
import { computeRetrospect, type RetrospectResult } from '@/lib/retrospect'

// 振り返りの計算に必要なデータ（在庫スナップショット・出荷実績・ロット・気象）は
// どれも重いので、画面を開いた瞬間ではなくボタンを押したときに取りに行く。
// 仕込み計画は全品種の提案計算だけでも重く、常時ここまで読むと開くのが遅くなる。

export interface RetrospectData {
  baseYearMonth: string          // 起点にした月末（例 2026-04）
  startDate:     string
  endDate:       string
  results:       RetrospectResult[]
  note:          string | null   // 計算できなかった理由など
}

export async function getRetrospect(baseYearMonth?: string): Promise<RetrospectData> {
  const [recipes, allSnaps, shipments, lots, moisture, weather] = await Promise.all([
    prisma.misoRecipe.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.monthlyInventorySnapshot.findMany({ orderBy: { yearMonth: 'asc' } }),
    prisma.shipmentHistory.findMany({ orderBy: { yearMonth: 'asc' } }),
    prisma.lot.findMany({ orderBy: { brewedAt: 'asc' } }),
    getMoistureSettings(),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  // 起点は指定が無ければ「最も古い月末スナップショット」。そこから今日までを振り返る。
  // ただし記録日時がその月末から離れているものは、月末以外に手動実行されて
  // ラベルが1ヶ月ずれた可能性がある（2026-05-30に実行された「2026-04」が実例）。
  // 中身は別の時点の在庫なので起点にすると振り返り全体がずれる。除外する
  const isTrustworthy = (ym: string) => {
    const rec = allSnaps.find(s => s.yearMonth === ym)?.recordedAt
    if (!rec) return false
    const monthEnd = addMonths(new Date(`${ym}-01T00:00:00`), 1)   // 翌月1日
    const diffDays = Math.abs((rec.getTime() - monthEnd.getTime()) / 86400000)
    return diffDays <= 3
  }
  const available = [...new Set(allSnaps.map(s => s.yearMonth))].sort().filter(isTrustworthy)
  const baseYm = baseYearMonth ?? available[0]
  if (!baseYm) {
    return {
      baseYearMonth: '', startDate: '', endDate: '', results: [],
      note: '月末在庫スナップショットがまだ無いため振り返れません（毎月末に自動保存されます）',
    }
  }

  const startDate = startOfDay(addMonths(new Date(`${baseYm}-01T00:00:00`), 1))
  const endDate   = startOfDay(new Date())
  const snaps     = allSnaps.filter(s => s.yearMonth === baseYm)

  // MM-dd別の有効積算温度平均（他の画面と同じ作り方）
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weather) {
    const k = format(w.date, 'MM-dd')
    const e = totals.get(k) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    totals.set(k, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [k, v] of totals) weatherAvg[k] = Math.round((v.sum / v.count) * 100) / 100
  const vals = Object.values(weatherAvg)
  const fallback = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 14

  const results: RetrospectResult[] = []
  for (const recipe of recipes) {
    // 各月末スナップショットを「翌月1日の朝の実測在庫」として持たせる
    const anchors = new Map<string, number>()
    for (const sn of allSnaps.filter(x => x.misoType === recipe.name && available.includes(x.yearMonth))) {
      const at = addMonths(new Date(`${sn.yearMonth}-01T00:00:00`), 1)
      if (at > startDate && at <= endDate) {
        anchors.set(format(at, 'yyyy-MM-dd'), (sn.agedKg ?? 0) + (sn.packagedKg ?? 0))
      }
    }
    const snap = snaps.find(s => s.misoType === recipe.name)
    if (!snap) continue                       // 起点在庫が無い品種は出さない
    const startKg = (snap.agedKg ?? 0) + (snap.packagedKg ?? 0)

    // 消費（月次実績の日割り）。実績が無い月は直近の月で代用する
    const rate: Record<string, number> = {}
    for (const s of shipments.filter(s => s.misoType === recipe.name)) {
      rate[s.yearMonth] = s.weightKg / getDaysInMonth(new Date(s.yearMonth + '-01T00:00:00'))
    }
    const months = Object.keys(rate).sort()
    if (months.length === 0) continue
    const dailyRateOf = (dt: Date) => rate[format(dt, 'yyyy-MM')] ?? rate[months[months.length - 1]] ?? 0

    // 補充（実際に完成したロット）。完了時の確定歩留まりがあればそれを使う
    const supplyByDate = new Map<string, number>()
    for (const l of lots) {
      if (l.misoType !== recipe.name || !l.completedAt) continue
      const k = format(l.completedAt, 'yyyy-MM-dd')
      supplyByDate.set(k, (supplyByDate.get(k) ?? 0) + (l.finalYieldKg ?? l.totalWeightKg * moisture.yieldRate))
    }

    results.push(computeRetrospect({
      misoType:     recipe.name,
      startKg,
      startDate,
      endDate,
      dailyRateOf,
      supplyByDate,
      anchors,
      safetyLineAt: makeSafetyLineFn(recipe.safetyStockKg ?? 0, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg),
      brewDates:    lots
        .filter(l => l.misoType === recipe.name && l.brewedAt >= startDate && l.brewedAt <= endDate)
        .map(l => l.brewedAt),
      batchKg:      recipe.totalWeightKg * moisture.yieldRate,
      fermentDaysAt: (brewDate: Date) =>
        simulateFermentationDays(
          brewDate, recipe.targetTempSum, weatherAvg, fallback,
          moisture.q10Value, moisture.heatingDefaultTemp,
          Math.max(moisture.heatingDefaultTemp - 10, 0),
        ).days,
    }))
  }

  return {
    baseYearMonth: baseYm,
    startDate:     format(startDate, 'yyyy-MM-dd'),
    endDate:       format(endDate, 'yyyy-MM-dd'),
    results,
    note: null,
  }
}

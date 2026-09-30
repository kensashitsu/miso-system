// 熟成中ロットの完成予定日（2026-10-01 切り出し）。
// 「熟成完了日」カレンダー（lib/calendarSync.ts）と、調味料工場の生産管理（factory-planner）向けの
// API（app/api/aging-lots）で同じ計算を使うため、ここに集約した。
// 実績の積算温度で較正した予定日（ダッシュボードの表示と同じ）。天候で数日前後する。

import { format } from 'date-fns'
import { prisma } from './prisma'
import { getHeatingStartDate, getMoistureSettings } from './settings'
import { calcAccumulatedTemp, getCurrentLocation } from './tempCalc'
import { calcCompletionFromBrew } from './brewSimulation'

export interface AgingLotPrediction {
  id:             string
  lotNumber:      string
  misoType:       string
  totalWeightKg:  number
  bucketNumbers:  string | null
  brewedAt:       Date
  targetTempSum:  number
  completion:     Date      // 完成予定日
}

export async function listAgingLotPredictions(): Promise<AgingLotPrediction[]> {
  const [moisture, heatingStartDate, lots, recipes, weather] = await Promise.all([
    getMoistureSettings(),
    getHeatingStartDate(),
    prisma.lot.findMany({
      where: { status: '熟成中' },
      include: { locationHistory: { orderBy: { startDate: 'asc' } } },
    }),
    prisma.misoRecipe.findMany(),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  // 日別・月日平均の有効積算温度（ダッシュボードと同じ作り方）
  const weatherMap = new Map<string, number>(weather.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp]))
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weather) {
    const k = format(w.date, 'MM-dd')
    const e = totals.get(k) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    totals.set(k, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [k, { sum, count }] of totals) weatherAvg[k] = Math.round((sum / count) * 100) / 100
  const roomTemps = {
    room1Temp: moisture.room1Temp, room2Temp: moisture.room2Temp, fridgeTemp: moisture.fridgeTemp,
    heatingBaseTemp: moisture.q10BaseTemp, q10Value: moisture.q10Value,
  }

  const out: AgingLotPrediction[] = []
  for (const lot of lots) {
    const target   = recipes.find(r => r.name === lot.misoType)?.targetTempSum ?? lot.targetTempSum
    const location = lot.locationHistory.length > 0 ? getCurrentLocation(lot.locationHistory) : '常温'
    const accum    = calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps)
    const completion = calcCompletionFromBrew(
      lot.brewedAt, target, location, weatherAvg,
      moisture.heatingDefaultTemp - 10, moisture.q10Value, moisture.q10BaseTemp, moisture.fridgeTemp,
      accum, heatingStartDate,
    )
    if (!completion) continue
    out.push({
      id: lot.id, lotNumber: lot.lotNumber, misoType: lot.misoType, totalWeightKg: lot.totalWeightKg,
      bucketNumbers: lot.bucketNumbers, brewedAt: lot.brewedAt, targetTempSum: target, completion,
    })
  }
  return out.sort((a, b) => a.completion.getTime() - b.completion.getTime())
}

'use server'

import { format } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import type { LotSimConfig } from '@/components/dashboard/lot-card'

// 仮登録リストから熟成シミュレーションを開くための設定一式。
// 仮登録ドロワーは全ページ共通（app/layout.tsx）なので、気象データ全件の集計を
// レイアウトで毎回やると全画面が重くなる。ボタンを押したときだけ取りに行く
export async function getPlanSimConfig(): Promise<{
  simConfig:     LotSimConfig
  targetByType:  Record<string, number>
}> {
  const [moisture, recipes, weather] = await Promise.all([
    getMoistureSettings(),
    prisma.misoRecipe.findMany(),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  // MM-dd別の有効積算温度平均（他画面と同じ作り方）
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weather) {
    const key = format(w.date, 'MM-dd')
    const e   = totals.get(key) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    totals.set(key, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of totals) {
    weatherAvg[key] = Math.round((sum / count) * 100) / 100
  }

  return {
    simConfig: {
      weatherAvg,
      q10Value:           moisture.q10Value,
      heatingBaseTemp:    moisture.heatingDefaultTemp,
      room1Temp:          moisture.room1Temp,
      heatingDefaultTemp: moisture.heatingDefaultTemp,
      coolingDefaultTemp: moisture.coolingDefaultTemp,
      fridgeTemp:         moisture.fridgeTemp,
    },
    targetByType: Object.fromEntries(recipes.map(r => [r.name, r.targetTempSum])),
  }
}

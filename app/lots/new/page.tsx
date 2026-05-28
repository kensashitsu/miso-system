import type { Metadata } from 'next'
import { format } from 'date-fns'
import { getMoistureSettings } from '@/lib/settings'
import { getMisoRecipes } from '@/lib/recipes'
import { prisma } from '@/lib/prisma'
import LotNewForm from './LotNewForm'

export const metadata: Metadata = {
  title: 'ロット登録 | 味噌熟成管理システム',
}

// 桶番号ペア一覧（1・2 〜 29・30、計15ペア）
const BUCKET_PAIRS = Array.from({ length: 15 }, (_, i) => `${i * 2 + 1}・${i * 2 + 2}`)

function nextBucketPair(last: string | null): string {
  if (!last) return BUCKET_PAIRS[0]
  const idx = BUCKET_PAIRS.indexOf(last)
  if (idx === -1) return BUCKET_PAIRS[0]
  return BUCKET_PAIRS[(idx + 1) % 15]
}

export default async function LotNewPage() {
  const [moisture, recipes, weatherData, lastLot] = await Promise.all([
    getMoistureSettings(),
    getMisoRecipes(),
    prisma.weatherCache.findMany(),
    prisma.lot.findFirst({
      orderBy: { createdAt: 'desc' },
      where:   { bucketNumbers: { not: null } },
      select:  { bucketNumbers: true },
    }),
  ])

  const suggestedBucketNumbers = nextBucketPair(lastLot?.bucketNumbers ?? null)

  // 月日（MM-dd）ごとの有効積算温度の平均を計算（常温の完了予定日推計用）
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

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <LotNewForm
        moisture={moisture}
        recipes={recipes}
        weatherAvg={weatherAvg}
        suggestedBucketNumbers={suggestedBucketNumbers}
      />
    </div>
  )
}

// 特定ロットの熟成度%が何で決まっているかを本番DBの実データで再現するデバッグ用スクリプト。
//
// 202607-001（無添加麦みそ）の熟成度が冷房記録の書き換え後も82%のままだった件の調査用。
// 画面（app/page.tsx・app/lots/[id]/page.tsx）と同じ入力・同じ関数で積算温度を出し、
// 場所の期間ごとの内訳まで表示する。
//
// 実行: npx tsx scripts/debug-lot-maturity.mts [ロット番号...]
import { differenceInDays, format, startOfDay } from 'date-fns'
import { PrismaClient } from '../lib/generated/prisma'
import * as tempCalcNs from '../lib/tempCalc'

const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const tempCalc = merge(tempCalcNs)
const { calcAccumulatedTemp, calcAccumulatedTempSplit, calcPeriodAccumulations, getCurrentLocation, calcColoringRisk } = tempCalc

const prisma = new PrismaClient()
const LOT_NUMBERS = process.argv.slice(2).length ? process.argv.slice(2) : ['202607-001', '202606-001']
const d = (x: Date | null | undefined) => (x ? format(x, 'yyyy-MM-dd') : '—')

const [lots, recipes, moistureRows, weatherData] = await Promise.all([
  prisma.lot.findMany({
    where: { lotNumber: { in: LOT_NUMBERS } },
    include: { locationHistory: { orderBy: { startDate: 'asc' } }, buckets: true },
  }),
  prisma.misoRecipe.findMany(),
  prisma.systemSetting.findMany({ where: { key: { startsWith: 'moisture_' } } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
])

const setting = (k: string, def: number) =>
  Number(moistureRows.find(m => m.key === `moisture_${k}`)?.value ?? def)
const roomTemps = {
  room1Temp:       setting('room1Temp', 24),
  room2Temp:       setting('room2Temp', 20),
  fridgeTemp:      setting('fridgeTemp', 6),
  heatingBaseTemp: setting('heatingDefaultTemp', 25),
  q10Value:        setting('q10Value', 2),
}
const weatherMap = new Map<string, number>(
  weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
)

console.log('設定:', roomTemps, '/ 気象データ件数:', weatherData.length,
  `(${d(weatherData[0]?.date)}〜${d(weatherData[weatherData.length - 1]?.date)})`)

for (const num of LOT_NUMBERS) {
  const lot = lots.find(l => l.lotNumber === num)
  if (!lot) { console.log(`\n### ${num}: 見つかりません`); continue }

  const recipe = recipes.find(r => r.name === lot.misoType)
  const target = recipe?.targetTempSum ?? lot.targetTempSum
  const accumUntil = lot.status === '熟成中' ? null : lot.completedAt
  const accum = calcAccumulatedTempSplit(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps, accumUntil)

  console.log(`\n### ${lot.lotNumber} ${lot.misoType}  status=${lot.status}`)
  console.log(`  仕込み=${d(lot.brewedAt)}  completedAt=${d(lot.completedAt)}  桶=${lot.buckets.map(b => b.bucketNumber).join(',')}`)
  console.log(`  目標=${target}℃・日 (レシピ=${recipe?.targetTempSum ?? '—'} / ロット=${lot.targetTempSum})`)
  console.log(`  積算 完成まで=${accum.untilCompletion.toFixed(1)}  完成後=${accum.afterCompletion.toFixed(1)}  合計=${accum.total.toFixed(1)}`)
  console.log(`  熟成度=${Math.round((accum.untilCompletion / target) * 100)}%  着色リスク=${calcColoringRisk(accum.total, target)}`)
  console.log(`  積算の打ち切り日(accumUntil)=${d(accumUntil)}  現在地=${getCurrentLocation(lot.locationHistory)}`)
  console.log(`  仕込みから今日まで=${differenceInDays(startOfDay(new Date()), startOfDay(lot.brewedAt))}日` +
    (lot.completedAt ? ` / 仕込み〜completedAt=${differenceInDays(startOfDay(lot.completedAt), startOfDay(lot.brewedAt))}日` : ''))

  console.log('  場所履歴（期間ごとの積算・今日まで）:')
  const periods = calcPeriodAccumulations(lot.locationHistory, weatherMap, roomTemps)
  for (const p of periods) {
    const start = new Date(p.startDateISO)
    const end   = p.endDateISO ? new Date(p.endDateISO) : null
    const days  = differenceInDays(end ?? startOfDay(new Date()), startOfDay(start)) + (end ? 0 : 1)
    console.log(`    ${d(start)}〜${d(end)} ${p.location.padEnd(10)} ${days}日  +${p.accumulated}℃・日` +
      (days > 0 ? ` (${(p.accumulated / days).toFixed(1)}/日)` : ''))
  }

  // completedAt で打ち切らなかった場合の積算（打ち切りの影響を見る）
  if (accumUntil) {
    const noCut = calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps, null)
    console.log(`  参考: 打ち切りなし（今日まで）=${noCut.toFixed(1)}℃・日 → ${Math.round((noCut / target) * 100)}%`)
  }
}

await prisma.$disconnect()

// 振り返り：今年、いつ・何回仕込んでいれば安全在庫ラインを保てたかを実データで出す。
//
// 予測ではなく**実際に起きたこと**だけを使う（後知恵の理想計画）。
//   起点在庫  … 月末在庫スナップショット（熟成済＋小分け）
//   消費      … ShipmentHistory の月次実績を日割り
//   補充      … 実際に完成したロット（Lot.completedAt × 歩留まり）
// これで実在庫の推移を再現し、安全在庫ラインを割った期間と深さを出す。
// そのうえで「不足を埋めるには、いつ仕込んでおけばよかったか」を逆算する。
//
// 実行: npx tsx scripts/retrospect.mts [起点の月末 yyyy-MM] [終了日 yyyy-MM-dd]
//   例: npx tsx scripts/retrospect.mts 2026-04
import { addDays, differenceInDays, format, getDaysInMonth, startOfDay } from 'date-fns'
import { PrismaClient } from '../lib/generated/prisma'
import * as calcNs from '../lib/brewPlanCalc'

const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const calc = merge(calcNs)
const { makeSafetyLineFn, simulateFermentationDays } = calc

const prisma = new PrismaClient()
const d = (x: Date) => format(x, 'yyyy-MM-dd')
const DOW = ['日', '月', '火', '水', '木', '金', '土']

const baseYm  = process.argv[2] ?? '2026-04'          // この月の月末在庫を起点にする
const endDate = startOfDay(process.argv[3] ? new Date(process.argv[3] + 'T00:00:00') : new Date())
const startDate = startOfDay(new Date(`${baseYm}-01T00:00:00`))
startDate.setMonth(startDate.getMonth() + 1)          // 起点は「その月末＝翌月1日の朝」

const [recipes, snaps, shipments, lots, moistureRows, weatherData] = await Promise.all([
  prisma.misoRecipe.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
  prisma.monthlyInventorySnapshot.findMany({ where: { yearMonth: baseYm } }),
  prisma.shipmentHistory.findMany({ orderBy: { yearMonth: 'asc' } }),
  prisma.lot.findMany({ orderBy: { brewedAt: 'asc' } }),
  prisma.systemSetting.findMany({ where: { key: { startsWith: 'moisture_' } } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
])
const yieldRate = Number(moistureRows.find(m => m.key === 'moisture_yieldRate')?.value ?? 0.95)
const q10Value  = Number(moistureRows.find(m => m.key === 'moisture_q10Value')?.value ?? 2)
const heatTemp  = Number(moistureRows.find(m => m.key === 'moisture_heatingDefaultTemp')?.value ?? 25)

// MM-dd別の有効積算温度平均（他の画面・スクリプトと同じ作り方）
const wm = new Map<string, { sum: number; count: number }>()
for (const w of weatherData) {
  const k = format(w.date, 'MM-dd')
  const e = wm.get(k) ?? { sum: 0, count: 0 }
  e.sum += w.effectiveTemp; e.count += 1; wm.set(k, e)
}
const weatherAvg: Record<string, number> = {}
for (const [k, v] of wm) weatherAvg[k] = Math.round((v.sum / v.count) * 100) / 100
const wVals = Object.values(weatherAvg)
const wFallback = wVals.length > 0 ? wVals.reduce((a, b) => a + b, 0) / wVals.length : 14

console.log(`=== 振り返り（${d(startDate)} 〜 ${d(endDate)}）===`)
console.log(`起点在庫は ${baseYm} の月末スナップショット（熟成済＋小分け）。消費は出荷実績の日割り、補充は実際に完成したロット`)

for (const recipe of recipes) {
  const name = recipe.name
  const snap = snaps.find(s => s.misoType === name)
  if (!snap) { console.log(`\n--- ${name}: 起点の在庫スナップショットが無いので対象外`); continue }
  const startKg = (snap.agedKg ?? 0) + (snap.packagedKg ?? 0)

  // 消費（月次実績の日割り）。実績が無い月は直近の月を使う
  const rate: Record<string, number> = {}
  for (const s of shipments.filter(s => s.misoType === name)) {
    rate[s.yearMonth] = s.weightKg / getDaysInMonth(new Date(s.yearMonth + '-01T00:00:00'))
  }
  const months = Object.keys(rate).sort()
  const rateOf = (dt: Date) => rate[format(dt, 'yyyy-MM')] ?? rate[months[months.length - 1]] ?? 0

  // 補充（実際に完成したロット）
  const supply = new Map<string, number>()
  for (const l of lots.filter(l => l.misoType === name && l.completedAt)) {
    const k = d(l.completedAt!)
    supply.set(k, (supply.get(k) ?? 0) + (l.finalYieldKg ?? l.totalWeightKg * yieldRate))
  }

  const lineAt = makeSafetyLineFn(recipe.safetyStockKg ?? 0, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg)

  // 実在庫の推移を再現し、ラインを割った期間と深さ、日別の不足量を出す
  let stock = startKg
  let cur = startDate
  const runs: { from: string; to: string; deepest: number; deepestDate: string }[] = []
  let runStart: string | null = null, deepest = 0, deepestDate = ''
  let peakDeficit = 0            // その時点までで最も深い不足（＝必要な追加供給量の目安）
  const close = (to: string) => { runs.push({ from: runStart!, to, deepest, deepestDate }); runStart = null; deepest = 0; deepestDate = '' }
  for (let i = 0; i <= differenceInDays(endDate, startDate); i++) {
    stock += supply.get(d(cur)) ?? 0
    stock -= rateOf(cur)
    const line = lineAt(cur)
    if (stock < line) {
      if (!runStart) runStart = d(cur)
      const gap = line - stock
      if (gap > deepest) { deepest = gap; deepestDate = d(cur) }
      if (gap > peakDeficit) peakDeficit = gap
    } else if (runStart) close(d(cur))
    cur = addDays(cur, 1)
  }
  if (runStart) close(d(endDate))

  const brews = lots.filter(l => l.misoType === name && l.brewedAt >= startDate && l.brewedAt <= endDate)
  const batchKg = recipe.totalWeightKg * yieldRate

  console.log(`\n--- ${name}`)
  console.log(` 起点在庫 ${Math.round(startKg).toLocaleString()}kg ／ ライン 通年${recipe.safetyStockKg ?? '-'} 冬${recipe.winterSafetyStockKg ?? '-'} 夏${recipe.summerSafetyStockKg ?? '-'}`)
  console.log(` 実際の仕込み ${brews.length}回: ${brews.map(l => `${format(l.brewedAt, 'M/d')}(${DOW[l.brewedAt.getDay()]})`).join(' ')}`)
  if (runs.length === 0) {
    console.log(' ラインを割った期間: なし')
    continue
  }
  console.log(' ラインを割った期間:')
  for (const r of runs) console.log(`   ${r.from}〜${r.to}  最大 ${Math.round(r.deepest).toLocaleString()}kg 不足（${r.deepestDate}）`)

  // 何回足りなかったか＝最も深い不足を1回の歩留まり量で割る
  const missing = Math.ceil(peakDeficit / batchKg)
  console.log(` → 最も深い不足 ${Math.round(peakDeficit).toLocaleString()}kg ＝ 1回 ${Math.round(batchKg).toLocaleString()}kg で ${missing} 回分`)

  // いつ仕込んでおけばよかったか＝各不足期間の入口から、その時期の実熟成日数だけ遡る
  // 熟成日数は**モデルで出す**。Lot.completedAt は出荷済ロットでは「使用開始日」であって
  // 熟成完了日ではないため、completedAt - brewedAt を熟成日数として使ってはいけない
  // （実データで95日などと出る）。他の画面と同じ simulateFermentationDays を使う
  const fermentDaysAt = (brewDate: Date) =>
    simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg, wFallback,
      q10Value, heatTemp, Math.max(heatTemp - 10, 0)).days
  console.log(' 仕込んでおくべきだった日（不足の入口から実熟成日数を遡る／水・木に丸める）:')
  for (const r of runs) {
    const entry = new Date(r.from + 'T00:00:00')
    // 仕込み日は「不足の入口 − その仕込み日の季節の熟成日数」。日数は仕込み時期で変わるので
    // いったん概算で遡ってから、その日を起点に引き直す（1回の反復で十分収束する）
    let back = addDays(entry, -fermentDaysAt(addDays(entry, -41)))
    back = addDays(entry, -fermentDaysAt(back))
    // 水(3)・木(4)に丸める（手前側）
    let snapped = back
    for (let k = 0; k < 7; k++) {
      if (snapped.getDay() === 3 || snapped.getDay() === 4) break
      snapped = addDays(snapped, -1)
    }
    const already = brews.some(l => Math.abs(differenceInDays(l.brewedAt, snapped)) <= 3)
    console.log(`   ${d(snapped)}(${DOW[snapped.getDay()]}) ごろに1回`
      + `  ← ${r.from} の不足に間に合わせるため（熟成${fermentDaysAt(snapped)}日）`
      + `${already ? '  ※この前後には実際に仕込んでいる（量が足りなかった）' : '  ※この前後には仕込みが無い'}`)
  }
}

await prisma.$disconnect()

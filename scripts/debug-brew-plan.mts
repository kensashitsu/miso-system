// AI仕込み提案（/planning ③）の計算を本番DBの実データで再現し、
// 各回の仕込み日がどう決まったかを表示するデバッグ用スクリプト。
//
// 画面だけでは「なぜこの日付になったのか」が追えず推測で修正を重ねてしまうため、
// 同じ入力・同じ関数（lib/brewPlanCalc.ts）で計算を再現できるようにしている。
//
// 実行: npx tsx scripts/debug-brew-plan.mts [品種名]
import { addDays, format, getDaysInMonth, startOfDay } from 'date-fns'
import { PrismaClient } from '../lib/generated/prisma'
import * as brewSimNs from '../lib/brewSimulation'
import * as calcNs from '../lib/brewPlanCalc'

// tsxはlib配下の.tsをCJSとして読むため、名前付きexportがnamespace直下に出ないことがある。
// ESM/CJSどちらでも取り出せるよう default とマージする
const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const brewSim = merge(brewSimNs)
const calc    = merge(calcNs)

const {
  simulateFermentationDays, calcBatches, findStockOutDate, findStockOutDateAfter,
  snapToBrewDay, nextWeekMonday, ORDER_LEAD_DAYS, DEFAULT_ORDER_LEAD_DAYS,
  PEAK_COMPLETION_MONTHS,
} = calc

const prisma   = new PrismaClient()
const MISO     = process.argv[2] ?? '無添加麦みそ'
const today    = startOfDay(new Date())
const d        = (x: Date) => format(x, 'yyyy-MM-dd')

const [recipes, moistureRows, weatherData, lots, plans, forecastRows] = await Promise.all([
  prisma.misoRecipe.findMany({ where: { isActive: true } }),
  prisma.systemSetting.findMany({ where: { key: { startsWith: 'moisture_' } } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
  prisma.lot.findMany({ where: { status: '熟成中' }, include: { buckets: true, locationHistory: { orderBy: { startDate: 'desc' } } } }),
  prisma.brewPlan.findMany({ where: { status: '仮登録' }, orderBy: { brewDate: 'asc' } }),
  prisma.forecastCache.findMany({ where: { misoType: MISO }, orderBy: { yearMonth: 'asc' } }),
])

const recipe = recipes.find(r => r.name === MISO)
if (!recipe) throw new Error(`レシピが見つかりません: ${MISO}`)

const setting = (k: string, def: number) =>
  Number(moistureRows.find(m => m.key === `moisture_${k}`)?.value ?? def)
const q10Value           = setting('q10Value', 2)
const heatingDefaultTemp = setting('heatingDefaultTemp', 25)
const brewBufferDays     = setting('brewBufferDays', 14)

// MM-dd別の有効積算温度平均（画面と同じ）
const wm = new Map<string, { sum: number; count: number }>()
for (const w of weatherData) {
  const k = format(w.date, 'MM-dd')
  const e = wm.get(k) ?? { sum: 0, count: 0 }
  e.sum += w.effectiveTemp; e.count += 1; wm.set(k, e)
}
const weatherAvg: Record<string, number> = {}
for (const [k, v] of wm) weatherAvg[k] = Math.round((v.sum / v.count) * 100) / 100
const weatherAvgValues = Object.values(weatherAvg)
const weatherFallback  = weatherAvgValues.length > 0
  ? weatherAvgValues.reduce((a, b) => a + b, 0) / weatherAvgValues.length : 14

// 消費ペース（SARIMAX予測の月別値 → 1日あたり）
const rateMap: Record<string, number> = {}
for (const f of forecastRows) rateMap[f.yearMonth] = f.forecastKg / getDaysInMonth(new Date(f.yearMonth + '-01T00:00:00'))
const lastRate = rateMap[forecastRows[forecastRows.length - 1]?.yearMonth] ?? 0
const getDailyRateFn = (date: Date) => rateMap[format(date, 'yyyy-MM')] ?? lastRate

// 供給イベント（熟成中ロットの完成 ＋ 仮登録の完成）
const supplyEvents: { date: Date; kg: number; note: string }[] = []
for (const lot of lots.filter(l => l.misoType === MISO)) {
  const nonEmpty = lot.buckets.filter(b => b.status !== '空')
  const yieldKg  = lot.buckets.length > 0
    ? nonEmpty.reduce((s, b) => s + (b.remainingWeightKg ?? b.initialWeightKg), 0)
    : lot.totalWeightKg
  if (yieldKg <= 0) continue
  const comp = brewSim.calcCompletionFromBrew(
    lot.brewedAt, recipe.targetTempSum, lot.locationHistory[0]?.location ?? '常温',
    weatherAvg, heatingDefaultTemp - 10, q10Value, heatingDefaultTemp, setting('fridgeTemp', 6))
  if (comp) supplyEvents.push({ date: startOfDay(comp), kg: yieldKg, note: `熟成中 ${lot.lotNumber}` })
}
const regPlans = plans.filter(p => p.misoType === MISO && p.completionDate > today)
for (const p of regPlans) {
  supplyEvents.push({ date: new Date(format(p.completionDate, 'yyyy-MM-dd') + 'T00:00:00'), kg: recipe.totalWeightKg, note: `仮登録 仕込${d(p.brewDate)}` })
}
supplyEvents.sort((a, b) => a.date.getTime() - b.date.getTime())

// 在庫（外部APIが取れないのでコマンドライン第3引数、既定は画面表示値）
const stockKg = Number(process.argv[3] ?? 2667)
const safety  = recipe.safetyStockKg ?? 0
const immediateKg = supplyEvents.filter(e => e.date <= today).reduce((s, e) => s + e.kg, 0)
const effectiveStock = stockKg + immediateKg
const depletableStock = effectiveStock - safety

const getCompletion = (brewDate: Date) =>
  simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg, weatherFallback,
    q10Value, heatingDefaultTemp, Math.max(heatingDefaultTemp - 10, 0))
const isDoubleBatch = MISO === '無添加麦みそ'
  ? (c: Date) => PEAK_COMPLETION_MONTHS.includes(c.getMonth() + 1)
  : undefined

console.log(`=== ${MISO} ===`)
console.log(`今日 ${d(today)} / 1回の生産量 ${recipe.totalWeightKg}kg / 安全在庫 ${safety}kg`)
console.log(`現在庫 ${stockKg}kg → 実質使える在庫 ${Math.round(depletableStock)}kg`)
console.log('消費ペース(kg/日):', ['2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03']
  .map(m => `${m}:${Math.round(rateMap[m] ?? lastRate)}`).join(' '))
console.log(`→ 1回(${recipe.totalWeightKg}kg)で賄える日数: ` + ['2026-10','2026-12','2027-02']
  .map(m => `${m}=${(recipe.totalWeightKg / (rateMap[m] ?? lastRate)).toFixed(1)}日`).join(' / '))
console.log('供給予定:', supplyEvents.map(e => `${d(e.date)} +${Math.round(e.kg)}(${e.note})`).join('  '))

const minBrewDate = snapToBrewDay(nextWeekMonday(today))
const earliest    = getCompletion(minBrewDate).completionDate
console.log(`\n最短仕込み日 ${d(minBrewDate)} → その完成日 ${d(earliest)}（熟成${getCompletion(minBrewDate).days}日）`)
console.log(`本当の在庫切れ日          : ${d(findStockOutDate(depletableStock, today, getDailyRateFn, supplyEvents))}`)
console.log(`この回が狙う在庫切れ日    : ${d(findStockOutDateAfter(depletableStock, today, getDailyRateFn, earliest, supplyEvents))}`)

const batches = calcBatches(
  depletableStock, getDailyRateFn, getCompletion(minBrewDate).days, recipe.totalWeightKg,
  Number(process.argv[4] ?? 5), today, ORDER_LEAD_DAYS[MISO] ?? DEFAULT_ORDER_LEAD_DAYS, brewBufferDays,
  getCompletion, snapToBrewDay, undefined, undefined, {}, supplyEvents, isDoubleBatch,
  new Set(regPlans.map(p => d(p.brewDate))))

console.log('\n=== 生成された提案 ===')
for (const b of batches) {
  console.log(` ${b.n}回目 仕込${d(b.brewDate)}${b.pairBrewDate ? `＋${d(b.pairBrewDate)}(2回)` : '      '} → 完成${d(b.completionDate)}${b.pairCompletionDate ? `＋${d(b.pairCompletionDate)}` : ''} (熟成${b.fermentationDays}日) 狙った在庫切れ${d(b.stockOutDate)}`)
}

// 提案どおり仕込んだ場合の在庫推移（安全在庫ラインを割る期間を検出）
const events = new Map<string, number>()
for (const e of supplyEvents) events.set(d(e.date), (events.get(d(e.date)) ?? 0) + e.kg)
for (const b of batches) {
  events.set(d(b.completionDate), (events.get(d(b.completionDate)) ?? 0) + recipe.totalWeightKg)
  if (b.pairCompletionDate) events.set(d(b.pairCompletionDate), (events.get(d(b.pairCompletionDate)) ?? 0) + recipe.totalWeightKg)
}
let stock = effectiveStock
let cur = today
const below: string[] = []
let runStart: string | null = null
for (let i = 0; i < 400; i++) {
  stock += events.get(d(cur)) ?? 0
  stock -= getDailyRateFn(cur)
  if (stock < safety) { if (!runStart) runStart = d(cur) }
  else if (runStart) { below.push(`${runStart}〜${d(cur)}`); runStart = null }
  cur = addDays(cur, 1)
}
if (runStart) below.push(`${runStart}〜(以降ずっと)`)
console.log('\n=== 提案どおり仕込んだ場合に安全在庫ラインを割る期間 ===')
console.log(below.length === 0 ? ' なし' : below.map(x => ' ' + x).join('\n'))

await prisma.$disconnect()

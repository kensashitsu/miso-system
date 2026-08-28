// AI仕込み提案（/planning ③）の計算を本番DBの実データで再現し、
// 各回の仕込み日がどう決まったかを表示するデバッグ用スクリプト。
//
// 画面だけでは「なぜこの日付になったのか」が追えず推測で修正を重ねてしまうため、
// 同じ入力・同じ関数（lib/brewPlanCalc.ts）で計算を再現できるようにしている。
//
// 実行: npx tsx scripts/debug-brew-plan.mts [品種名]
import { addDays, differenceInDays, format, getDaysInMonth, startOfDay } from 'date-fns'
import { PrismaClient } from '../lib/generated/prisma'
import * as brewSimNs from '../lib/brewSimulation'
import * as tempCalcNs from '../lib/tempCalc'
import * as lotStockNs from '../lib/lotStock'
import * as calcNs from '../lib/brewPlanCalc'

// tsxはlib配下の.tsをCJSとして読むため、名前付きexportがnamespace直下に出ないことがある。
// ESM/CJSどちらでも取り出せるよう default とマージする
const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const brewSim  = merge(brewSimNs)
const tempCalc = merge(tempCalcNs)
const lotStock = merge(lotStockNs)
const calc    = merge(calcNs)

const {
  simulateFermentationDays, calcBatches, findStockOutDate, findStockOutDateAfter,
  snapToBrewDay, nextWeekMonday, ORDER_LEAD_DAYS, DEFAULT_ORDER_LEAD_DAYS,
  PEAK_COMPLETION_MONTHS, makeSafetyDeltaFn, makeSafetyLineFn, expandBlockedWeeks,
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

// 日付別の有効積算温度（実績積算の再現用・画面と同じ）
const weatherMap = new Map<string, number>(
  weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
)

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

// 第8引数で1回の生産量を上書きできる（仕込み単位を変えた場合の試算用）
const batchKg = process.env.BATCH_KG ? Number(process.env.BATCH_KG) : recipe.totalWeightKg

// 供給イベント（熟成中ロットの完成 ＋ 仮登録の完成）
const supplyEvents: { date: Date; kg: number; note: string }[] = []
for (const lot of lots.filter(l => l.misoType === MISO)) {
  const yieldKg = lotStock.fermentingKgOfLot(lot, setting('yieldRate', 0.95))
  if (yieldKg <= 0) continue
  // 画面と同じく、今日時点の実績積算温度で較正した完成予定日を使う
  const accumulatedTemp = tempCalc.calcAccumulatedTemp(
    lot.brewedAt, lot.locationHistory, weatherMap,
    { room1Temp: setting('room1Temp', 24), room2Temp: setting('room2Temp', 20),
      fridgeTemp: setting('fridgeTemp', 6), heatingBaseTemp: heatingDefaultTemp, q10Value })
  const comp = brewSim.calcCompletionFromBrew(
    lot.brewedAt, recipe.targetTempSum, tempCalc.getCurrentLocation(lot.locationHistory),
    weatherAvg, heatingDefaultTemp - 10, q10Value, heatingDefaultTemp, setting('fridgeTemp', 6),
    accumulatedTemp)
  if (comp) supplyEvents.push({ date: startOfDay(comp), kg: yieldKg, note: `熟成中 ${lot.lotNumber}` })
}
const regPlans = plans.filter(p => p.misoType === MISO && p.completionDate > today)
for (const p of regPlans) {
  supplyEvents.push({ date: new Date(format(p.completionDate, 'yyyy-MM-dd') + 'T00:00:00'), kg: batchKg, note: `仮登録 仕込${d(p.brewDate)}` })
}
supplyEvents.sort((a, b) => a.date.getTime() - b.date.getTime())

// 在庫（外部APIが取れないのでコマンドライン第3引数、既定は画面表示値）
const numArg = (i: number) => (process.argv[i] != null && process.argv[i] !== '' ? Number(process.argv[i]) : undefined)
const stockKg = numArg(3) ?? 2667
// 第5引数で安全在庫ラインを上書きできる（設定変更の影響を試算するため）
const safety  = numArg(5) ?? recipe.safetyStockKg ?? 0
const immediateKg = supplyEvents.filter(e => e.date <= today).reduce((s, e) => s + e.kg, 0)
const effectiveStock = stockKg + immediateKg
const depletableStock = effectiveStock - safety

// 仕込めない週（DBのplanning_blockedWeeks）
const blockedRow = await prisma.systemSetting.findUnique({ where: { key: 'planning_blockedWeeks' } })
let blockedWeeks: string[] = []
try { const p = JSON.parse(blockedRow?.value ?? '[]'); if (Array.isArray(p)) blockedWeeks = p } catch {}

const winterSafety = numArg(6) ?? recipe.winterSafetyStockKg
const summerSafety = numArg(7) ?? recipe.summerSafetyStockKg
const getSafetyDelta = makeSafetyDeltaFn(safety, winterSafety, summerSafety)
const safetyLineAt   = makeSafetyLineFn(safety, winterSafety, summerSafety)

// 山吹の工程制約（無添加・田舎の翌日）。確定分の仕込み日から近似的に作る
const yamabukiNextDays = MISO === '山吹みそ'
  ? new Set(plans.filter(p => p.misoType === '無添加麦みそ' || p.misoType === '田舎みそ')
      .map(p => d(addDays(p.brewDate, 1))))
  : null
const yamabukiLastKnown = MISO === '山吹みそ'
  ? plans.filter(p => p.misoType === '無添加麦みそ' || p.misoType === '田舎みそ')
      .reduce((mx, p) => (d(p.brewDate) > mx ? d(p.brewDate) : mx), '')
  : ''
const isAllowedBrewDayForYamabuki = yamabukiNextDays
  ? (dt: Date) => yamabukiNextDays.has(d(dt)) || (d(dt) > yamabukiLastKnown && dt.getDay() === 4)
  : undefined
if (yamabukiNextDays) console.log('山吹の仕込み可能日(確定分の翌日):', [...yamabukiNextDays].sort().join(' '), '／以降は木曜のみ')

const getCompletion = (brewDate: Date) =>
  simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg, weatherFallback,
    q10Value, heatingDefaultTemp, Math.max(heatingDefaultTemp - 10, 0))
const isDoubleBatch = MISO === '無添加麦みそ'
  ? (c: Date) => PEAK_COMPLETION_MONTHS.includes(c.getMonth() + 1)
  : undefined

console.log(`=== ${MISO} ===`)
console.log(`今日 ${d(today)} / 1回の生産量 ${batchKg}kg${batchKg !== recipe.totalWeightKg ? `（実際は${recipe.totalWeightKg}kg・試算で上書き）` : ''} / 安全在庫 ${safety}kg`)
console.log(`現在庫 ${stockKg}kg → 実質使える在庫 ${Math.round(depletableStock)}kg / 冬季ライン ${winterSafety ?? '未設定'} / 夏季ライン ${summerSafety ?? '未設定'}`)
console.log('消費ペース(kg/日):', ['2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03']
  .map(m => `${m}:${Math.round(rateMap[m] ?? lastRate)}`).join(' '))
console.log(`→ 1回(${batchKg}kg)で賄える日数: ` + ['2026-10','2026-12','2027-02']
  .map(m => `${m}=${(batchKg / (rateMap[m] ?? lastRate)).toFixed(1)}日`).join(' / '))
console.log('仕込めない週:', blockedWeeks.length ? blockedWeeks.join(' ') : 'なし')
console.log('供給予定:', supplyEvents.map(e => `${d(e.date)} +${Math.round(e.kg)}(${e.note})`).join('  '))

const minBrewDate = snapToBrewDay(nextWeekMonday(today))
const earliest    = getCompletion(minBrewDate).completionDate
console.log(`\n最短仕込み日 ${d(minBrewDate)} → その完成日 ${d(earliest)}（熟成${getCompletion(minBrewDate).days}日）`)
console.log(`本当の在庫切れ日          : ${d(findStockOutDate(depletableStock, today, getDailyRateFn, supplyEvents))}`)
console.log(`この回が狙う在庫切れ日    : ${d(findStockOutDateAfter(depletableStock, today, getDailyRateFn, earliest, supplyEvents))}`)

const batches = calcBatches(
  depletableStock, getDailyRateFn, getCompletion(minBrewDate).days, batchKg,
  numArg(4) ?? 5, today, ORDER_LEAD_DAYS[MISO] ?? DEFAULT_ORDER_LEAD_DAYS, brewBufferDays,
  getCompletion, snapToBrewDay, undefined, undefined, {}, supplyEvents, isDoubleBatch,
  new Set([...regPlans.map(p => d(p.brewDate)), ...expandBlockedWeeks(blockedWeeks)]), getSafetyDelta,
  // 工程制約: 山吹は無添加・田舎の翌日にしか仕込めない。
  // 本番と同じ集合を作るには両品種の提案計算が要るため、ここでは確定分（仮登録）の翌日で近似する
  isAllowedBrewDayForYamabuki)

console.log('\n=== 生成された提案 ===')
for (const b of batches) {
  console.log(` ${b.n}回目 仕込${d(b.brewDate)}${b.pairBrewDate ? `＋${d(b.pairBrewDate)}(2回)` : '      '} → 完成${d(b.completionDate)}${b.pairCompletionDate ? `＋${d(b.pairCompletionDate)}` : ''} (熟成${b.fermentationDays}日) 狙った在庫切れ${d(b.stockOutDate)}`)
}

// 提案どおり仕込んだ場合の在庫推移（安全在庫ラインを割る期間を検出）
const events = new Map<string, number>()
for (const e of supplyEvents) events.set(d(e.date), (events.get(d(e.date)) ?? 0) + e.kg)
for (const b of batches) {
  events.set(d(b.completionDate), (events.get(d(b.completionDate)) ?? 0) + batchKg)
  if (b.pairCompletionDate) events.set(d(b.pairCompletionDate), (events.get(d(b.pairCompletionDate)) ?? 0) + batchKg)
}
// 検証期間は最終提案の完成日まで伸ばす（400日固定だと山吹・白みそのように
// 提案が数年先に及ぶ品種で、割れている期間を見逃す）
const lastDate = batches.reduce((mx: Date, b: any) => {
  const c = b.pairCompletionDate ?? b.completionDate
  return c > mx ? c : mx
}, today)
const horizonDays = Math.max(400, differenceInDays(lastDate, today) + 90)

let stock = effectiveStock
let cur = today
const below: string[] = []
let runStart: string | null = null
for (let i = 0; i < horizonDays; i++) {
  stock += events.get(d(cur)) ?? 0
  stock -= getDailyRateFn(cur)
  if (stock < safetyLineAt(cur)) { if (!runStart) runStart = d(cur) }
  else if (runStart) { below.push(`${runStart}〜${d(cur)}`); runStart = null }
  cur = addDays(cur, 1)
}
if (runStart) below.push(`${runStart}〜(以降ずっと)`)
// 月別の在庫水準（ラインに対してどれだけ余っているか）
const monthly = new Map<string, { min: number; max: number; line: number }>()
{
  let st = effectiveStock
  let c = today
  for (let i = 0; i < horizonDays; i++) {
    st += events.get(d(c)) ?? 0
    st -= getDailyRateFn(c)
    const ln = safetyLineAt(c)
    const ym = format(c, 'yyyy-MM')
    const e = monthly.get(ym) ?? { min: Infinity, max: -Infinity, line: ln }
    e.min = Math.min(e.min, st); e.max = Math.max(e.max, st); e.line = ln
    monthly.set(ym, e)
    c = addDays(c, 1)
  }
}
console.log('\n=== 月別の在庫水準（ラインに対する余剰） ===')
for (const [ym, e] of monthly) {
  const rate = getDailyRateFn(new Date(ym + '-15T00:00:00'))
  console.log(` ${ym} 最小${Math.round(e.min).toString().padStart(5)}kg 最大${Math.round(e.max).toString().padStart(5)}kg (ライン${e.line}) 余剰最大${Math.round(e.max - e.line).toString().padStart(5)}kg=${((e.max - e.line) / rate).toFixed(0)}日分`)
}

console.log('\n=== 提案どおり仕込んだ場合に安全在庫ラインを割る期間 ===')
console.log(below.length === 0 ? ' なし' : below.map(x => ' ' + x).join('\n'))

await prisma.$disconnect()

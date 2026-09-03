// 「3品種まとめて」の提案（lib/brewCombine.ts）が、人が組んだ仮登録の並びを
// 再現できるかを確かめるスクリプト。
//
// 仮登録は実務で使っているので **DBは一切書き換えない**。
// 「仮登録がまだ無かったこと」にするのは読み込んだデータからの除外だけで行う
// （供給イベントにも入れず、仕込み禁止日にも入れない）。
//
// 実行: npx tsx scripts/verify-combine.mts
// Next.jsと違い素のスクリプトは .env.local を読まないため明示的に読み込む
// （読まないと在庫APIのURL・キーが無く、現在庫が全品種0kgになって比較にならない）
import 'dotenv/config'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local', override: true })
import { addDays, differenceInDays, format, getDaysInMonth, startOfDay } from 'date-fns'
import { PrismaClient } from '../lib/generated/prisma'
import * as brewSimNs  from '../lib/brewSimulation'
import * as tempCalcNs from '../lib/tempCalc'
import * as lotStockNs from '../lib/lotStock'
import * as calcNs     from '../lib/brewPlanCalc'
import * as combineNs  from '../lib/brewCombine'
import * as extApiNs   from '../lib/externalApi'

// tsxはlib配下の.tsをCJSとして読むため、名前付きexportがnamespace直下に出ないことがある
const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const brewSim  = merge(brewSimNs)
const tempCalc = merge(tempCalcNs)
const lotStock = merge(lotStockNs)
const calc     = merge(calcNs)
const combine  = merge(combineNs)
const extApi   = merge(extApiNs)

const {
  simulateFermentationDays, calcBatches, snapToBrewDay, nextWeekMonday,
  ORDER_LEAD_DAYS, DEFAULT_ORDER_LEAD_DAYS, PEAK_COMPLETION_MONTHS,
  makeSafetyDeltaFn, makeSafetyLineFn, expandBlockedWeeks,
} = calc
const { combineBrewPlans } = combine

const prisma = new PrismaClient()
const today  = startOfDay(new Date())
const d      = (x: Date) => format(x, 'yyyy-MM-dd')
const DOW    = ['日', '月', '火', '水', '木', '金', '土']
const dw     = (x: Date) => `${format(x, 'M/d')}(${DOW[x.getDay()]})`

// 画面と同じ計算順（山吹は無添加・田舎の翌日にしか仕込めないので最後）
const CALC_ORDER = ['田舎みそ', '無添加麦みそ', '山吹みそ']
const BATCHES_PER_TYPE = Number(process.env.BATCHES ?? 6)

const [recipes, moistureRows, weatherData, lots, actualPlans, forecastRows, blockedRow] = await Promise.all([
  prisma.misoRecipe.findMany({ where: { isActive: true } }),
  prisma.systemSetting.findMany({ where: { key: { startsWith: 'moisture_' } } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
  prisma.lot.findMany({ where: { status: '熟成中' }, include: { buckets: true, locationHistory: { orderBy: { startDate: 'desc' } } } }),
  prisma.brewPlan.findMany({ where: { status: '仮登録' }, orderBy: { brewDate: 'asc' } }),
  prisma.forecastCache.findMany({ orderBy: { yearMonth: 'asc' } }),
  prisma.systemSetting.findUnique({ where: { key: 'planning_blockedWeeks' } }),
])

const setting = (k: string, def: number) =>
  Number(moistureRows.find(m => m.key === `moisture_${k}`)?.value ?? def)
const q10Value           = setting('q10Value', 2)
const heatingDefaultTemp = setting('heatingDefaultTemp', 25)
const brewBufferDays     = setting('brewBufferDays', 14)
const yieldRate          = setting('yieldRate', 0.95)
const fridgeTemp         = setting('fridgeTemp', 6)

let blockedWeeks: string[] = []
try { const p = JSON.parse(blockedRow?.value ?? '[]'); if (Array.isArray(p)) blockedWeeks = p } catch {}

// 気象（画面と同じ作り方）
const weatherMap = new Map<string, number>(weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp]))
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

// 現在庫（画面と同じく在庫API。取れなければ環境変数 STOCK_<品種> で指定）
const apiStock = await extApi.fetchAgedStock()
const stockByType: Record<string, number> = {}
for (const it of apiStock ?? []) stockByType[it.misoType] = it.stockKg + (it.packagedStockKg ?? 0)

console.log('=== 3品種まとめての提案：人が組んだ仮登録との突き合わせ ===')
console.log(`今日 ${d(today)} ／ DBは読むだけ・仮登録は削除せず「入力から外して」計算する`)
console.log('現在庫(在庫API):', CALC_ORDER.map(t => `${t}=${Math.round(stockByType[t] ?? 0)}kg`).join(' '))
console.log('仕込めない週:', blockedWeeks.length ? blockedWeeks.join(' ') : 'なし')

// ── 品種ごとの提案（仮登録を無かったことにして計算）─────────────
const mugiInakaBrewDateStrs: string[] = []
const candidates: any[] = []

for (const name of CALC_ORDER) {
  const recipe = recipes.find(r => r.name === name)
  if (!recipe) { console.log(`(レシピなし: ${name})`); continue }

  // 消費ペース（SARIMAXの月別予測 → 1日あたり）
  const rows = forecastRows.filter(f => f.misoType === name)
  const rateMap: Record<string, number> = {}
  for (const f of rows) rateMap[f.yearMonth] = f.forecastKg / getDaysInMonth(new Date(f.yearMonth + '-01T00:00:00'))
  const lastRate = rateMap[rows[rows.length - 1]?.yearMonth] ?? 0
  const getDailyRateFn = (date: Date) => rateMap[format(date, 'yyyy-MM')] ?? lastRate

  // 供給は熟成中ロットの完成だけ（仮登録の完成は入れない＝無かったことにする）
  const supplyEvents: { date: Date; kg: number }[] = []
  for (const lot of lots.filter(l => l.misoType === name)) {
    const kg = lotStock.fermentingKgOfLot(lot, yieldRate)
    if (kg <= 0) continue
    const accum = tempCalc.calcAccumulatedTemp(
      lot.brewedAt, lot.locationHistory, weatherMap,
      { room1Temp: setting('room1Temp', 24), room2Temp: setting('room2Temp', 20),
        fridgeTemp, heatingBaseTemp: heatingDefaultTemp, q10Value })
    const comp = brewSim.calcCompletionFromBrew(
      lot.brewedAt, recipe.targetTempSum, tempCalc.getCurrentLocation(lot.locationHistory),
      weatherAvg, heatingDefaultTemp - 10, q10Value, heatingDefaultTemp, fridgeTemp, accum)
    if (comp) supplyEvents.push({ date: startOfDay(comp), kg })
  }
  supplyEvents.sort((a, b) => +a.date - +b.date)

  const stockKg = stockByType[name] ?? Number(process.env[`STOCK_${name}`] ?? 0)
  const immediateKg = supplyEvents.filter(e => e.date <= today).reduce((s, e) => s + e.kg, 0)
  const safety  = recipe.safetyStockKg ?? 0
  const getSafetyDelta = makeSafetyDeltaFn(safety, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg)
  const safetyLineAt   = makeSafetyLineFn(safety, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg)
  const depletableStock = stockKg + immediateKg - safety

  const location = recipe.defaultLocation
  const getCompletion = (brewDate: Date) =>
    simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg, weatherFallback,
      q10Value, heatingDefaultTemp, Math.max(heatingDefaultTemp - 10, 0))

  // 山吹は無添加・田舎の翌日にしか仕込めない（画面と同じ制約。両者の提案日から作る）
  const isAllowedBrewDay = name === '山吹みそ' && mugiInakaBrewDateStrs.length > 0
    ? (dt: Date) => mugiInakaBrewDateStrs.includes(d(addDays(dt, -1)))
    : undefined

  // 出荷ピーク期の2本立ては「完成が10〜12月なら2本」と月で決め打ちしている。
  // 実際には2本まとめるか田舎と組むかは**その時の在庫**で決まる（2026-09-04 ユーザー確認）。
  // まとめモードでは2本立てを使わず1本ずつ候補にして、空いた枠は在庫のきつい品種が取る。
  // DOUBLE=1 を付けて実行すると従来どおり2本立てで計算する（比較用）
  const isDoubleBatch = (process.env.DOUBLE === '1' && name === '無添加麦みそ')
    ? (c: Date) => PEAK_COMPLETION_MONTHS.includes(c.getMonth() + 1)
    : undefined

  const batches = calcBatches(
    depletableStock, getDailyRateFn, getCompletion(snapToBrewDay(nextWeekMonday(today))).days,
    recipe.totalWeightKg, BATCHES_PER_TYPE, today,
    ORDER_LEAD_DAYS[name] ?? DEFAULT_ORDER_LEAD_DAYS, brewBufferDays,
    getCompletion, snapToBrewDay, undefined, undefined, {}, supplyEvents, isDoubleBatch,
    new Set(expandBlockedWeeks(blockedWeeks)),  // 仮登録済みの日は塞がない
    getSafetyDelta, safetyLineAt, isAllowedBrewDay, [])

  for (const b of batches) {
    if (name !== '山吹みそ') mugiInakaBrewDateStrs.push(d(b.brewDate))
    candidates.push({
      misoType: name, location,
      brewDate: b.brewDate, completionDate: b.completionDate,
      fermentationDays: b.fermentationDays,
      materialOrderDeadline: b.materialOrderDeadline,
      stockOutDate: b.stockOutDate,
      orderLeadDays: ORDER_LEAD_DAYS[name] ?? DEFAULT_ORDER_LEAD_DAYS,
      isFixed: false,
      getCompletion,
      decidedBy: b.decidedBy,
      solvedBrewDate: b.solvedBrewDate,
    })
    // 2本立ての相方も候補に入れる
    if (b.pairBrewDate && b.pairCompletionDate && b.pairFermentationDays !== undefined) {
      if (name !== '山吹みそ') mugiInakaBrewDateStrs.push(d(b.pairBrewDate))
      candidates.push({
        misoType: name, location,
        brewDate: b.pairBrewDate, completionDate: b.pairCompletionDate,
        fermentationDays: b.pairFermentationDays,
        materialOrderDeadline: b.pairMaterialOrderDeadline ?? addDays(b.pairBrewDate, -(ORDER_LEAD_DAYS[name] ?? DEFAULT_ORDER_LEAD_DAYS)),
        stockOutDate: b.stockOutDate,
        orderLeadDays: ORDER_LEAD_DAYS[name] ?? DEFAULT_ORDER_LEAD_DAYS,
        isFixed: false,
        getCompletion,
      })
    }
  }
}

console.log('\n=== 品種ごとの提案（仮登録なしで再計算・置き直す前） ===')
for (const c of [...candidates].sort((a, b) => +a.brewDate - +b.brewDate)) {
  console.log(` ${dw(c.brewDate)} ${c.misoType.padEnd(6, '　')} 完成${format(c.completionDate, 'M/d')}(${c.fermentationDays}日)`
    + ` 狙う在庫切れ${format(c.stockOutDate, 'M/d')} 余裕${differenceInDays(c.stockOutDate, c.completionDate)}日`
    + ` 決め手=${c.decidedBy ?? '-'}${c.solvedBrewDate ? ` 逆算値${format(c.solvedBrewDate, 'M/d')}` : ''}`)
}

// ── 現場ルールで週の枠へ置き直す ──────────────────────────
const getCompletionMap: Record<string, any> = {}
for (const c of candidates) getCompletionMap[c.misoType] = c.getCompletion
const weeks = combineBrewPlans(candidates, {
  blockedWeeks: new Set(blockedWeeks),
  getCompletion: getCompletionMap,
})

console.log('\n=== まとめモードの出力 vs 人が組んだ仮登録 ===')
const actualByWeek = new Map<string, { wed?: string; thu?: string }>()
for (const p of actualPlans) {
  const monday = combine.mondayOf(p.brewDate)
  const e = actualByWeek.get(d(monday)) ?? {}
  if (p.brewDate.getDay() === 4) e.thu = p.misoType
  else e.wed = p.misoType
  actualByWeek.set(d(monday), e)
}
const allWeeks = [...new Set([...weeks.map(w => d(w.weekMonday)), ...actualByWeek.keys()])].sort()
let hit = 0, total = 0
for (const wk of allWeeks) {
  const mine = weeks.find(w => d(w.weekMonday) === wk)
  const act  = actualByWeek.get(wk)
  const fmtPair = (wed?: string | null, thu?: string | null) =>
    `水:${(wed ?? '—').padEnd(6, '　')} 木:${(thu ?? '—').padEnd(6, '　')}`
  const mineStr = fmtPair(mine?.wed?.misoType, mine?.thu?.misoType)
  const actStr  = fmtPair(act?.wed, act?.thu)
  const same    = mineStr === actStr
  if (act) { total++; if (same) hit++ }
  console.log(` ${wk} | 提案 ${mineStr} | 実際 ${act ? actStr : '（仮登録なし）'} ${act ? (same ? '  ○' : '  ×') : ''}`)
}
console.log(`\n仮登録のある ${total} 週のうち ${hit} 週が一致`)

await prisma.$disconnect()

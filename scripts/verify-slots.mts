// 週の水木2枠へ直接割り当てる提案（lib/brewSlotPlanner.ts）を、
// 人が組んだ仮登録・以前のまとめモード（品種ごとの提案を後から並べ直す方式）と比べる。
//
// 比べるもの：仕込みに使う週の数・単発の週の数・安全在庫ラインを割る日数と深さ・在庫0割れ。
// 2026年の仮登録は「制約下の妥協」なので一致率は追わない。
// 同じ期間でラインを割らずに、より少ない週で回せるかを見る。
//
// DBは読むだけ。実行: npx tsx scripts/verify-slots.mts
//   UNTIL=2026-12-21  … 割り当てる最後の週の月曜（既定＝仮登録の最後の週）
//   EVAL=2027-01-31   … ライン割れを数える最終日（既定＝UNTIL＋35日）
//   BUFFER / PEAK / PULL … 新方式のバッファ日数・ピーク期の上乗せ・前倒し週数（既定＝画面と同じ）
//   ONLY_NEW=1        … 新方式だけ出す
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
import * as plannerNs  from '../lib/brewSlotPlanner'
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
const planner  = merge(plannerNs)
const extApi   = merge(extApiNs)

const prisma = new PrismaClient()
const today  = startOfDay(new Date())
const d      = (x: Date) => format(x, 'yyyy-MM-dd')
const DOW    = ['日', '月', '火', '水', '木', '金', '土']
const TYPES  = ['田舎みそ', '無添加麦みそ', '山吹みそ']

const [recipes, moistureRows, weatherData, lots, actualPlans, forecastRows, blockedRow] = await Promise.all([
  prisma.misoRecipe.findMany({ where: { isActive: true } }),
  prisma.systemSetting.findMany({ where: { OR: [{ key: { startsWith: 'moisture_' } }, { key: 'aging_heatingStartDate' }] } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
  prisma.lot.findMany({ where: { status: '熟成中' }, include: { buckets: true, locationHistory: { orderBy: { startDate: 'desc' } } } }),
  prisma.brewPlan.findMany({ where: { status: '仮登録', lotId: null }, orderBy: { brewDate: 'asc' } }),
  prisma.forecastCache.findMany({ orderBy: { yearMonth: 'asc' } }),
  prisma.systemSetting.findUnique({ where: { key: 'planning_blockedWeeks' } }),
])
const setting = (k: string, def: number) =>
  Number(moistureRows.find(m => m.key === `moisture_${k}`)?.value ?? def)
const q10Value = setting('q10Value', 2), heatingDefaultTemp = setting('heatingDefaultTemp', 25)
const q10BaseTemp = setting('q10BaseTemp', 25), brewBufferDays = setting('brewBufferDays', 14)
const yieldRate = setting('yieldRate', 0.95), fridgeTemp = setting('fridgeTemp', 6)
const hsRaw = moistureRows.find(m => m.key === 'aging_heatingStartDate')?.value?.trim() ?? ''
const heatingStartDate = /^\d{4}-\d{2}-\d{2}$/.test(hsRaw) ? hsRaw : null
let blockedWeeks: string[] = []
try { const p = JSON.parse(blockedRow?.value ?? '[]'); if (Array.isArray(p)) blockedWeeks = p } catch {}

const weatherMap = new Map<string, number>(weatherData.map(w => [d(w.date), w.effectiveTemp]))
const wm = new Map<string, { sum: number; count: number }>()
for (const w of weatherData) {
  const k = format(w.date, 'MM-dd'); const e = wm.get(k) ?? { sum: 0, count: 0 }
  e.sum += w.effectiveTemp; e.count += 1; wm.set(k, e)
}
const weatherAvg: Record<string, number> = {}
for (const [k, v] of wm) weatherAvg[k] = v.sum / v.count
const wv = Object.values(weatherAvg)
const weatherFallback = wv.length ? wv.reduce((a, b) => a + b, 0) / wv.length : 14

const apiStock = await extApi.fetchAgedStock()
const stockByType: Record<string, number> = {}
for (const it of apiStock ?? []) stockByType[it.misoType] = it.stockKg + (it.packagedStockKg ?? 0)

const thisMonday      = combine.mondayOf(today)
const lastPlanMonday  = actualPlans.length ? combine.mondayOf(actualPlans[actualPlans.length - 1].brewDate) : thisMonday
const UNTIL = process.env.UNTIL ? new Date(process.env.UNTIL + 'T00:00:00') : lastPlanMonday
const EVAL  = process.env.EVAL  ? new Date(process.env.EVAL  + 'T00:00:00') : addDays(UNTIL, 35)
// 人の計画は今週（今日以降）の仕込みも含むので、比べる側も今週から割り当てる
const startMonday  = thisMonday
const horizonWeeks = Math.floor(differenceInDays(UNTIL, startMonday) / 7) + 1

console.log(`今日 ${d(today)} ／ 割り当て ${d(startMonday)}〜${d(UNTIL)} の週（${horizonWeeks}週）／ ライン割れは ${d(EVAL)} まで数える`)
console.log('現在庫:', TYPES.map(t => `${t}=${Math.round(stockByType[t] ?? 0)}kg`).join(' '))
console.log('仕込めない週:', blockedWeeks.join(' ') || 'なし')

// 入力（withFixed=true なら今日以降の仮登録を枠・供給に含める）
function buildInputs(withFixed: boolean) {
  return TYPES.map(name => {
    const recipe = recipes.find(r => r.name === name)!
    const rows = forecastRows.filter(f => f.misoType === name)
    const rateMap: Record<string, number> = {}
    for (const f of rows) rateMap[f.yearMonth] = f.forecastKg / getDaysInMonth(new Date(f.yearMonth + '-01T00:00:00'))
    const lastRate = rateMap[rows[rows.length - 1]?.yearMonth] ?? 0
    const getDailyRateFn = (date: Date) => rateMap[format(date, 'yyyy-MM')] ?? lastRate
    const events: { date: Date; kg: number }[] = []
    for (const lot of lots.filter(l => l.misoType === name)) {
      const kg = lotStock.fermentingKgOfLot(lot, yieldRate)
      if (kg <= 0) continue
      const accum = tempCalc.calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap,
        { room1Temp: setting('room1Temp', 24), room2Temp: setting('room2Temp', 20), fridgeTemp, heatingBaseTemp: q10BaseTemp, q10Value })
      const comp = brewSim.calcCompletionFromBrew(lot.brewedAt, recipe.targetTempSum,
        tempCalc.getCurrentLocation(lot.locationHistory), weatherAvg, heatingDefaultTemp - 10,
        q10Value, q10BaseTemp, fridgeTemp, accum, heatingStartDate)
      if (comp) events.push({ date: startOfDay(comp), kg })
    }
    const immediateKg = events.filter(e => e.date <= today).reduce((s, e) => s + e.kg, 0)
    const future = events.filter(e => e.date > today)
    const getCompletion = (bd: Date) => calc.simulateFermentationDays(bd, recipe.targetTempSum, weatherAvg,
      weatherFallback, q10Value, q10BaseTemp, Math.max(heatingDefaultTemp - 10, 0), heatingStartDate)
    const fixed = withFixed ? actualPlans
      .filter(p => p.misoType === name && d(p.brewDate) >= d(today))
      .map(p => {
        const bd = new Date(d(p.brewDate) + 'T00:00:00')
        const c  = getCompletion(bd)   // 仮登録の完成日は登録時点の値なので、今の条件で引き直して揃える
        return { brewDate: bd, completionDate: c.completionDate, fermentationDays: c.days,
                 materialOrderDeadline: addDays(bd, -21), bucketNumbers: p.bucketNumbers }
      }) : []
    const safety = recipe.safetyStockKg ?? 0
    const hasSafety = recipe.safetyStockKg != null || recipe.winterSafetyStockKg != null || recipe.summerSafetyStockKg != null
    return {
      misoType: name, location: recipe.defaultLocation,
      orderLeadDays: calc.ORDER_LEAD_DAYS[name] ?? calc.DEFAULT_ORDER_LEAD_DAYS,
      batchKg: recipe.totalWeightKg,
      effectiveStock: (stockByType[name] ?? 0) + immediateKg,
      getDailyRateFn,
      safetyLineFn: hasSafety ? calc.makeSafetyLineFn(safety, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg) : null,
      baseSupplyEvents: [...future, ...fixed.map(f => ({ date: f.completionDate, kg: recipe.totalWeightKg }))],
      getCompletion, fixed,
      // 旧方式用
      _depletable: (stockByType[name] ?? 0) + immediateKg - safety,
      _safetyDelta: hasSafety ? calc.makeSafetyDeltaFn(safety, recipe.winterSafetyStockKg, recipe.summerSafetyStockKg) : undefined,
      _future: future,
    }
  })
}

// 置いた仕込みの完成を足して在庫を引き直す（期間の外に置かれた仕込みは数えない）
function simulate(inputs: any[], placed: { misoType: string; completionDate: Date }[]) {
  const n = differenceInDays(EVAL, today) + 1
  const res: Record<string, number[]> = {}
  for (const inp of inputs) {
    const ev = new Map<string, number>()
    const add = (dt: Date, kg: number) => ev.set(d(dt), (ev.get(d(dt)) ?? 0) + kg)
    for (const e of inp.baseSupplyEvents) add(e.date, e.kg)
    for (const p of placed.filter(p => p.misoType === inp.misoType)) add(p.completionDate, inp.batchKg)
    let s = inp.effectiveStock; const arr: number[] = []
    for (let i = 0; i < n; i++) { const dt = addDays(today, i); s += ev.get(d(dt)) ?? 0; s -= inp.getDailyRateFn(dt); arr.push(s) }
    res[inp.misoType] = arr
  }
  return res
}

const inWindow = (w: any) => w.weekMonday >= startMonday && w.weekMonday <= UNTIL

function report(label: string, inputs: any[], weeks: any[], stock: Record<string, number[]>) {
  const inRange = weeks.filter(inWindow)
  const pairs   = inRange.filter((w: any) => w.wed && w.thu).length
  const singles = inRange.filter((w: any) => !!w.wed !== !!w.thu).length
  const ev = planner.evaluatePlan(inputs, stock, today, EVAL)
  console.log(`\n■ ${label}`)
  const c = (b: any) => b
    ? `${format(b.brewDate, 'M/d')}${DOW[b.brewDate.getDay()]} ${b.misoType.padEnd(6, '　')}${b.reason && b.reason !== 'fixed' ? `（${combine.REASON_LABEL[b.reason] ?? b.reason}）` : ''}`
    : '—'
  for (const w of inRange) console.log(`  ${format(w.weekMonday, 'M/d')}週  水:${c(w.wed)}  木:${c(w.thu)}`)
  console.log(`  仕込み週 ${inRange.length}（セット${pairs}・単発${singles}）・仕込み ${pairs * 2 + singles}本`)
  for (const t of TYPES) {
    const e = ev[t]
    console.log(`  ${t.padEnd(6, '　')} ライン割れ ${String(e.belowLineDays).padStart(3)}日・最大 ${String(e.maxShortKg).padStart(5)}kg不足・在庫0割れ ${e.stockOutDays}日`)
  }
}
const placedIn = (weeks: any[]) => weeks.filter(inWindow).flatMap((w: any) => [w.wed, w.thu].filter(Boolean))

const ONLY_NEW = process.env.ONLY_NEW === '1'
// ① 人が組んだ仮登録（それ以上は仕込まない）
if (!ONLY_NEW) {
  const inputs = buildInputs(true)
  const r = planner.planBrewSlots(inputs, { today, bufferDays: brewBufferDays, horizonWeeks: 0 })
  report('人が組んだ仮登録', inputs, r.weeks, simulate(inputs, []))
}

// ② 新方式：仮登録なしでゼロから割り当て
{
  const inputs = buildInputs(false)
  const buf  = Number(process.env.BUFFER ?? brewBufferDays)
  const peak = Number(process.env.PEAK ?? planner.SLOT_PEAK_EXTRA_BUFFER_DAYS)
  const pull = Number(process.env.PULL ?? planner.PULL_WEEKS)
  const r = planner.planBrewSlots(inputs, { today, bufferDays: buf, peakExtraBufferDays: peak, pullWeeks: pull,
    horizonWeeks, blockedWeeks: new Set(blockedWeeks), firstMonday: startMonday })
  // DEBUG_TYPE=品種名 DEBUG_FROM=yyyy-MM-dd DEBUG_TO=… で、その品種の在庫とラインを週ごとに出す
  if (process.env.DEBUG_TYPE) {
    const inp = inputs.find(i => i.misoType === process.env.DEBUG_TYPE)!
    const from = new Date((process.env.DEBUG_FROM ?? d(today)) + 'T00:00:00')
    const to   = new Date((process.env.DEBUG_TO ?? d(EVAL)) + 'T00:00:00')
    const arr  = r.stockByType[inp.misoType]
    for (let dt = from; dt <= to; dt = addDays(dt, 3)) {
      const i = differenceInDays(dt, today)
      console.log(`  ${d(dt)} 在庫 ${Math.round(arr[i])}kg ライン ${inp.safetyLineFn?.(dt) ?? 0}kg 消費 ${inp.getDailyRateFn(dt).toFixed(1)}kg/日`)
    }
  }
  report(`新方式（週の枠へ直接割り当て・仮登録なし・バッファ${buf}日＋ピーク${peak}日・前倒し${pull}週まで）`, inputs, r.weeks, simulate(inputs, placedIn(r.weeks)))
}

// ③ 旧方式：品種ごとの提案を後から並べ直す（仮登録なし）
if (!ONLY_NEW) {
  const inputs = buildInputs(false)
  const cands: any[] = []
  const carrierDates: string[] = []
  const gcMap: Record<string, any> = {}
  for (const inp of inputs) {
    const name = inp.misoType
    gcMap[name] = inp.getCompletion
    const isAllowed = name === '山吹みそ' && carrierDates.length
      ? (dt: Date) => carrierDates.includes(d(addDays(dt, -1))) : undefined
    const bs = calc.calcBatches(inp._depletable, inp.getDailyRateFn,
      inp.getCompletion(calc.snapToBrewDay(calc.nextWeekMonday(today))).days, inp.batchKg, 12, today,
      inp.orderLeadDays, brewBufferDays, inp.getCompletion, calc.snapToBrewDay, undefined, undefined, {},
      inp._future, undefined, new Set(calc.expandBlockedWeeks(blockedWeeks)), inp._safetyDelta,
      inp.safetyLineFn ?? undefined, isAllowed, [])
    for (const b of bs) {
      if (name !== '山吹みそ') carrierDates.push(d(b.brewDate))
      cands.push({ misoType: name, location: inp.location, brewDate: b.brewDate, completionDate: b.completionDate,
        fermentationDays: b.fermentationDays, materialOrderDeadline: b.materialOrderDeadline,
        stockOutDate: b.stockOutDate, orderLeadDays: inp.orderLeadDays, isFixed: false })
    }
  }
  const weeks = combine.combineBrewPlans(cands, { blockedWeeks: new Set(blockedWeeks), getCompletion: gcMap })
  report('旧方式（品種ごとの提案を後から並べ直す・仮登録なし）', inputs, weeks, simulate(inputs, placedIn(weeks)))
}

await prisma.$disconnect()

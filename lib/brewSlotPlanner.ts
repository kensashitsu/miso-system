// 3品種（無添加・田舎・山吹）の仕込みを、週の水木2枠へ直接割り当てる。
//
// なぜ作り直したか（2026-09-29）：以前の combineBrewPlans は「品種ごとに独立して出した提案」を
// 後から枠へ並べ直す方式だったため、
//   ① 押し出して後ろへずらした回の在庫の減りが、その品種の後続の回に伝わらない
//   ② 隣り合う週の単発どうし（例：12/7 無添加だけ・12/14 田舎だけ）を1つのセットにまとめられない
//   ③ 山吹の提案が「前日に無添加・田舎がある日」を品種ごとの計算で探すため、数年先の無効な日付が出る
// という欠陥があった。ここでは3品種の在庫を同時に1日ずつ進め、週ごとに2枠の使い方を決める。
//
// 現場ルール（2026-09-04 ユーザー確認・lib/brewCombine.ts と同じ）
//   絶対：① 水・木のみ ② 山吹は木曜のみ・同じ週の水曜に田舎か無添加 ③ セットは 水＝田舎／木＝無添加
//         ④ 単発は水木どちらでもよい ⑤ 田舎は2本立てしない
//   なるべく：水木セットが基本・単発はコスト。仕込みのない週はみそ以外の仕事に使う
//
// 決め方（週ごと・早い週から）
//   1. 各品種の「期限」＝この週に仕込まないと、次に仕込める週では谷（安全在庫ライン割れ）に
//      バッファ日数を残して完成できない。期限の品種は必ずその週に入れる
//   2. 期限の品種が無い週は仕込まない
//   3. 枠が余ったら、PULL_WEEKS 以内（仕込める週で数えて）に期限が来る品種を前倒しして組む（単発を減らす）
//   4. 山吹が期限なのに水曜の相方がいなければ、期限の近い方（田舎/無添加）を前倒しして相方にする
//   5. 3品種が同時に期限なら、余裕（谷までの日数）の少ない2品種を入れ、残りは翌週へ
//
// 「谷」の見方は品種ごとの提案（findStockOutDateAfter）と揃えている：ラインを割り、
// 実在庫が MIN_COVER_DAYS 日分を切り、SHORTFALL_TOLERANCE_DAYS 日以上続くもの。
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'
import {
  MIN_COVER_DAYS, SHORTFALL_TOLERANCE_DAYS, PEAK_COMPLETION_MONTHS,
} from './brewPlanCalc'
import { mondayOf, YAMABUKI, INAKA, MUTENKA, type BrewSlot, type CombinedWeek, type PlacedBrew } from './brewCombine'

export interface SlotPlannerInput {
  misoType:         string
  location:         string
  orderLeadDays:    number
  batchKg:          number
  effectiveStock:   number                                // 今日の実在庫（熟成済＋小分け＋完成済みの熟成中）
  getDailyRateFn:   (date: Date) => number
  safetyLineFn:     ((date: Date) => number) | null
  baseSupplyEvents: { date: Date; kg: number }[]        // 熟成中ロット＋仮登録の完成
  getCompletion:    (brewDate: Date) => { days: number; completionDate: Date }
  fixed: {                                               // 仮登録済み（枠を占める・動かさない）
    brewDate:              Date
    completionDate:        Date
    fermentationDays:      number
    materialOrderDeadline: Date
    bucketNumbers?:        string | null
  }[]
}

export interface SlotPlannerOptions {
  today:          Date
  blockedWeeks?:  Set<string>   // 仕込めない週（月曜の yyyy-MM-dd）
  bufferDays:     number        // 谷の入口の何日前に完成させたいか（brewBufferDays）
  peakExtraBufferDays?: number  // 完成が出荷ピーク期（10〜12月）の回に上乗せするバッファ
  horizonWeeks?:  number        // 何週先まで割り当てるか
  pullWeeks?:     number        // セットにするため何週まで前倒ししてよいか
  firstMonday?:   Date          // 最初に割り当てる週（省略時は翌週＝当週は原料手配が間に合わない）
}

// セットにするため何週まで前倒ししてよいか。
// 2026-09-29 に実データで比べた（scripts/verify-slots.mts・今日〜12月の13週）：
//   0週 → 9週（単発6）／1週 → 7週（セット6・単発1）／2週 → 8週（田舎を3週連続で前倒しし前に詰まる）。
//   1週は人が組んだ仮登録と同じ7週・13本になり、7週のうち6週が同じ週だった
export const PULL_WEEKS = 1

// 出荷ピーク期の上乗せバッファの既定は0。品種ごとの提案（calcBatches）では週の粒度で
// 谷を取りこぼすのを補うために入れていたが、枠の割り当てでは1年通しても仕込みが2本増えるだけで
// ライン割れは変わらなかった（冬は安全在庫ライン自体が厚い）
export const SLOT_PEAK_EXTRA_BUFFER_DAYS = 0

const CARRIERS = [INAKA, MUTENKA]
const dayKey   = (d: Date) => format(d, 'yyyy-MM-dd')

// 1品種ぶんの在庫の見込み（今日からの日次の実在庫）。枠に置くたびに作り直す
class TypeState {
  readonly input:  SlotPlannerInput
  readonly events = new Map<string, number>()
  stock: number[] = []
  private readonly today: Date
  private readonly days:  number
  private readonly compCache = new Map<string, { days: number; completionDate: Date }>()

  constructor(input: SlotPlannerInput, today: Date, days: number) {
    this.input = input
    this.today = today
    this.days  = days
    for (const e of input.baseSupplyEvents) this.addEvent(e.date, e.kg)
    this.rebuild()
  }
  addEvent(date: Date, kg: number) {
    const k = dayKey(date)
    this.events.set(k, (this.events.get(k) ?? 0) + kg)
  }
  // 不足分は0で底打ちしない（割り込んだ分を無かったことにすると後の在庫を多く見積もる）
  rebuild() {
    let s = this.input.effectiveStock
    const out: number[] = []
    let d = this.today
    for (let i = 0; i < this.days; i++) {
      s += this.events.get(dayKey(d)) ?? 0
      s -= this.input.getDailyRateFn(d)
      out.push(s)
      d = addDays(d, 1)
    }
    this.stock = out
  }
  completion(brewDate: Date) {
    const k = dayKey(brewDate)
    let c = this.compCache.get(k)
    if (!c) {
      const r = this.input.getCompletion(brewDate)
      c = { days: r.days, completionDate: startOfDay(r.completionDate) }
      this.compCache.set(k, c)
    }
    return c
  }
  // from 以降で最初の「本物の谷」の入口。無ければ null
  findDip(from: Date): Date | null {
    // ラインの無い品種は在庫0を谷とみなす
    const line = this.input.safetyLineFn
    const start = Math.max(0, differenceInDays(startOfDay(from), this.today))
    let entry = -1
    let deep  = false
    for (let i = start; i < this.stock.length; i++) {
      const d    = addDays(this.today, i)
      const l    = line?.(d) ?? 0
      const kg   = this.stock[i]
      if (kg >= l) { entry = -1; deep = false; continue }
      if (entry < 0) entry = i
      if (kg < MIN_COVER_DAYS * Math.max(this.input.getDailyRateFn(d), 1e-9)) deep = true
      if (deep && i - entry >= SHORTFALL_TOLERANCE_DAYS) return addDays(this.today, entry)
    }
    return null
  }
}

export interface SlotPlanResult {
  weeks: CombinedWeek[]
  // 検証・画面の注記用：最終的な在庫の見込み（品種ごと・今日からの日次）
  stockByType: Record<string, number[]>
}

export function planBrewSlots(inputs: SlotPlannerInput[], options: SlotPlannerOptions): SlotPlanResult {
  const today        = startOfDay(options.today)
  const horizonWeeks = options.horizonWeeks ?? 52
  const pullWeeks    = options.pullWeeks ?? PULL_WEEKS
  const blocked      = options.blockedWeeks ?? new Set<string>()
  const peakExtra    = options.peakExtraBufferDays ?? SLOT_PEAK_EXTRA_BUFFER_DAYS
  // 在庫の見込みは割り当て期間より先まで要る（最後の週に仕込んだ回の完成と、その先の谷を見るため）
  const simDays      = horizonWeeks * 7 + 180

  const states = new Map<string, TypeState>()
  for (const inp of inputs) states.set(inp.misoType, new TypeState(inp, today, simDays))

  const firstMonday = options.firstMonday ? mondayOf(options.firstMonday) : addDays(mondayOf(today), 7)
  const weekMondays: Date[] = []
  for (let i = 0; i < horizonWeeks; i++) weekMondays.push(addDays(firstMonday, 7 * i))

  // 仮登録済みを先に枠へ置く（供給は baseSupplyEvents に入っているので在庫は触らない）
  const slots = new Map<string, { wed: PlacedBrew | null; thu: PlacedBrew | null }>()
  const slotsOf = (monday: Date) => {
    const k = dayKey(monday)
    let s = slots.get(k)
    if (!s) { s = { wed: null, thu: null }; slots.set(k, s) }
    return s
  }
  for (const inp of inputs) {
    for (const f of inp.fixed) {
      const s = slotsOf(mondayOf(f.brewDate))
      const slot: BrewSlot = f.brewDate.getDay() === 4 ? '木' : '水'
      const placed: PlacedBrew = {
        misoType: inp.misoType, location: inp.location, slot,
        brewDate: f.brewDate, idealBrewDate: f.brewDate, movedDays: 0,
        completionDate: f.completionDate, fermentationDays: f.fermentationDays,
        materialOrderDeadline: f.materialOrderDeadline,
        stockOutDate: f.completionDate, fits: true, marginDays: 0,
        reason: 'fixed', isFixed: true, bucketNumbers: f.bucketNumbers ?? null,
      }
      if (slot === '木' && !s.thu) s.thu = placed
      else if (!s.wed) s.wed = placed
      else if (!s.thu) s.thu = placed
    }
  }

  const usable = (monday: Date) => !blocked.has(dayKey(monday))
  const slotDate = (monday: Date, slot: BrewSlot) => addDays(monday, slot === '水' ? 2 : 3)
  // 品種がその週に入るならどちらの曜日か（山吹は木のみ。ほかは期限判定に水を使う）
  const probeSlot = (t: string): BrewSlot => (t === YAMABUKI ? '木' : '水')

  // monday の次に仕込める週
  const nextUsable = (monday: Date) => {
    let m = addDays(monday, 7)
    for (let i = 0; i < 26 && !usable(m); i++) m = addDays(m, 7)
    return m
  }

  // 期限の判定。この週に仕込めば間に合い、次に仕込める週では間に合わないなら期限。
  // 返り値の slack は「谷の入口 − バッファ − この週の完成日」（小さいほど苦しい。マイナスは遅れ）
  const assess = (t: string, monday: Date) => {
    const st   = states.get(t)!
    const cNow = st.completion(slotDate(monday, probeSlot(t))).completionDate
    const dip  = st.findDip(cNow)
    if (!dip) return { due: false, slack: Infinity, dip: null as Date | null }
    const buffer = options.bufferDays +
      (PEAK_COMPLETION_MONTHS.includes(cNow.getMonth() + 1) ? peakExtra : 0)
    const target = addDays(dip, -buffer)
    const cNext  = st.completion(slotDate(nextUsable(monday), probeSlot(t))).completionDate
    return { due: cNext > target, slack: differenceInDays(target, cNow), dip }
  }

  // 何週後（仕込める週で数えて）に期限が来るか。limit を超えたら Infinity
  const weeksUntilDue = (t: string, monday: Date, limit: number) => {
    let m = monday
    for (let k = 0; k <= limit; k++) {
      if (assess(t, m).due) return k
      m = nextUsable(m)
    }
    return Infinity
  }

  const put = (t: string, monday: Date, slot: BrewSlot, reason: PlacedBrew['reason']) => {
    const st  = states.get(t)!
    const a   = assess(t, monday)
    const bd  = slotDate(monday, slot)
    const c   = st.completion(bd)
    st.addEvent(c.completionDate, st.input.batchKg)
    st.rebuild()
    const stockOut = a.dip ?? c.completionDate
    const margin   = differenceInDays(stockOut, c.completionDate)
    const placed: PlacedBrew = {
      misoType: t, location: st.input.location, slot,
      brewDate: bd, idealBrewDate: bd, movedDays: 0,
      completionDate: c.completionDate, fermentationDays: c.days,
      materialOrderDeadline: addDays(bd, -st.input.orderLeadDays),
      stockOutDate: stockOut, fits: margin >= 0, marginDays: margin,
      reason, isFixed: false,
    }
    const s = slotsOf(monday)
    if (slot === '水') s.wed = placed
    else s.thu = placed
  }

  const types = inputs.map(i => i.misoType)
  const has   = (t: string) => types.includes(t)

  for (const monday of weekMondays) {
    if (!usable(monday)) continue
    const s = slotsOf(monday)
    if (s.wed && s.thu) continue

    // 期限の品種（余裕の少ない順）
    const due = types
      .map(t => ({ t, ...assess(t, monday) }))
      .filter(x => x.due)
      .sort((a, b) => a.slack - b.slack)
      .map(x => x.t)
    if (due.length === 0) continue

    const wedFree = !s.wed
    const thuFree = !s.thu
    const carrierOnWed = s.wed && CARRIERS.includes(s.wed.misoType)

    // 山吹を入れる（木曜・水曜に相方が要る）
    const placeYamabuki = (reason: PlacedBrew['reason']) => {
      if (!thuFree || !has(YAMABUKI)) return false
      if (carrierOnWed) { put(YAMABUKI, monday, '木', reason); return true }
      if (!wedFree) return false
      // 相方：期限の相方がいればそれ、いなければ期限の近い方を前倒し
      const dueCarrier = due.find(t => CARRIERS.includes(t))
      const carrier = dueCarrier ?? CARRIERS
        .filter(has)
        .map(t => ({ t, k: weeksUntilDue(t, monday, 8) }))
        .sort((a, b) => a.k - b.k)[0]?.t
      if (!carrier) return false
      put(carrier, monday, '水', dueCarrier ? 'due' : 'carrier')
      put(YAMABUKI, monday, '木', reason)
      return true
    }

    const yamabukiDue = due.includes(YAMABUKI)
    const inakaDue    = due.includes(INAKA)
    const mutenkaDue  = due.includes(MUTENKA)

    // ⑤ 3品種が同時に期限：余裕の少ない2品種。山吹が落ちる場合は田舎＋無添加のセット
    if (yamabukiDue && inakaDue && mutenkaDue) {
      if (due[2] === YAMABUKI) {
        if (wedFree) put(INAKA, monday, '水', 'due')
        if (thuFree) put(MUTENKA, monday, '木', 'due')
      } else {
        placeYamabuki('due')   // 相方は期限の2品種のうち余裕の少ない方
      }
      continue
    }

    if (yamabukiDue) {
      if (placeYamabuki('due')) continue
      // 木曜が埋まっている等で山吹が入れられない週は、ほかの期限だけ処理する
    }

    if (inakaDue && mutenkaDue) {
      if (wedFree) put(INAKA, monday, '水', 'due')
      if (thuFree) put(MUTENKA, monday, '木', 'due')
      continue
    }

    if (inakaDue) {
      // 田舎が水、木は無添加か山吹を前倒しして組む（期限の近い方）
      if (wedFree) {
        put(INAKA, monday, '水', 'due')
      } else if (thuFree && s.wed?.misoType !== INAKA) {
        // 水が埋まっている（無添加の仮登録など）→ 単発扱いで木に田舎（④）
        put(INAKA, monday, '木', 'due')
        continue
      } else {
        continue
      }
      if (thuFree) {
        const opts = [MUTENKA, YAMABUKI].filter(has)
          .map(t => ({ t, k: weeksUntilDue(t, monday, pullWeeks) }))
          .filter(x => x.k <= pullWeeks)
          .sort((a, b) => a.k - b.k)
        if (opts[0]) put(opts[0].t, monday, '木', 'pair-pull')
      }
      continue
    }

    if (mutenkaDue) {
      if (wedFree && thuFree) {
        // 田舎が近いなら 水＝田舎（前倒し）／木＝無添加 のセット
        const kInaka = has(INAKA) ? weeksUntilDue(INAKA, monday, pullWeeks) : Infinity
        if (kInaka <= pullWeeks) {
          put(INAKA, monday, '水', 'pair-pull')
          put(MUTENKA, monday, '木', 'due')
          continue
        }
        put(MUTENKA, monday, '水', 'due')
        // 1本では足りなければ2本立て（無添加のみ）
        if (assess(MUTENKA, monday).due) { put(MUTENKA, monday, '木', 'double'); continue }
        const kYama = has(YAMABUKI) ? weeksUntilDue(YAMABUKI, monday, pullWeeks) : Infinity
        if (kYama <= pullWeeks) put(YAMABUKI, monday, '木', 'pair-pull')
        continue
      }
      if (thuFree) { put(MUTENKA, monday, '木', 'due'); continue }
      if (wedFree) { put(MUTENKA, monday, '水', 'due'); continue }
    }
  }

  const weeks: CombinedWeek[] = [...slots.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ weekMonday: new Date(`${k}T00:00:00`), wed: v.wed, thu: v.thu }))
    .filter(w => w.wed || w.thu)

  const stockByType: Record<string, number[]> = {}
  for (const [t, st] of states) stockByType[t] = st.stock
  return { weeks, stockByType }
}

// 計画の良し悪しを測る（検証スクリプト・画面の注記で共通）。
// until までの期間で、安全在庫ラインを割った日数・最大の不足kg・在庫が0を割った日数を品種ごとに出す
export function evaluatePlan(
  inputs: SlotPlannerInput[],
  stockByType: Record<string, number[]>,
  today: Date,
  until: Date,
) {
  const out: Record<string, { belowLineDays: number; maxShortKg: number; stockOutDays: number }> = {}
  const n = differenceInDays(startOfDay(until), startOfDay(today))
  for (const inp of inputs) {
    const s = stockByType[inp.misoType] ?? []
    let below = 0, maxShort = 0, out0 = 0
    for (let i = 0; i < Math.min(n, s.length); i++) {
      const d = addDays(startOfDay(today), i)
      const l = inp.safetyLineFn?.(d) ?? 0
      if (s[i] < l) { below++; maxShort = Math.max(maxShort, l - s[i]) }
      if (s[i] < 0) out0++
    }
    out[inp.misoType] = { belowLineDays: below, maxShortKg: Math.round(maxShort), stockOutDays: out0 }
  }
  return out
}

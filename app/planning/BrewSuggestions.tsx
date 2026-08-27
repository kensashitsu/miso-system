'use client'

import { useState, useEffect, useRef } from 'react'
import { addDays, differenceInDays, format, getDaysInMonth, isSameISOWeek } from 'date-fns'
import { Printer, Download, ChevronDown, ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { holtWinters, getTimeSeries } from '@/lib/forecast'
import { HEATING_MONTHLY_FACTOR } from '@/lib/tempCalc'
import { createBrewPlan } from './brew-plan-actions'
import StockProjectionChart, { type StockPoint } from './StockProjectionChart'

interface Recipe {
  name:            string
  targetTempSum:   number
  totalWeightKg:   number
  defaultLocation: string
  safetyStockKg:   number | null
}

interface FermentingInfo {
  totalKg: number
  count:   number
}

interface FermentingLotSchedule {
  completionDateStr: string  // 'yyyy-MM-dd'
  yieldKg:           number
  label?:            string  // 在庫推移グラフに表示する桶番号（例: 桶12・13）
}

// SARIMAX予測データの型（品種ごと）
interface SarimaxEntry {
  months:   string[]
  forecast: number[]
  lower90:  number[]
  upper90:  number[]
}

interface Props {
  recipes:          Recipe[]
  shipmentMap:      Record<string, Record<string, number>>
  heatingDefaultTemp: number
  coolingDefaultTemp: number
  fridgeTemp:       number
  q10Value:         number
  brewBufferDays:   number
  weatherAvg:       Record<string, number>
  fermentingByType: Record<string, FermentingInfo>
  apiStockByType?:  Record<string, number>
  // SARIMAX予測データ（未実行時はundefined）
  sarimaxForecast?: Record<string, SarimaxEntry>
  // SARIMAX予測誤差（MAPE %・品種別・未実行時はundefined）
  sarimaxMape?:     Record<string, number>
  // バックテストで品種ごとに最も的中する方式（自動方式選択用・低精度品種は含まれない）
  autoMethodByType?: Record<string, 'sarimax' | 'hw' | 'avg'>
  // 熟成中ロットの完成予定日・歩留まりスケジュール（在庫補充タイミング計算用）
  fermentingScheduleByType?: Record<string, FermentingLotSchedule[]>
  // 既存の仮登録キー一覧（"品種::yyyy-MM-dd" 形式）
  existingBrewPlanKeys?: string[]
  // DBに保存済みの仮登録仕込み日（品種別・他PCからの同期用フォールバック）
  initialManualBrewDates?: Record<string, string>
  // 仮登録済み（確定）の仕込み予定。完成日に生産量を供給算入し、確定行として表示する
  registeredPlansByType?: Record<string, {
    brewDateStr:              string
    completionDateStr:        string
    materialOrderDeadlineStr: string
    fermentationDays:         number
    bucketNumbers?:           string | null
  }[]>
  // 本登録済み（ロット化済み）の仕込み日（品種別・yyyy-MM-dd）。
  // 同じ日付の手動調整ピンは実現済みのため自動解除するために使う。
  registeredDoneDatesByType?: Record<string, string[]>
}

interface BatchPlan {
  n:                     number
  brewDate:              Date
  completionDate:        Date
  fermentationDays:      number  // Q10補正ありの熟成日数（常温）/ 固定値（暖房・冷房）
  stockOutDate:          Date
  materialOrderDeadline: Date
  daysUntilOrder:        number
  startStockKg:          number  // この回の計画開始時点の有効在庫
  rawFermentationDays?:      number  // Q10補正なしの熟成日数（常温かつq10≠1のときのみ）
  rawCompletionDate?:        Date    // Q10補正なしの完成日
  rawBrewDate?:              Date    // Q10補正なしの推奨仕込み日
  rawMaterialOrderDeadline?: Date    // Q10補正なしの手配締切
  isFixed?:                  boolean // 仮登録済み（確定）の行。提案ではなく既定の予定
}

interface RecipePlan {
  name:             string
  monthlyAvg:       number | null
  usingHW:          boolean
  usingSarimax:     boolean   // SARIMAX予測を使用しているか
  autoApplied:      'sarimax' | 'hw' | 'avg' | null  // 自動方式選択で採用された方式（ON時のみ）
  fermentationDays: number
  effectiveStock:   number
  stockKg:          number
  fermentingKg:     number
  fermentingCount:  number
  safetyStockKg:    number | null
  dailyRate:        number
  dailyAccum:       number
  location:         string
  orderLeadDays:    number
  batches:          BatchPlan[]
  hasData:          boolean
  canCalc:          boolean
  isBrewDatePast:   boolean       // 1回目AI推奨仕込み日が今日より過去かどうか
  overdueDays:      number        // 何日超過しているか
  manualPinIndices: number[]      // 手動固定が実際に効いている回のインデックス（確定日と重複時は除外）
  idealBrewDate0:   Date | null   // 修正前のAI推奨仕込み日（警告バナー表示用）
  orderImpact:      {             // 予定出荷の反映前後の比較（未入力時はnull）
    orderCount:     number
    orderKg:        number
    stockOutBefore: Date
    stockOutAfter:  Date
    perBatch:       { n: number; before: Date; after: Date; deltaDays: number }[]  // 全回分（+なら前倒し）
  } | null
  stockOutInDays:   number | null // 推定在庫切れまでの日数
  whatIf:           {             // ② もしもの試算（全回分・調整値は品種別state）
    demandPct:      number
    demandStockOut: { newStockOut: Date; delta: number } | null
    demand:         { n: number; newBrew: Date; deltaDays: number }[]
    delayDays:      number
    delay:          { n: number; newCompletion: Date; fits: boolean; marginDays: number }[]
    tempDelta:      number
    temp:           { n: number; newDays: number; dayDelta: number; newCompletion: Date }[]  // 常温のみ・他は空
  } | null
  stockPoints:      StockPoint[] | null  // 在庫推移グラフ用の日次系列（計算の根拠の可視化）
  supplyMarkers:    { d: string; label: string; kind: 'fermenting' | 'registered' }[]  // 補充ジャンプの桶番号ラベル（熟成中=緑/仮登録=紫）
}

const BATCH_OPTIONS = [1, 3, 5] as const

// 場所名から温度を抽出するパターン
const TEMP_RE = /^(?:温調室|暖房|冷房)(\d+(?:\.\d+)?)℃$/

// 場所名から1日あたりの有効積算温度を計算（常温はQ10補正済み年間平均）
function getDailyAccum(
  location:         string,
  fridgeTemp:       number,
  weatherAvgValues: number[],
  q10Value?:        number,
  heatingBaseTemp?: number,
): number {
  const m = location.match(TEMP_RE)
  if (m) return Math.max(Number(m[1]) - 10, 0)
  if (location === '冷蔵庫') return Math.max(fridgeTemp - 10, 0)
  // 常温: 気象データの年間平均にQ10補正を適用
  if (weatherAvgValues.length === 0) return 14
  const q10  = q10Value      ?? 1
  const base = heatingBaseTemp ?? 25
  return weatherAvgValues
    .map(v => {
      if (v <= 0 || q10 === 1) return v
      const avgTempC = v + 10
      return v * Math.pow(q10, (avgTempC - base) / 10)
    })
    .reduce((a, b) => a + b, 0) / weatherAvgValues.length
}

// 常温：仕込み日から気象データを日ごとに積み上げて完成日を推計（Q10補正あり）
// lib/tempCalc.ts の applyQ10 と同ロジック（effectiveTemp > 0 のとき avgTempC = eff + 10 で逆算）
function simulateFermentationDays(
  brewDate:         Date,
  targetTempSum:    number,
  weatherAvg:       Record<string, number>,
  fallbackDaily:    number,
  q10Value:         number,
  heatingBaseTemp:  number,
  indoorDailyRate?: number,  // 10〜5月の暖房レート（常温→暖房の季節切り替え用）
): { days: number; completionDate: Date } {
  if (!brewDate || isNaN(brewDate.getTime())) return { days: 0, completionDate: new Date() }
  let accumulated = 0
  let current = new Date(brewDate)
  for (let i = 0; i < 730; i++) {
    const month = current.getMonth() + 1
    const isOutdoorMonth = month >= 6 && month <= 9
    let daily: number
    if (indoorDailyRate !== undefined && !isOutdoorMonth) {
      // 10〜5月: 暖房レートに実データ較正済みの月別補正係数を適用（Q10補正は対象外）
      daily = indoorDailyRate * (HEATING_MONTHLY_FACTOR[month] ?? 1)
    } else {
      const key = format(current, 'MM-dd')
      const eff = weatherAvg[key] ?? fallbackDaily
      if (eff > 0 && q10Value !== 1) {
        const avgTempC = eff + 10
        daily = eff * Math.pow(q10Value, (avgTempC - heatingBaseTemp) / 10)
      } else {
        daily = eff
      }
    }
    accumulated += daily
    current = addDays(current, 1)
    if (accumulated >= targetTempSum) {
      return { days: i + 1, completionDate: new Date(current) }
    }
  }
  return { days: 730, completionDate: addDays(brewDate, 730) }
}

// 品種別の原料手配リードタイム（仕込み日の何日前までに手配が必要か）
const ORDER_LEAD_DAYS: Record<string, number> = {
  '白みそ': 7,
}
const DEFAULT_ORDER_LEAD_DAYS = 21

// 指定日以降で最も近い水曜（3）または木曜（4）を返す
// 各曜日からの加算日数: [日,月,火,水,木,金,土] = [3,2,1,0,0,5,4]
const SNAP_DAYS_OFFSET = [3, 2, 1, 0, 0, 5, 4]

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

const MISO_ABBR: Record<string, string> = {
  '無添加麦みそ': '麦',
  '田舎みそ':     '田',
  '山吹みそ':     '山',
  '白みそ':       '白',
}

// 仕込み日バッジ: 濃い塗りつぶし＋白文字
const MISO_DARK_COLOR: Record<string, string> = {
  '無添加麦みそ': '#0F6E56',
  '田舎みそ':     '#854F0B',
  '山吹みそ':     '#3C3489',
  '白みそ':       '#185FA5',
}
function getBrewBadgeStyle(misoType: string) {
  const c = MISO_DARK_COLOR[misoType] ?? '#555555'
  return { backgroundColor: c, color: 'white', border: `1px solid ${c}` }
}
// 完成日バッジ: 白背景＋枠線
function getCompBadgeStyle(misoType: string) {
  const c = MISO_DARK_COLOR[misoType] ?? '#555555'
  return { backgroundColor: 'white', color: c, border: `1.5px solid ${c}` }
}

function snapToBrewDay(date: Date): Date {
  return addDays(date, SNAP_DAYS_OFFSET[date.getDay()])
}

// 翌週の月曜日を返す（当週は原料手配等の都合で提案対象外にするための起点）
function nextWeekMonday(date: Date): Date {
  const isoDow = (date.getDay() + 6) % 7  // 月=0, 火=1, ... 日=6
  return addDays(date, 7 - isoDow)
}

// 工程上の運用ルール：田舎みそと無添加麦みそを同じ週に仕込む場合、田舎を先に仕込む。
// 無添加のバッチが田舎のいずれかのバッチと同じ週で同日以前になっていたら、
// その田舎の仕込み日の翌日以降（仕込み曜日制限があれば次の水or木）にずらす上書き指定を作る。
function buildOrderingOverrides(
  generated:      { brewDate: Date }[],
  blockedDates:   Date[],
  snapBrewDate?:  (date: Date) => Date,
): Record<number, Date> {
  const overrides: Record<number, Date> = {}
  generated.forEach((b, i) => {
    const conflict = blockedDates.find(bd => isSameISOWeek(b.brewDate, bd) && b.brewDate <= bd)
    if (conflict) {
      const next = addDays(conflict, 1)
      overrides[i] = snapBrewDate ? snapBrewDate(next) : next
    }
  })
  return overrides
}

// 手動調整の仕込み日をlocalStorageに保存する際のキー。1回目（idx=0）は後方互換のため
// 従来どおり品種名のみ、2回目以降（idx>=1）は品種名にインデックスを付与する。
function manualDateKey(name: string, idx: number): string {
  return idx === 0 ? name : `${name}#${idx}`
}

function get3YearAvg(data: Record<string, number>, month: number, year: number): number | null {
  const values: number[] = []
  for (let i = 1; i <= 3; i++) {
    const ym = `${year - i}-${String(month).padStart(2, '0')}`
    if (data[ym] != null) values.push(data[ym])
  }
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

// 3年平均の保守値（需要多めシナリオ）。平均＋標準偏差（≒上ブレ）。
// データ1点のみのときは平均×1.1の固定マージン。SARIMAXのupper90に相当する役割。
function get3YearConservative(data: Record<string, number>, month: number, year: number): number | null {
  const values: number[] = []
  for (let i = 1; i <= 3; i++) {
    const ym = `${year - i}-${String(month).padStart(2, '0')}`
    if (data[ym] != null) values.push(data[ym])
  }
  if (values.length === 0) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (values.length < 2) return mean * 1.1
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return mean + Math.sqrt(variance)
}

// 標準／保守的を切り替えて3年平均を返す
function avg3(data: Record<string, number>, month: number, year: number, conservative: boolean): number | null {
  return conservative ? get3YearConservative(data, month, year) : get3YearAvg(data, month, year)
}

// 月別変動レートを使って在庫が尽きる日をシミュレーション（熟成中ロットの補充スケジュール考慮）
function findStockOutDate(
  stock:          number,
  startDate:      Date,
  getDailyRateFn: (date: Date) => number,
  supplyEvents?:  { date: Date; kg: number }[],
): Date {
  if (stock <= 0 && (!supplyEvents || supplyEvents.length === 0)) return new Date(startDate)
  let remaining = stock
  let d = new Date(startDate)
  for (let i = 0; i < 3650; i++) {
    // 完成予定日に熟成中ロットの歩留まりを補充
    if (supplyEvents) {
      const dStr = format(d, 'yyyy-MM-dd')
      for (const ev of supplyEvents) {
        if (format(ev.date, 'yyyy-MM-dd') === dStr) remaining += ev.kg
      }
    }
    remaining -= getDailyRateFn(d)
    if (remaining <= 0) return addDays(d, 1)
    d = addDays(d, 1)
  }
  return addDays(startDate, 3650)
}

// 期間内に受け取る補充量合計（熟成中ロット完成分）
function computeSupplyReceived(
  startDate:     Date,
  endDate:       Date,
  supplyEvents?: { date: Date; kg: number }[],
): number {
  if (!supplyEvents) return 0
  return supplyEvents
    .filter(ev => ev.date >= startDate && ev.date < endDate)
    .reduce((sum, ev) => sum + ev.kg, 0)
}

// startDate〜endDate間の月別変動レートによる消費量合計
function computeConsumed(
  startDate:      Date,
  endDate:        Date,
  getDailyRateFn: (date: Date) => number,
): number {
  let total = 0
  let d = new Date(startDate)
  while (d < endDate) {
    total += getDailyRateFn(d)
    d = addDays(d, 1)
  }
  return total
}

// 1バッチの歩留まり(kg)を消費しきるまでの日数（月別変動レートで積分）
// = このバッチが「何日分の需要を賄えるか」。連続バッチの完成日がこの間隔より
// 密集すると仕込み日が1〜数日差で団子になるため、最小完成間隔の基準として使う。
function computeCoverageDays(
  batchKg:        number,
  startDate:      Date,
  getDailyRateFn: (date: Date) => number,
): number {
  if (batchKg <= 0) return 0
  let remaining = batchKg
  let d = new Date(startDate)
  for (let i = 0; i < 730; i++) {
    remaining -= getDailyRateFn(d)
    if (remaining <= 0) return i + 1
    d = addDays(d, 1)
  }
  return 730
}

// 完成間隔を詰められる下限（水木仕込みなら同じ週に2回（水→木で1日差）まで可能なため、
// 物理的な下限は1日。2026-08-26にユーザー指摘で「週1本」想定から緩和）
const MIN_COMPLETION_GAP_DAYS = 1

// 次バッチの完成日下限を計算する。
// 基本は「前バッチ完成日＋カバー日数」（団子防止）だが、完成時点の在庫の底が
// バッファ日数分を下回る見込みのときは、不足日数分だけ間隔を詰めることを許し、
// 数バッチかけてバッファを回復できるようにする。
// ※従来はカバー日数固定の下限だったため間隔が常に消費とトントン以上となり、
//   一度食い込んだバッファ（例: 秋冬の需要増×熟成長期化）を回復する手段がなく
//   在庫ゼロ張り付きの提案が連鎖する「ラチェット」になっていた。
function calcMinNextCompletion(
  completionDate: Date,
  stockAtRef:     number,   // refDate時点の在庫（前バッチの歩留まり加算済み）
  refDate:        Date,     // 前バッチの完成日（初回は今日）
  batchYieldKg:   number,
  bufferDays:     number,
  getDailyRateFn: (date: Date) => number,
  supplyEvents?:  { date: Date; kg: number }[],
): Date {
  const coverage = computeCoverageDays(batchYieldKg, completionDate, getDailyRateFn)
  // このバッチ完成時点の在庫の底（歩留まり加算前）
  const floorKg = Math.max(
    0,
    stockAtRef
      - computeConsumed(refDate, completionDate, getDailyRateFn)
      + computeSupplyReceived(refDate, completionDate, supplyEvents),
  )
  const rate        = Math.max(getDailyRateFn(completionDate), 1e-9)
  const deficitDays = Math.max(0, bufferDays - floorKg / rate)
  const minGap      = Math.min(MIN_COMPLETION_GAP_DAYS, coverage)
  const gapDays     = Math.max(minGap, Math.ceil(coverage - deficitDays))
  return addDays(completionDate, gapDays)
}

// 予測方式・データから「日付→1日消費量(kg)」関数を生成
// conservative=true で需要多めシナリオ：SARIMAX→upper90 / HW→上限(平均+σ) / 3年平均→平均+標準偏差
function buildDailyRateFn(
  method:       'sarimax' | 'hw' | 'avg',
  typeData:     Record<string, number>,
  sarimaxEntry: SarimaxEntry | undefined,
  hwInput:      number[],
  fallback:     number,
  conservative: boolean = false,
): (date: Date) => number {
  // 予測値が無い月のフォールバック（3年平均・保守時は平均+σ）
  const avg3Fn = (date: Date) => {
    const v = avg3(typeData, date.getMonth() + 1, date.getFullYear(), conservative)
    return v !== null ? v / getDaysInMonth(date) : fallback
  }

  // SARIMAX: 月別予測値を直接使用（保守はupper90）
  if (method === 'sarimax' && sarimaxEntry && sarimaxEntry.months.length > 0) {
    const series = (conservative && sarimaxEntry.upper90?.length === sarimaxEntry.forecast.length)
      ? sarimaxEntry.upper90
      : sarimaxEntry.forecast
    const map: Record<string, number> = {}
    for (let i = 0; i < sarimaxEntry.months.length; i++) {
      const ym = sarimaxEntry.months[i]
      map[ym] = series[i] / getDaysInMonth(new Date(ym + '-01T00:00:00'))
    }
    return (date: Date) => {
      const ym = format(date, 'yyyy-MM')
      return map[ym] !== undefined ? map[ym] : avg3Fn(date)
    }
  }

  // HW: 36ヶ月先まで予測してマッピング（保守は上限 upperBound = 平均+σ）
  if (method === 'hw' && hwInput.length >= 12) {
    const sortedKeys = Object.keys(typeData).sort()
    const lastKnown  = sortedKeys[sortedKeys.length - 1]
    if (lastKnown) {
      const hw = holtWinters(hwInput, 36)
      const series = conservative ? hw.upperBound : hw.forecast
      const map: Record<string, number> = {}
      let [hy, hm] = lastKnown.split('-').map(Number)
      for (let i = 0; i < series.length; i++) {
        hm++; if (hm > 12) { hm = 1; hy++ }
        const ym     = `${hy}-${String(hm).padStart(2, '0')}`
        const daysInM = getDaysInMonth(new Date(hy, hm - 1, 1))
        map[ym] = Math.max(0, series[i]) / daysInM
      }
      return (date: Date) => {
        const ym = format(date, 'yyyy-MM')
        return map[ym] !== undefined ? map[ym] : avg3Fn(date)
      }
    }
  }

  // 3年平均: 月ごとに直近3年の実績平均（保守は平均+標準偏差）
  return avg3Fn
}

// 在庫切れ日からの逆算で「仕込み日 ＝ 在庫切れ日 −（その日に仕込んだ場合の実熟成日数＋バッファ）」を
// 不動点反復で収束させる（常温のQ10シミュレーション専用）。
// 静的な年間平均ベースの初期推定だと最初の仮仕込み日が別の季節（例：春）に落ち、
// そこで得た遅い熟成日数（45日前後）のまま1回だけ補正すると、夏仕込みなのに仕込み日が
// 2〜3週間も前倒しになる。実際の仕込み日の季節に合った熟成日数へ収束するまで繰り返す。
function refineBrewDateToStockOut(
  stockOut:      Date,
  initialEst:    number,
  buffer:        number,
  getCompletion: (d: Date) => { days: number; completionDate: Date },
  snapBrewDate?: (d: Date) => Date,
): Date {
  const snap = (d: Date) => (snapBrewDate ? snapBrewDate(d) : d)
  let brew = snap(addDays(stockOut, -(initialEst + buffer)))
  const seen = new Set<string>()
  for (let k = 0; k < 6; k++) {
    const r    = getCompletion(brew)
    const next = snap(addDays(stockOut, -(r.days + buffer)))
    if (format(next, 'yyyy-MM-dd') === format(brew, 'yyyy-MM-dd')) return next  // 収束
    // スナップ起因で隣接日を行き来する2サイクルは、遅い方（完成が在庫切れに近い＝過剰仕込みが少ない安全側）を採用
    if (seen.has(format(next, 'yyyy-MM-dd'))) return next > brew ? next : brew
    seen.add(format(brew, 'yyyy-MM-dd'))
    brew = next
  }
  return brew
}

function calcBatches(
  effectiveStock:      number,
  getDailyRateFn:      (date: Date) => number,  // 月別消費量関数
  fermentationDays:    number,    // Q10補正ありの初期推定値
  batchYieldKg:        number,
  count:               number,
  today:               Date,
  orderLeadDays:       number,
  bufferDays:          number,
  getCompletion?:      (brewDate: Date) => { days: number; completionDate: Date },
  snapBrewDate?:       (date: Date) => Date,
  getCompletionRaw?:   (brewDate: Date) => { days: number; completionDate: Date },
  fermentationDaysRaw?: number,   // Q10補正なしの初期推定値（常温のみ）
  manualBrewDateByIndex?: Record<number, Date>,  // 回ごと（0始まり）の仕込み日手動指定（スナップ無効）
  supplyEvents?:       { date: Date; kg: number }[],  // 熟成中ロットの補充スケジュール
): BatchPlan[] {
  const batches: BatchPlan[] = []
  // 当週はもう原料手配等の都合で仕込めないため、仕込み日として提案できるのは最短で翌週から
  const minBrewDate   = snapBrewDate ? snapBrewDate(nextWeekMonday(today)) : nextWeekMonday(today)
  let stock           = effectiveStock
  let refDate         = today
  // Q10補正あり・なしそれぞれの推定値を独立して追跡する
  let currentEstimate    = fermentationDays
  let rawCurrentEstimate = fermentationDaysRaw ?? fermentationDays
  // バッチ間の昇順を保証するための下限日（前バッチの翌日以降）
  let minNextBrewDate:    Date = minBrewDate
  let minNextRawBrewDate: Date = minBrewDate
  // 連続バッチの完成日が密集しないための下限（前バッチの完成日＋カバー期間）。
  // これにより「1バッチを消費しきる前に次が完成」する団子状の仕込み提案を防ぐ。
  let minNextCompletion:    Date = today
  let minNextRawCompletion: Date = today
  // Q10補正なしチェーン専用の在庫追跡（Q10補正ありとは独立して連鎖する）
  let rawRefDate = today
  let rawStock   = effectiveStock

  for (let i = 0; i < count; i++) {
    const startStockKg = stock
    const safeBuffer   = Number.isFinite(bufferDays) ? bufferDays : 0
    const stockOutDate = findStockOutDate(stock, refDate, getDailyRateFn, supplyEvents)
    // Q10補正なし専用の在庫切れ予測日（独立チェーン）
    const rawStockOutDate = getCompletionRaw ? findStockOutDate(rawStock, rawRefDate, getDailyRateFn, supplyEvents) : stockOutDate

    // ── Q10補正あり（メイン） ──────────────────────────────
    let brewDate: Date
    if (manualBrewDateByIndex?.[i]) {
      brewDate = manualBrewDateByIndex[i]
      // 手動指定日が当日以前の場合も翌日以降に修正（elseブランチと統一）
      if (brewDate < minBrewDate) {
        brewDate = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
      }
    } else {
      // 常温は仕込み日の季節に合った実熟成日数へ不動点反復で収束させる（単発補正だと前倒し過ぎる）。
      // それ以外は固定熟成日数で逆算するだけ。
      if (getCompletion) {
        brewDate = refineBrewDateToStockOut(stockOutDate, currentEstimate, safeBuffer, getCompletion, snapBrewDate)
      } else {
        const preSnapDate = addDays(stockOutDate, -(currentEstimate + safeBuffer))
        brewDate = snapBrewDate ? snapBrewDate(preSnapDate) : preSnapDate
      }
      // 計算結果が当日以前になった場合は翌日以降に修正（当日はもう仕込めないため）
      if (brewDate < minBrewDate) {
        brewDate = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
      }
    }
    // 前バッチ以前にならないよう修正（昇順を保証し、sort後のn=1・n=2が同日になるのを防ぐ）
    if (brewDate < minNextBrewDate) {
      brewDate = snapBrewDate ? snapBrewDate(minNextBrewDate) : minNextBrewDate
    }

    // 完成日を計算するヘルパー（常温はQ10シミュレーション、それ以外は固定熟成日数）
    const computeCompletion = (bd: Date): { completionDate: Date; days: number } =>
      getCompletion ? getCompletion(bd) : { completionDate: addDays(bd, fermentationDays), days: fermentationDays }

    let { completionDate, days: actualFermentDays } = computeCompletion(brewDate)
    // 完成日が「前バッチの完成日＋カバー期間」より早い場合は仕込み日を後ろへずらす。
    // 1バッチの歩留まりを消費しきる前に次が完成すると、仕込み日が1〜数日差で密集する
    // （前バッチの翌日へ丸める昇順クランプだけでは団子状の提案になってしまう）。
    // ただし手動固定されている回は、現場の都合（水木連続仕込みなど）を優先しそのまま採用する。
    if (completionDate < minNextCompletion && !manualBrewDateByIndex?.[i]) {
      const deficit = differenceInDays(minNextCompletion, completionDate)
      brewDate = snapBrewDate ? snapBrewDate(addDays(brewDate, deficit)) : addDays(brewDate, deficit)
      let r     = computeCompletion(brewDate)
      let guard = 0
      while (r.completionDate < minNextCompletion && guard < 60) {
        brewDate = snapBrewDate ? snapBrewDate(addDays(brewDate, 1)) : addDays(brewDate, 1)
        r        = computeCompletion(brewDate)
        guard++
      }
      completionDate    = r.completionDate
      actualFermentDays = r.days
    }
    currentEstimate   = actualFermentDays
    minNextBrewDate   = addDays(brewDate, 1)
    // バッファ不足時は間隔を詰められる下限（stock/refDateはこの時点ではまだ前バッチ基準）
    minNextCompletion = calcMinNextCompletion(completionDate, stock, refDate, batchYieldKg, safeBuffer, getDailyRateFn, supplyEvents)

    const materialOrderDeadline = addDays(brewDate, -orderLeadDays)
    const daysUntilOrder        = differenceInDays(materialOrderDeadline, today)

    // ── Q10補正なし（サブ・常温かつq10≠1のときのみ） ────────
    let rawBrewDate: Date | undefined
    let rawFermentationDays: number | undefined
    let rawCompletionDate: Date | undefined
    let rawMaterialOrderDeadline: Date | undefined
    if (getCompletionRaw) {
      let rawProv: Date
      if (manualBrewDateByIndex?.[i]) {
        rawProv = manualBrewDateByIndex[i]
        // 手動指定日が当日以前の場合も翌日以降に修正（elseブランチと統一）
        if (rawProv < minBrewDate) {
          rawProv = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
        }
      } else {
        // Q10補正ありと同様に、不動点反復で仕込み日の季節に合った熟成日数へ収束させる
        rawProv = refineBrewDateToStockOut(rawStockOutDate, rawCurrentEstimate, safeBuffer, getCompletionRaw, snapBrewDate)
        if (rawProv < minBrewDate) {
          rawProv = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
        }
      }
      // rawBrewDateも昇順を保証
      if (rawProv < minNextRawBrewDate) {
        rawProv = snapBrewDate ? snapBrewDate(minNextRawBrewDate) : minNextRawBrewDate
      }
      rawBrewDate = rawProv
      let rr = getCompletionRaw(rawBrewDate)
      // Q10補正ありと同様に、カバー期間で完成日の密集（仕込み日の団子化）を防ぐ（手動固定回は除く）
      if (rr.completionDate < minNextRawCompletion && !manualBrewDateByIndex?.[i]) {
        const deficit = differenceInDays(minNextRawCompletion, rr.completionDate)
        rawBrewDate = snapBrewDate ? snapBrewDate(addDays(rawBrewDate, deficit)) : addDays(rawBrewDate, deficit)
        rr          = getCompletionRaw(rawBrewDate)
        let guard   = 0
        while (rr.completionDate < minNextRawCompletion && guard < 60) {
          rawBrewDate = snapBrewDate ? snapBrewDate(addDays(rawBrewDate, 1)) : addDays(rawBrewDate, 1)
          rr          = getCompletionRaw(rawBrewDate)
          guard++
        }
      }
      minNextRawBrewDate       = addDays(rawBrewDate, 1)
      rawFermentationDays      = rr.days
      rawCompletionDate        = rr.completionDate
      rawCurrentEstimate       = rawFermentationDays   // 次回の推定に実績値を使う
      minNextRawCompletion     = calcMinNextCompletion(rawCompletionDate, rawStock, rawRefDate, batchYieldKg, safeBuffer, getDailyRateFn, supplyEvents)
      rawMaterialOrderDeadline = addDays(rawBrewDate, -orderLeadDays)
    }

    batches.push({
      n: i + 1, brewDate, completionDate, fermentationDays: actualFermentDays,
      stockOutDate, materialOrderDeadline, daysUntilOrder, startStockKg,
      rawFermentationDays, rawCompletionDate, rawBrewDate, rawMaterialOrderDeadline,
    })

    // 在庫引き継ぎはQ10補正ありの完成日を基準にする（月別変動レートで積分 + 熟成中ロット補充分を加算）
    const consumed       = computeConsumed(refDate, completionDate, getDailyRateFn)
    const supplyReceived = computeSupplyReceived(refDate, completionDate, supplyEvents)
    refDate = completionDate
    stock   = Math.max(0, stock - consumed + supplyReceived) + batchYieldKg
    // Q10補正なしチェーンも独立して在庫を前進させる
    if (rawCompletionDate) {
      const rawConsumed       = computeConsumed(rawRefDate, rawCompletionDate, getDailyRateFn)
      const rawSupplyReceived = computeSupplyReceived(rawRefDate, rawCompletionDate, supplyEvents)
      rawRefDate = rawCompletionDate
      rawStock   = Math.max(0, rawStock - rawConsumed + rawSupplyReceived) + batchYieldKg
    }
  }

  // 仕込み日昇順で並び替えて回数を振り直す（理論上は既に単調増加だが念のため）
  return batches
    .sort((a, b) => a.brewDate.getTime() - b.brewDate.getTime())
    .map((b, i) => ({ ...b, n: i + 1 }))
}

function daysLabel(days: number): string {
  return days >= 0 ? `あと${days}日` : `${Math.abs(days)}日超過`
}

// CSV生成
function generateCSV(plans: RecipePlan[], maxBatches: number, today: Date): string {
  const exportedAt = format(today, 'yyyy/MM/dd')
  const lines: string[] = [
    `仕込み計画 出力日: ${exportedAt}  表示回数: ${maxBatches}回分`,
    '品種,回目,仕込み日,完成日,原料手配締切,在庫切れ予測日,現在庫(kg),熟成中(kg),月次消費推計(kg)',
  ]
  for (const plan of plans) {
    if (!plan.canCalc || plan.batches.length === 0) {
      lines.push(`${plan.name},データ不足,,,,,${Math.round(plan.stockKg)},${Math.round(plan.fermentingKg)},`)
      continue
    }
    for (const b of plan.batches) {
      lines.push([
        plan.name,
        b.n,
        format(b.brewDate,              'yyyy/MM/dd'),
        format(b.completionDate,        'yyyy/MM/dd'),
        format(b.materialOrderDeadline, 'yyyy/MM/dd'),
        format(b.stockOutDate,          'yyyy/MM/dd'),
        Math.round(plan.stockKg),
        Math.round(plan.fermentingKg),
        plan.monthlyAvg != null ? Math.round(plan.monthlyAvg) : '',
      ].join(','))
    }
  }
  return lines.join('\n')
}

// 現在月から季節に合った仕込み場所のデフォルトを返す（6〜9月:常温 / 10〜5月:暖房）
function getSeasonalDefaultLocation(heatingDefaultTemp: number): string {
  const month = new Date().getMonth() + 1
  return (month >= 6 && month <= 9) ? '常温' : `暖房${heatingDefaultTemp}℃`
}

function downloadCSV(content: string, filename: string) {
  // BOM付きUTF-8（Excelで文字化けしないよう）
  const bom  = '﻿'
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// What-if結果の増減タグ（例：「3日 前倒し」を色付きで表示）
// 既定は日付向け：後ろ倒し（＋日）＝余裕が増える＝緑／前倒し（−日）＝注意＝赤
function DeltaTag({ days, labelLater = '後ろ倒し', labelEarlier = '前倒し', unit = '日', invertColor = false }: {
  days: number; labelLater?: string; labelEarlier?: string; unit?: string; invertColor?: boolean
}) {
  if (days === 0) return <span className="ml-1 text-muted-foreground">（変化なし）</span>
  const later = days > 0
  const good  = invertColor ? !later : later
  return (
    <span className={`ml-1 font-medium ${good ? 'text-emerald-600' : 'text-rose-600'}`}>
      （{Math.abs(days)} {unit} {later ? labelLater : labelEarlier}）
    </span>
  )
}

// What-if用の小型ステッパー（[−] 値 [＋]）
function WhatIfStepper({ value, onChange, step, min, max, signed, suffix }: {
  value: number; onChange: (v: number) => void
  step: number; min: number; max: number; signed?: boolean; suffix: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const disp  = signed && value > 0 ? `+${value}` : String(value)
  return (
    <span className="inline-flex items-center rounded border bg-white">
      <button type="button" aria-label="減らす"
        className="px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}>−</button>
      <span className="min-w-[3rem] text-center tabular-nums font-semibold text-foreground">{disp}{suffix}</span>
      <button type="button" aria-label="増やす"
        className="px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}>＋</button>
    </span>
  )
}

export default function BrewSuggestions({ recipes, shipmentMap, heatingDefaultTemp, coolingDefaultTemp, fridgeTemp, q10Value, brewBufferDays, weatherAvg, fermentingByType, apiStockByType, sarimaxForecast, sarimaxMape, autoMethodByType, fermentingScheduleByType, existingBrewPlanKeys, initialManualBrewDates, registeredPlansByType, registeredDoneDatesByType }: Props) {
  const [stocks,          setStocks]         = useState<Record<string, string>>({})
  const [locations,       setLocations]      = useState<Record<string, string>>(() => {
    const seasonal = getSeasonalDefaultLocation(heatingDefaultTemp)
    return Object.fromEntries(recipes.map(r => [r.name, seasonal]))
  })
  const [maxBatches,      setMaxBatches]     = useState<number>(1)
  const [perRecipeBatches, setPerRecipeBatches] = useState<Record<string, number>>({})
  const [openBasis,       setOpenBasis]      = useState<Record<string, boolean>>({})
  const [forecastMethod,  setForecastMethod] = useState<'hw' | 'avg' | 'sarimax'>(
    () => sarimaxForecast && Object.keys(sarimaxForecast).length > 0 ? 'sarimax' : 'hw'
  )
  const [bufferEnabled,   setBufferEnabled]  = useState(true)
  const [snapEnabled,     setSnapEnabled]    = useState(true)
  const [optimisticStock, setOptimisticStock] = useState(false)  // true=楽観的（熟成中を即時在庫）
  const [conservativeDemand, setConservativeDemand] = useState(false)  // true=保守的（SARIMAX upper90で需要多め）
  const [autoMethod,         setAutoMethod]         = useState(false)  // true=品種ごとにバックテスト最良方式を自動採用
  const [hoveredKey,      setHoveredKey]     = useState<string | null>(null)
  const [calendarOffsets, setCalendarOffsets] = useState<Record<string, number>>({})
  const [useRawAsBase,    setUseRawAsBase]    = useState(false)
  // キーは manualDateKey(品種名, 回のインデックス0始まり) の形式
  const [manualBrewDates, setManualBrewDates] = useState<Record<string, string>>({})
  const [editingPlan,     setEditingPlan]     = useState<{ name: string; genIndex: number } | null>(null)
  const [editDateValue,   setEditDateValue]   = useState<string>('')
  // 予定出荷（大口）: 品種ごとの { 出荷予定日, kg } リスト（localStorage永続）
  const [scheduledOrders, setScheduledOrders] = useState<Record<string, { date: string; kg: number }[]>>({})
  // 追加フォームの入力中ドラフト（品種ごと）
  const [orderDraft,      setOrderDraft]      = useState<Record<string, { date: string; kg: string }>>({})
  // ② What-if（もしもの試算）: 品種ごとのパネル開閉と調整値
  const [whatIfOpen,  setWhatIfOpen]  = useState<Record<string, boolean>>({})
  const [whatIfPct,   setWhatIfPct]   = useState<Record<string, number>>({})  // 需要変動%（デフォルト+20）
  const [whatIfDelay, setWhatIfDelay] = useState<Record<string, number>>({})  // 仕込み遅延日数（デフォルト7）
  const [whatIfTemp,  setWhatIfTemp]  = useState<Record<string, number>>({})  // 気温差℃（デフォルト-2・常温のみ）
  const cancelEditRef = useRef(false)
  const locationInitializedRef = useRef(false)
  const [savedKeys,  setSavedKeys]  = useState<Set<string>>(
    () => new Set(existingBrewPlanKeys ?? [])
  )
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const today        = new Date()
  const currentMonth = today.getMonth() + 1
  const currentYear  = today.getFullYear()

  const locationOptions = [
    `暖房${heatingDefaultTemp}℃`,
    `冷房${coolingDefaultTemp}℃`,
    '常温',
    '冷蔵庫',
  ]
  const weatherAvgValues = Object.values(weatherAvg ?? {})

  useEffect(() => {
    locationInitializedRef.current = false
    const savedStocks:       Record<string, string> = {}
    const savedLocations:    Record<string, string> = {}
    const savedManualDates:  Record<string, string> = {}
    const savedOrders:       Record<string, { date: string; kg: number }[]> = {}
    for (const r of recipes) {
      savedStocks[r.name]  = localStorage.getItem(`planning_stock_${r.name}`) ?? ''
      const stored   = localStorage.getItem(`planning_location_${r.name}`)
      const seasonal = getSeasonalDefaultLocation(heatingDefaultTemp)
      savedLocations[r.name] = stored && locationOptions.includes(stored) ? stored : seasonal
      // 本登録済み（ロット化済み）と同じ日付の手動調整ピンは実現済みなので自動解除する。
      // これがないと本登録後もその回が古い日付に固定表示され続ける。
      const doneDates = registeredDoneDatesByType?.[r.name] ?? []
      // 回ごと（最大5回分・0始まり）の手動固定を読み込む。1回目のみ後方互換でinitialManualBrewDatesも見る
      for (let idx = 0; idx < 5; idx++) {
        const key        = manualDateKey(r.name, idx)
        const storedDate = localStorage.getItem(`planning_manualDate_${key}`)
          ?? (idx === 0 ? initialManualBrewDates?.[r.name] : undefined)
        if (storedDate && doneDates.includes(storedDate)) {
          localStorage.removeItem(`planning_manualDate_${key}`)
        } else if (storedDate) {
          savedManualDates[key] = storedDate
        }
      }
      const rawOrders = localStorage.getItem(`planning_scheduledOrders_${r.name}`)
      if (rawOrders) {
        try {
          const arr = JSON.parse(rawOrders)
          if (Array.isArray(arr)) {
            savedOrders[r.name] = arr.filter(
              (o): o is { date: string; kg: number } =>
                o && typeof o.date === 'string' && typeof o.kg === 'number',
            )
          }
        } catch { /* 破損データは無視 */ }
      }
    }
    setStocks(savedStocks)
    setLocations(savedLocations)
    setManualBrewDates(savedManualDates)
    setScheduledOrders(savedOrders)
    setUseRawAsBase(localStorage.getItem('planning_useRawAsBase') === '1')
    setOptimisticStock(localStorage.getItem('planning_optimisticStock') === '1')
    setConservativeDemand(localStorage.getItem('planning_conservativeDemand') === '1')
    setAutoMethod(localStorage.getItem('planning_autoMethod') === '1')
  }, [recipes])

  // plans 確定後に1回だけ: 1回目仕込み日の月で場所デフォルトを補正（localStorage未保存の品種のみ）
  useEffect(() => {
    if (locationInitializedRef.current) return
    const hasAnyBatch = plans.some(p => p.canCalc && p.batches.length > 0)
    if (!hasAnyBatch) return
    locationInitializedRef.current = true
    const updates: Record<string, string> = {}
    for (const plan of plans) {
      if (!plan.canCalc || plan.batches.length === 0) continue
      if (localStorage.getItem(`planning_location_${plan.name}`)) continue
      const brewMonth = plan.batches[0].brewDate.getMonth() + 1
      const targetLoc = (brewMonth >= 6 && brewMonth <= 9) ? '常温' : `暖房${heatingDefaultTemp}℃`
      if (plan.location !== targetLoc) updates[plan.name] = targetLoc
    }
    if (Object.keys(updates).length > 0) setLocations(prev => ({ ...prev, ...updates }))
  })

  function handleStockChange(name: string, value: string) {
    setStocks(prev => ({ ...prev, [name]: value }))
    localStorage.setItem(`planning_stock_${name}`, value)
  }

  function handleLocationChange(name: string, value: string) {
    setLocations(prev => ({ ...prev, [name]: value }))
    localStorage.setItem(`planning_location_${name}`, value)
  }

  function persistOrders(name: string, list: { date: string; kg: number }[]) {
    localStorage.setItem(`planning_scheduledOrders_${name}`, JSON.stringify(list))
  }

  function handleAddOrder(name: string) {
    const d  = orderDraft[name]
    const kg = d ? parseFloat(d.kg) : NaN
    if (!d || !d.date || !Number.isFinite(kg) || kg <= 0) return
    setScheduledOrders(prev => {
      const list = [...(prev[name] ?? []), { date: d.date, kg }]
        .sort((a, b) => a.date.localeCompare(b.date))
      persistOrders(name, list)
      return { ...prev, [name]: list }
    })
    setOrderDraft(prev => ({ ...prev, [name]: { date: '', kg: '' } }))
  }

  function handleRemoveOrder(name: string, idx: number) {
    setScheduledOrders(prev => {
      const list = (prev[name] ?? []).filter((_, i) => i !== idx)
      persistOrders(name, list)
      return { ...prev, [name]: list }
    })
  }

  // 全品種のプラン計算。
  // 工程上の運用ルール（田舎→無添加の順で仕込む）を反映するため、田舎みそを先に計算する必要がある。
  // 表示順は元のrecipes順を保つので、計算だけこの並びで行い最後に元の順序へ戻す。
  const CROSS_TYPE_CALC_ORDER: Record<string, number> = { '田舎みそ': 0, '無添加麦みそ': 1 }
  const recipesForCalc = [...recipes].sort((a, b) =>
    (CROSS_TYPE_CALC_ORDER[a.name] ?? 99) - (CROSS_TYPE_CALC_ORDER[b.name] ?? 99)
  )
  let inakaBrewDates: Date[] = []  // 田舎みその確定＋新規提案の仕込み日（無添加の順序ルール判定に使う）

  const plansForCalc: RecipePlan[] = recipesForCalc.map(recipe => {
    const apiStock    = apiStockByType?.[recipe.name] ?? null
    const stockStr    = apiStock != null ? String(apiStock) : (stocks[recipe.name] ?? '')
    const stockKg     = parseFloat(stockStr) || 0
    const typeData    = shipmentMap[recipe.name] ?? {}
    const hasData     = Object.keys(typeData).length > 0

    const hwInput        = getTimeSeries(typeData)
    const hasEnoughForHW = hwInput.length >= 12
    let hwMonthlyEst: number | null = null
    if (hasEnoughForHW) {
      const hw = holtWinters(hwInput, 2)
      // 保守モードは上限値（平均+σ）を使用
      hwMonthlyEst = (conservativeDemand ? hw.upperBound[0] : hw.forecast[0]) ?? null
    }

    // SARIMAXの今月〜翌3ヶ月平均を計算（保守モードは upper90 を使用）
    const sarimaxEntry = sarimaxForecast?.[recipe.name]
    let sarimaxMonthlyEst: number | null = null
    if (sarimaxEntry && sarimaxEntry.forecast.length > 0) {
      const baseSeries = (conservativeDemand && sarimaxEntry.upper90?.length === sarimaxEntry.forecast.length)
        ? sarimaxEntry.upper90
        : sarimaxEntry.forecast
      // 翌3ヶ月または利用可能な予測全体の平均
      const sliced = baseSeries.slice(0, Math.min(3, baseSeries.length))
      const sum    = sliced.reduce((a, b) => a + b, 0)
      sarimaxMonthlyEst = sliced.length > 0 ? sum / sliced.length : null
    }

    // 予測方式に応じてmonthlyAvgを決定。
    // 自動方式選択ON時はバックテスト最良方式（autoMethodByType）を品種ごとに採用、
    // 該当なし（低精度品種など）はグローバル選択(forecastMethod)にフォールバック。
    const autoPick    = autoMethod ? autoMethodByType?.[recipe.name] : undefined
    const effMethod   = autoPick ?? forecastMethod
    const autoApplied = autoPick ?? null
    let monthlyAvg: number | null
    let usingHW      = false
    let usingSarimax = false

    if (effMethod === 'sarimax' && sarimaxMonthlyEst !== null) {
      monthlyAvg   = sarimaxMonthlyEst
      usingSarimax = true
    } else if (effMethod === 'hw' && hwMonthlyEst !== null) {
      monthlyAvg = hwMonthlyEst
      usingHW    = true
    } else {
      monthlyAvg = hasData ? avg3(typeData, currentMonth, currentYear, conservativeDemand) : null
    }

    const selectedLocation = locations[recipe.name]
      ?? (locationOptions.includes(recipe.defaultLocation) ? recipe.defaultLocation : locationOptions[0])
    const dailyAccum       = getDailyAccum(selectedLocation, fridgeTemp, weatherAvgValues, q10Value, heatingDefaultTemp)
    const fermentationDays = dailyAccum > 0
      ? Math.ceil(recipe.targetTempSum / dailyAccum)
      : 0

    // 補正なしの初期推定値（常温・q10≠1のときのみ）
    const rawDailyAccum = (selectedLocation === '常温' && q10Value !== 1)
      ? getDailyAccum(selectedLocation, fridgeTemp, weatherAvgValues, 1, heatingDefaultTemp)
      : dailyAccum
    const fermentationDaysRaw = (selectedLocation === '常温' && q10Value !== 1 && rawDailyAccum > 0)
      ? Math.ceil(recipe.targetTempSum / rawDailyAccum)
      : undefined

    const fermenting      = fermentingByType[recipe.name]
    const fermentingKg    = fermenting?.totalKg ?? 0
    const fermentingCount = fermenting?.count ?? 0

    // 熟成中ロットの補充スケジュールを構築（完成予定日 → 歩留まりkg）
    const rawSchedule    = fermentingScheduleByType?.[recipe.name] ?? []
    const allSupplyEvents = rawSchedule.map(s => ({
      date: new Date(s.completionDateStr + 'T00:00:00'),
      kg:   s.yieldKg,
    }))
    // 完成予定日が今日以前のロットは即時在庫として扱う
    const immediateKg  = allSupplyEvents.filter(e => e.date <= today).reduce((s, e) => s + e.kg, 0)
    const futureEvents = allSupplyEvents.filter(e => e.date > today)
    // 楽観的モード: 熟成中ロットを全量即時在庫として扱う（完成予定日を無視）
    // 悲観的モード: 完成予定日に補充されるスケジュールとして管理
    const effectiveStock = optimisticStock
      ? stockKg + fermentingKg
      : stockKg + immediateKg
    // 予定出荷（大口）を負の補充イベントとして合流。
    // 未来分のみ反映（過去の予定は現在庫に既に織り込まれている前提で二重計上を避ける）。
    const futureOrderEvents = (scheduledOrders[recipe.name] ?? [])
      .map(o => ({ date: new Date(o.date + 'T00:00:00'), kg: -o.kg }))
      .filter(e => e.date > today)
    // 仮登録済み（確定）の仕込み予定：完成日に生産量(totalWeightKg)が入る供給として算入し、
    // 確定行としても表示する。本登録済（ロット化済み）は熟成中ロットで算入済みのため対象外（page.tsx側で除外）。
    const regPlans = (registeredPlansByType?.[recipe.name] ?? [])
      .map(p => ({
        brewDate:              new Date(p.brewDateStr + 'T00:00:00'),
        completionDate:        new Date(p.completionDateStr + 'T00:00:00'),
        materialOrderDeadline: new Date(p.materialOrderDeadlineStr + 'T00:00:00'),
        fermentationDays:      p.fermentationDays,
        bucketNumbers:         p.bucketNumbers ?? null,
      }))
      .filter(p => p.completionDate > today)
      .sort((a, b) => a.brewDate.getTime() - b.brewDate.getTime())
    const registeredSupplyEvents = regPlans.map(p => ({ date: p.completionDate, kg: recipe.totalWeightKg }))
    // 在庫推移グラフ用：補充ジャンプ地点の桶番号ラベル（同日・同種は結合。種別で色分け）。
    // 熟成中ロットは悲観モードのみ（楽観モードは即時在庫扱いでジャンプが無い）、
    // 仮登録の完成分は常に供給算入されるためモードに関わらず表示する
    const supplyMarkers: { d: string; label: string; kind: 'fermenting' | 'registered' }[] = (() => {
      const collect = (entries: { d: string; label: string }[], kind: 'fermenting' | 'registered') => {
        const byDay = new Map<string, string[]>()
        for (const e of entries) byDay.set(e.d, [...(byDay.get(e.d) ?? []), e.label])
        return [...byDay.entries()].map(([d, labels]) => ({ d, label: labels.join(' / '), kind }))
      }
      const todayStr = format(today, 'yyyy-MM-dd')
      const fermenting = optimisticStock ? [] : rawSchedule
        .filter(s => s.label && s.completionDateStr > todayStr)
        .map(s => ({ d: s.completionDateStr, label: s.label! }))
      const registered = regPlans
        .filter(p => p.bucketNumbers)
        .map(p => ({ d: format(p.completionDate, 'yyyy-MM-dd'), label: `桶${p.bucketNumbers}` }))
      return [...collect(fermenting, 'fermenting'), ...collect(registered, 'registered')]
    })()
    // 熟成中ロット補充＋仮登録の確定生産（予定出荷を除く供給）
    const baseSupplyEvents = [...(optimisticStock ? [] : futureEvents), ...registeredSupplyEvents]
    const combinedEvents   = [...baseSupplyEvents, ...futureOrderEvents]
    const activeSupplyEvents = combinedEvents.length > 0 ? combinedEvents : undefined

    // 安全在庫ライン（熟成済バラ在庫）が設定されている品種は、在庫切れ判定・仕込み提案の
    // 起点をライン到達時点にシフトする（実在庫からラインを引いた「実質使える在庫」で計算し、
    // 0を切ったタイミング＝ライン到達日として扱う）。表示用のeffectiveStockは実数のまま。
    const safetyStockKg   = recipe.safetyStockKg ?? null
    const depletableStock = safetyStockKg != null ? effectiveStock - safetyStockKg : effectiveStock

    const canCalc   = monthlyAvg !== null && monthlyAvg > 0 && fermentationDays > 0
    const daysInMonth = getDaysInMonth(today)
    const dailyRate   = canCalc ? (monthlyAvg! / daysInMonth) : 0
    // 月別消費量関数: 予測方式に応じて将来各月の実際の予測値を使用（夏低・冬高を反映）
    const getDailyRateFn = canCalc
      ? buildDailyRateFn(effMethod, typeData, sarimaxEntry, hwInput, dailyRate, conservativeDemand)
      : () => 0

    const orderLeadDays = ORDER_LEAD_DAYS[recipe.name] ?? DEFAULT_ORDER_LEAD_DAYS

    // 常温：仕込み日から気象データを日ごとに積み上げて完成日を推計
    const weatherFallback = weatherAvgValues.length > 0
      ? weatherAvgValues.reduce((a, b) => a + b, 0) / weatherAvgValues.length
      : 14
    // 常温→暖房の季節切り替えレート（6〜9月:常温, 10〜5月:暖房heatingDefaultTemp℃）
    const outdoorToIndoorRate = selectedLocation === '常温'
      ? Math.max(heatingDefaultTemp - 10, 0)
      : undefined

    const getCompletion = selectedLocation === '常温'
      ? (brewDate: Date) => simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg ?? {}, weatherFallback, q10Value, heatingDefaultTemp, outdoorToIndoorRate)
      : undefined

    // 補正なし完成日（q10≠1のときのみ生成）
    const getCompletionRaw = (selectedLocation === '常温' && q10Value !== 1)
      ? (brewDate: Date) => simulateFermentationDays(brewDate, recipe.targetTempSum, weatherAvg ?? {}, weatherFallback, 1, heatingDefaultTemp, outdoorToIndoorRate)
      : undefined

    const bufferDays    = bufferEnabled ? brewBufferDays : 0
    const snapFn        = snapEnabled ? snapToBrewDay : undefined
    const recipeBatches = perRecipeBatches[recipe.name] ?? maxBatches
    // 仮登録（確定）と同じ日付の集合。手動固定や新規提案がこれと重複しないようにする
    const regDateSet    = new Set(regPlans.map(p => format(p.brewDate, 'yyyy-MM-dd')))
    // 手動固定（回ごと・0始まり）。確定行と同じ日付なら無効化（確定供給で算入済み＝二重計上・行重複を防ぐ）
    const manualBrewDateRaw: Record<number, Date> = {}
    for (let idx = 0; idx < recipeBatches; idx++) {
      const dateStr = manualBrewDates[manualDateKey(recipe.name, idx)]
      if (dateStr && !regDateSet.has(dateStr)) {
        manualBrewDateRaw[idx] = new Date(dateStr + 'T00:00:00')
      }
    }

    // 1回目推奨仕込み日・在庫切れ日を、補充スケジュールを与えて計算する内部ヘルパー。
    // 予定出荷あり／なしを同一ロジックで出し、効果を比較できるようにする。
    // 常温ではQ10シミュレーションで実際の熟成日数を使い再計算する（冬〜春に当たると
    // 静的推定の数倍になり refined=stockOut-actual-buffer が過去へ大きくズレるため）。
    const computeIdeal = (
      supplyEvents: { date: Date; kg: number }[] | undefined,
    ): { stockOut: Date | null; ideal: Date | null } => {
      if (!canCalc) return { stockOut: null, ideal: null }
      const so = findStockOutDate(depletableStock, today, getDailyRateFn, supplyEvents)
      // calcBatches と同じ不動点反復で1回目推奨日を求める（単発補正だと前倒し過ぎてバナーが誤って超過表示になる）
      let ideal: Date
      if (getCompletion) {
        ideal = refineBrewDateToStockOut(so, fermentationDays, bufferDays, getCompletion, snapFn)
      } else {
        const pre = addDays(so, -(fermentationDays + bufferDays))
        ideal = snapEnabled ? snapToBrewDay(pre) : pre
      }
      return { stockOut: so, ideal }
    }

    const withOrders     = computeIdeal(activeSupplyEvents)
    const stockOutDate0  = withOrders.stockOut
    const idealBrewDate0 = withOrders.ideal
    // 当日はもう仕込めないため、推奨日が「今日以前」なら超過扱いにする
    const isBrewDatePast = !!idealBrewDate0 && idealBrewDate0 <= today
    const overdueDays    = isBrewDatePast && idealBrewDate0 ? differenceInDays(today, idealBrewDate0) : 0
    const stockOutInDays = stockOutDate0 ? differenceInDays(stockOutDate0, today) : null

    // 予定出荷の反映効果の見出し用（予定出荷なしの在庫切れ日・1回目理想日を同一ロジックで算出）
    const hasOrders     = futureOrderEvents.length > 0
    const noOrderSupply = baseSupplyEvents.length > 0 ? baseSupplyEvents : undefined
    const noOrders      = hasOrders ? computeIdeal(noOrderSupply) : null

    // 1回目に手動調整がない場合のみ自動補正（当週はもう仕込めないため翌週で最も早い仕込み可能日）
    const nextWeekStart       = nextWeekMonday(today)
    const autoCorrectDate     = (isBrewDatePast && manualBrewDateRaw[0] === undefined)
      ? (snapEnabled ? snapToBrewDay(nextWeekStart) : nextWeekStart)
      : undefined
    const manualBrewDateByIndex: Record<number, Date> = { ...manualBrewDateRaw }
    if (autoCorrectDate) manualBrewDateByIndex[0] = autoCorrectDate

    // 新規提案バッチ（仮登録の確定生産を供給算入した上で、足りない分を生成）
    let generated = canCalc
      ? calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents)
      : []

    // 工程上の運用ルール：無添加が田舎と同じ週で同日以前になっていたら、田舎の翌仕込み可能日へ自動でずらして再計算
    if (canCalc && recipe.name === '無添加麦みそ' && inakaBrewDates.length > 0) {
      const orderingOverrides = buildOrderingOverrides(generated, inakaBrewDates, snapFn)
      if (Object.keys(orderingOverrides).length > 0) {
        Object.assign(manualBrewDateByIndex, orderingOverrides)
        generated = calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents)
      }
    }

    // 仮登録の確定行（BatchPlan形）
    const fixedRows: BatchPlan[] = regPlans.map(p => ({
      n:                     0,
      brewDate:              p.brewDate,
      completionDate:        p.completionDate,
      fermentationDays:      p.fermentationDays,
      stockOutDate:          p.completionDate,
      materialOrderDeadline: p.materialOrderDeadline,
      daysUntilOrder:        differenceInDays(p.materialOrderDeadline, today),
      startStockKg:          0,
      isFixed:               true,
    }))

    // 田舎みその仕込み日（確定＋新規提案）を記録し、後続の無添加の順序判定に使う
    if (recipe.name === '田舎みそ') {
      inakaBrewDates = [...fixedRows.map(f => f.brewDate), ...generated.map(b => b.brewDate)]
    }

    // 表示は「確定行（常に表示）＋新規提案（表示回数で打ち切り）」を仕込み日順に並べる。
    // 表示回数は新規提案にのみ効かせる（確定行が枠を食って実提案が消えるのを防ぐ。
    // 例：表示1回で確定行があると、本当の次提案が打ち切られ最優先判定から漏れていた）。
    // 確定行と同じ日付の新規提案は重複なので除外（安全網）。
    const generatedDeduped = generated.filter(b => !regDateSet.has(format(b.brewDate, 'yyyy-MM-dd')))
    const shownGenerated   = generatedDeduped.slice(0, recipeBatches)
    const batches = canCalc
      ? [...fixedRows, ...shownGenerated]
          .sort((a, b) => a.brewDate.getTime() - b.brewDate.getTime())
          .map((b, i) => ({ ...b, n: i + 1 }))
      : []

    // 予定出荷の反映効果：予定出荷なしの新規提案を同一条件で別途算出し、各回を before→after で比較。
    // 1回目の起点は手動指定のみ引き継ぐ（予定出荷由来の自動補正は渡さない＝1回目の真の前倒しも見えるように）。
    const generatedNoOrders = (canCalc && hasOrders)
      ? calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateRaw, noOrderSupply)
        .filter(b => !regDateSet.has(format(b.brewDate, 'yyyy-MM-dd')))
      : null
    const shownGenCount = batches.filter(b => !b.isFixed).length
    const orderImpact = (hasOrders && noOrders && noOrders.ideal && noOrders.stockOut && idealBrewDate0 && stockOutDate0)
      ? {
          orderCount:     futureOrderEvents.length,
          orderKg:        futureOrderEvents.reduce((s, e) => s - e.kg, 0),  // kgは負で保持しているため反転
          stockOutBefore: noOrders.stockOut,
          stockOutAfter:  stockOutDate0,
          // 表示中の新規提案分のみ比較（同インデックス＝同じ新規回。前倒し日数付き）
          perBatch: generatedNoOrders
            ? generatedDeduped.slice(0, shownGenCount).map((b, i) => {
                const before = generatedNoOrders[i]?.brewDate ?? b.brewDate
                return { n: i + 1, before, after: b.brewDate, deltaDays: differenceInDays(before, b.brewDate) }
              })
            : [],
        }
      : null

    // ── ② What-if（もしもの試算・全回分）─────────────────────
    // 調整値は品種別state。ここで再計算してカードに渡す（stateが変わると再描画＝即時反映）。
    // 表示中の新規提案バッチを起点に、各回ごとに試算する。
    const wifPct   = whatIfPct[recipe.name]   ?? 20
    const wifDelay = whatIfDelay[recipe.name] ?? 7
    const wifTemp  = whatIfTemp[recipe.name]  ?? -2
    const shownNew = generatedDeduped.slice(0, shownGenCount)  // 表示中の新規提案バッチ

    // (1) 需要が ±X% 変わったら → 在庫切れ日と各回の仕込み日の動き
    let demandStockOut: NonNullable<RecipePlan['whatIf']>['demandStockOut'] = null
    let demandBatches:  NonNullable<RecipePlan['whatIf']>['demand'] = []
    if (canCalc && stockOutDate0) {
      const factor   = 1 + wifPct / 100
      const scaledFn = (d: Date) => getDailyRateFn(d) * factor
      const so       = findStockOutDate(depletableStock, today, scaledFn, activeSupplyEvents)
      demandStockOut = { newStockOut: so, delta: differenceInDays(so, stockOutDate0) }
      // スケール済みレートで全回再計算し、表示中の各回と同インデックスで比較
      const scaledGen = calcBatches(depletableStock, scaledFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents)
        .filter(b => !regDateSet.has(format(b.brewDate, 'yyyy-MM-dd')))
      demandBatches = shownNew.map((b, i) => {
        const after = scaledGen[i]?.brewDate ?? b.brewDate
        return { n: i + 1, newBrew: after, deltaDays: differenceInDays(after, b.brewDate) }
      })
    }

    // (2) 仕込みが N日遅れたら → 各回がその回の在庫切れ日に間に合うか
    const delayBatches: NonNullable<RecipePlan['whatIf']>['delay'] = canCalc
      ? shownNew.map((b, i) => {
          const delayed = addDays(b.brewDate, wifDelay)
          const comp    = getCompletion ? getCompletion(delayed).completionDate : addDays(delayed, b.fermentationDays)
          const margin  = differenceInDays(b.stockOutDate, comp)
          return { n: i + 1, newCompletion: comp, fits: margin >= 0, marginDays: margin }
        })
      : []

    // (3) 気温が ±X℃ 違ったら（常温のみ）→ 各回の熟成日数・完成日の動き
    let tempBatches: NonNullable<RecipePlan['whatIf']>['temp'] = []
    if (canCalc && selectedLocation === '常温') {
      const adjWeather: Record<string, number> = {}
      for (const k in (weatherAvg ?? {})) adjWeather[k] = Math.max((weatherAvg ?? {})[k] + wifTemp, 0)
      const adjFallback = Math.max(weatherFallback + wifTemp, 0)
      tempBatches = shownNew.map((b, i) => {
        const adjR = simulateFermentationDays(b.brewDate, recipe.targetTempSum, adjWeather, adjFallback, q10Value, heatingDefaultTemp, outdoorToIndoorRate)
        return { n: i + 1, newDays: adjR.days, dayDelta: adjR.days - b.fermentationDays, newCompletion: adjR.completionDate }
      })
    }

    const whatIf: RecipePlan['whatIf'] = canCalc
      ? { demandPct: wifPct, demandStockOut, demand: demandBatches, delayDays: wifDelay, delay: delayBatches, tempDelta: wifTemp, temp: tempBatches }
      : null

    // ── 在庫推移グラフ用の日次系列（計算の根拠の可視化） ─────────────
    // findStockOutDate と同じ歩き方（供給を加えてから消費を引く）で、
    // 新規提案バッチの完成補充も供給に加えて最終バッチの在庫切れ日過ぎまで在庫残量を出す。
    // 縦線マーカーと整合するようQ10補正あり（メイン）チェーンの完成日を使う。
    const stockPoints: StockPoint[] | null = (() => {
      if (!canCalc || batches.length === 0) return null
      const endTime = Math.max(...batches.map(b => (b.isFixed ? b.completionDate : b.stockOutDate).getTime()))
      const horizon = Math.min(differenceInDays(new Date(endTime), today) + 8, 550)
      if (horizon <= 1) return null
      const events = new Map<string, number>()
      for (const ev of activeSupplyEvents ?? []) {
        const k = format(ev.date, 'yyyy-MM-dd')
        events.set(k, (events.get(k) ?? 0) + ev.kg)
      }
      for (const b of batches) {
        if (b.isFixed) continue  // 確定行（仮登録）の完成分は activeSupplyEvents に算入済み
        const k = format(b.completionDate, 'yyyy-MM-dd')
        events.set(k, (events.get(k) ?? 0) + recipe.totalWeightKg)
      }
      let stock = effectiveStock
      const daily: StockPoint[] = []
      let d = today
      for (let i = 0; i <= horizon; i++) {
        const k = format(d, 'yyyy-MM-dd')
        stock += events.get(k) ?? 0
        stock -= getDailyRateFn(d)
        if (stock < 0) stock = 0
        daily.push({ d: k, kg: Math.round(stock) })
        d = addDays(d, 1)
      }
      // 描画点を間引く（補充ジャンプの前後の点は形が崩れないよう必ず残す）
      const step = Math.max(1, Math.ceil(daily.length / 180))
      if (step === 1) return daily
      return daily.filter((p, i) =>
        i % step === 0 || i === daily.length - 1 ||
        events.has(p.d) || (i + 1 < daily.length && events.has(daily[i + 1].d)))
    })()

    return {
      name: recipe.name,
      monthlyAvg, usingHW, usingSarimax, autoApplied, fermentationDays,
      effectiveStock, stockKg, fermentingKg, fermentingCount, safetyStockKg,
      dailyRate, dailyAccum, location: selectedLocation, orderLeadDays,
      batches, hasData, canCalc,
      isBrewDatePast, overdueDays, manualPinIndices: Object.keys(manualBrewDateRaw).map(Number),
      idealBrewDate0, stockOutInDays, orderImpact, whatIf, stockPoints, supplyMarkers,
    }
  })

  // 表示順は元のrecipes順に戻す（計算は田舎→無添加の順で行ったが、カード表示順は変えない）
  const plans: RecipePlan[] = recipes.map(r => plansForCalc.find(p => p.name === r.name)!)

  // ③ 今週やるべきこと（最優先品種）: 全品種を横断し、最も急ぐ1件を先頭に提示。
  // 過去超過を最優先（超過日数が大きいほど上位）、次に手配締切までの日数が短い順。
  const topPriority = (() => {
    type Cand = {
      plan: RecipePlan; firstNew: BatchPlan; brewDate: Date
      deadline: Date | null; daysUntilOrder: number; sortKey: number
    }
    const cands: Cand[] = []
    for (const plan of plans) {
      if (!plan.canCalc) continue
      const firstNew = plan.batches.find(b => !b.isFixed)
      if (!firstNew) continue
      const deadline = (useRawAsBase && firstNew.rawMaterialOrderDeadline)
        ? firstNew.rawMaterialOrderDeadline : firstNew.materialOrderDeadline
      const brewDate = (useRawAsBase && firstNew.rawBrewDate) ? firstNew.rawBrewDate : firstNew.brewDate
      const daysUntilOrder = deadline ? differenceInDays(deadline, today) : Infinity
      // 超過品種は非常に小さいキー（超過が大きいほど上位）、それ以外は締切までの日数
      const sortKey = plan.isBrewDatePast ? -100000 - plan.overdueDays : daysUntilOrder
      cands.push({ plan, firstNew, brewDate, deadline, daysUntilOrder, sortKey })
    }
    if (cands.length === 0) return null
    cands.sort((a, b) => a.sortKey - b.sortKey)
    const top = cands[0]
    // 急ぎの基準：超過中 or 手配締切30日以内のときだけ「最優先」として強調表示
    const isUrgent = top.plan.isBrewDatePast || top.daysUntilOrder <= 30
    return { ...top, isUrgent }
  })()

  function handleCSV() {
    const csv      = generateCSV(plans, maxBatches, today)
    const filename = `仕込み計画_${format(today, 'yyyyMMdd')}.csv`
    downloadCSV(csv, filename)
  }

  function handlePrint() {
    window.print()
  }

  return (
    <section>
      {/* セクション見出し＋操作ボタン（スクロール追従） */}
      <div className="sticky top-14 z-20 bg-white/95 backdrop-blur-sm -mx-3 sm:-mx-4 px-3 sm:px-4 py-2 mb-2 border-b border-gray-100">
        <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4">
          <h2 className="text-base font-semibold">③ AI仕込み提案</h2>
          {/* 印刷時の出力日 */}
          <span className="print-only text-sm text-muted-foreground">
            出力日：{format(today, 'yyyy年M月d日')}
          </span>
        </div>
        <div className="flex items-center gap-3 no-print flex-wrap">
          {/* 仕込み曜日 */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">仕込み曜日：</span>
            <button
              type="button"
              onClick={() => setSnapEnabled(v => !v)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                snapEnabled
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {snapEnabled ? '水・木のみ' : '制限なし'}
            </button>
          </div>
          {/* 熟成中在庫モード切り替え（熟成中ロットがある場合のみ表示） */}
          {Object.keys(fermentingByType).length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">熟成中在庫：</span>
              {([false, true] as const).map(isOpt => (
                <button
                  key={String(isOpt)}
                  type="button"
                  onClick={() => {
                    setOptimisticStock(isOpt)
                    localStorage.setItem('planning_optimisticStock', isOpt ? '1' : '0')
                  }}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    optimisticStock === isOpt
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {isOpt ? '楽観的' : '悲観的'}
                </button>
              ))}
            </div>
          )}
          {/* バッファ切り替え */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">バッファ：</span>
            <button
              type="button"
              onClick={() => setBufferEnabled(v => !v)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                bufferEnabled
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {bufferEnabled ? `あり（${brewBufferDays}日）` : 'なし'}
            </button>
          </div>
          {/* 基準切り替え（常温・Q10補正ありのときのみ表示） */}
          {q10Value !== 1 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">基準：</span>
              {([false, true] as const).map(isRaw => (
                <button
                  key={String(isRaw)}
                  type="button"
                  onClick={() => {
                    setUseRawAsBase(isRaw)
                    localStorage.setItem('planning_useRawAsBase', isRaw ? '1' : '0')
                  }}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    useRawAsBase === isRaw
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {isRaw ? '補正なし' : 'Q10補正あり'}
                </button>
              ))}
            </div>
          )}
          {/* 予測方式切り替え */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">予測方式：</span>
            {(['hw', 'avg', 'sarimax'] as const).map(m => {
              // SARIMAXはキャッシュがある場合のみ表示
              if (m === 'sarimax' && (!sarimaxForecast || Object.keys(sarimaxForecast).length === 0)) {
                return null
              }
              const label = m === 'hw' ? 'AI予測' : m === 'avg' ? '3年平均' : 'SARIMAX'
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setForecastMethod(m)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    forecastMethod === m
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {/* 品種別の自動方式選択（バックテストで信頼できるベストがある品種が1つ以上あるとき） */}
          {autoMethodByType && Object.keys(autoMethodByType).length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">品種別最適化：</span>
              {([false, true] as const).map(on => (
                <button
                  key={String(on)}
                  type="button"
                  onClick={() => {
                    setAutoMethod(on)
                    localStorage.setItem('planning_autoMethod', on ? '1' : '0')
                  }}
                  title={on
                    ? 'バックテストで最も的中した方式を品種ごとに自動採用（精度が低い品種は手動選択のまま）'
                    : '全品種で上の「予測方式」を使用'}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    autoMethod === on
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {on ? '自動（実績ベスト）' : '手動'}
                </button>
              ))}
            </div>
          )}
          {/* 需要見積り切り替え（全方式で有効：SARIMAX→upper90 / HW→上限 / 3年平均→平均+σ） */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">需要見積り：</span>
            {([false, true] as const).map(isCons => (
              <button
                key={String(isCons)}
                type="button"
                onClick={() => {
                  setConservativeDemand(isCons)
                  localStorage.setItem('planning_conservativeDemand', isCons ? '1' : '0')
                }}
                title={isCons
                  ? '需要を多めに見て安全側に計算（SARIMAX:90%上限 / AI予測:上限 / 3年平均:平均+ばらつき）'
                  : '中央値（標準的な需要見込み）で計算'}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  conservativeDemand === isCons
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {isCons ? '保守的' : '標準'}
              </button>
            ))}
          </div>
          {/* 回数切り替え（一括） */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">表示回数（一括）：</span>
            {BATCH_OPTIONS.map(n => (
              <button
                key={n}
                type="button"
                onClick={() => { setMaxBatches(n); setPerRecipeBatches({}) }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  maxBatches === n && Object.keys(perRecipeBatches).length === 0
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {n}回分
              </button>
            ))}
          </div>
          {/* 計算の根拠 一括開閉 */}
          {(() => {
            const allOpen = plans.length > 0 && plans.every(p => openBasis[p.name])
            return (
              <button
                type="button"
                onClick={() => {
                  const next = !allOpen
                  setOpenBasis(Object.fromEntries(plans.map(p => [p.name, next])))
                }}
                className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${allOpen ? '' : '-rotate-90'}`} />
                計算の根拠 {allOpen ? '全閉' : '全開'}
              </button>
            )
          })()}
          {/* 出力ボタン */}
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={handleCSV} className="text-xs h-7 gap-1.5">
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
            <Button variant="outline" size="sm" onClick={handlePrint} className="text-xs h-7 gap-1.5">
              <Printer className="h-3.5 w-3.5" />
              印刷
            </Button>
          </div>
        </div>
        </div>
      </div>

      {/* ③ 今週やるべきこと（最優先品種） */}
      {topPriority && (() => {
        const { plan, brewDate, deadline, daysUntilOrder, isUrgent } = topPriority
        const daysToBrew    = Math.max(differenceInDays(brewDate, today), 0)
        const deadlineRel   =
          daysUntilOrder < 0  ? `${-daysUntilOrder}日 超過` :
          daysUntilOrder === 0 ? '本日まで' :
          daysUntilOrder === 1 ? '明日' : `あと ${daysUntilOrder} 日`
        const typeBadge = (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold" style={getMisoTypeBadgeStyle(plan.name)}>
            {plan.name}
          </span>
        )
        if (!isUrgent) {
          return (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900">
              <span>✅</span>
              <span>今すぐ手配が必要な品種はありません。</span>
              <span className="text-emerald-800/80">直近の候補は</span>
              {typeBadge}
              <span className="text-emerald-800/80">（手配締切 {deadline ? format(deadline, 'M/d') : '—'}・{deadlineRel}）</span>
            </div>
          )
        }
        const tone = plan.isBrewDatePast || daysUntilOrder <= 14
          ? 'border-red-300 bg-red-50 text-red-800'
          : 'border-amber-300 bg-amber-50 text-amber-800'
        return (
          <div className={`mb-4 rounded-lg border px-4 py-3 ${tone}`}>
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <span className="text-base">⚠️</span>
              <span>最優先：</span>
              {typeBadge}
              {plan.isBrewDatePast ? (
                <span>
                  推奨仕込み日を {plan.overdueDays} 日超過。できるだけ早く仕込んでください
                  {plan.stockOutInDays != null && (
                    <span className="font-normal">（在庫切れまであと約 {Math.max(plan.stockOutInDays, 0)} 日）</span>
                  )}
                </span>
              ) : daysUntilOrder <= 14 ? (
                // 手配締切が差し迫っているときは、それを先頭に出す（仕込み日が先でも今動くべきは手配）
                <span>
                  原料手配の締切が {deadline ? format(deadline, 'M/d') : '—'}（{deadlineRel}）に迫っています。
                  <span className="font-normal"> 推奨仕込み日は {format(brewDate, 'M/d')}（あと {daysToBrew} 日）。</span>
                </span>
              ) : (
                <span>
                  推奨仕込み日まであと {daysToBrew} 日（{format(brewDate, 'M/d')}）。
                  <span className="font-normal"> 原料手配の締切は {deadline ? format(deadline, 'M/d') : '—'}（{deadlineRel}）です。</span>
                </span>
              )}
            </div>
          </div>
        )
      })()}

      <div className="grid grid-cols-1 gap-4">
        {plans.map(plan => {
          const apiStock    = apiStockByType?.[plan.name] ?? null
          const isAutoFetch = apiStock != null
          const stockStr    = isAutoFetch ? String(apiStock) : (stocks[plan.name] ?? '')
          const first       = plan.batches[0] ?? null
          // 手配の緊急度は「最初の新規提案」基準（確定行は手配済み前提なので除外）
          const firstNew    = plan.batches.find(b => !b.isFixed) ?? null
          // 新規提案のみの並び（確定行を除く）。手動調整は回ごとにこのインデックスをキーにする
          const genBatches  = plan.batches.filter(b => !b.isFixed)

          const firstPrimaryDeadline = firstNew
            ? ((useRawAsBase && firstNew.rawMaterialOrderDeadline) ? firstNew.rawMaterialOrderDeadline : firstNew.materialOrderDeadline)
            : null
          const firstDaysUntilOrder = firstPrimaryDeadline ? differenceInDays(firstPrimaryDeadline, today) : Infinity
          const urgencyBadge =
            firstDaysUntilOrder <= 14
              ? { label: `要手配 あと${firstDaysUntilOrder}日`, cls: 'bg-rose-100 text-rose-700 border border-rose-300' }
              : firstDaysUntilOrder <= 30
              ? { label: `要手配 あと${firstDaysUntilOrder}日`, cls: 'bg-amber-100 text-amber-700 border border-amber-300' }
              : null

          // 予測信頼度バッジ（SARIMAX選択時のみ・MAPE=予測誤差率）
          const mape      = sarimaxMape?.[plan.name]
          const mapeBadge = (plan.usingSarimax && mape != null)
            ? {
                label: `予測誤差 ±${Math.round(mape)}%`,
                cls: mape <= 15
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : mape <= 30
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-gray-100 text-gray-500 border border-gray-300',
                title: mape <= 15
                  ? '直近の予測精度は高め。提案日の信頼度は比較的高い'
                  : mape <= 30
                  ? '直近の予測には中程度のブレあり。提案日は幅をもって判断'
                  : '直近の予測誤差が大きい。提案日は目安程度に',
              }
            : null

          // ① 根拠の自然文サマリー（数値→助言の文章化・追加コストなし）
          const summary: { tone: 'urgent' | 'soon' | 'ok'; text: string } | null = (() => {
            if (!plan.hasData || !plan.canCalc || !firstNew) return null
            const primaryBrew = (useRawAsBase && firstNew.rawBrewDate) ? firstNew.rawBrewDate : firstNew.brewDate
            const ferment     = (useRawAsBase && firstNew.rawFermentationDays !== undefined)
              ? firstNew.rawFermentationDays : firstNew.fermentationDays
            const stockKgTxt  = Math.round(plan.effectiveStock).toLocaleString()
            const rateTxt     = Math.round(plan.dailyRate).toLocaleString()
            const fmtKg       = Math.round(plan.fermentingKg).toLocaleString()
            // 熟成中ロットの扱いを明示（楽観的=在庫に算入済み／悲観的=完成予定日に順次補充）
            const stockClause = (plan.fermentingCount > 0 && optimisticStock)
              ? `（うち熟成中ロット ${fmtKg} kg を算入）` : ''
            const fermentLead = (plan.fermentingCount > 0 && !optimisticStock)
              ? `熟成中ロット ${fmtKg} kg（${plan.fermentingCount}件）が順次完成する分を見込んでも、` : ''
            // 安全在庫ライン設定時は「在庫切れ」ではなく「ラインを割る」という言い回しにする
            const outLabel   = plan.safetyStockKg != null ? '安全在庫ラインを下回る見込み' : '在庫切れの見込み'
            const safetyTxt  = plan.safetyStockKg != null
              ? `（安全在庫ライン ${plan.safetyStockKg.toLocaleString()} kg を割らないよう逆算）` : ''

            // 在庫切れ超過中：最優先で警告トーン
            if (plan.isBrewDatePast) {
              const outTxt = plan.stockOutInDays != null
                ? (plan.stockOutInDays <= 0 ? `既に${outLabel}` : `${outLabel}まであと約 ${plan.stockOutInDays} 日`)
                : '見込み時期は算出不可'
              return {
                tone: 'urgent',
                text: `${plan.name}は既に推奨仕込み日を ${plan.overdueDays} 日超過しています${safetyTxt}。`
                  + `有効在庫 ${stockKgTxt} kg${stockClause}・消費ペース約 ${rateTxt} kg/日で、${fermentLead}${outTxt}。`
                  + `${plan.location}での熟成に約 ${ferment} 日かかるため、できるだけ早く仕込んでください。`,
              }
            }

            const daysToBrew     = differenceInDays(primaryBrew, today)
            const daysToStockOut = differenceInDays(firstNew.stockOutDate, today)
            const deadlineTxt    = firstPrimaryDeadline
              ? `原料手配は ${format(firstPrimaryDeadline, 'M/d')}（あと ${Math.max(firstDaysUntilOrder, 0)} 日）が締切です。`
              : ''
            const tone: 'soon' | 'ok' =
              (firstDaysUntilOrder <= 14 || daysToBrew <= 7) ? 'soon' : 'ok'
            return {
              tone,
              text: `${plan.name}は有効在庫 ${stockKgTxt} kg${stockClause}、消費ペース約 ${rateTxt} kg/日です${safetyTxt}。`
                + `${fermentLead || 'このままだと '}${format(firstNew.stockOutDate, 'M/d')}（あと約 ${Math.max(daysToStockOut, 0)} 日）に${outLabel}。`
                + `${plan.location}での熟成に約 ${ferment} 日かかるため、${format(primaryBrew, 'M/d')}（あと ${Math.max(daysToBrew, 0)} 日）までに仕込むのが目安です。`
                + deadlineTxt,
            }
          })()

          const summaryStyle = {
            urgent: 'border-red-200 bg-red-50/70 text-red-800',
            soon:   'border-amber-200 bg-amber-50/70 text-amber-800',
            ok:     'border-emerald-200 bg-emerald-50/60 text-emerald-900',
          } as const

          return (
            <Card key={plan.name}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span
                    className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium"
                    style={getMisoTypeBadgeStyle(plan.name)}
                  >
                    {plan.name}
                  </span>
                  {urgencyBadge && (
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${urgencyBadge.cls}`}>
                      {urgencyBadge.label}
                    </span>
                  )}
                  {mapeBadge && (
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${mapeBadge.cls}`}
                      title={mapeBadge.title}
                    >
                      {mapeBadge.label}
                    </span>
                  )}
                  {autoMethod && plan.autoApplied && (
                    <span
                      className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700"
                      title="バックテストで最も的中した方式を自動採用中"
                    >
                      自動：{plan.autoApplied === 'sarimax' ? 'SARIMAX' : plan.autoApplied === 'hw' ? 'AI予測' : '3年平均'}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">仕込み場所</span>
                    <Select
                      value={locations[plan.name] ?? ''}
                      onValueChange={(v: string | null) => { if (v) handleLocationChange(plan.name, v) }}
                    >
                      <SelectTrigger className="h-7 text-xs w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locationOptions.map(loc => (
                          <SelectItem key={loc} value={loc} className="text-xs">{loc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 品種別 表示回数 */}
                  <div className="flex items-center gap-1 ml-auto">
                    {BATCH_OPTIONS.map(n => {
                      const current = perRecipeBatches[plan.name] ?? maxBatches
                      return (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setPerRecipeBatches(prev => ({ ...prev, [plan.name]: n }))}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                            current === n
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          }`}
                        >
                          {n}回
                        </button>
                      )
                    })}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                {/* ① 根拠の自然文サマリー */}
                {summary && (
                  <div className={`flex gap-2 rounded-lg border px-3 py-2.5 text-sm leading-relaxed ${summaryStyle[summary.tone]}`}>
                    <span className="shrink-0 pt-0.5">
                      {summary.tone === 'urgent' ? '⚠️' : summary.tone === 'soon' ? '🟡' : '✅'}
                    </span>
                    <p>{summary.text}</p>
                  </div>
                )}

                {/* 在庫 */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground whitespace-nowrap shrink-0">現在庫残量</span>
                    <Input
                      type="number"
                      min="0"
                      value={stockStr}
                      onChange={e => !isAutoFetch && handleStockChange(plan.name, e.target.value)}
                      readOnly={isAutoFetch}
                      className={`h-8 text-sm w-28 print:border-0 print:shadow-none ${isAutoFetch ? 'bg-muted cursor-default' : ''}`}
                      placeholder="0"
                    />
                    <span className="text-sm text-muted-foreground">kg</span>
                    {isAutoFetch && (
                      <span className="inline-flex items-center rounded border border-green-300 bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 whitespace-nowrap">
                        自動取得
                      </span>
                    )}
                  </div>
                  {plan.fermentingCount > 0 && (
                    <p className="text-xs text-muted-foreground pl-1">
                      熟成中ロット：
                      <span className="font-medium text-foreground">
                        {Math.round(plan.fermentingKg).toLocaleString()} kg
                      </span>
                      （{plan.fermentingCount}件）
                    </p>
                  )}
                </div>

                {/* 予定出荷（大口） */}
                <div className="space-y-1.5 rounded-lg border border-dashed border-gray-200 px-3 py-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-medium text-foreground">予定出荷（大口）</span>
                    <span className="text-[10px] text-muted-foreground/80">
                      分かっている大口受注を入れると、在庫から差し引いて仕込み日を前倒し計算します
                    </span>
                  </div>
                  {(scheduledOrders[plan.name]?.length ?? 0) > 0 && (
                    <ul className="space-y-1">
                      {(scheduledOrders[plan.name] ?? []).map((o, idx) => {
                        const od     = new Date(o.date + 'T00:00:00')
                        const isPast = od <= today
                        return (
                          <li
                            key={`${o.date}-${idx}`}
                            className={`flex items-center gap-2 text-xs ${isPast ? 'text-muted-foreground/50' : ''}`}
                          >
                            <span className="tabular-nums">{format(od, 'M/d')}（{WEEKDAY_JA[od.getDay()]}）</span>
                            <span className="tabular-nums font-medium">{o.kg.toLocaleString()} kg</span>
                            {isPast && <span className="text-[10px]">（過去・反映外）</span>}
                            <button
                              type="button"
                              onClick={() => handleRemoveOrder(plan.name, idx)}
                              className="ml-auto text-muted-foreground hover:text-red-600 no-print"
                              aria-label="削除"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <div className="flex items-center gap-1.5 no-print">
                    <input
                      type="date"
                      value={orderDraft[plan.name]?.date ?? ''}
                      onChange={e => setOrderDraft(prev => ({
                        ...prev,
                        [plan.name]: { date: e.target.value, kg: prev[plan.name]?.kg ?? '' },
                      }))}
                      className="h-7 rounded border px-1.5 text-xs"
                    />
                    <input
                      type="number"
                      min="0"
                      placeholder="kg"
                      value={orderDraft[plan.name]?.kg ?? ''}
                      onChange={e => setOrderDraft(prev => ({
                        ...prev,
                        [plan.name]: { date: prev[plan.name]?.date ?? '', kg: e.target.value },
                      }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddOrder(plan.name) }}
                      className="h-7 w-20 rounded border px-1.5 text-xs"
                    />
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleAddOrder(plan.name)}>
                      追加
                    </Button>
                  </div>
                </div>

                {/* 予定出荷の反映効果（反映前→反映後の比較・全回分） */}
                {plan.orderImpact && (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs space-y-1.5">
                    <div className="font-medium text-indigo-800">
                      予定出荷の反映効果（{plan.orderImpact.orderCount}件・計 {Math.round(plan.orderImpact.orderKg).toLocaleString()} kg）
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
                      <span className="w-16 shrink-0">在庫切れ予測</span>
                      <span className="line-through tabular-nums">{format(plan.orderImpact.stockOutBefore, 'M/d')}</span>
                      <span>→</span>
                      <span className="text-foreground tabular-nums">{format(plan.orderImpact.stockOutAfter, 'M/d')}</span>
                    </div>
                    {plan.orderImpact.perBatch.length > 0 && (
                      <div className="space-y-0.5">
                        {plan.orderImpact.perBatch.map(pb => (
                          <div key={pb.n} className="flex items-center gap-2 flex-wrap">
                            <span className="w-20 shrink-0 text-muted-foreground">新規{pb.n}回目</span>
                            <span className="line-through text-muted-foreground tabular-nums">
                              {format(pb.before, 'M/d')}（{WEEKDAY_JA[pb.before.getDay()]}）
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-semibold text-indigo-700 tabular-nums">
                              {format(pb.after, 'M/d')}（{WEEKDAY_JA[pb.after.getDay()]}）
                            </span>
                            <span className={
                              pb.deltaDays > 0 ? 'text-rose-600 font-medium' :
                              pb.deltaDays < 0 ? 'text-blue-600 font-medium' :
                                                 'text-muted-foreground'
                            }>
                              {pb.deltaDays > 0 ? `${pb.deltaDays}日 前倒し` :
                               pb.deltaDays < 0 ? `${-pb.deltaDays}日 後ろ倒し` :
                                                  '変化なし'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 在庫切れ警告バナー */}
                {plan.isBrewDatePast && plan.idealBrewDate0 && (
                  <div className="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2.5 space-y-1">
                    <p className="text-xs font-semibold text-red-700">
                      ⚠️ 在庫切れリスク：推奨仕込み日（{format(plan.idealBrewDate0, 'M/d')}）を {plan.overdueDays} 日超過しています。早急に仕込みを検討してください。
                    </p>
                    <p className="text-xs text-red-600/90">
                      現在の有効在庫：{Math.round(plan.effectiveStock).toLocaleString()} kg
                      {plan.safetyStockKg != null && (
                        <> （安全在庫ライン {plan.safetyStockKg.toLocaleString()} kg を除く実質 {Math.max(Math.round(plan.effectiveStock - plan.safetyStockKg), 0).toLocaleString()} kg）</>
                      )} ／
                      消費ペース：約 {Math.round(plan.dailyRate).toLocaleString()} kg/日 ／
                      {plan.safetyStockKg != null ? '安全在庫ラインを割るまで' : '推定在庫切れまで'}：{plan.stockOutInDays != null ? `あと ${plan.stockOutInDays} 日` : '—'}
                    </p>
                  </div>
                )}

                {/* 計画テーブル */}
                {!plan.hasData ? (
                  <p className="text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2 border border-amber-200">
                    過去データなし・要インポート
                  </p>
                ) : !plan.canCalc ? (
                  <p className="text-sm text-muted-foreground">
                    直近3年の{currentMonth}月データが不足しています
                  </p>
                ) : (
                  <>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40 border-b text-muted-foreground">
                            <th className="text-center px-2 py-1.5 font-medium w-8">回</th>
                            <th className="text-left px-2 py-1.5 font-medium">仕込み日</th>
                            <th className="text-left px-2 py-1.5 font-medium">完成日</th>
                            <th className="text-left px-2 py-1.5 font-medium">手配締切</th>
                            <th className="text-right px-2 py-1.5 font-medium w-16"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.batches.map(b => {
                            const hasRaw   = b.rawBrewDate !== undefined
                            const sLabel   = useRawAsBase ? 'Q10補正あり' : '補正なし'
                            const pBrew    = (useRawAsBase && hasRaw) ? b.rawBrewDate! : b.brewDate
                            const sBrew    = hasRaw ? (useRawAsBase ? b.brewDate : b.rawBrewDate) : undefined
                            const pComp    = (useRawAsBase && b.rawCompletionDate) ? b.rawCompletionDate : b.completionDate
                            const sComp    = b.rawCompletionDate ? (useRawAsBase ? b.completionDate : b.rawCompletionDate) : undefined
                            const pDays    = (useRawAsBase && b.rawFermentationDays !== undefined) ? b.rawFermentationDays : b.fermentationDays
                            const sDays    = b.rawFermentationDays !== undefined ? (useRawAsBase ? b.fermentationDays : b.rawFermentationDays) : undefined
                            const pDL      = (useRawAsBase && b.rawMaterialOrderDeadline) ? b.rawMaterialOrderDeadline : b.materialOrderDeadline
                            const sDL      = b.rawMaterialOrderDeadline ? (useRawAsBase ? b.materialOrderDeadline : b.rawMaterialOrderDeadline) : undefined
                            const pDaysUntilOrder = differenceInDays(pDL, today)
                            const orderCls =
                              pDaysUntilOrder <= 14 ? 'text-red-600 font-semibold' :
                              pDaysUntilOrder <= 30 ? 'text-orange-600 font-semibold' :
                              'text-muted-foreground'
                            const isPast     = pBrew < today
                            // 手動調整の対象は「確定行ではない新規提案」すべて（回ごとにインデックスで管理）
                            const genIndex   = b.isFixed ? -1 : genBatches.indexOf(b)
                            const isGen      = !b.isFixed
                            const isManual   = isGen && plan.manualPinIndices.includes(genIndex)
                            const isEditing  = isGen && editingPlan?.name === plan.name && editingPlan.genIndex === genIndex
                            const dateKey    = manualDateKey(plan.name, genIndex)
                            return (
                              <tr key={b.n} className={`border-b last:border-0 ${b.isFixed ? 'bg-emerald-50/40' : ''}`}>
                                <td className="text-center px-2 py-2 text-muted-foreground">{b.n}</td>
                                <td className={`px-2 py-2 tabular-nums ${!isEditing && isPast ? 'text-red-600' : ''}`}>
                                  {isEditing ? (
                                    <input
                                      type="date"
                                      autoFocus
                                      value={editDateValue}
                                      onChange={e => setEditDateValue(e.target.value)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault()
                                          if (editDateValue) {
                                            localStorage.setItem(`planning_manualDate_${dateKey}`, editDateValue)
                                            setManualBrewDates(prev => ({ ...prev, [dateKey]: editDateValue }))
                                          }
                                          setEditingPlan(null)
                                        }
                                        if (e.key === 'Escape') {
                                          e.preventDefault()
                                          cancelEditRef.current = true
                                          setEditingPlan(null)
                                        }
                                      }}
                                      onBlur={() => {
                                        if (cancelEditRef.current) { cancelEditRef.current = false; return }
                                        if (editDateValue) {
                                          localStorage.setItem(`planning_manualDate_${dateKey}`, editDateValue)
                                          setManualBrewDates(prev => ({ ...prev, [dateKey]: editDateValue }))
                                        }
                                        setEditingPlan(null)
                                      }}
                                      className="text-xs border border-input rounded px-1.5 py-0.5 w-32 focus:outline-none focus:ring-1 focus:ring-ring bg-background"
                                    />
                                  ) : (
                                    <>
                                      <div className="flex items-center gap-1 flex-wrap">
                                        {format(pBrew, 'M/d')}
                                        <span className="text-[10px] ml-0.5">（{WEEKDAY_JA[pBrew.getDay()]}）</span>
                                        {b.isFixed && (
                                          <span className="text-[10px] text-emerald-700 font-medium ml-0.5 rounded bg-emerald-100 px-1">確定</span>
                                        )}
                                        {isPast && <span className="ml-1 text-[10px]">超過</span>}
                                        {isManual && (
                                          <span className="text-[10px] text-amber-600 font-medium ml-0.5">調整済</span>
                                        )}
                                        {isGen && (
                                          <span className="inline-flex items-center gap-0.5 ml-0.5">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingPlan({ name: plan.name, genIndex })
                                                setEditDateValue(manualBrewDates[dateKey] || format(b.brewDate, 'yyyy-MM-dd'))
                                              }}
                                              className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                              title="仕込み日を手動調整"
                                            >
                                              <Pencil className="h-2.5 w-2.5" />
                                            </button>
                                            {isManual && (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  localStorage.removeItem(`planning_manualDate_${dateKey}`)
                                                  setManualBrewDates(prev => {
                                                    const n = { ...prev }
                                                    delete n[dateKey]
                                                    return n
                                                  })
                                                }}
                                                className="text-muted-foreground/40 hover:text-rose-500 transition-colors"
                                                title="AI推奨日に戻す"
                                              >
                                                <X className="h-2.5 w-2.5" />
                                              </button>
                                            )}
                                          </span>
                                        )}
                                      </div>
                                      {sBrew && (
                                        <div className="text-[10px] text-muted-foreground/50 mt-0.5 whitespace-nowrap">
                                          {sLabel} {format(sBrew, 'M/d')}（{WEEKDAY_JA[sBrew.getDay()]}）
                                        </div>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td className="px-2 py-2 tabular-nums text-muted-foreground">
                                  {format(pComp, 'M/d')}
                                  <span className="text-[10px] ml-0.5">（{WEEKDAY_JA[pComp.getDay()]}）</span>
                                  <span className="ml-1 text-[10px]">({pDays}日)</span>
                                  {sComp && sDays !== undefined && (
                                    <div className="text-[10px] text-muted-foreground/50 mt-0.5 whitespace-nowrap">
                                      {sLabel} {format(sComp, 'M/d')}（{WEEKDAY_JA[sComp.getDay()]}）（{sDays}日）
                                    </div>
                                  )}
                                </td>
                                <td className={`px-2 py-2 tabular-nums ${orderCls}`}>
                                  {format(pDL, 'M/d')}
                                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                                    ({daysLabel(pDaysUntilOrder)})
                                  </span>
                                  {sDL && (
                                    <div className="text-[10px] text-muted-foreground/50 mt-0.5 whitespace-nowrap font-normal">
                                      {sLabel} {format(sDL, 'M/d')}
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {(() => {
                                    if (b.isFixed) {
                                      return (
                                        <span className="text-[11px] text-emerald-700 font-medium whitespace-nowrap">
                                          確定済
                                        </span>
                                      )
                                    }
                                    const planKey = `${plan.name}::${format(pBrew, 'yyyy-MM-dd')}`
                                    const isSaved  = savedKeys.has(planKey)
                                    const isSaving = savingKeys.has(planKey)
                                    if (isSaved) {
                                      return (
                                        <span className="text-[11px] text-emerald-600 font-medium whitespace-nowrap">
                                          登録済 ✓
                                        </span>
                                      )
                                    }
                                    return (
                                      <button
                                        type="button"
                                        disabled={isSaving}
                                        onClick={async () => {
                                          setSavingKeys(prev => new Set([...prev, planKey]))
                                          try {
                                            // JST午前0時はUTCで前日になるため、日付文字列からUTC midnightに正規化
                                            const toUTCMidnight = (d: Date) => `${format(d, 'yyyy-MM-dd')}T00:00:00Z`
                                            await createBrewPlan({
                                              misoType:                 plan.name,
                                              brewDateISO:              toUTCMidnight(pBrew),
                                              completionDateISO:        toUTCMidnight(pComp),
                                              fermentationDays:         pDays,
                                              location:                 plan.location,
                                              materialOrderDeadlineISO: toUTCMidnight(pDL),
                                            })
                                            setSavedKeys(prev => new Set([...prev, planKey]))
                                          } finally {
                                            setSavingKeys(prev => { const n = new Set(prev); n.delete(planKey); return n })
                                          }
                                        }}
                                        className="text-[11px] px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 whitespace-nowrap"
                                      >
                                        {isSaving ? '保存中' : '仮登録'}
                                      </button>
                                    )
                                  })()}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* ② What-if（もしもの試算） */}
                    {plan.whatIf && (
                      <div className="rounded-lg border border-sky-200 bg-sky-50/40 px-3 py-2.5 no-print">
                        <button
                          type="button"
                          onClick={() => setWhatIfOpen(prev => ({ ...prev, [plan.name]: !prev[plan.name] }))}
                          className="flex items-center gap-1 text-xs font-medium text-sky-800 hover:text-sky-900 transition-colors"
                        >
                          <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform ${whatIfOpen[plan.name] ? '' : '-rotate-90'}`}
                          />
                          🔍 もしもの試算（What-if）
                        </button>
                        {whatIfOpen[plan.name] && (() => {
                          const wi = plan.whatIf!
                          const nLabel = (n: number, multi: boolean) =>
                            multi ? <span className="w-12 shrink-0 text-muted-foreground/70">{n}回目</span> : null
                          return (
                            <div className="mt-2.5 space-y-3 text-xs">
                              {/* (1) 需要が ±X% 変わったら */}
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span className="text-muted-foreground">需要が</span>
                                  <WhatIfStepper
                                    value={wi.demandPct} step={5} min={-50} max={50} signed suffix="%"
                                    onChange={v => setWhatIfPct(prev => ({ ...prev, [plan.name]: v }))}
                                  />
                                  <span className="text-muted-foreground">変わったら</span>
                                  {wi.demandStockOut && (
                                    <span className="text-muted-foreground">
                                      → 在庫切れ
                                      <span className="tabular-nums font-medium text-foreground ml-1">{format(wi.demandStockOut.newStockOut, 'M/d')}</span>
                                      <DeltaTag days={wi.demandStockOut.delta} />
                                    </span>
                                  )}
                                </div>
                                {wi.demand.length > 0 && (
                                  <ul className="pl-1 space-y-0.5">
                                    {wi.demand.map(d => (
                                      <li key={d.n} className="flex items-center gap-1.5">
                                        {nLabel(d.n, wi.demand.length > 1)}
                                        <span>仕込み <span className="tabular-nums font-medium">{format(d.newBrew, 'M/d')}</span></span>
                                        <DeltaTag days={d.deltaDays} />
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              {/* (2) 仕込みが N日遅れたら */}
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span className="text-muted-foreground">仕込みが</span>
                                  <WhatIfStepper
                                    value={wi.delayDays} step={1} min={0} max={30} suffix="日"
                                    onChange={v => setWhatIfDelay(prev => ({ ...prev, [plan.name]: v }))}
                                  />
                                  <span className="text-muted-foreground">遅れたら</span>
                                </div>
                                {wi.delay.length > 0 && (
                                  <ul className="pl-1 space-y-0.5">
                                    {wi.delay.map(d => (
                                      <li key={d.n} className="flex flex-wrap items-center gap-1.5">
                                        {nLabel(d.n, wi.delay.length > 1)}
                                        <span>完成 <span className="tabular-nums font-medium">{format(d.newCompletion, 'M/d')}</span></span>
                                        {d.fits ? (
                                          <span className="font-medium text-emerald-700">✅ 間に合う（余裕 {d.marginDays} 日）</span>
                                        ) : (
                                          <span className="font-medium text-rose-600">⚠️ 間に合わない（{-d.marginDays} 日 不足）</span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              {/* (3) 気温が ±X℃ 違ったら（常温のみ） */}
                              {wi.temp.length > 0 && (
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="text-muted-foreground">気温が</span>
                                    <WhatIfStepper
                                      value={wi.tempDelta} step={1} min={-5} max={5} signed suffix="℃"
                                      onChange={v => setWhatIfTemp(prev => ({ ...prev, [plan.name]: v }))}
                                    />
                                    <span className="text-muted-foreground">違ったら</span>
                                  </div>
                                  <ul className="pl-1 space-y-0.5">
                                    {wi.temp.map(d => (
                                      <li key={d.n} className="flex flex-wrap items-center gap-1.5">
                                        {nLabel(d.n, wi.temp.length > 1)}
                                        <span>熟成 <span className="tabular-nums font-medium">{d.newDays} 日</span></span>
                                        <DeltaTag days={d.dayDelta} labelLater="延びる" labelEarlier="縮む" unit="日" invertColor />
                                        <span className="text-muted-foreground/50">→</span>
                                        <span>完成 <span className="tabular-nums font-medium">{format(d.newCompletion, 'M/d')}</span></span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              <p className="text-[10px] text-muted-foreground/70 pt-0.5">
                                ※ 表示中の各回を起点にした概算です。判断の目安にどうぞ。
                              </p>
                            </div>
                          )
                        })()}
                      </div>
                    )}

                    {first && (
                      <div className="border-t pt-2">
                        <button
                          type="button"
                          onClick={() => setOpenBasis(prev => ({ ...prev, [plan.name]: !prev[plan.name] }))}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform ${openBasis[plan.name] ? '' : '-rotate-90'}`}
                          />
                          計算の根拠
                        </button>
                        {openBasis[plan.name] && (
                          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                            {/* 在庫推移グラフ：計算の根拠を時間軸で可視化 */}
                            {plan.stockPoints && plan.stockPoints.length > 1 && (
                              <div className="mb-3">
                                <StockProjectionChart
                                  points={plan.stockPoints}
                                  markers={plan.batches.map(b => ({
                                    n:          b.n,
                                    deadline:   b.materialOrderDeadline >= today ? format(b.materialOrderDeadline, 'yyyy-MM-dd') : null,
                                    brew:       format(b.brewDate, 'yyyy-MM-dd'),
                                    completion: format(b.completionDate, 'yyyy-MM-dd'),
                                    stockOut:   b.isFixed ? null : format(b.stockOutDate, 'yyyy-MM-dd'),
                                    isFixed:    b.isFixed,
                                  }))}
                                  todayStr={format(today, 'yyyy-MM-dd')}
                                  supplyMarkers={plan.supplyMarkers}
                                  safetyStockKg={plan.safetyStockKg}
                                />
                                <p className="text-[10px] text-muted-foreground/70 mt-1">
                                  完成の補充を織り込んだ在庫見込み。赤の縦線は「その回の完成が間に合わない場合に{plan.safetyStockKg != null ? '安全在庫ラインを割る' : '在庫が尽きる'}日」。
                                  {plan.location === '常温' && q10Value !== 1 && 'グラフはQ10補正あり基準。'}
                                </p>
                              </div>
                            )}
                            {/* ① 消費量推計：全回共通 */}
                            <p>
                              {plan.usingSarimax
                                ? `① SARIMAX（気温外生変数）予測の翌3ヶ月平均`
                                : plan.usingHW
                                  ? `① ホルト・ウィンタース法（季節調整AI予測）による今月消費量推計`
                                  : `① ${currentMonth}月の直近3年平均出荷量`}
                              ：<span className="tabular-nums font-medium text-foreground">{Math.round(plan.monthlyAvg!).toLocaleString()} kg</span>
                              　→ 当月約 <span className="tabular-nums font-medium text-foreground">{Math.round(plan.dailyRate).toLocaleString()} kg</span>/日
                              <span className="text-foreground/50">（2回目以降は月別変動値を使用）</span>
                            </p>
                            {/* ②③④ 各回分 */}
                            {plan.batches.map((b, idx) => {
                              const isMulti = plan.batches.length > 1
                              const label   = isMulti ? `【${b.n}回目】` : ''
                              const prevCompletion = idx === 0 ? today : plan.batches[idx - 1].completionDate
                              const genIndex = b.isFixed ? -1 : genBatches.indexOf(b)
                              const hasRaw  = b.rawBrewDate !== undefined
                              const sLabel  = useRawAsBase ? 'Q10補正あり' : '補正なし'
                              const pBrew   = (useRawAsBase && hasRaw) ? b.rawBrewDate! : b.brewDate
                              const sBrew   = hasRaw ? (useRawAsBase ? b.brewDate : b.rawBrewDate) : undefined
                              const pDays   = (useRawAsBase && b.rawFermentationDays !== undefined) ? b.rawFermentationDays : b.fermentationDays
                              const sDays   = b.rawFermentationDays !== undefined ? (useRawAsBase ? b.fermentationDays : b.rawFermentationDays) : undefined
                              const pDL     = (useRawAsBase && b.rawMaterialOrderDeadline) ? b.rawMaterialOrderDeadline : b.materialOrderDeadline
                              const sDL     = b.rawMaterialOrderDeadline ? (useRawAsBase ? b.materialOrderDeadline : b.rawMaterialOrderDeadline) : undefined
                              const seasonLabel = `6〜9月:常温 / 10〜5月:暖房${heatingDefaultTemp}℃`
                              const basisLabel = plan.location === '常温' && q10Value !== 1
                                ? useRawAsBase
                                  ? `・気象シミュレーション（${seasonLabel}）・補正なし（参考：Q10係数${q10Value}）`
                                  : `・気象シミュレーション（${seasonLabel}）・Q10補正あり（係数：${q10Value}）`
                                : plan.location === '常温'
                                  ? `・気象シミュレーション（${seasonLabel}）・補正なし`
                                  : `・${plan.dailyAccum.toFixed(1)}℃/日`
                              return (
                                <div
                                  key={b.n}
                                  className={isMulti && idx > 0 ? 'mt-1.5 pt-1.5 border-t border-gray-100 space-y-1' : 'space-y-1'}
                                >
                                  <p>
                                    {label}② 有効在庫：
                                    {idx === 0 ? (
                                      <>
                                        現在庫 <span className="tabular-nums">{Math.round(plan.stockKg).toLocaleString()} kg</span>
                                        {plan.fermentingKg > 0 && (
                                          <> ＋ 熟成中 <span className="tabular-nums">{Math.round(plan.fermentingKg).toLocaleString()} kg</span>
                                          <span className="text-foreground/50 text-[11px]">（完成予定日に補充）</span></>
                                        )}
                                      </>
                                    ) : (
                                      <>{format(prevCompletion, 'M月d日')}時点 ＝ <span className="tabular-nums font-medium text-foreground">{Math.round(b.startStockKg).toLocaleString()} kg</span></>
                                    )}
                                    　→ 約 <span className="tabular-nums">{differenceInDays(b.stockOutDate, prevCompletion)}</span> 日後に在庫切れ
                                    （<span className="tabular-nums">{format(b.stockOutDate, 'M月d日')}</span>）
                                  </p>
                                  <p>
                                    {label}③ 在庫切れ日 − 熟成{' '}
                                    <span className="tabular-nums">{pDays}</span> 日
                                    {sDays !== undefined && (
                                      <span className="text-foreground/50">
                                        {' '}/ <span className="tabular-nums">{sDays}</span> 日（{sLabel}）
                                      </span>
                                    )}
                                    <span className="text-foreground/60">（{plan.location}{basisLabel}）</span>
                                    {bufferEnabled && brewBufferDays > 0 && (
                                      <>{' '}− バッファ <span className="tabular-nums">{brewBufferDays}</span> 日</>
                                    )}
                                    　→ 推奨仕込み日：<span className="tabular-nums font-medium text-foreground">{format(pBrew, 'M月d日')}</span>
                                    {!b.isFixed && plan.manualPinIndices.includes(genIndex) && (
                                      <span className="text-amber-600 text-[10px] ml-1">（手動調整済み）</span>
                                    )}
                                    {sBrew && (
                                      <span className="text-foreground/50">
                                        {' '}/ {sLabel}：{format(sBrew, 'M月d日')}
                                      </span>
                                    )}
                                  </p>
                                  <p>
                                    {label}④ 推奨仕込み日の <span className="tabular-nums">{plan.orderLeadDays}</span> 日前
                                    　→ 原料手配締切：<span className="tabular-nums font-medium text-foreground">{format(pDL, 'M月d日')}</span>
                                    {sDL && (
                                      <span className="text-foreground/50">
                                        {' '}/ {sLabel}：{format(sDL, 'M月d日')}
                                      </span>
                                    )}
                                  </p>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                <p className="text-xs text-muted-foreground/50 border-t pt-2">
                  ※考慮していない要素：大口受注の予定 ／ 原料の調達状況 ／ 人員スケジュール
                </p>

                {/* 品種別仕込みカレンダー */}
                {plan.canCalc && plan.batches.length > 0 && (() => {
                  type CalEv = { type: 'brew' | 'comp'; misoType: string; n: number }
                  const typeEvMap = new Map<string, CalEv[]>()
                  for (const b of plan.batches) {
                    if (!b.brewDate || isNaN(b.brewDate.getTime())) continue
                    const bk = format(b.brewDate, 'yyyy-MM-dd')
                    typeEvMap.set(bk, [...(typeEvMap.get(bk) ?? []), { type: 'brew', misoType: plan.name, n: b.n }])
                    if (b.completionDate && !isNaN(b.completionDate.getTime())) {
                      const ck = format(b.completionDate, 'yyyy-MM-dd')
                      typeEvMap.set(ck, [...(typeEvMap.get(ck) ?? []), { type: 'comp', misoType: plan.name, n: b.n }])
                    }
                  }
                  if (typeEvMap.size === 0) return null

                  const allDates = [...typeEvMap.keys()].map(k => new Date(k))
                  const maxDate  = new Date(Math.max(...allDates.map(d => d.getTime())))
                  const months: Array<{ year: number; month: number }> = []
                  let cy = today.getFullYear(), cm = today.getMonth()
                  const ey = maxDate.getFullYear(), em = maxDate.getMonth()
                  while (cy < ey || (cy === ey && cm <= em)) {
                    months.push({ year: cy, month: cm })
                    cm++; if (cm > 11) { cm = 0; cy++ }
                  }

                  const maxOffset     = Math.max(0, months.length - 3)
                  const offset        = calendarOffsets[plan.name] ?? 0
                  const safeOffset    = Math.max(0, Math.min(offset, maxOffset))
                  const displayMonths = months.slice(safeOffset, safeOffset + 3)
                  const canPrev       = safeOffset > 0
                  const canNext       = safeOffset < maxOffset

                  return (
                    <div className="mt-3 space-y-2 no-print border-t pt-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">仕込みカレンダー</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setCalendarOffsets(prev => ({ ...prev, [plan.name]: Math.max(0, (prev[plan.name] ?? 0) - 1) }))}
                            disabled={!canPrev}
                            className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            aria-label="前の月"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
                          <span className="text-[11px] text-muted-foreground tabular-nums px-1">
                            {displayMonths[0] && `${displayMonths[0].year}/${displayMonths[0].month + 1}`}
                            〜
                            {displayMonths.at(-1) && `${displayMonths.at(-1)!.year}/${displayMonths.at(-1)!.month + 1}`}
                          </span>
                          <button
                            type="button"
                            onClick={() => setCalendarOffsets(prev => ({ ...prev, [plan.name]: Math.min(maxOffset, (prev[plan.name] ?? 0) + 1) }))}
                            disabled={!canNext}
                            className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            aria-label="次の月"
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {/* 凡例 */}
                      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="inline-block w-3.5 h-3.5 rounded" style={getBrewBadgeStyle(plan.name)} />
                          仕込み日
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block w-3.5 h-3.5 rounded" style={getCompBadgeStyle(plan.name)} />
                          完成日
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {displayMonths.map(({ year, month }) => {
                          const firstDow = new Date(year, month, 1).getDay()
                          const nDays    = getDaysInMonth(new Date(year, month, 1))
                          const cells    = [
                            ...Array(firstDow).fill(null as number | null),
                            ...Array.from({ length: nDays }, (_, i) => i + 1),
                          ]
                          while (cells.length % 7 !== 0) cells.push(null)
                          return (
                            <div key={`${year}-${month}`}>
                              <p className="text-[11px] font-semibold mb-1">{year}年{month + 1}月</p>
                              <div className="rounded border overflow-hidden">
                                <div className="grid grid-cols-7 bg-muted/40 border-b">
                                  {WEEKDAY_JA.map((d, i) => (
                                    <div key={d} className={`text-center py-0.5 text-[9px] font-medium ${
                                      i === 3 || i === 4 ? 'text-blue-600' :
                                      i === 0 || i === 6 ? 'text-muted-foreground/50' :
                                      'text-muted-foreground'
                                    }`}>{d}</div>
                                  ))}
                                </div>
                                <div className="grid grid-cols-7">
                                  {cells.map((day, idx) => {
                                    if (!day) return <div key={idx} className="min-h-[32px] border-t border-l" style={{ borderColor: 'hsl(var(--border))' }} />
                                    const dow      = (firstDow + day - 1) % 7
                                    const dateKey  = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                                    const events   = typeEvMap.get(dateKey) ?? []
                                    const isToday  = dateKey === format(today, 'yyyy-MM-dd')
                                    const isBrewDay = dow === 3 || dow === 4
                                    return (
                                      <div key={idx} className={`min-h-[32px] border-t border-l p-0.5 flex flex-col items-center gap-0.5 ${
                                        isToday   ? 'bg-primary/10' :
                                        isBrewDay ? 'bg-blue-50/60' : ''
                                      }`} style={{ borderColor: 'hsl(var(--border))' }}>
                                        <span className={`text-[10px] leading-none mt-0.5 ${
                                          isToday   ? 'font-bold text-primary' :
                                          dow === 0 || dow === 6 ? 'text-muted-foreground/40' : ''
                                        }`}>{day}</span>
                                        {events.map((ev, i) => {
                                          const isBrew   = ev.type === 'brew'
                                          const style    = isBrew ? getBrewBadgeStyle(ev.misoType) : getCompBadgeStyle(ev.misoType)
                                          const darkC    = MISO_DARK_COLOR[ev.misoType] ?? '#555555'
                                          const hKey     = `${ev.misoType}-${ev.n}`
                                          const isHov    = hoveredKey === hKey
                                          const isDimmed = hoveredKey !== null && !isHov
                                          const abbr     = MISO_ABBR[ev.misoType] ?? ev.misoType[0]
                                          return (
                                            <span
                                              key={i}
                                              onMouseEnter={() => setHoveredKey(hKey)}
                                              onMouseLeave={() => setHoveredKey(null)}
                                              className={`text-[9px] leading-tight rounded px-0.5 w-full text-center font-semibold cursor-default transition-all ${
                                                isDimmed ? 'opacity-20' : ''
                                              }`}
                                              style={{
                                                ...style,
                                                ...(isHov ? { outline: `2px solid ${darkC}`, outlineOffset: '1px', fontWeight: 800 } : {}),
                                              }}
                                            >
                                              {abbr}{ev.n}{isBrew ? '仕' : '完'}
                                            </span>
                                          )
                                        })}
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}

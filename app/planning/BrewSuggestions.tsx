'use client'

import { useState, useEffect, useRef } from 'react'
import { addDays, differenceInDays, format, getDaysInMonth } from 'date-fns'
import { Printer, Download, ChevronDown, ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { holtWinters, getTimeSeries } from '@/lib/forecast'
import { createBrewPlan } from './brew-plan-actions'

interface Recipe {
  name:            string
  targetTempSum:   number
  totalWeightKg:   number
  defaultLocation: string
}

interface FermentingInfo {
  totalKg: number
  count:   number
}

interface FermentingLotSchedule {
  completionDateStr: string  // 'yyyy-MM-dd'
  yieldKg:           number
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
  // 熟成中ロットの完成予定日・歩留まりスケジュール（在庫補充タイミング計算用）
  fermentingScheduleByType?: Record<string, FermentingLotSchedule[]>
  // 既存の仮登録キー一覧（"品種::yyyy-MM-dd" 形式）
  existingBrewPlanKeys?: string[]
  // DBに保存済みの仮登録仕込み日（品種別・他PCからの同期用フォールバック）
  initialManualBrewDates?: Record<string, string>
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
}

interface RecipePlan {
  name:             string
  monthlyAvg:       number | null
  usingHW:          boolean
  usingSarimax:     boolean   // SARIMAX予測を使用しているか
  fermentationDays: number
  effectiveStock:   number
  stockKg:          number
  fermentingKg:     number
  fermentingCount:  number
  dailyRate:        number
  dailyAccum:       number
  location:         string
  orderLeadDays:    number
  batches:          BatchPlan[]
  hasData:          boolean
  canCalc:          boolean
  isBrewDatePast:   boolean       // 1回目AI推奨仕込み日が今日より過去かどうか
  overdueDays:      number        // 何日超過しているか
  idealBrewDate0:   Date | null   // 修正前のAI推奨仕込み日（警告バナー表示用）
  stockOutInDays:   number | null // 推定在庫切れまでの日数
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
      // 10〜5月: 暖房レート（固定・Q10補正なし）
      daily = indoorDailyRate
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

function get3YearAvg(data: Record<string, number>, month: number, year: number): number | null {
  const values: number[] = []
  for (let i = 1; i <= 3; i++) {
    const ym = `${year - i}-${String(month).padStart(2, '0')}`
    if (data[ym] != null) values.push(data[ym])
  }
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
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

// 予測方式・データから「日付→1日消費量(kg)」関数を生成
function buildDailyRateFn(
  method:       'sarimax' | 'hw' | 'avg',
  typeData:     Record<string, number>,
  sarimaxEntry: SarimaxEntry | undefined,
  hwInput:      number[],
  fallback:     number,
): (date: Date) => number {
  // SARIMAX: 月別予測値を直接使用
  if (method === 'sarimax' && sarimaxEntry && sarimaxEntry.months.length > 0) {
    const map: Record<string, number> = {}
    for (let i = 0; i < sarimaxEntry.months.length; i++) {
      const ym = sarimaxEntry.months[i]
      map[ym] = sarimaxEntry.forecast[i] / getDaysInMonth(new Date(ym + '-01T00:00:00'))
    }
    return (date: Date) => {
      const ym = format(date, 'yyyy-MM')
      if (map[ym] !== undefined) return map[ym]
      const avg3 = get3YearAvg(typeData, date.getMonth() + 1, date.getFullYear())
      return avg3 !== null ? avg3 / getDaysInMonth(date) : fallback
    }
  }

  // HW: 36ヶ月先まで予測してマッピング
  if (method === 'hw' && hwInput.length >= 12) {
    const sortedKeys = Object.keys(typeData).sort()
    const lastKnown  = sortedKeys[sortedKeys.length - 1]
    if (lastKnown) {
      const hw = holtWinters(hwInput, 36)
      const map: Record<string, number> = {}
      let [hy, hm] = lastKnown.split('-').map(Number)
      for (let i = 0; i < hw.forecast.length; i++) {
        hm++; if (hm > 12) { hm = 1; hy++ }
        const ym     = `${hy}-${String(hm).padStart(2, '0')}`
        const daysInM = getDaysInMonth(new Date(hy, hm - 1, 1))
        map[ym] = Math.max(0, hw.forecast[i]) / daysInM
      }
      return (date: Date) => {
        const ym = format(date, 'yyyy-MM')
        if (map[ym] !== undefined) return map[ym]
        const avg3 = get3YearAvg(typeData, date.getMonth() + 1, date.getFullYear())
        return avg3 !== null ? avg3 / getDaysInMonth(date) : fallback
      }
    }
  }

  // 3年平均: 月ごとに直近3年の実績平均を使用
  return (date: Date) => {
    const avg3 = get3YearAvg(typeData, date.getMonth() + 1, date.getFullYear())
    return avg3 !== null ? avg3 / getDaysInMonth(date) : fallback
  }
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
  manualFirstBrewDate?: Date,     // 1回目の仕込み日手動指定（スナップ無効）
  supplyEvents?:       { date: Date; kg: number }[],  // 熟成中ロットの補充スケジュール
): BatchPlan[] {
  const batches: BatchPlan[] = []
  let stock           = effectiveStock
  let refDate         = today
  // Q10補正あり・なしそれぞれの推定値を独立して追跡する
  let currentEstimate    = fermentationDays
  let rawCurrentEstimate = fermentationDaysRaw ?? fermentationDays
  // バッチ間の昇順を保証するための下限日（前バッチの翌日以降）
  let minNextBrewDate:    Date = today
  let minNextRawBrewDate: Date = today
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
    if (i === 0 && manualFirstBrewDate) {
      brewDate = manualFirstBrewDate
      // 手動指定日が過去の場合も今日以降に修正（elseブランチと統一）
      if (brewDate < today) {
        brewDate = snapBrewDate ? snapBrewDate(today) : today
      }
    } else {
      const preSnapDate = addDays(stockOutDate, -(currentEstimate + safeBuffer))
      let provisional   = snapBrewDate ? snapBrewDate(preSnapDate) : preSnapDate
      // 常温の場合、仮仕込み日でシミュレーションして熟成日数を取得し仕込み日を再計算。
      // currentEstimate が前バッチの季節（例：春）の熟成日数を引き継いでいると、
      // 夏バッチの仕込み日が補正なしと同じになるズレを防ぐ。
      if (getCompletion) {
        const r0      = getCompletion(provisional)
        const refined = addDays(stockOutDate, -(r0.days + safeBuffer))
        provisional   = snapBrewDate ? snapBrewDate(refined) : refined
      }
      brewDate = provisional
      // 計算結果が過去になった場合は今日以降に修正
      if (brewDate < today) {
        brewDate = snapBrewDate ? snapBrewDate(today) : today
      }
    }
    // 前バッチ以前にならないよう修正（昇順を保証し、sort後のn=1・n=2が同日になるのを防ぐ）
    if (brewDate < minNextBrewDate) {
      brewDate = snapBrewDate ? snapBrewDate(minNextBrewDate) : minNextBrewDate
    }
    minNextBrewDate = addDays(brewDate, 1)

    const materialOrderDeadline = addDays(brewDate, -orderLeadDays)
    const daysUntilOrder        = differenceInDays(materialOrderDeadline, today)

    let completionDate: Date
    let actualFermentDays: number
    if (getCompletion) {
      const r           = getCompletion(brewDate)
      completionDate    = r.completionDate
      actualFermentDays = r.days
      currentEstimate   = actualFermentDays
    } else {
      completionDate    = addDays(brewDate, fermentationDays)
      actualFermentDays = fermentationDays
    }

    // ── Q10補正なし（サブ・常温かつq10≠1のときのみ） ────────
    let rawBrewDate: Date | undefined
    let rawFermentationDays: number | undefined
    let rawCompletionDate: Date | undefined
    let rawMaterialOrderDeadline: Date | undefined
    if (getCompletionRaw) {
      let rawProv: Date
      if (i === 0 && manualFirstBrewDate) {
        rawProv = manualFirstBrewDate
        // 手動指定日が過去の場合も今日以降に修正（elseブランチと統一）
        if (rawProv < today) {
          rawProv = snapBrewDate ? snapBrewDate(today) : today
        }
      } else {
        const rawPreSnap = addDays(rawStockOutDate, -(rawCurrentEstimate + safeBuffer))
        rawProv = snapBrewDate ? snapBrewDate(rawPreSnap) : rawPreSnap
        // Q10補正ありと同様に、仮仕込み日でシミュレーションして仕込み日を再計算
        const r0      = getCompletionRaw(rawProv)
        const refined = addDays(rawStockOutDate, -(r0.days + safeBuffer))
        rawProv = snapBrewDate ? snapBrewDate(refined) : refined
        if (rawProv < today) {
          rawProv = snapBrewDate ? snapBrewDate(today) : today
        }
      }
      // rawBrewDateも昇順を保証
      if (rawProv < minNextRawBrewDate) {
        rawProv = snapBrewDate ? snapBrewDate(minNextRawBrewDate) : minNextRawBrewDate
      }
      rawBrewDate = rawProv
      minNextRawBrewDate = addDays(rawProv, 1)
      const r = getCompletionRaw(rawBrewDate)
      rawFermentationDays      = r.days
      rawCompletionDate        = r.completionDate
      rawCurrentEstimate       = rawFermentationDays   // 次回の推定に実績値を使う
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

export default function BrewSuggestions({ recipes, shipmentMap, heatingDefaultTemp, coolingDefaultTemp, fridgeTemp, q10Value, brewBufferDays, weatherAvg, fermentingByType, apiStockByType, sarimaxForecast, fermentingScheduleByType, existingBrewPlanKeys, initialManualBrewDates }: Props) {
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
  const [hoveredKey,      setHoveredKey]     = useState<string | null>(null)
  const [calendarOffsets, setCalendarOffsets] = useState<Record<string, number>>({})
  const [useRawAsBase,    setUseRawAsBase]    = useState(false)
  const [manualBrewDates, setManualBrewDates] = useState<Record<string, string>>({})
  const [editingPlan,     setEditingPlan]     = useState<string | null>(null)
  const [editDateValue,   setEditDateValue]   = useState<string>('')
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
    for (const r of recipes) {
      savedStocks[r.name]  = localStorage.getItem(`planning_stock_${r.name}`) ?? ''
      const stored   = localStorage.getItem(`planning_location_${r.name}`)
      const seasonal = getSeasonalDefaultLocation(heatingDefaultTemp)
      savedLocations[r.name] = stored && locationOptions.includes(stored) ? stored : seasonal
      const storedDate = localStorage.getItem(`planning_manualDate_${r.name}`) ?? initialManualBrewDates?.[r.name]
      if (storedDate) savedManualDates[r.name] = storedDate
    }
    setStocks(savedStocks)
    setLocations(savedLocations)
    setManualBrewDates(savedManualDates)
    setUseRawAsBase(localStorage.getItem('planning_useRawAsBase') === '1')
    setOptimisticStock(localStorage.getItem('planning_optimisticStock') === '1')
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

  // 全品種のプラン計算
  const plans: RecipePlan[] = recipes.map(recipe => {
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
      hwMonthlyEst = hw.forecast[0] ?? null
    }

    // SARIMAXの今月〜翌3ヶ月平均を計算
    const sarimaxEntry = sarimaxForecast?.[recipe.name]
    let sarimaxMonthlyEst: number | null = null
    if (sarimaxEntry && sarimaxEntry.forecast.length > 0) {
      // 翌3ヶ月または利用可能な予測全体の平均
      const slicedForecast = sarimaxEntry.forecast.slice(0, Math.min(3, sarimaxEntry.forecast.length))
      const sum = slicedForecast.reduce((a, b) => a + b, 0)
      sarimaxMonthlyEst = slicedForecast.length > 0 ? sum / slicedForecast.length : null
    }

    // 予測方式に応じてmonthlyAvgを決定
    let monthlyAvg: number | null
    let usingHW      = false
    let usingSarimax = false

    if (forecastMethod === 'sarimax' && sarimaxMonthlyEst !== null) {
      monthlyAvg   = sarimaxMonthlyEst
      usingSarimax = true
    } else if (forecastMethod === 'hw' && hwMonthlyEst !== null) {
      monthlyAvg = hwMonthlyEst
      usingHW    = true
    } else {
      monthlyAvg = hasData ? get3YearAvg(typeData, currentMonth, currentYear) : null
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
    const activeSupplyEvents = optimisticStock ? undefined : (futureEvents.length > 0 ? futureEvents : undefined)

    const canCalc   = monthlyAvg !== null && monthlyAvg > 0 && fermentationDays > 0
    const daysInMonth = getDaysInMonth(today)
    const dailyRate   = canCalc ? (monthlyAvg! / daysInMonth) : 0
    // 月別消費量関数: 予測方式に応じて将来各月の実際の予測値を使用（夏低・冬高を反映）
    const getDailyRateFn = canCalc
      ? buildDailyRateFn(forecastMethod, typeData, sarimaxEntry, hwInput, dailyRate)
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
    const manualDateStr       = manualBrewDates[recipe.name]
    const manualFirstBrewDate = manualDateStr ? new Date(manualDateStr + 'T00:00:00') : undefined

    // 1回目推奨仕込み日が過去かどうかを事前チェック（警告バナーと自動補正のため）
    // 熟成中ロットの補充スケジュールを考慮して在庫切れ日をシミュレーション
    const stockOutDate0 = canCalc
      ? findStockOutDate(effectiveStock, today, getDailyRateFn, activeSupplyEvents)
      : null
    const preSnap0       = (canCalc && stockOutDate0)
      ? addDays(stockOutDate0, -(fermentationDays + bufferDays))
      : null
    // 常温ではQ10シミュレーションで実際の熟成日数を使い再計算する。
    // 静的推定（年間平均）の仮仕込み日が冬〜春に当たると実際の熟成日数が
    // 静的推定の数倍になり、refined=stockOut-actual-bufferが過去へ大きくズレるため。
    let idealBrewDate0: Date | null = (canCalc && preSnap0)
      ? (snapEnabled ? snapToBrewDay(preSnap0) : preSnap0)
      : null
    if (idealBrewDate0 && getCompletion && stockOutDate0) {
      const r0       = getCompletion(idealBrewDate0)
      const refined  = addDays(stockOutDate0, -(r0.days + bufferDays))
      idealBrewDate0 = snapEnabled ? snapToBrewDay(refined) : refined
    }
    const isBrewDatePast = !!idealBrewDate0 && idealBrewDate0 < today
    const overdueDays    = isBrewDatePast && idealBrewDate0 ? differenceInDays(today, idealBrewDate0) : 0
    const stockOutInDays = stockOutDate0 ? differenceInDays(stockOutDate0, today) : null

    // 手動調整がない場合のみ自動補正（今日以降で最も早い仕込み可能日）
    const autoCorrectDate     = (isBrewDatePast && !manualFirstBrewDate)
      ? (snapEnabled ? snapToBrewDay(today) : today)
      : undefined
    const effectiveFirstBrewDate = manualFirstBrewDate ?? autoCorrectDate

    const batches = canCalc
      ? calcBatches(effectiveStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, effectiveFirstBrewDate, activeSupplyEvents)
      : []

    return {
      name: recipe.name,
      monthlyAvg, usingHW, usingSarimax, fermentationDays,
      effectiveStock, stockKg, fermentingKg, fermentingCount,
      dailyRate, dailyAccum, location: selectedLocation, orderLeadDays,
      batches, hasData, canCalc,
      isBrewDatePast, overdueDays, idealBrewDate0, stockOutInDays,
    }
  })

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
      <div className="sticky top-14 z-20 bg-white/95 backdrop-blur-sm -mx-4 px-4 py-2 mb-2 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
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
      <div className="grid grid-cols-1 gap-4">
        {plans.map(plan => {
          const apiStock    = apiStockByType?.[plan.name] ?? null
          const isAutoFetch = apiStock != null
          const stockStr    = isAutoFetch ? String(apiStock) : (stocks[plan.name] ?? '')
          const first       = plan.batches[0] ?? null

          const firstPrimaryDeadline = first
            ? ((useRawAsBase && first.rawMaterialOrderDeadline) ? first.rawMaterialOrderDeadline : first.materialOrderDeadline)
            : null
          const firstDaysUntilOrder = firstPrimaryDeadline ? differenceInDays(firstPrimaryDeadline, today) : Infinity
          const urgencyBadge =
            firstDaysUntilOrder <= 14
              ? { label: `要手配 あと${firstDaysUntilOrder}日`, cls: 'bg-rose-100 text-rose-700 border border-rose-300' }
              : firstDaysUntilOrder <= 30
              ? { label: `要手配 あと${firstDaysUntilOrder}日`, cls: 'bg-amber-100 text-amber-700 border border-amber-300' }
              : null

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

                {/* 在庫切れ警告バナー */}
                {plan.isBrewDatePast && plan.idealBrewDate0 && (
                  <div className="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2.5 space-y-1">
                    <p className="text-xs font-semibold text-red-700">
                      ⚠️ 在庫切れリスク：推奨仕込み日（{format(plan.idealBrewDate0, 'M/d')}）を {plan.overdueDays} 日超過しています。早急に仕込みを検討してください。
                    </p>
                    <p className="text-xs text-red-600/90">
                      現在の有効在庫：{Math.round(plan.effectiveStock).toLocaleString()} kg ／
                      消費ペース：約 {Math.round(plan.dailyRate).toLocaleString()} kg/日 ／
                      推定在庫切れまで：{plan.stockOutInDays != null ? `あと ${plan.stockOutInDays} 日` : '—'}
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
                            const isPast    = pBrew < today
                            const isManual  = b.n === 1 && !!manualBrewDates[plan.name]
                            const isEditing = b.n === 1 && editingPlan === plan.name
                            return (
                              <tr key={b.n} className="border-b last:border-0">
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
                                            localStorage.setItem(`planning_manualDate_${plan.name}`, editDateValue)
                                            setManualBrewDates(prev => ({ ...prev, [plan.name]: editDateValue }))
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
                                          localStorage.setItem(`planning_manualDate_${plan.name}`, editDateValue)
                                          setManualBrewDates(prev => ({ ...prev, [plan.name]: editDateValue }))
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
                                        {isPast && <span className="ml-1 text-[10px]">超過</span>}
                                        {isManual && (
                                          <span className="text-[10px] text-amber-600 font-medium ml-0.5">調整済</span>
                                        )}
                                        {b.n === 1 && (
                                          <span className="inline-flex items-center gap-0.5 ml-0.5">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingPlan(plan.name)
                                                setEditDateValue(manualBrewDates[plan.name] || format(b.brewDate, 'yyyy-MM-dd'))
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
                                                  localStorage.removeItem(`planning_manualDate_${plan.name}`)
                                                  setManualBrewDates(prev => {
                                                    const n = { ...prev }
                                                    delete n[plan.name]
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
                                    {b.n === 1 && manualBrewDates[plan.name] && (
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

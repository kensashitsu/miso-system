'use client'

import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { addDays, differenceInDays, format, getDaysInMonth, isSameISOWeek, startOfDay } from 'date-fns'
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
import {
  type BatchPlan, simulateFermentationDays, ORDER_LEAD_DAYS, DEFAULT_ORDER_LEAD_DAYS,
  snapToBrewDay, nextWeekMonday, findStockOutDate, computeConsumed, computeSupplyReceived,
  PEAK_COMPLETION_MONTHS, calcBatches, refineBrewDateToStockOut, makeSafetyDeltaFn, makeSafetyLineFn,
  weekStartOf, expandBlockedWeeks,
} from '@/lib/brewPlanCalc'
import { createBrewPlan } from './brew-plan-actions'
import { addBlockedWeek, removeBlockedWeek } from './blocked-week-actions'
import StockProjectionChart, { type StockPoint } from './StockProjectionChart'

// 仕込み日を最終的に決めた条件の表示名（BatchPlan.decidedBy と対応）
// 「◯◯だったので、こう動かした」と分かる文にする。単語だけだと何が起きたのか伝わらない
const DECIDED_BY_LABEL: Record<NonNullable<BatchPlan['decidedBy']>, string> = {
  stockout: '逆算した日をそのまま採用',
  peak:     '出荷ピーク期に完成する回なので、いつもより早めに仕込む',
  earliest: '逆算すると来週より前になるので、最短で仕込める日まで後ろへ',
  order:    '逆算すると前の回と重なるので、前の回の翌日以降まで後ろへ',
  spacing:  '前の回の分を使い切る前に完成してしまうので、後ろへ',
  blocked:  '逆算した日が仮登録済み・仕込めない週なので、次に仕込める日へ',
  manual:   '✎ 手動で指定した日',
}

interface Recipe {
  name:            string
  targetTempSum:   number
  totalWeightKg:   number
  defaultLocation: string
  safetyStockKg:   number | null
  winterSafetyStockKg: number | null
  summerSafetyStockKg: number | null
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
  // 仕込めない週（月曜日の 'yyyy-MM-dd' 配列・全品種共通）
  initialBlockedWeeks?: string[]
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
  safetyStockKg:    number | null   // 通年ライン（ラインが設定されているかの判定用）
  currentSafetyKg:  number | null   // 今日に適用されるライン（季節で変わるため表示はこちらを使う）
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

function daysLabel(days: number): string {
  return days >= 0 ? `あと${days}日` : `${Math.abs(days)}日超過`
}

// 提案1行を仮登録する。2本立て（出荷ピーク期）の回は相方も同時に登録する。
// JST午前0時はUTCで前日になるため、日付文字列からUTC midnightに正規化する
async function registerBatch(
  planName:     string,
  location:     string,
  b:            BatchPlan,
  useRawAsBase: boolean,
): Promise<void> {
  const toUTCMidnight = (d: Date) => `${format(d, 'yyyy-MM-dd')}T00:00:00Z`
  const pBrew = (useRawAsBase && b.rawBrewDate)              ? b.rawBrewDate              : b.brewDate
  const pComp = (useRawAsBase && b.rawCompletionDate)        ? b.rawCompletionDate        : b.completionDate
  const pDays = (useRawAsBase && b.rawFermentationDays !== undefined) ? b.rawFermentationDays : b.fermentationDays
  const pDL   = (useRawAsBase && b.rawMaterialOrderDeadline) ? b.rawMaterialOrderDeadline : b.materialOrderDeadline
  await createBrewPlan({
    misoType:                 planName,
    brewDateISO:              toUTCMidnight(pBrew),
    completionDateISO:        toUTCMidnight(pComp),
    fermentationDays:         pDays,
    location,
    materialOrderDeadlineISO: toUTCMidnight(pDL),
  })
  if (b.pairBrewDate && b.pairCompletionDate && b.pairFermentationDays !== undefined && b.pairMaterialOrderDeadline) {
    await createBrewPlan({
      misoType:                 planName,
      brewDateISO:              toUTCMidnight(b.pairBrewDate),
      completionDateISO:        toUTCMidnight(b.pairCompletionDate),
      fermentationDays:         b.pairFermentationDays,
      location,
      materialOrderDeadlineISO: toUTCMidnight(b.pairMaterialOrderDeadline),
    })
  }
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

export default function BrewSuggestions({ recipes, shipmentMap, heatingDefaultTemp, coolingDefaultTemp, fridgeTemp, q10Value, brewBufferDays, weatherAvg, fermentingByType, apiStockByType, sarimaxForecast, sarimaxMape, autoMethodByType, fermentingScheduleByType, existingBrewPlanKeys, initialManualBrewDates, registeredPlansByType, registeredDoneDatesByType, initialBlockedWeeks }: Props) {
  const [stocks,          setStocks]         = useState<Record<string, string>>({})
  const [locations,       setLocations]      = useState<Record<string, string>>(() => {
    const seasonal = getSeasonalDefaultLocation(heatingDefaultTemp)
    return Object.fromEntries(recipes.map(r => [r.name, seasonal]))
  })
  const [maxBatches,      setMaxBatches]     = useState<number>(1)
  // 無添加麦みそ・田舎みそはデフォルトで5回分表示（在庫切れリスクが高く先の見通しが必要なため）
  const [perRecipeBatches, setPerRecipeBatches] = useState<Record<string, number>>({
    '無添加麦みそ': 5,
    '田舎みそ':     5,
  })
  // 「計算の根拠」（在庫推移グラフを含む）は最初から開いた状態にする
  const [openBasis,       setOpenBasis]      = useState<Record<string, boolean>>(
    () => Object.fromEntries(recipes.map(r => [r.name, true]))
  )
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
  // 仕込めない週（全品種共通）。その週は提案から除外し、翌週以降で提案する
  const [blockedWeeks, setBlockedWeeks] = useState<string[]>(initialBlockedWeeks ?? [])
  const [blockedWeekDraft, setBlockedWeekDraft] = useState('')
  const [blockedSaving, setBlockedSaving] = useState(false)
  const blockedDateSet = useMemo(() => expandBlockedWeeks(blockedWeeks), [blockedWeeks])
  // 提案テーブルのチェックボックス選択（まとめて仮登録用）。キーは仮登録と同じ `${品種名}::yyyy-MM-dd`
  const [selectedProposals, setSelectedProposals] = useState<Set<string>>(new Set())
  const [bulkSaving, setBulkSaving] = useState(false)
  // existingBrewPlanKeys はサーバーから毎回渡される最新の仮登録状況。
  // savedKeysの初期値はマウント時の一度きりなので、削除等で内容が変わった後に
  // ページ遷移せず再取得された場合は追従せず「登録済」表示が残ってしまう。
  // propsが変わるたびにサーバー側の値へ同期し直す。
  useEffect(() => {
    setSavedKeys(new Set(existingBrewPlanKeys ?? []))
  }, [existingBrewPlanKeys])
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
  // 工程上の運用ルールを反映するため計算順を固定する。
  //  ・田舎→無添加の順で仕込む（無添加は田舎と同じ週なら田舎の後）
  //  ・山吹は無添加・田舎の翌日にしか仕込めない（＝両者の仕込み日が先に必要）
  // 表示順は元のrecipes順を保つので、計算だけこの並びで行い最後に元の順序へ戻す。
  const CROSS_TYPE_CALC_ORDER: Record<string, number> = { '田舎みそ': 0, '無添加麦みそ': 1, '山吹みそ': 2 }
  const recipesForCalc = [...recipes].sort((a, b) =>
    (CROSS_TYPE_CALC_ORDER[a.name] ?? 99) - (CROSS_TYPE_CALC_ORDER[b.name] ?? 99)
  )
  // 田舎みその確定＋新規提案の仕込み日（無添加の順序ルール判定に使う）。
  // 提案側の日付は today（現在時刻）起点で作られ時刻を持つため、必ず startOfDay で日付単位に丸めて保持・比較する。
  let inakaBrewDays: Date[] = []
  // 無添加・田舎の仕込み日（'yyyy-MM-dd'）。山吹の「翌日しか仕込めない」制約に使う
  const mugiInakaBrewDateStrs: string[] = []

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

    // 安全在庫ライン（熟成済バラ＋小分け製品の合算の下限）が設定されている品種は、在庫切れ判定・仕込み提案の
    // 起点をライン到達時点にシフトする（実在庫からラインを引いた「実質使える在庫」で計算し、
    // 0を切ったタイミング＝ライン到達日として扱う）。表示用のeffectiveStockは実数のまま。
    // 季節ラインだけ設定されている品種（例: 山吹みそ＝通年なし・冬季300kg）もあるため、
    // 通年が未設定なら 0 を基準にして季節差だけを効かせる
    const winterSafetyKg  = recipe.winterSafetyStockKg
    const summerSafetyKg  = recipe.summerSafetyStockKg
    const hasAnySafety    = recipe.safetyStockKg != null || winterSafetyKg != null || summerSafetyKg != null
    const baseSafetyKg    = recipe.safetyStockKg ?? 0
    const safetyStockKg   = recipe.safetyStockKg ?? null
    const depletableStock = hasAnySafety ? effectiveStock - baseSafetyKg : effectiveStock
    // 冬季（11〜12月）は着色が実質進まないためラインを厚く、夏季（5〜8月）は着色が早いため薄く。
    // 在庫連鎖は通年ラインを引いた実質在庫で追跡しているので、季節差は差分で補正する
    const getSafetyDelta = hasAnySafety
      ? makeSafetyDeltaFn(baseSafetyKg, winterSafetyKg, summerSafetyKg)
      : undefined
    // その日に適用されるライン（グラフの階段線・当月の表示に使う）
    const safetyLineAt    = hasAnySafety ? makeSafetyLineFn(baseSafetyKg, winterSafetyKg, summerSafetyKg) : null

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
    // 出荷ピーク期（11〜12月）に在庫を厚くするため、完成が10〜12月に入る回は2本立てにする。
    // 対象は無添加麦みそのみ（量が最も多く在庫切れリスクが高いため・2026-08-28ユーザー判断）
    const isDoubleBatch = recipe.name === '無添加麦みそ'
      ? (completionDate: Date) => PEAK_COMPLETION_MONTHS.includes(completionDate.getMonth() + 1)
      : undefined
    const recipeBatches = perRecipeBatches[recipe.name] ?? maxBatches
    // 仮登録（確定）と同じ日付の集合。手動固定や新規提案がこれと重複しないようにする
    const regDateSet    = new Set(regPlans.map(p => format(p.brewDate, 'yyyy-MM-dd')))
    // 提案を置いてはいけない日＝仮登録済みの日 ＋ 仕込めない週の全日
    const blockedForCalc = new Set<string>([...regDateSet, ...blockedDateSet])
    // 工程上の制約：山吹みそは無添加麦みそ・田舎みその「翌日」にしか仕込めない
    // （両者は水曜仕込みが基本なので、必然的に木曜仕込みになる）。
    // ※無添加・田舎の提案は表示回数分しか先が無い一方、山吹は1回で数ヶ月もつため提案が先まで及ぶ。
    //   両者の予定が尽きた先は「木曜であればよい」とみなす（実務上そうなるため）
    const isAllowedBrewDay = (() => {
      if (recipe.name !== '山吹みそ' || mugiInakaBrewDateStrs.length === 0) return undefined
      const nextDayStrs = new Set(
        mugiInakaBrewDateStrs.map(ds => format(addDays(new Date(ds + 'T00:00:00'), 1), 'yyyy-MM-dd'))
      )
      const lastKnown = mugiInakaBrewDateStrs.reduce((mx, ds) => (ds > mx ? ds : mx), '')
      return (dt: Date) => {
        const key = format(dt, 'yyyy-MM-dd')
        if (nextDayStrs.has(key)) return true
        // 無添加・田舎の予定が尽きた先は木曜(4)なら可とする
        return key > lastKnown && dt.getDay() === 4
      }
    })()
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
      const so = findStockOutDate(depletableStock, today, getDailyRateFn, supplyEvents, getSafetyDelta)
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

    // 1回目を最短日へ強制する自動補正は廃止（2026-08-28）。
    // calcBatches 側が「今から仕込んで間に合う最初の在庫切れ」を狙って日付を決め、
    // 過去日になる場合は最短仕込み可能日にクランプするため、ここでの上書きは不要。
    // 上書きしていた頃は、確定済みの仕込みで既に手当て済みでも1回目が常に最短日に
    // 貼り付き、不要な仕込みを提案していた。
    const manualBrewDateByIndex: Record<number, Date> = { ...manualBrewDateRaw }

    // 新規提案バッチ（仮登録の確定生産を供給算入した上で、足りない分を生成）
    let generated = canCalc
      ? calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents, isDoubleBatch, blockedForCalc, getSafetyDelta, safetyLineAt ?? undefined, isAllowedBrewDay, regPlans.map(p => p.completionDate))
      : []

    // 工程上の運用ルール：無添加が田舎と同じ週で同日以前になっていたら、田舎の翌仕込み可能日へ
    // 「ずらして」再計算する。除外（提案を消す）にすると、その回の仕込みが計画から丸ごと
    // 抜け落ちて後々の在庫不足につながるため、必ず後ろへ動かす。
    // ※日付は startOfDay で丸めてから比較する（提案側のbrewDateは現在時刻を引き継いでいるため）
    if (canCalc && recipe.name === '無添加麦みそ' && inakaBrewDays.length > 0) {
      // ずらし先として使える最初の仕込み可能日を探す。
      // 仮登録済み(確定)と同じ日には置かない：その日は表示上「重複」として消される一方、
      // 在庫計算では1本分（ピーク期なら2本分）の歩留まりが加算されたままになり、
      // 実在しない在庫を見込んで後続の仕込みが遅れ、結果として欠品する。
      const nextFreeBrewDay = (from: Date): Date => {
        let d = snapFn ? snapFn(from) : from
        for (let guard = 0; guard < 60; guard++) {
          const day = startOfDay(d)
          const hitsRegistered = blockedForCalc.has(format(d, 'yyyy-MM-dd'))
          const hitsInaka      = inakaBrewDays.some(bd => isSameISOWeek(day, bd) && day <= bd)
          if (!hitsRegistered && !hitsInaka) return d
          d = snapFn ? snapFn(addDays(d, 1)) : addDays(d, 1)
        }
        return d
      }
      const overrides: Record<number, Date> = {}
      generated.forEach((b, i) => {
        // ユーザーが鉛筆アイコンで手動固定した回だけは動かさない。
        // 在庫超過時の自動補正(autoCorrectDate)は手動固定ではないのでずらして良い
        // （ここを manualBrewDateByIndex で判定すると自動補正済みの1回目が常にスキップされ、
        //   田舎と重なったままの提案が残ってしまう）
        if (manualBrewDateRaw[i]) return
        const brewDay  = startOfDay(b.brewDate)
        const conflict = inakaBrewDays.find(bd => isSameISOWeek(brewDay, bd) && brewDay <= bd)
        if (conflict) {
          overrides[i] = nextFreeBrewDay(addDays(conflict, 1))
        }
      })
      if (Object.keys(overrides).length > 0) {
        Object.assign(manualBrewDateByIndex, overrides)
        generated = calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents, isDoubleBatch, blockedForCalc, getSafetyDelta, safetyLineAt ?? undefined, isAllowedBrewDay, regPlans.map(p => p.completionDate))
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
      inakaBrewDays = [...fixedRows, ...generated].map(b => startOfDay(b.brewDate))
    }
    // 無添加・田舎の仕込み日を蓄積（山吹はこれらの翌日にしか仕込めない）
    if (recipe.name === '田舎みそ' || recipe.name === '無添加麦みそ') {
      for (const b of [...fixedRows, ...generated]) {
        mugiInakaBrewDateStrs.push(format(b.brewDate, 'yyyy-MM-dd'))
        if (b.pairBrewDate) mugiInakaBrewDateStrs.push(format(b.pairBrewDate, 'yyyy-MM-dd'))
      }
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
      ? calcBatches(depletableStock, getDailyRateFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateRaw, noOrderSupply, isDoubleBatch, blockedForCalc, getSafetyDelta, safetyLineAt ?? undefined, isAllowedBrewDay, regPlans.map(p => p.completionDate))
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
      const so       = findStockOutDate(depletableStock, today, scaledFn, activeSupplyEvents, getSafetyDelta)
      demandStockOut = { newStockOut: so, delta: differenceInDays(so, stockOutDate0) }
      // スケール済みレートで全回再計算し、表示中の各回と同インデックスで比較
      const scaledGen = calcBatches(depletableStock, scaledFn, fermentationDays, recipe.totalWeightKg, recipeBatches, today, orderLeadDays, bufferDays, getCompletion, snapFn, getCompletionRaw, fermentationDaysRaw, manualBrewDateByIndex, activeSupplyEvents, isDoubleBatch, blockedForCalc, getSafetyDelta, safetyLineAt ?? undefined, isAllowedBrewDay, regPlans.map(p => p.completionDate))
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
        // 2本立て（出荷ピーク期）の回は相方の完成分も補充として積む
        if (b.pairCompletionDate) {
          const pk = format(b.pairCompletionDate, 'yyyy-MM-dd')
          events.set(pk, (events.get(pk) ?? 0) + recipe.totalWeightKg)
        }
      }
      let stock = effectiveStock
      const daily: StockPoint[] = []
      let d = today
      for (let i = 0; i <= horizon; i++) {
        const k = format(d, 'yyyy-MM-dd')
        stock += events.get(k) ?? 0
        stock -= getDailyRateFn(d)
        if (stock < 0) stock = 0
        daily.push({
          d: k, kg: Math.round(stock),
          // 冬季（11〜12月）は安全在庫ラインが厚くなるため、その日のラインを持たせる
          safety: safetyLineAt ? safetyLineAt(d) : undefined,
        })
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
      currentSafetyKg: safetyLineAt ? safetyLineAt(today) : null,
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

      {/* 仕込めない週（全品種共通）。登録した週を避けて翌週以降で提案する */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 no-print">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-slate-700">仕込めない週</span>
          <span className="text-[11px] text-muted-foreground">
            現場の都合で仕込めない週を登録すると、その週を避けて翌週以降で提案します（全品種共通）
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-2">
          {blockedWeeks.length === 0 && (
            <span className="text-[11px] text-muted-foreground">登録なし</span>
          )}
          {blockedWeeks.map(w => {
            const mon = new Date(w + 'T00:00:00')
            return (
              <span
                key={w}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700"
              >
                {format(mon, 'M/d')}〜{format(addDays(mon, 6), 'M/d')} の週
                <button
                  type="button"
                  disabled={blockedSaving}
                  onClick={async () => {
                    setBlockedSaving(true)
                    try { setBlockedWeeks(await removeBlockedWeek(w)) } finally { setBlockedSaving(false) }
                  }}
                  className="text-slate-400 hover:text-rose-500 transition-colors disabled:opacity-40"
                  title="解除"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
          <input
            type="date"
            value={blockedWeekDraft}
            onChange={e => setBlockedWeekDraft(e.target.value)}
            className="text-xs border border-input rounded px-1.5 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="仕込めない週に含まれる日付"
          />
          <button
            type="button"
            disabled={blockedSaving || !blockedWeekDraft}
            onClick={async () => {
              if (!blockedWeekDraft) return
              setBlockedSaving(true)
              try {
                const wk = weekStartOf(new Date(blockedWeekDraft + 'T00:00:00'))
                setBlockedWeeks(await addBlockedWeek(wk))
                setBlockedWeekDraft('')
              } finally { setBlockedSaving(false) }
            }}
            className="text-[11px] px-2.5 py-1 rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            {blockedSaving ? '保存中' : 'この日を含む週を登録'}
          </button>
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
          // 表示中の仕込み日（基準トグルにより補正なし/Q10補正ありが切り替わる）。仮登録キーの基準もこれに合わせる
          const pBrewOf     = (b: BatchPlan) => (useRawAsBase && b.rawBrewDate !== undefined) ? b.rawBrewDate! : b.brewDate
          const planKeyOf   = (b: BatchPlan) => `${plan.name}::${format(pBrewOf(b), 'yyyy-MM-dd')}`
          const selectableKeys = plan.batches
            .filter(b => !b.isFixed && !savedKeys.has(planKeyOf(b)))
            .map(planKeyOf)
          const selectedInPlan = selectableKeys.filter(k => selectedProposals.has(k))

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
            const outLabel   = plan.currentSafetyKg != null && plan.currentSafetyKg > 0 ? '安全在庫ラインを下回る見込み' : '在庫切れの見込み'
            const safetyTxt  = plan.currentSafetyKg != null && plan.currentSafetyKg > 0
              ? `（安全在庫ライン ${plan.currentSafetyKg.toLocaleString()} kg を割らないよう逆算）` : ''

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

          // 安全在庫ラインを設定している品種は「在庫切れ」ではなく「ラインを割る」と言い換える
          const outWord = plan.currentSafetyKg != null && plan.currentSafetyKg > 0 ? '安全在庫ラインを割る' : '尽きる'

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
                      {plan.currentSafetyKg != null && plan.currentSafetyKg > 0 && (
                        <> （安全在庫ライン {plan.currentSafetyKg.toLocaleString()} kg を除く実質 {Math.max(Math.round(plan.effectiveStock - plan.currentSafetyKg), 0).toLocaleString()} kg）</>
                      )} ／
                      消費ペース：約 {Math.round(plan.dailyRate).toLocaleString()} kg/日 ／
                      {plan.currentSafetyKg != null && plan.currentSafetyKg > 0 ? '安全在庫ラインを割るまで' : '推定在庫切れまで'}：{plan.stockOutInDays != null ? `あと ${plan.stockOutInDays} 日` : '—'}
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
                    {selectedInPlan.length > 0 && (
                      <div className="flex items-center justify-end mb-1.5">
                        <button
                          type="button"
                          disabled={bulkSaving}
                          onClick={async () => {
                            setBulkSaving(true)
                            try {
                              for (const b of plan.batches) {
                                if (b.isFixed) continue
                                const planKey = planKeyOf(b)
                                if (!selectedInPlan.includes(planKey)) continue
                                await registerBatch(plan.name, plan.location, b, useRawAsBase)
                                setSavedKeys(prev => new Set([...prev, planKey]))
                              }
                              setSelectedProposals(prev => {
                                const next = new Set(prev)
                                selectedInPlan.forEach(k => next.delete(k))
                                return next
                              })
                            } finally {
                              setBulkSaving(false)
                            }
                          }}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                          {bulkSaving ? '保存中' : `選択した${selectedInPlan.length}件をまとめて仮登録`}
                        </button>
                      </div>
                    )}
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40 border-b text-muted-foreground">
                            <th className="text-center px-2 py-1.5 font-medium w-6">
                              {selectableKeys.length > 0 && (() => {
                                const allSelected = selectableKeys.every(k => selectedProposals.has(k))
                                return (
                                  <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={() => {
                                      setSelectedProposals(prev => {
                                        const next = new Set(prev)
                                        if (allSelected) selectableKeys.forEach(k => next.delete(k))
                                        else selectableKeys.forEach(k => next.add(k))
                                        return next
                                      })
                                    }}
                                    aria-label="すべて選択"
                                    className="h-3.5 w-3.5 align-middle"
                                  />
                                )
                              })()}
                            </th>
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
                            const planKey  = `${plan.name}::${format(pBrew, 'yyyy-MM-dd')}`
                            const isSaved  = savedKeys.has(planKey)
                            return (
                              <tr key={b.n} className={`border-b last:border-0 ${b.isFixed ? 'bg-emerald-50/40' : ''}`}>
                                <td className="text-center px-2 py-2">
                                  {!b.isFixed && !isSaved && (
                                    <input
                                      type="checkbox"
                                      checked={selectedProposals.has(planKey)}
                                      onChange={() => {
                                        setSelectedProposals(prev => {
                                          const next = new Set(prev)
                                          if (next.has(planKey)) next.delete(planKey)
                                          else next.add(planKey)
                                          return next
                                        })
                                      }}
                                      aria-label={`${plan.name} ${format(b.brewDate, 'M/d')}を選択`}
                                      className="h-3.5 w-3.5 align-middle"
                                    />
                                  )}
                                </td>
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
                                        {b.pairBrewDate && (
                                          <>
                                            <span className="text-muted-foreground">＋{format(b.pairBrewDate, 'M/d')}</span>
                                            <span className="text-[10px] ml-0.5">（{WEEKDAY_JA[b.pairBrewDate.getDay()]}）</span>
                                            <span
                                              className="text-[10px] text-sky-700 font-medium ml-0.5 rounded bg-sky-100 px-1"
                                              title="出荷ピーク（11〜12月）に備えて連続2回仕込む回です"
                                            >
                                              2回
                                            </span>
                                          </>
                                        )}
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
                                  {b.pairCompletionDate && (
                                    <>
                                      <span className="ml-0.5">＋{format(b.pairCompletionDate, 'M/d')}</span>
                                      <span className="text-[10px] ml-0.5">（{WEEKDAY_JA[b.pairCompletionDate.getDay()]}）</span>
                                      {b.pairFermentationDays !== undefined && (
                                        <span className="ml-1 text-[10px]">({b.pairFermentationDays}日)</span>
                                      )}
                                    </>
                                  )}
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
                                            await registerBatch(plan.name, plan.location, b, useRawAsBase)
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
                                  在庫見込み＝<span className="font-medium">熟成済バラ＋小分け製品</span>（完成の補充を織り込み）。
                                  安全在庫ラインも同じ合算基準です。
                                  {plan.safetyStockKg != null
                                    ? '赤の縦線は安全在庫ラインを割る日。'
                                    : '赤の縦線は在庫が尽きる日。'}
                                  {plan.location === '常温' && q10Value !== 1 && 'グラフはQ10補正あり基準。'}
                                </p>
                              </div>
                            )}
                            {/* 前提（全回共通）：回ごとに繰り返さず1回だけ示す */}
                            {(() => {
                              const methodLabel = plan.usingSarimax
                                ? 'SARIMAX予測の翌3ヶ月平均'
                                : plan.usingHW
                                  ? 'ホルト・ウィンタース法の今月推計'
                                  : `${currentMonth}月の直近3年平均`
                              const tempTxt = plan.location === '常温'
                                ? `常温｜6〜9月=外気 / 10〜5月=暖房${heatingDefaultTemp}℃`
                                : `${plan.location}｜${plan.dailyAccum.toFixed(1)}℃/日`
                              const basisTxt = plan.location === '常温' && q10Value !== 1
                                ? (useRawAsBase ? 'Q10補正なし基準' : `Q10補正あり（係数 ${q10Value}）`)
                                : null
                              return (
                                <div className="rounded-md bg-muted/50 px-2.5 py-2">
                                  <p className="font-medium text-foreground/70 mb-1">計算に使った前提（全回共通）</p>
                                  <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5">
                                    <span className="text-foreground/50">1日の消費ペース</span>
                                    <span>
                                      <span className="tabular-nums font-medium text-foreground">{Math.round(plan.dailyRate).toLocaleString()} kg</span>/日
                                      <span className="text-foreground/50">（{methodLabel} {Math.round(plan.monthlyAvg!).toLocaleString()} kg/月から換算・2回目以降は月別の変動値）</span>
                                    </span>
                                    <span className="text-foreground/50">今の在庫</span>
                                    <span>
                                      <span className="tabular-nums font-medium text-foreground">{Math.round(plan.stockKg).toLocaleString()} kg</span>
                                      {plan.fermentingKg > 0 && (
                                        <> ＋ 熟成中 <span className="tabular-nums">{Math.round(plan.fermentingKg).toLocaleString()} kg</span>
                                        <span className="text-foreground/50">（完成予定日に在庫へ加算）</span></>
                                      )}
                                    </span>
                                    <span className="text-foreground/50">熟成の条件</span>
                                    <span>{tempTxt}{basisTxt && `｜${basisTxt}`}</span>
                                    <span className="text-foreground/50">見込む余裕</span>
                                    <span>
                                      {bufferEnabled && brewBufferDays > 0
                                        ? <>在庫切れの <span className="tabular-nums">{brewBufferDays}</span> 日前に完成させる（バッファ）</>
                                        : <span className="text-foreground/50">バッファなし（在庫切れ当日に完成）</span>}
                                    </span>
                                    <span className="text-foreground/50">原料の手配</span>
                                    <span>仕込みの <span className="tabular-nums">{plan.orderLeadDays}</span> 日前までに発注</span>
                                  </div>
                                </div>
                              )
                            })()}
                            {/* 各回の逆算：1行1回。列見出しを付けて何の日付かを明示する */}
                            <div className="pt-2">
                              <p className="font-medium text-foreground/70">仕込み日の決め方（各回）</p>
                              <p className="text-foreground/50 mb-1.5">
                                まず在庫が{outWord}日から「熟成日数＋バッファ」を引いて仕込み日を置き、そのうえで
                                <span className="text-foreground/70">最短で仕込める日・前の回との間隔・仕込める曜日・仮登録済みの日</span>
                                といった制約で前後に動かしています。実際にその日を決めた条件を右端に出しています。
                              </p>
                              {/* 全回で1つのgrid＝列が縦に揃う */}
                              <div className="grid grid-cols-[3.2rem_6.5rem_6.5rem_auto_auto] justify-start items-baseline gap-x-4 gap-y-1 whitespace-nowrap">
                                <span className="text-foreground/40 text-[10px]">回</span>
                                <span className="text-foreground/40 text-[10px]">仕込み日</span>
                                <span className="text-foreground/40 text-[10px]">完成予定</span>
                                <span className="text-foreground/40 text-[10px]">在庫が{outWord}日に間に合うか</span>
                                <span className="text-foreground/40 text-[10px] whitespace-normal">この日になった理由</span>
                                {plan.batches.map(b => {
                                  const genIndex = b.isFixed ? -1 : genBatches.indexOf(b)
                                  const hasRaw   = b.rawBrewDate !== undefined
                                  const pBrew    = (useRawAsBase && hasRaw) ? b.rawBrewDate! : b.brewDate
                                  const pComp    = (useRawAsBase && b.rawCompletionDate) ? b.rawCompletionDate : b.completionDate
                                  const pDays    = (useRawAsBase && b.rawFermentationDays !== undefined) ? b.rawFermentationDays : b.fermentationDays
                                  // 2本立ての回は遅い方の完成日で間に合うかを見る
                                  const lastComp = (b.pairCompletionDate && b.pairCompletionDate > pComp) ? b.pairCompletionDate : pComp
                                  const marginDays = differenceInDays(b.stockOutDate, lastComp)
                                  const isManual   = !b.isFixed && plan.manualPinIndices.includes(genIndex)
                                  const decidedTxt = isManual
                                    ? DECIDED_BY_LABEL.manual
                                    : DECIDED_BY_LABEL[b.decidedBy ?? 'stockout']
                                  return (
                                    <Fragment key={b.n}>
                                      <span className="text-foreground/60">{b.n}回目</span>
                                      <span className="tabular-nums font-medium text-foreground">
                                        {format(pBrew, 'M/d')}
                                        {b.pairBrewDate && <span className="text-foreground/60">＋{format(b.pairBrewDate, 'M/d')}</span>}
                                      </span>
                                      <span className="tabular-nums">
                                        {format(lastComp, 'M/d')}
                                        <span className="text-foreground/40">（{pDays}日）</span>
                                      </span>
                                      {b.isFixed ? (
                                        <span className="text-foreground/40">—</span>
                                      ) : (
                                        <span>
                                          <span className="tabular-nums">{format(b.stockOutDate, 'M/d')}</span>
                                          {marginDays >= 0
                                            ? <span className="text-emerald-700">{' の '}{marginDays} 日前に完成</span>
                                            : <span className="text-amber-600">{' に '}{-marginDays} 日 遅れて完成</span>}
                                        </span>
                                      )}
                                      <span className={`whitespace-normal ${b.isFixed ? 'text-emerald-700' : isManual ? 'text-amber-600' : 'text-foreground/60'}`}>
                                        {b.isFixed ? '仮登録で確定済み（計算ではなく実際の予定）' : decidedTxt}
                                      </span>
                                    </Fragment>
                                  )
                                })}
                              </div>
                              {plan.batches.some(b => !b.isFixed && differenceInDays(b.stockOutDate, (b.pairCompletionDate && b.pairCompletionDate > b.completionDate) ? b.pairCompletionDate : b.completionDate) < 0) && (
                                <p className="text-foreground/50 mt-1.5">
                                  ※「遅れて完成」の回は、熱源を充てて熟成を早めればリカバリできます（実績で最短21日）。
                                </p>
                              )}
                            </div>
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
                    // 2本立て（出荷ピーク期）の回はカレンダーにも相方の仕込み日・完成日を出す
                    if (b.pairBrewDate && !isNaN(b.pairBrewDate.getTime())) {
                      const pbk = format(b.pairBrewDate, 'yyyy-MM-dd')
                      typeEvMap.set(pbk, [...(typeEvMap.get(pbk) ?? []), { type: 'brew', misoType: plan.name, n: b.n }])
                    }
                    if (b.pairCompletionDate && !isNaN(b.pairCompletionDate.getTime())) {
                      const pck = format(b.pairCompletionDate, 'yyyy-MM-dd')
                      typeEvMap.set(pck, [...(typeEvMap.get(pck) ?? []), { type: 'comp', misoType: plan.name, n: b.n }])
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

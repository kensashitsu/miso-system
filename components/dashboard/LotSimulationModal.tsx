'use client'

import { useState, useMemo } from 'react'
import { differenceInDays, format, startOfDay } from 'date-fns'
import {
  ComposedChart, Area, Line, LabelList,
  XAxis, YAxis, CartesianGrid,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Tooltip,
} from 'recharts'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { X } from 'lucide-react'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { simulateLotForModal } from '@/lib/brewSimulation'

// ─── 型定義 ───────────────────────────────────────────────────

export interface LotSimConfig {
  weatherAvg:         Record<string, number>  // { 'MM-dd': effectiveTemp 月日平均 }
  q10Value:           number
  heatingBaseTemp:    number  // = heatingDefaultTemp
  room1Temp:          number  // 室内参照温度（dailyRoomAccum = room1Temp - 10）
  heatingDefaultTemp: number
  coolingDefaultTemp: number
  fridgeTemp:         number
}

type LocType = '暖房' | '冷房' | '常温' | '冷蔵庫'

interface LocationTransition {
  date: string  // yyyy-MM-dd
  from: string
  to:   string
}

interface Props {
  isOpen:               boolean
  onClose:              () => void
  lotNumber:            string
  misoType:             string
  brewedAtISO:          string
  elapsedDays:          number
  accumulatedTemp:      number
  targetTempSum:        number
  currentLocation:      string
  simConfig:            LotSimConfig
  locationTransitions?: LocationTransition[]
  completedAtISO?:      string | null
}

function getShortLoc(loc: string): string {
  if (loc === '常温')   return '常温'
  if (loc === '冷蔵庫') return '冷蔵'
  const m = loc.match(/^(暖房|冷房)/)
  if (m) return m[1]
  return loc.slice(0, 2)
}

// ─── ユーティリティ ───────────────────────────────────────────

function parseInitialLoc(loc: string): [LocType, number | null] {
  const m = loc.match(/^(暖房|冷房)(\d+(?:\.\d+)?)℃$/)
  if (m) return [m[1] as LocType, Number(m[2])]
  if (loc === '常温')  return ['常温',  null]
  if (loc === '冷蔵庫') return ['冷蔵庫', null]
  return ['暖房', null]
}

// WeatherSimulator と同一設計のカスタムツールチップ（dataKey 名だけ異なる）
function ModalTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; dataKey: string }>
  label?: string
}) {
  if (!active || !payload?.length || !label) return null

  const simple = payload.find(p => p.dataKey === 'simplePct')
  const q10    = payload.find(p => p.dataKey === 'maturityPct')
  const rows   = [simple, q10]
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .sort((a, b) => b.value - a.value)

  return (
    <div style={{
      background: 'rgba(255,255,255,0.93)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      border: '1px solid #e2e8f0',
      borderRadius: 6,
      boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
      padding: '10px 12px',
      minWidth: 172,
      fontSize: 12,
    }}>
      <p style={{ fontWeight: 700, color: '#1e293b', marginBottom: 6 }}>
        {label.replace(/-/g, '/')}
      </p>
      <hr style={{ border: 'none', borderTop: '1px solid #f1f5f9', marginBottom: 8 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map(p => {
          const isQ10 = p.dataKey === 'maturityPct'
          return (
            <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#475569' }}>
                {isQ10 ? (
                  <span style={{ display: 'inline-block', width: 16, height: 2.5, backgroundColor: '#2563eb', borderRadius: 2, flexShrink: 0 }} />
                ) : (
                  <span style={{
                    display: 'inline-block', width: 16, height: 2, flexShrink: 0,
                    background: 'repeating-linear-gradient(90deg,#94a3b8 0px,#94a3b8 4px,transparent 4px,transparent 7px)',
                  }} />
                )}
                {p.name}
              </span>
              <span style={{ fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                {p.value.toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── メインコンポーネント ──────────────────────────────────────

export default function LotSimulationModal({
  isOpen, onClose,
  lotNumber, misoType, brewedAtISO, elapsedDays,
  accumulatedTemp, targetTempSum, currentLocation,
  simConfig, locationTransitions = [], completedAtISO,
}: Props) {
  const {
    weatherAvg, q10Value, heatingBaseTemp,
    room1Temp, heatingDefaultTemp, coolingDefaultTemp, fridgeTemp,
  } = simConfig

  const [initLocType, initLocTemp] = parseInitialLoc(currentLocation)
  const [locType, setLocType] = useState<LocType>(initLocType)
  const [locTemp, setLocTemp] = useState<number>(
    initLocType === '暖房' ? (initLocTemp ?? heatingDefaultTemp) :
    initLocType === '冷房' ? (initLocTemp ?? coolingDefaultTemp) :
    heatingDefaultTemp
  )

  const currentPct     = targetTempSum > 0 ? Math.min(100, (accumulatedTemp / targetTempSum) * 100) : 0
  // 室内期間（10〜5月）は暖房デフォルト温度を使用（WeatherSimulator と統一）
  const dailyRoomAccum = Math.max(heatingBaseTemp - 10, 0)

  // ── シミュレーション（WeatherSimulator と同一関数） ──────────
  const {
    chartData,
    labelIndices,
    maturityComplete,
    accumulatedComplete,
    todayStr,
    maturityCompleteDateStr,
    hasQ10Effect,
    yAxisMax,
  } = useMemo(() => {
    const today    = startOfDay(new Date())
    const brewDate = startOfDay(new Date(brewedAtISO))
    const todStr   = format(today, 'yyyy-MM-dd')

    // 今日以降の「もしも」固定レート（常温は undefined → weatherAvg を継続使用）
    let futureFixedRate: number | undefined
    if (locType === '暖房' || locType === '冷房') {
      futureFixedRate = Math.max(locTemp - 10, 0)
    } else if (locType === '冷蔵庫') {
      futureFixedRate = Math.max(fridgeTemp - 10, 0)
    }

    // accumulatedTemp（今日時点の実績積算）を渡して今日の点を実績に合わせる。
    // これでカードの熟成度%・完成予定日とグラフが一致する
    const fullData = simulateLotForModal(
      brewDate, targetTempSum, weatherAvg, dailyRoomAccum,
      q10Value, heatingBaseTemp, futureFixedRate, locType === '暖房',
      accumulatedTemp,
    )

    const matCompleteIdx  = fullData.findIndex(d => d.maturityPct >= 100)
    const simpCompleteIdx = fullData.findIndex(d => d.simplePct   >= 100)
    const matComplete  = matCompleteIdx  >= 0 ? new Date(fullData[matCompleteIdx].date)  : null
    const simpComplete = simpCompleteIdx >= 0 ? new Date(fullData[simpCompleteIdx].date) : null
    const matCompStr   = matComplete ? format(matComplete, 'yyyy-MM-dd') : ''

    // 週次サンプリング（先頭・末尾・今日・100%到達日・場所移動日は必ず含む）
    const transitionDates = new Set(locationTransitions.map(t => t.date))
    const sampled = fullData.filter((d, i) => {
      if (i === 0 || i === fullData.length - 1) return true
      if ((i + 1) % 7 === 0) return true
      if (i === matCompleteIdx || i === simpCompleteIdx) return true
      if (d.date === todStr) return true
      if (transitionDates.has(d.date)) return true
      return false
    })

    // 線の上に出す日付ラベルの位置。以前は「1点おき（index % 2）」で、シミュレーション期間が
    // 長い（＝冬をまたいで200%到達まで数ヶ月かかる）ロットだと20個以上が並んで重なっていた。
    // 点数によらず最大 MAX_DATE_LABELS 個に間引く。今日・完成日は縦線側にラベルがあるので
    // ここでは出さない（同じ位置に二重に出て潰れるため）
    const MAX_DATE_LABELS = 8
    const step = Math.max(1, Math.ceil(sampled.length / MAX_DATE_LABELS))
    const labelIndices = new Set<number>()
    for (let i = 0; i < sampled.length; i += step) labelIndices.add(i)
    // 末尾は必ず出す（グラフの終端が何月か分からないと読めない）。
    // 直前のラベルと近すぎる場合はそちらを消す
    if (sampled.length > 1) {
      const lastIdx = sampled.length - 1
      if (!labelIndices.has(lastIdx)) {
        const prev = Math.max(...labelIndices)
        if (lastIdx - prev < step / 2) labelIndices.delete(prev)
        labelIndices.add(lastIdx)
      }
    }

    // Y軸最大値: データの最大値を10%単位に切り上げ+10、最低110
    const dataMax = fullData.reduce((m, d) => Math.max(m, d.maturityPct, d.simplePct), 0)
    const yMax = Math.max(110, Math.ceil(dataMax / 10) * 10 + 10)

    return {
      chartData:              sampled,
      labelIndices,
      maturityComplete:       matComplete,
      accumulatedComplete:    simpComplete,
      todayStr:               todStr,
      maturityCompleteDateStr: matCompStr,
      hasQ10Effect:           fullData.some(d => d.simplePct !== d.maturityPct),
      yAxisMax:               yMax,
    }
  }, [locType, locTemp, brewedAtISO, targetTempSum, room1Temp, fridgeTemp, accumulatedTemp,
      dailyRoomAccum, weatherAvg, q10Value, heatingBaseTemp, locationTransitions])

  const today           = startOfDay(new Date())
  const maturityDays    = maturityComplete    ? differenceInDays(maturityComplete,    today) : null
  const accumulatedDays = accumulatedComplete ? differenceInDays(accumulatedComplete, today) : null

  const completedAtDate    = completedAtISO ? startOfDay(new Date(completedAtISO)) : null
  const completedAtDateStr = completedAtDate ? format(completedAtDate, 'yyyy-MM-dd') : null

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-card rounded-xl shadow-2xl w-full max-w-2xl overflow-y-auto"
        style={{ maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-4">

          {/* ヘッダー */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold">{lotNumber}</h2>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={getMisoTypeBadgeStyle(misoType)}
              >
                {misoType}
              </span>
              <span className="text-sm text-muted-foreground">熟成シミュレーション</span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded text-muted-foreground hover:bg-muted transition-colors shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 現在の状況 */}
          <div className="bg-muted/30 rounded-lg px-3 py-2 text-sm flex flex-wrap gap-4">
            <span>進捗 <span className="font-semibold">{Math.round(currentPct)}%</span></span>
            <span>積算 <span className="font-semibold tabular-nums">{Math.round(accumulatedTemp)} / {targetTempSum} ℃・日</span></span>
            <span>経過 <span className="font-semibold tabular-nums">{elapsedDays} 日</span></span>
            <span>現在地 <span className="font-semibold">{currentLocation}</span></span>
          </div>

          {/* 完成予定サマリー */}
          {maturityComplete && maturityDays !== null && (
            <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5 text-sm">
              <p>
                <span className="text-muted-foreground">
                  {hasQ10Effect
                    ? (maturityDays <= 0 ? '完成日（Q10熟成値）：' : '完成予定日（Q10熟成値）：')
                    : (maturityDays <= 0 ? '完成日：' : '完成予定日：')}
                </span>
                <span className="font-semibold ml-1 text-primary">
                  {format(maturityComplete, 'M月d日')}
                  {maturityDays === 0
                    ? '（本日）'
                    : maturityDays < 0
                      ? `（${Math.abs(maturityDays)} 日前）`
                      : `（約 ${maturityDays} 日後）`}
                </span>
              </p>
              {hasQ10Effect && accumulatedComplete && accumulatedDays !== null && (
                <p>
                  <span className="text-muted-foreground">
                    {accumulatedDays <= 0 ? '完成日（単純積算）：' : '完成予定日（単純積算）：'}
                  </span>
                  <span className="font-semibold ml-1 text-muted-foreground">
                    {format(accumulatedComplete, 'M月d日')}
                    {accumulatedDays === 0
                      ? '（本日）'
                      : accumulatedDays < 0
                        ? `（${Math.abs(accumulatedDays)} 日前）`
                        : `（約 ${accumulatedDays} 日後）`}
                  </span>
                  {accumulatedDays !== maturityDays && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ← Q10補正で {Math.abs(accumulatedDays - maturityDays)} 日
                      {accumulatedDays > maturityDays ? '短縮' : '延長'}
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* 「もしも」シミュレーション */}
          <div className="border rounded-lg px-4 py-3 space-y-2.5">
            <p className="text-sm font-medium">
              「もしも」シミュレーション
              <span className="text-xs text-muted-foreground font-normal ml-2">
                今日以降の場所を変えた場合の完成日を試算
              </span>
            </p>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="space-y-1">
                <Label className="text-xs">仮の熟成場所</Label>
                <Select
                  value={locType}
                  onValueChange={(v) => {
                    const lt = v as LocType
                    setLocType(lt)
                    if (lt === '暖房') setLocTemp(heatingDefaultTemp)
                    if (lt === '冷房') setLocTemp(coolingDefaultTemp)
                  }}
                >
                  <SelectTrigger className="h-9 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="暖房">暖房</SelectItem>
                    <SelectItem value="冷房">冷房</SelectItem>
                    <SelectItem value="常温">常温</SelectItem>
                    <SelectItem value="冷蔵庫">冷蔵庫</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(locType === '暖房' || locType === '冷房') && (
                <div className="space-y-1">
                  <Label className="text-xs">設定温度</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={10}
                      max={45}
                      value={locTemp}
                      onChange={e => setLocTemp(Number(e.target.value))}
                      className="h-9 w-20"
                    />
                    <span className="text-sm text-muted-foreground">℃</span>
                    <span className="text-xs text-muted-foreground">
                      （有効積算 {Math.max(locTemp - 10, 0)} ℃/日）
                    </span>
                  </div>
                </div>
              )}

              {locType === '冷蔵庫' && (
                <p className="text-sm text-muted-foreground border-l pl-3">
                  冷蔵庫ではほぼ停止します
                </p>
              )}
            </div>
          </div>

          {/* グラフ（WeatherSimulator と同一デザイン） */}
          {chartData.length > 0 && (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={chartData} margin={{ top: 24, right: 16, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tick={false}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    domain={[0, yAxisMax]}
                    tickFormatter={v => `${v}%`}
                    stroke="hsl(var(--border))"
                  />

                  {/* 要注意ゾーン（120〜150%） */}
                  <ReferenceArea y1={120} y2={150} fill="#fef3c7" fillOpacity={0.55} ifOverflow="visible" />
                  {/* 着色リスク高ゾーン（150%〜） */}
                  <ReferenceArea y1={150} y2={300} fill="#fee2e2" fillOpacity={0.55} ifOverflow="visible" />

                  {/* 完成ライン（横、y=100） */}
                  <ReferenceLine
                    y={100}
                    stroke="#ef4444"
                    strokeDasharray="6 3"
                    label={{ value: '完成 100%', position: 'insideTopRight', fontSize: 11, fill: '#ef4444' }}
                  />

                  {/* 今日ライン（縦） */}
                  <ReferenceLine
                    x={todayStr}
                    stroke="#94a3b8"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={({ viewBox }) => {
                      const vb = viewBox as { x?: number; y?: number }
                      if (vb.x == null || vb.y == null) return <g />
                      return (
                        <text x={vb.x + 3} y={vb.y + 12} textAnchor="start" fontSize={9} fill="#64748b">
                          今日
                        </text>
                      )
                    }}
                  />

                  {/* 場所移動ライン（縦・アンバー） */}
                  {locationTransitions.map(t => (
                    <ReferenceLine
                      key={t.date}
                      x={t.date}
                      stroke="#d97706"
                      strokeDasharray="3 3"
                      strokeWidth={1.5}
                      label={({ viewBox }) => {
                        const vb = viewBox as { x?: number; y?: number }
                        if (vb.x == null || vb.y == null) return <g />
                        return (
                          <text x={vb.x + 3} y={vb.y + 22} textAnchor="start" fontSize={9} fill="#d97706">
                            →{getShortLoc(t.to)}
                          </text>
                        )
                      }}
                    />
                  ))}

                  {/* Q10完成予定日ライン（縦・常時ラベル） */}
                  {maturityCompleteDateStr && maturityComplete && (
                    <ReferenceLine
                      x={maturityCompleteDateStr}
                      stroke="#2563eb"
                      strokeDasharray="3 3"
                      strokeWidth={1.5}
                      label={({ viewBox }) => {
                        const vb = viewBox as { x?: number; y?: number }
                        if (vb.x == null || vb.y == null) return <g />
                        return (
                          <text x={vb.x + 3} y={vb.y + 12} textAnchor="start" fontSize={10} fill="#2563eb" fontWeight={600}>
                            {format(maturityComplete, 'M/d')} 完成
                          </text>
                        )
                      }}
                    />
                  )}

                  {/* 完成日ライン（縦・緑の実線） */}
                  {completedAtDateStr && completedAtDate && (
                    <ReferenceLine
                      x={completedAtDateStr}
                      stroke="#059669"
                      strokeWidth={2}
                      label={({ viewBox }) => {
                        const vb = viewBox as { x?: number; y?: number }
                        if (vb.x == null || vb.y == null) return <g />
                        return (
                          <text x={vb.x + 3} y={vb.y + 24} textAnchor="start" fontSize={10} fill="#059669" fontWeight={600}>
                            完成日 {format(completedAtDate, 'M/d')}
                          </text>
                        )
                      }}
                    />
                  )}

                  {/* Q10熟成値エリア（塗り潰しのみ・strokeなし） */}
                  <Area
                    type="monotone"
                    dataKey="maturityPct"
                    name="Q10熟成値"
                    stroke="none"
                    fill="#2563eb"
                    fillOpacity={0.10}
                    dot={false}
                    strokeWidth={0}
                    legendType="none"
                  />

                  {/* 単純積算（点線グレー）- Q10補正と差異がある場合のみ描画 */}
                  {hasQ10Effect && (
                    <Line
                      type="monotone"
                      dataKey="simplePct"
                      name="単純積算"
                      stroke="#94a3b8"
                      strokeDasharray="5 4"
                      dot={false}
                      strokeWidth={1.5}
                    />
                  )}

                  {/* Q10熟成値（実線ブルー）- 単純積算より後に描画して最前面へ */}
                  <Line
                    type="monotone"
                    dataKey="maturityPct"
                    name="Q10熟成値"
                    stroke="#2563eb"
                    dot={false}
                    strokeWidth={2.5}
                  >
                    <LabelList
                      dataKey="date"
                      position="top"
                      content={({ x, y, value, index }) => {
                        if (typeof index !== 'number' || !labelIndices.has(index)) return null
                        const lbl = typeof value === 'string' ? value.slice(5).replace('-', '/') : ''
                        return (
                          <text
                            x={x}
                            y={typeof y === 'number' ? y - 4 : y}
                            textAnchor="middle"
                            fontSize={10}
                            fill="hsl(var(--muted-foreground))"
                          >
                            {lbl}
                          </text>
                        )
                      }}
                    />
                  </Line>

                  <Tooltip
                    content={<ModalTooltip />}
                    wrapperStyle={{ padding: 0, border: 'none', background: 'none', boxShadow: 'none', outline: 'none' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>

              {/* 凡例 */}
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground justify-end pr-4">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-6 border-t-2" style={{ borderColor: '#2563eb' }} />
                  Q10熟成値（酵素反応補正あり）
                </span>
                {hasQ10Effect && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t border-dashed border-muted-foreground/70" />
                    単純積算（補正なし）
                  </span>
                )}
                {completedAtDateStr && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t-2" style={{ borderColor: '#059669' }} />
                    実際の完成日
                  </span>
                )}
                {yAxisMax > 110 && (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-300" />
                      要注意（120〜150%）
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-300" />
                      着色リスク高（150%〜）
                    </span>
                  </>
                )}
              </div>
            </>
          )}

          {/* 注意書き */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            {/* 注記は実際の計算に合わせて出し分ける。常温を選んだ場合は「10〜5月は暖房25℃」
                ではなく全期間で気象データを使っている（simulateLotForModal の
                futureFixedRate=undefined 分岐）。以前は常温でも室内期間の説明を出しており、
                冬に線が寝る理由が読み取れなかった（2026-08-31修正） */}
            {locType === '常温' ? (
              <>
                ※ 常温は全期間で過去気象データの月日平均を使用。
                有効積算温度は「平均気温 − 10℃」なので、平均気温が10℃を下回る12〜3月は熟成がほぼ止まります
                （グラフが横ばいになるのはこのため）。冬に暖房室へ移す運用であれば、
                「仮の熟成場所」で暖房を選ぶと実際に近い試算になります。
              </>
            ) : (
              <>
                ※ 今日以降は選択した場所（{locType}）の温度で試算。今日までは室内期間（10月〜5月）を
                暖房デフォルト温度 {heatingBaseTemp}℃、常温期間（6〜9月）を過去気象データの月日平均として計算しています。
              </>
            )}
            {hasQ10Effect
              ? `Q10係数 ${q10Value} で酵素反応速度を補正（高温時に傾きが急増、低温時に緩慢）。`
              : `現在の条件（室内温度 = 基準温度 ${heatingBaseTemp}℃）ではQ10補正係数が1.0となり、単純積算と一致するため1本表示。`}
            {' '}グラフは完成（100%）で止めず、着色の目安（120%要注意・150%リスク高）が見えるよう200%まで描いています。
          </p>

        </div>
      </div>
    </div>
  )
}

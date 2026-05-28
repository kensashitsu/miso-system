'use client'

import { useState } from 'react'
import { addDays, differenceInDays, format, subDays } from 'date-fns'
import {
  ComposedChart, Area, Line, LabelList,
  XAxis, YAxis, CartesianGrid,
  ReferenceLine, ResponsiveContainer, Tooltip,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Plus, X } from 'lucide-react'

interface Recipe {
  name: string
  targetTempSum: number
}

interface Props {
  recipes:            Recipe[]
  weatherAvg:         Record<string, number>  // { 'MM-dd': effectiveTemp }
  q10Value:           number
  heatingBaseTemp:    number
  coolingDefaultTemp: number
  fridgeTemp:         number
}

type LocType = '暖房' | '冷房' | '常温' | '冷蔵庫'

interface LocationMove {
  id:            string
  daysAfterBrew: number
  locType:       LocType
  temp:          number
}

type SimDay = {
  date:           string
  accumulatedPct: number
  maturityPct:    number
}

const LOC_COLORS: Record<LocType, string> = {
  '暖房':   '#ef4444',
  '冷房':   '#3b82f6',
  '常温':   '#16a34a',
  '冷蔵庫': '#7c3aed',
}

function locLabel(locType: LocType, temp: number): string {
  if (locType === '暖房') return `暖房${temp}℃`
  if (locType === '冷房') return `冷房${temp}℃`
  return locType
}

function getDailyAccum(
  locType:         LocType,
  locTemp:         number,
  dateStr:         string,
  weatherAvg:      Record<string, number>,
  q10Value:        number,
  heatingBaseTemp: number,
  fridgeTemp:      number,
): { simple: number; corrected: number } {
  if (locType === '暖房') {
    const eff = Math.max(locTemp - 10, 0)
    return { simple: eff, corrected: eff }
  }
  if (locType === '冷房') {
    const eff = Math.max(locTemp - 10, 0)
    return { simple: eff, corrected: eff }
  }
  if (locType === '冷蔵庫') {
    const eff = Math.max(fridgeTemp - 10, 0)
    return { simple: eff, corrected: eff }
  }
  // 常温: weatherAvg + Q10補正
  const mmDd = dateStr.slice(5)
  const eff  = weatherAvg[mmDd] ?? 0
  let corrected = eff
  if (eff > 0 && q10Value !== 1) {
    const avgTempC = eff + 10
    corrected = eff * Math.pow(q10Value, (avgTempC - heatingBaseTemp) / 10)
  }
  return { simple: eff, corrected }
}

interface LocSegment { startDay: number; locType: LocType; temp: number }

function simulate(
  startDate:       Date,
  targetTempSum:   number,
  weatherAvg:      Record<string, number>,
  segments:        LocSegment[],
  q10Value:        number,
  heatingBaseTemp: number,
  fridgeTemp:      number,
): SimDay[] {
  if (segments.length === 0 || targetTempSum <= 0) return []

  const sorted = [...segments].sort((a, b) => a.startDay - b.startDay)
  let current  = new Date(startDate)
  let total    = 0
  let maturity = 0
  const result: SimDay[] = []

  for (let i = 0; i < 730; i++) {
    let seg = sorted[0]
    for (const s of sorted) {
      if (s.startDay <= i) seg = s
    }

    const dateStr = format(current, 'yyyy-MM-dd')
    const { simple, corrected } = getDailyAccum(
      seg.locType, seg.temp, dateStr, weatherAvg, q10Value, heatingBaseTemp, fridgeTemp,
    )

    total    = Math.round((total    + simple)    * 10) / 10
    maturity = Math.round((maturity + corrected) * 10) / 10

    result.push({
      date:           dateStr,
      accumulatedPct: Math.min(100, Math.round(total    / targetTempSum * 1000) / 10),
      maturityPct:    Math.min(100, Math.round(maturity / targetTempSum * 1000) / 10),
    })

    if (total >= targetTempSum && maturity >= targetTempSum) break
    current = addDays(current, 1)
  }
  return result
}

function CustomTooltip({ active, payload, label }: {
  active?:  boolean
  payload?: Array<{ name: string; value: number; dataKey: string }>
  label?:   string
}) {
  if (!active || !payload?.length || !label) return null

  const simple = payload.find(p => p.dataKey === 'accumulatedPct')
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
      minWidth: 176,
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


export default function WeatherSimulator({
  recipes, weatherAvg, q10Value, heatingBaseTemp, coolingDefaultTemp, fridgeTemp,
}: Props) {
  const todayStr    = format(new Date(), 'yyyy-MM-dd')
  const todayMonth  = new Date().getMonth() + 1
  const defaultLoc  = todayMonth >= 6 && todayMonth <= 9 ? '常温' : '暖房'

  const [selectedType, setSelectedType] = useState(recipes[0]?.name ?? '')
  const [brewDate,     setBrewDate]     = useState(todayStr)
  const [initLocType,  setInitLocType]  = useState<LocType>(defaultLoc as LocType)
  const [initTemp,     setInitTemp]     = useState(heatingBaseTemp)
  const [moves,        setMoves]        = useState<LocationMove[]>([])

  const recipe        = recipes.find(r => r.name === selectedType)
  const targetTempSum = recipe?.targetTempSum ?? 0

  const sortedMoves = [...moves].sort((a, b) => a.daysAfterBrew - b.daysAfterBrew)
  const segments: LocSegment[] = [
    { startDay: 0, locType: initLocType, temp: initTemp },
    ...sortedMoves.map(m => ({ startDay: m.daysAfterBrew, locType: m.locType, temp: m.temp })),
  ]

  const fullData = brewDate && targetTempSum > 0
    ? simulate(new Date(brewDate), targetTempSum, weatherAvg, segments, q10Value, heatingBaseTemp, fridgeTemp)
    : []

  const maturityCompleteIdx    = fullData.findIndex(d => d.maturityPct    >= 100)
  const accumulatedCompleteIdx = fullData.findIndex(d => d.accumulatedPct >= 100)
  const maturityComplete    = maturityCompleteIdx    >= 0 ? new Date(fullData[maturityCompleteIdx].date)    : null
  const accumulatedComplete = accumulatedCompleteIdx >= 0 ? new Date(fullData[accumulatedCompleteIdx].date) : null

  const moveIndices = new Set(sortedMoves.map(m => m.daysAfterBrew).filter(d => d > 0 && d < fullData.length))
  const chartData = fullData.filter(
    (_, i) => i === 0 || (i + 1) % 7 === 0 || i === fullData.length - 1
      || i === maturityCompleteIdx || i === accumulatedCompleteIdx
      || moveIndices.has(i),
  )

  const maturityDays    = maturityComplete    && brewDate ? differenceInDays(maturityComplete,    new Date(brewDate)) : null
  const accumulatedDays = accumulatedComplete && brewDate ? differenceInDays(accumulatedComplete, new Date(brewDate)) : null
  const materialDeadline = brewDate ? subDays(new Date(brewDate), 21) : null
  const hasWeatherData   = Object.keys(weatherAvg).length > 0

  function addMove() {
    const lastDays = sortedMoves.length > 0
      ? sortedMoves[sortedMoves.length - 1].daysAfterBrew + 30
      : 90
    setMoves(prev => [...prev, {
      id:            Date.now().toString(),
      daysAfterBrew: lastDays,
      locType:       '常温',
      temp:          0,
    }])
  }

  function removeMove(id: string) {
    setMoves(prev => prev.filter(m => m.id !== id))
  }

  function updateMove(id: string, patch: Partial<LocationMove>) {
    setMoves(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
  }

  function handleMoveLocTypeChange(id: string, locType: LocType) {
    const temp = locType === '暖房' ? heatingBaseTemp
               : locType === '冷房' ? coolingDefaultTemp
               : 0
    updateMove(id, { locType, temp })
  }

  function handleInitLocTypeChange(locType: LocType) {
    setInitLocType(locType)
    if      (locType === '暖房') setInitTemp(heatingBaseTemp)
    else if (locType === '冷房') setInitTemp(coolingDefaultTemp)
  }

  function handleBrewDateChange(dateStr: string) {
    setBrewDate(dateStr)
    if (!dateStr) return
    const month = parseInt(dateStr.slice(5, 7), 10)
    if (month >= 6 && month <= 9) {
      setInitLocType('常温')
    } else {
      setInitLocType('暖房')
      setInitTemp(heatingBaseTemp)
    }
  }

  return (
    <section>
      <h2 className="text-base font-semibold mb-4">② 熟成シミュレーター</h2>
      <Card>
        <CardContent className="pt-5 space-y-5">

          {/* 品種・仕込み日 */}
          <div className="flex gap-4 flex-wrap items-end">
            <div className="space-y-1">
              <Label className="text-sm">品種</Label>
              <Select value={selectedType} onValueChange={(v: string | null) => { if (v) setSelectedType(v) }}>
                <SelectTrigger className="min-h-[40px] w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {recipes.map(r => (
                    <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">仕込み予定日</Label>
              <Input
                type="date"
                value={brewDate}
                onChange={e => handleBrewDateChange(e.target.value)}
                className="min-h-[40px] w-44"
              />
            </div>
            {targetTempSum > 0 && (
              <p className="text-xs text-muted-foreground pb-1">
                目標積算温度 {targetTempSum} ℃・日 ／ Q10係数 {q10Value}
              </p>
            )}
          </div>

          {/* 場所プラン */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">場所プラン</Label>

            {/* 初期場所 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground w-20 shrink-0">仕込み直後</span>
              <Select value={initLocType} onValueChange={(v: string | null) => { if (v) handleInitLocTypeChange(v as LocType) }}>
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
              {(initLocType === '暖房' || initLocType === '冷房') && (
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={10}
                    max={40}
                    value={initTemp}
                    onChange={e => setInitTemp(Number(e.target.value))}
                    className="h-9 w-20 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">℃</span>
                </div>
              )}
            </div>

            {/* 移動リスト */}
            {sortedMoves.map((move, idx) => (
              <div key={move.id} className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground w-20 shrink-0 text-right">↓</span>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    value={move.daysAfterBrew}
                    onChange={e => updateMove(move.id, { daysAfterBrew: Math.max(1, Number(e.target.value)) })}
                    className="h-9 w-20 text-sm"
                  />
                  <span className="text-xs text-muted-foreground">日後</span>
                </div>
                <Select value={move.locType} onValueChange={(v: string | null) => { if (v) handleMoveLocTypeChange(move.id, v as LocType) }}>
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
                {(move.locType === '暖房' || move.locType === '冷房') && (
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={10}
                      max={40}
                      value={move.temp}
                      onChange={e => updateMove(move.id, { temp: Number(e.target.value) })}
                      className="h-9 w-20 text-sm"
                    />
                    <span className="text-sm text-muted-foreground">℃</span>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => removeMove(move.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
                {fullData.length > 0 && move.daysAfterBrew <= fullData.length && (() => {
                  const pct = fullData[Math.min(move.daysAfterBrew - 1, fullData.length - 1)]?.maturityPct ?? 0
                  return (
                    <span className="text-xs text-muted-foreground">
                      移動時:{' '}
                      <span className="font-semibold tabular-nums" style={{ color: pct >= 100 ? '#16a34a' : pct >= 80 ? '#d97706' : '#0f172a' }}>
                        {pct.toFixed(1)}%
                      </span>
                    </span>
                  )
                })()}
              </div>
            ))}

            <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={addMove}>
              <Plus className="h-3.5 w-3.5" />
              場所移動を追加
            </Button>
          </div>

          {/* 結果サマリー */}
          {(maturityComplete || accumulatedComplete) && (
            <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5 text-sm">
              {maturityComplete && maturityDays !== null && (
                <p>
                  <span className="text-muted-foreground">完成予定日（Q10熟成値）：</span>
                  <span className="font-semibold ml-1 text-primary">
                    {format(maturityComplete, 'M月d日')}（約 {maturityDays} 日間）
                  </span>
                </p>
              )}
              {accumulatedComplete && accumulatedDays !== null && (
                <p>
                  <span className="text-muted-foreground">完成予定日（単純積算）：</span>
                  <span className="font-semibold ml-1 text-muted-foreground">
                    {format(accumulatedComplete, 'M月d日')}（約 {accumulatedDays} 日間）
                  </span>
                  {maturityDays !== null && accumulatedDays !== maturityDays && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ← Q10補正で {Math.abs(accumulatedDays - maturityDays)} 日{accumulatedDays > maturityDays ? '短縮' : '延長'}
                    </span>
                  )}
                </p>
              )}
              {materialDeadline && (
                <p>
                  <span className="text-muted-foreground">原料手配締切：</span>
                  <span className="font-semibold ml-1">
                    {format(materialDeadline, 'M月d日')}
                    <span className="text-muted-foreground font-normal ml-1">（仕込み日の21日前）</span>
                  </span>
                </p>
              )}
              {segments.length > 1 && (
                <p className="pt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="text-muted-foreground shrink-0">場所プラン：</span>
                  {segments.map((s, idx) => (
                    <span key={idx} className="flex items-center gap-1 text-xs">
                      {idx > 0 && <span className="text-muted-foreground">→ {s.startDay}日目</span>}
                      <span className="font-semibold" style={{ color: LOC_COLORS[s.locType] }}>
                        {locLabel(s.locType, s.temp)}
                      </span>
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          {/* グラフ */}
          {chartData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={260}>
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
                    domain={[0, 110]}
                    tickFormatter={v => `${v}%`}
                    stroke="hsl(var(--border))"
                  />

                  {/* 完成ライン（100%） */}
                  <ReferenceLine
                    y={100}
                    stroke="hsl(var(--destructive))"
                    strokeDasharray="6 3"
                    label={{
                      value: '完成 100%',
                      position: 'insideTopRight',
                      fontSize: 11,
                      fill: 'hsl(var(--destructive))',
                    }}
                  />

                  {/* Q10完成予定日（実線・青） */}
                  {maturityCompleteIdx >= 0 && maturityComplete != null && (
                    <ReferenceLine
                      x={fullData[maturityCompleteIdx].date}
                      stroke="#2563eb"
                      strokeWidth={1.5}
                      label={({ viewBox }) => {
                        const vb = viewBox as { x?: number; y?: number }
                        if (vb.x == null || vb.y == null) return <g />
                        return (
                          <text x={vb.x + 4} y={vb.y + 12} textAnchor="start" fontSize={10} fill="#2563eb" fontWeight={600}>
                            {format(maturityComplete, 'M/d')} 完成
                          </text>
                        )
                      }}
                    />
                  )}

                  {/* 単純積算完成日（点線・グレー）：Q10と異なる場合のみ */}
                  {q10Value !== 1 && accumulatedCompleteIdx >= 0 && accumulatedComplete != null
                    && accumulatedCompleteIdx !== maturityCompleteIdx && (
                    <ReferenceLine
                      x={fullData[accumulatedCompleteIdx].date}
                      stroke="#94a3b8"
                      strokeDasharray="5 3"
                      strokeWidth={1.5}
                      label={({ viewBox }) => {
                        const vb = viewBox as { x?: number; y?: number }
                        if (vb.x == null || vb.y == null) return <g />
                        return (
                          <text x={vb.x + 4} y={vb.y + 12} textAnchor="start" fontSize={10} fill="#94a3b8" fontWeight={600}>
                            {format(accumulatedComplete, 'M/d')} 補正なし
                          </text>
                        )
                      }}
                    />
                  )}

                  {/* 場所移動縦線 */}
                  {sortedMoves.map((move, idx) => {
                    const date  = fullData[move.daysAfterBrew]?.date
                    if (!date) return null
                    const color = LOC_COLORS[move.locType]
                    const pct   = fullData[Math.min(move.daysAfterBrew - 1, fullData.length - 1)]?.maturityPct ?? 0
                    return (
                      <ReferenceLine
                        key={move.id}
                        x={date}
                        stroke={color}
                        strokeDasharray="4 3"
                        strokeWidth={1.5}
                        label={({ viewBox }) => {
                          const vb = viewBox as { x?: number; y?: number }
                          if (vb.x == null || vb.y == null) return <g />
                          const yOffset = idx % 2 === 0 ? 12 : 26
                          return (
                            <text x={vb.x + 4} y={vb.y + yOffset} textAnchor="start" fontSize={10} fill={color} fontWeight={600}>
                              → {locLabel(move.locType, move.temp)}（{pct.toFixed(1)}%）
                            </text>
                          )
                        }}
                      />
                    )
                  })}

                  {/* Q10補正熟成値（実線・エリア） */}
                  <Area
                    type="monotone"
                    dataKey="maturityPct"
                    name="Q10熟成値"
                    stroke="#2563eb"
                    fill="#2563eb"
                    fillOpacity={0.10}
                    dot={false}
                    strokeWidth={2.5}
                  >
                    <LabelList
                      dataKey="date"
                      position="top"
                      content={({ x, y, value, index }) => {
                        if (typeof index !== 'number' || index % 2 !== 0) return null
                        const label = typeof value === 'string' ? value.slice(5).replace('-', '/') : ''
                        return (
                          <text
                            x={x}
                            y={typeof y === 'number' ? y - 4 : y}
                            textAnchor="middle"
                            fontSize={10}
                            fill="hsl(var(--muted-foreground))"
                          >
                            {label}
                          </text>
                        )
                      }}
                    />
                  </Area>

                  {/* 単純積算（点線グレー） */}
                  <Line
                    type="monotone"
                    dataKey="accumulatedPct"
                    name="単純積算"
                    stroke="#64748b"
                    strokeDasharray="6 3"
                    dot={false}
                    strokeWidth={2}
                  />

                  <Tooltip
                    content={<CustomTooltip />}
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
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-6 border-t border-dashed border-muted-foreground/70" />
                  単純積算（補正なし）
                </span>
                {sortedMoves.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t border-dashed" style={{ borderColor: '#6b7280' }} />
                    場所移動
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              品種と仕込み予定日を入力してください
            </div>
          )}

          {/* 注意事項 */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            ※ 常温の積算は
            {hasWeatherData
              ? `過去気象データの月日平均を使用（Q10係数 ${q10Value} で酵素反応速度を補正）。`
              : '気象データ未取込のためデフォルト値（0℃/日）を使用。設定画面から取り込むと精度が向上します。'}
            暖房・冷房は設定温度から10℃を引いた値を毎日加算。
          </p>
        </CardContent>
      </Card>
    </section>
  )
}

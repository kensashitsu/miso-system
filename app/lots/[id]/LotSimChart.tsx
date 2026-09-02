'use client'

import { useMemo } from 'react'
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'
import {
  ComposedChart, Area, Line, LabelList,
  XAxis, YAxis, CartesianGrid,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Tooltip,
} from 'recharts'
import { HEATING_MONTHLY_FACTOR } from '@/lib/tempCalc'

const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/

interface LocationPeriodItem {
  location:     string
  startDateISO: string
  endDateISO:   string | null
}

interface SimDay {
  date:        string
  maturityPct: number
  simplePct:   number
}

interface Props {
  brewedAtISO:     string
  targetTempSum:   number
  weatherAvg:      Record<string, number>
  heatingBaseTemp: number
  q10Value:        number
  fridgeTemp:      number
  locationPeriods: LocationPeriodItem[]
  completedAtISO?: string | null
  // 今日時点の実績積算温度（℃・日）。渡すと今日の点が実績と一致するよう較正する。
  // これが無いと、同じ画面のヘッダー「完成予定」（較正あり）と数日ズレる
  actualAccumToday?: number | null
}

// ── 縦線イベント ──────────────────────────────────────────────
type LineEventKind = 'completed' | 'transition' | 'assumed' | 'today' | 'prediction'

interface EventStyle {
  stroke:           string
  strokeDasharray?: string
  strokeWidth:      number
}

const EVENT_PRIORITY: Record<LineEventKind, number> = {
  completed:  1,
  transition: 2,
  assumed:    3,
  today:      4,
  prediction: 5,
}

const EVENT_STYLE: Record<LineEventKind, EventStyle> = {
  completed:  { stroke: '#059669', strokeWidth: 2 },
  transition: { stroke: '#d97706', strokeDasharray: '3 3', strokeWidth: 1.5 },
  // 実際の移動記録ではなく「これから移す予定」の目安なので、同じ橙でより細く薄い破線にする
  assumed:    { stroke: '#f59e0b', strokeDasharray: '2 5', strokeWidth: 1.2 },
  today:      { stroke: '#94a3b8', strokeDasharray: '3 4', strokeWidth: 1 },
  prediction: { stroke: '#2563eb', strokeDasharray: '3 3', strokeWidth: 1.5 },
}

interface LineEvent {
  date:  string
  kind:  LineEventKind
  label: string
}

interface GroupedLine {
  date:     string
  style:    EventStyle
  label:    string
  labelPos: 'top' | 'mid'
}

/**
 * 縦線イベントを日付近接（3日以内）でグループ化し、ラベルを交互配置する。
 * 同一グループ内は優先度順に主線色でまとめて1本の縦線にする。
 */
function buildGroupedLines(events: LineEvent[]): GroupedLine[] {
  if (events.length === 0) return []

  const sorted = [...events].sort((a, b) =>
    a.date !== b.date
      ? a.date.localeCompare(b.date)
      : EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind],
  )

  // 最初のイベント日から3日以内は同一グループ（greedy）
  const groups: LineEvent[][] = []
  for (const ev of sorted) {
    const last = groups[groups.length - 1]
    if (last) {
      const diff = differenceInDays(
        new Date(ev.date + 'T00:00:00'),
        new Date(last[0].date + 'T00:00:00'),
      )
      if (diff <= 3) { last.push(ev); continue }
    }
    groups.push([ev])
  }

  return groups.map((group, idx) => {
    const sg      = [...group].sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind])
    const primary = sg[0]
    const allSameDay = group.every(e => e.date === primary.date)
    const label = sg.length === 1
      ? primary.label
      : allSameDay
        ? `${primary.label}（${sg.slice(1).map(e => e.label).join('・')}）`
        : sg.map(e => e.label).join('・')
    return {
      date:     primary.date,
      style:    EVENT_STYLE[primary.kind],
      label,
      labelPos: (idx % 2 === 0 ? 'top' : 'mid') as 'top' | 'mid',
    }
  })
}

// ── ユーティリティ ─────────────────────────────────────────────
function getShortLoc(loc: string): string {
  if (loc === '常温')   return '常温'
  if (loc === '冷蔵庫') return '冷蔵'
  const m = loc.match(/^(暖房|冷房)/)
  if (m) return m[1]
  return loc.slice(0, 2)
}

// ── ツールチップ ──────────────────────────────────────────────
function SimTooltip({ active, payload, label }: {
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

// ── シミュレーション（場所履歴ベース） ────────────────────────
function simulateWithHistory(
  brewDate:        Date,
  targetTempSum:   number,
  weatherAvg:      Record<string, number>,
  locationPeriods: LocationPeriodItem[],
  q10Value:        number,
  heatingBaseTemp: number,
  fridgeTemp:      number,
  actualAccumToday?: number | null,
): SimDay[] {
  if (!locationPeriods.length || targetTempSum <= 0) return []
  const today = startOfDay(new Date())
  let calibrated = false

  const periods = locationPeriods.map(p => ({
    location: p.location,
    startMs:  startOfDay(new Date(p.startDateISO)).getTime(),
    endMs:    p.endDateISO ? startOfDay(new Date(p.endDateISO)).getTime() : Infinity,
  }))

  function getLocation(dateMs: number): string {
    for (const p of periods) {
      if (dateMs >= p.startMs && dateMs < p.endMs) return p.location
    }
    return periods[periods.length - 1].location
  }

  let curr          = startOfDay(new Date(brewDate))
  let totalSimple   = 0
  let totalMaturity = 0
  const result: SimDay[] = []

  for (let i = 0; i < 730; i++) {
    const loc  = getLocation(curr.getTime())
    const mmdd = format(curr, 'MM-dd')

    const fixedMatch = loc.match(TEMP_LOCATION_RE)
    let eff       = 0
    let isOutdoor = false
    if (fixedMatch) {
      eff = Math.max(Number(fixedMatch[1]) - 10, 0)
      // 暖房は月別の実効レート補正を掛ける（lib/brewSimulation と同じ扱い。
      // 冷房・温調室は対象外）。これが無いと暖房期の完成予定が他画面とズレる
      if (loc.startsWith('暖房')) eff *= HEATING_MONTHLY_FACTOR[curr.getMonth() + 1] ?? 1
    } else if (loc === '冷蔵庫') {
      eff = Math.max(fridgeTemp - 10, 0)
    } else {
      // 常温。今日以降の10〜5月は暖房室へ移して熟成させる運用のため、暖房デフォルト温度で積む
      // （月別補正あり）。過去は実際に常温にいた期間なので気象データのまま（2026-09-02）
      const month = curr.getMonth() + 1
      const movedToHeating = curr.getTime() > today.getTime() && !(month >= 6 && month <= 9)
      if (movedToHeating) {
        eff = Math.max(heatingBaseTemp - 10, 0) * (HEATING_MONTHLY_FACTOR[month] ?? 1)
      } else {
        eff = weatherAvg[mmdd] ?? 0
        isOutdoor = true
      }
    }

    totalSimple = Math.round((totalSimple + eff) * 10) / 10

    // Q10補正は常温のみ（CLAUDE.md準拠）
    const corrected = (isOutdoor && eff > 0 && q10Value !== 1)
      ? eff * Math.pow(q10Value, (eff + 10 - heatingBaseTemp) / 10)
      : eff
    totalMaturity = Math.round((totalMaturity + corrected) * 10) / 10

    result.push({
      date:        format(curr, 'yyyy-MM-dd'),
      maturityPct: Math.round(totalMaturity / targetTempSum * 1000) / 10,
      simplePct:   Math.round(totalSimple   / targetTempSum * 1000) / 10,
    })

    // 今日の時点で実績積算に合わせて較正する（lib/brewSimulation.simulateLotForModal と同じ方式）。
    // 過去も weatherAvg（月日平均）で積んだモデル値なので、実際の日別気温で積んだ実績とズレる。
    // 今日が実績と一致するよう過去を比例で伸縮し、今日以降はそこからモデルの増分を積む
    if (!calibrated && actualAccumToday != null && curr.getTime() === today.getTime()) {
      calibrated = true
      if (totalMaturity > 0) {
        const k = actualAccumToday / totalMaturity
        totalMaturity = actualAccumToday
        totalSimple   = Math.round(totalSimple * k * 10) / 10
        for (const r of result) {
          r.maturityPct = Math.round(r.maturityPct * k * 10) / 10
          r.simplePct   = Math.round(r.simplePct   * k * 10) / 10
        }
      }
    }

    if (totalSimple >= targetTempSum * 2 && totalMaturity >= targetTempSum * 2) break
    curr = addDays(curr, 1)
  }

  return result
}

// ── メインコンポーネント ──────────────────────────────────────
export default function LotSimChart({
  brewedAtISO, targetTempSum, weatherAvg,
  heatingBaseTemp, q10Value, fridgeTemp,
  locationPeriods, completedAtISO, actualAccumToday,
}: Props) {
  const locationTransitions = useMemo(() =>
    locationPeriods.slice(1).map((p, i) => ({
      date: format(startOfDay(new Date(p.startDateISO)), 'yyyy-MM-dd'),
      from: locationPeriods[i].location,
      to:   p.location,
    }))
  , [locationPeriods])

  const {
    chartData,
    maturityComplete,
    accumulatedComplete,
    maturityCompleteDateStr,
    todayStr,
    hasQ10Effect,
    yAxisMax,
    completedAtAccumKg,
    displayDays,
    assumedTransitions,
  } = useMemo(() => {
    const today    = startOfDay(new Date())
    const brewDate = startOfDay(new Date(brewedAtISO))
    const todStr   = format(today, 'yyyy-MM-dd')
    const completedAtDateLocal = completedAtISO ? startOfDay(new Date(completedAtISO)) : null

    const fullData = simulateWithHistory(
      brewDate, targetTempSum, weatherAvg,
      locationPeriods, q10Value, heatingBaseTemp, fridgeTemp, actualAccumToday,
    )

    const matCompleteIdx  = fullData.findIndex(d => d.maturityPct >= 100)
    const simpCompleteIdx = fullData.findIndex(d => d.simplePct   >= 100)
    const matComplete     = matCompleteIdx  >= 0 ? new Date(fullData[matCompleteIdx].date  + 'T00:00:00') : null
    const simpComplete    = simpCompleteIdx >= 0 ? new Date(fullData[simpCompleteIdx].date + 'T00:00:00') : null
    const matCompStr      = matComplete ? format(matComplete, 'yyyy-MM-dd') : ''

    // 表示終端：完成済み → completedAt+14日、熟成中 → 予測完成日+7日 or 今日+30日
    const displayEnd = completedAtDateLocal
      ? addDays(completedAtDateLocal, 14)
      : matComplete
        ? addDays(matComplete, 7)
        : addDays(today, 30)
    const displayEndStr = format(displayEnd, 'yyyy-MM-dd')
    const dispDays = differenceInDays(displayEnd, brewDate)

    // 短期間は密にサンプリング、長期間は間引く
    const samplingStep = dispDays <= 10 ? 1 : dispDays <= 30 ? 2 : 7

    const transitionDates = new Set(locationTransitions.map(t => t.date))

    // 常温のままのロットは10〜5月を暖房室として積算している（simulateWithHistory 参照）。
    // 傾きが変わるだけでは何が起きたのか読み取れないため、「これから移す予定」の
    // 縦線として出す（実際の移動記録とは別スタイル）。X軸が日付カテゴリのため、
    // 縦線を引く日はサンプリングで間引かれないよう必ず残す
    const lastLoc  = locationPeriods[locationPeriods.length - 1]?.location ?? ''
    const isOutdoorLot = lastLoc !== '' && !TEMP_LOCATION_RE.test(lastLoc) && lastLoc !== '冷蔵庫'
    const assumed: { date: string; label: string }[] = []
    if (isOutdoorLot) {
      const firstStr = format(brewDate, 'yyyy-MM-dd')
      for (let y = brewDate.getFullYear(); y <= displayEnd.getFullYear(); y++) {
        for (const [md, label] of [['10-01', '→暖房（予定）'], ['06-01', '→常温（予定）']] as const) {
          const d = `${y}-${md}`
          if (d > todStr && d >= firstStr && d <= displayEndStr) assumed.push({ date: d, label })
        }
      }
    }
    const assumedDates = new Set(assumed.map(a => a.date))
    const completedAtDateStr = completedAtDateLocal ? format(completedAtDateLocal, 'yyyy-MM-dd') : null

    const completedAtPoint = completedAtDateStr
      ? fullData.find(d => d.date === completedAtDateStr)
      : null
    const completedAtAccumKg = completedAtPoint != null
      ? Math.round(completedAtPoint.maturityPct * targetTempSum / 100)
      : null

    const sampled = fullData.filter((d, i) => {
      if (d.date > displayEndStr) return false
      if (i === 0 || d.date === displayEndStr) return true
      if (i % samplingStep === 0) return true
      if (i === matCompleteIdx || i === simpCompleteIdx) return true
      if (d.date === todStr) return true
      if (transitionDates.has(d.date)) return true
      if (assumedDates.has(d.date)) return true
      if (completedAtDateStr && d.date === completedAtDateStr) return true
      return false
    })

    // yMax は表示範囲内のデータのみで算出
    const dataMax = sampled.reduce((m, d) => Math.max(m, d.maturityPct, d.simplePct), 0)
    const yMax = Math.max(110, Math.ceil(dataMax / 10) * 10 + 10)

    return {
      chartData:               sampled,
      maturityComplete:        matComplete,
      accumulatedComplete:     simpComplete,
      maturityCompleteDateStr: matCompStr,
      todayStr:                todStr,
      hasQ10Effect:            fullData.some(d => d.simplePct !== d.maturityPct),
      yAxisMax:                yMax,
      completedAtAccumKg,
      displayDays:             dispDays,
      assumedTransitions:      assumed,
    }
  }, [brewedAtISO, targetTempSum, weatherAvg, locationPeriods,
      q10Value, heatingBaseTemp, fridgeTemp, locationTransitions, completedAtISO, actualAccumToday])

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        データなし
      </div>
    )
  }

  const today           = startOfDay(new Date())
  const maturityDays    = maturityComplete    ? differenceInDays(maturityComplete,    today) : null
  const accumulatedDays = accumulatedComplete ? differenceInDays(accumulatedComplete, today) : null

  const completedAtDate    = completedAtISO ? startOfDay(new Date(completedAtISO)) : null
  const completedAtDateStr = completedAtDate ? format(completedAtDate, 'yyyy-MM-dd') : null

  // 表示期間に応じてX軸ラベルの間引き数を決定
  // （LabelListのindexはsampledデータのインデックス）
  const labelStep = displayDays <= 30 ? 1 : displayDays <= 90 ? 2 : 4

  // ── 縦線イベントをグループ化 ──────────────────────────────────
  const lineEvents: LineEvent[] = [
    { date: todayStr, kind: 'today', label: '今日' },
    ...locationTransitions.map(t => ({
      date:  t.date,
      kind:  'transition' as LineEventKind,
      label: `→${getShortLoc(t.to)}`,
    })),
    ...assumedTransitions.map(t => ({
      date:  t.date,
      kind:  'assumed' as LineEventKind,
      label: t.label,
    })),
    ...(maturityCompleteDateStr && maturityComplete
      ? [{ date: maturityCompleteDateStr, kind: 'prediction' as LineEventKind, label: `${format(maturityComplete, 'M/d')}予測` }]
      : []),
    ...(completedAtDateStr && completedAtDate
      ? [{ date: completedAtDateStr, kind: 'completed' as LineEventKind, label: `完成${format(completedAtDate, 'M/d')}` }]
      : []),
  ]
  const groupedLines = buildGroupedLines(lineEvents)

  return (
    <div className="space-y-2">

      {/* サマリー */}
      {completedAtDate ? (
        <div className="rounded-lg bg-emerald-50/60 border border-emerald-200/60 px-4 py-3 text-sm">
          <p>
            <span className="text-muted-foreground">実際の完成日：</span>
            <span className="font-semibold ml-1 text-emerald-700">
              {format(completedAtDate, 'yyyy年M月d日')}
            </span>
            {completedAtAccumKg != null && (
              <span className="ml-2 text-xs text-muted-foreground">
                （積算温度 {completedAtAccumKg} / {targetTempSum} ℃・日時点）
              </span>
            )}
          </p>
        </div>
      ) : (
        maturityComplete && maturityDays !== null && (
          <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5 text-sm">
            <p>
              <span className="text-muted-foreground">
                {hasQ10Effect
                  ? (maturityDays <= 0 ? '完成日（Q10シミュレーション）：' : '完成予定日（Q10シミュレーション）：')
                  : (maturityDays <= 0 ? '完成日（シミュレーション）：' : '完成予定日（シミュレーション）：')}
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
        )
      )}

      {/* グラフ */}
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={chartData} margin={{ top: 24, right: 16, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="date" tick={false} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11 }} domain={[0, yAxisMax]} tickFormatter={v => `${v}%`} stroke="hsl(var(--border))" />

          {/* 要注意ゾーン（120〜150%） */}
          <ReferenceArea y1={120} y2={150} fill="#fef3c7" fillOpacity={0.55} ifOverflow="visible" />
          {/* 着色リスク高ゾーン（150%〜） */}
          <ReferenceArea y1={150} y2={300} fill="#fee2e2" fillOpacity={0.55} ifOverflow="visible" />

          {/* 完成ライン（横） */}
          <ReferenceLine
            y={100}
            stroke="#ef4444"
            strokeDasharray="6 3"
            label={{ value: '完成 100%', position: 'insideTopRight', fontSize: 11, fill: '#ef4444' }}
          />

          {/* 縦線（グループ化済み・ラベル交互配置） */}
          {groupedLines.map((gl, i) => (
            <ReferenceLine
              key={`refline-${i}`}
              x={gl.date}
              stroke={gl.style.stroke}
              strokeDasharray={gl.style.strokeDasharray}
              strokeWidth={gl.style.strokeWidth}
              label={({ viewBox }) => {
                const vb = viewBox as { x?: number; y?: number }
                if (vb.x == null || vb.y == null) return <g />
                const yPos = gl.labelPos === 'top' ? vb.y + 12 : vb.y + 28
                return (
                  <text
                    x={vb.x + 3}
                    y={yPos}
                    textAnchor="start"
                    fontSize={9}
                    fill={gl.style.stroke}
                    fontWeight={gl.style.strokeWidth >= 2 ? 600 : 400}
                  >
                    {gl.label}
                  </text>
                )
              }}
            />
          ))}

          {/* Q10熟成値エリア（塗り潰しのみ） */}
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

          {/* 単純積算（点線グレー） */}
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

          {/* Q10熟成値（実線ブルー） */}
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
                if (typeof index !== 'number' || index % labelStep !== 0) return null
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
            content={<SimTooltip />}
            wrapperStyle={{ padding: 0, border: 'none', background: 'none', boxShadow: 'none', outline: 'none' }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* 凡例 */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground justify-end pr-4">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 border-t-2" style={{ borderColor: '#2563eb' }} />
          Q10熟成値（常温期間に酵素補正あり）
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

      {/* 注釈 */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        ※ 場所履歴に基づき各期間の温度で積算（暖房・冷房は設定温度固定、常温は気象データ月日平均）。
        常温のまま今日以降が10〜5月にかかる分は、暖房室（{heatingBaseTemp}℃）へ移す前提で積算しています。
        {hasQ10Effect
          ? `常温期間にQ10係数 ${q10Value} で酵素反応速度を補正（青線 vs 点線の差が補正効果）。`
          : '常温期間がないためQ10補正の差異なし。'}
      </p>
    </div>
  )
}

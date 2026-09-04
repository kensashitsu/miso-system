'use client'

import { useMemo, useState } from 'react'
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceDot, ResponsiveContainer,
} from 'recharts'
import type { PlacedBrew } from '@/lib/brewCombine'

// まとめ提案の根拠。
//
// 3品種を1枚に重ねると、鋸歯が3本交差して読めないうえ、安全在庫ラインが
// どの品種のものか分からなくなる（ラインの高さは品種ごとに違う）。
// **縦に3段に分ける**と線は交差せず、ラインもその段の品種のものだと一目で分かる。
// 見せ方は品種ごとの提案のグラフ（StockProjectionChart）に揃えている
// ＝実在庫の面グラフ＋安全在庫ラインの破線。
//
// x軸は3段で共通なので、ある週を縦に見れば「そのときどの品種が苦しいか」を比べられる。
// 枠の取り合いは余裕の少ない品種が勝つので、これがそのまま割り当ての根拠になる。
export const SERIES_COLOR: Record<string, string> = {
  '無添加麦みそ': '#12A47A',
  '田舎みそ':     '#C97A0E',
  '山吹みそ':     '#6355E0',
}
const SAFETY_COLOR = '#d97706'   // amber-600（品種ごとのグラフと同じ）

export interface StockSeriesInput {
  misoType:         string
  effectiveStock:   number
  getDailyRateFn:   (date: Date) => number
  safetyLineFn:     ((date: Date) => number) | null
  baseSupplyEvents: { date: Date; kg: number }[]
  batchKg:          number
}

interface Row { d: string; kg: number; safety: number }

// 完成点に添えるラベル。1行目＝桶番号、2行目＝仕込み日と熟成日数。
// 1行に繋げると隣の完成点のラベルと重なって読めない（品種ごとのグラフと同じ扱い）
function completionLabel(main: string, sub: string, color: string, lift: number) {
  return (props: { viewBox?: { x?: number; y?: number } }) => {
    const { x = 0, y = 0 } = props.viewBox ?? {}
    return (
      <text
        x={x} y={y - lift} textAnchor="middle" fill={color}
        stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
      >
        <tspan x={x} dy={-14} fontSize={9}>{main}</tspan>
        <tspan x={x} dy={9} fontSize={8} fillOpacity={0.75}>{sub}</tspan>
      </text>
    )
  }
}

// 表示期間。先まで見たいときと、直近の谷だけ詰めて見たいときで必要な幅が違う
const RANGES = [
  { key: '3m',  label: '3ヶ月', days: 92 },
  { key: '6m',  label: '6ヶ月', days: 183 },
  { key: '1y',  label: '1年',   days: 365 },
  { key: 'all', label: '提案の最後まで', days: 0 },  // 0＝最後の完成日＋30日まで
] as const

export default function CombinedStockChart({
  series,
  placed,
}: {
  series: StockSeriesInput[]
  placed: PlacedBrew[]   // 置き直したあとの仕込み（完成日に生産量が入る）
}) {
  const today = startOfDay(new Date())
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]['key']>('6m')

  const days = useMemo(() => {
    const r = RANGES.find(r => r.key === rangeKey)!
    if (r.days > 0) return r.days
    const last = placed.reduce((mx, b) => (b.completionDate > mx ? b.completionDate : mx), today)
    return Math.max(92, differenceInDays(last, today) + 30)
  }, [rangeKey, placed, today])

  const panels = useMemo(() => series.map(s => {
    // 補充は「熟成中＋仮登録の完成」＋「まとめ提案の完成」。
    // 仮登録済み（isFixed）は baseSupplyEvents に既に入っているので足さない（二重計上になる）
    const supply = new Map<string, number>()
    for (const e of s.baseSupplyEvents) {
      const k = format(e.date, 'yyyy-MM-dd')
      supply.set(k, (supply.get(k) ?? 0) + e.kg)
    }
    for (const b of placed.filter(b => b.misoType === s.misoType && !b.isFixed)) {
      const k = format(b.completionDate, 'yyyy-MM-dd')
      supply.set(k, (supply.get(k) ?? 0) + s.batchKg)
    }

    const rows: Row[] = []
    let stock = s.effectiveStock
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i)
      const k    = format(date, 'yyyy-MM-dd')
      stock += supply.get(k) ?? 0
      stock -= s.getDailyRateFn(date)
      rows.push({ d: k, kg: Math.round(stock), safety: Math.round(s.safetyLineFn ? s.safetyLineFn(date) : 0) })
    }

    const marks = placed
      .filter(b => b.misoType === s.misoType)
      .flatMap(b => ([
        { kind: '仕込み' as const, d: format(b.brewDate, 'yyyy-MM-dd'), main: '', sub: '' },
        {
          kind: '完成' as const,
          d:    format(b.completionDate, 'yyyy-MM-dd'),
          // 桶番号は仮登録のときに採番されるので、未登録の提案にはまだ無い
          main: b.bucketNumbers ? `桶${b.bucketNumbers}` : '桶未定',
          sub:  `${format(b.brewDate, 'M/d')}仕込 ${b.fermentationDays}日`,
        },
      ]))
      .map(m => ({ ...m, kg: rows.find(r => r.d === m.d)?.kg }))
      .filter((m): m is { kind: '仕込み' | '完成'; d: string; main: string; sub: string; kg: number } =>
        typeof m.kg === 'number')
      .sort((a, b) => a.d.localeCompare(b.d))

    // 完成点が近いとラベル同士が重なるので、近接するものは1段上げて互い違いにする
    let lastCompletion = ''
    let lifted = false
    const marksWithLift = marks.map(m => {
      if (m.kind !== '完成') return { ...m, lift: 0 }
      const gapDays = lastCompletion
        ? (new Date(m.d + 'T00:00:00').getTime() - new Date(lastCompletion + 'T00:00:00').getTime()) / 86400000
        : Infinity
      lifted = gapDays <= 21 ? !lifted : false
      lastCompletion = m.d
      return { ...m, lift: lifted ? 20 : 0 }
    })

    return { misoType: s.misoType, rows, marks: marksWithLift }
  }), [series, placed, days, today])

  if (panels.length === 0) return null

  const monthTicks = panels[0].rows
    .filter(r => r.d.endsWith('-01') || (days <= 120 && r.d.endsWith('-16')))
    .map(r => r.d)

  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-xs font-semibold text-gray-900">なぜこの組み方になるか</h4>
        <span className="text-[11px] text-muted-foreground">
          品種ごとの在庫見込みと安全在庫ライン。同じ週を2品種が取り合ったら、ラインまでの余裕が少ないほうが枠を取ります
        </span>
        <span className="ml-auto inline-flex rounded-lg border p-0.5 text-[11px]">
          {RANGES.map(r => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRangeKey(r.key)}
              className={`rounded-md px-2 py-0.5 transition-colors ${
                rangeKey === r.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {r.label}
            </button>
          ))}
        </span>
      </div>

      {panels.map((p, idx) => {
        const isLast = idx === panels.length - 1
        const color  = SERIES_COLOR[p.misoType] ?? '#6b7280'
        return (
          <div key={p.misoType} className={isLast ? '' : 'mb-1'}>
            <div className="flex items-baseline gap-1.5 pl-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
              <span className="text-[11px] font-medium text-gray-800">{p.misoType}</span>
            </div>
            <ResponsiveContainer width="100%" height={isLast ? 176 : 158}>
              <ComposedChart data={p.rows} margin={{ top: 40, right: 12, bottom: isLast ? 0 : 2, left: 4 }}>
                <CartesianGrid stroke="#f1efec" vertical={false} />
                <XAxis
                  dataKey="d"
                  ticks={monthTicks}
                  tickFormatter={v => format(new Date(v + 'T00:00:00'), 'M月')}
                  tick={isLast ? { fontSize: 11, fill: '#6b7280' } : false}
                  height={isLast ? 20 : 1}
                  axisLine={{ stroke: '#e5e7eb' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#6b7280' }}
                  axisLine={false}
                  tickLine={false}
                  width={54}
                  tickFormatter={v => (v as number).toLocaleString()}
                />
                <Tooltip
                  contentStyle={{ fontSize: 11, padding: '4px 8px', borderRadius: 8, border: '1px solid #e5e7eb' }}
                  labelFormatter={v => format(new Date(String(v) + 'T00:00:00'), 'yyyy/M/d')}
                  formatter={(v, name) => [
                    `${Math.round(Number(v ?? 0)).toLocaleString()} kg`,
                    name === 'safety' ? '安全在庫ライン' : '在庫見込み',
                  ]}
                />
                <Area
                  type="linear"
                  dataKey="kg"
                  name="在庫見込み"
                  stroke={color}
                  strokeWidth={1.8}
                  fill={color}
                  fillOpacity={0.1}
                  isAnimationActive={false}
                />
                {/* 冬季はラインが変わるので階段で描く（品種ごとのグラフと同じ扱い） */}
                <Line
                  type="stepAfter"
                  dataKey="safety"
                  name="safety"
                  stroke={SAFETY_COLOR}
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <ReferenceLine y={0} stroke="#e5e7eb" />
                {p.marks.map((m, i) => (
                  <ReferenceDot
                    key={`${m.d}-${m.kind}-${i}`}
                    x={m.d}
                    y={m.kg}
                    r={m.kind === '仕込み' ? 4 : 5}
                    fill={m.kind === '仕込み' ? '#ffffff' : color}
                    stroke={color}
                    strokeWidth={2}
                    label={m.kind === '完成' ? completionLabel(m.main, m.sub, color, m.lift) : undefined}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )
      })}

      <p className="mt-1 text-[11px] text-muted-foreground">
        面＝在庫見込み／橙の破線＝その品種の安全在庫ライン（冬は厚くなるので段が付きます）。
        白丸＝仕込み日、塗り丸＝完成日（桶番号と、いつ何日熟成した分かを添えています）。
        面が破線より下にある期間はラインを割っている見込みです
      </p>
    </div>
  )
}

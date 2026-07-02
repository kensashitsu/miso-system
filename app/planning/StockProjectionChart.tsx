'use client'

// 計算の根拠の可視化：在庫推移グラフ
// 有効在庫が消費ペースで減り、完成補充でジャンプし、在庫切れに向かう様子を
// 手配締切・仕込み日・完成日・在庫切れ日の縦線とともに時間軸で表示する。
import {
  ComposedChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'

export interface StockPoint {
  d:  string   // 'yyyy-MM-dd'
  kg: number
}

export interface BatchMarker {
  n:          number
  deadline:   string | null  // 手配締切（今日より過去はnull＝線を出さない）
  brew:       string
  completion: string
  stockOut:   string | null  // 確定行はnull
  isFixed?:   boolean
}

interface Props {
  points:   StockPoint[]
  markers:  BatchMarker[]
  todayStr: string
  // 熟成中ロット完成日の桶番号ラベル（補充ジャンプ地点に点＋ラベルで表示）
  supplyMarkers?: { d: string; label: string }[]
}

const COLOR = {
  stock:    '#0284c7',  // sky-600
  deadline: '#f59e0b',  // amber-500
  brew:     '#2563eb',  // blue-600
  comp:     '#059669',  // emerald-600
  out:      '#e11d48',  // rose-600
  today:    '#9ca3af',  // gray-400
}

function fmtMd(d: string): string {
  const [, m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
}

export default function StockProjectionChart({ points, markers, todayStr, supplyMarkers }: Props) {
  if (points.length < 2) return null
  const dateSet = new Set(points.map(p => p.d))
  const has = (d: string | null): d is string => d !== null && dateSet.has(d)
  // 桶番号ラベル：グラフ範囲内のもののみ。ジャンプ後の在庫値（その日の点）に打つ
  const kgAt = new Map(points.map(p => [p.d, p.kg]))
  const buckets = (supplyMarkers ?? []).filter(m => dateSet.has(m.d))
  const multi = markers.length > 1
  const lbl = (base: string, n: number) => (multi ? `${base}${n}` : base)

  // X軸ラベルは8個程度に間引く
  const tickStep = Math.max(1, Math.ceil(points.length / 8))
  const ticks = points.filter((_, i) => i % tickStep === 0).map(p => p.d)

  return (
    <div className="space-y-1">
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis
              dataKey="d"
              ticks={ticks}
              tickFormatter={fmtMd}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
            />
            <YAxis
              width={44}
              tick={{ fontSize: 10, fill: '#6b7280' }}
              tickFormatter={(v: number) => v.toLocaleString()}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              labelFormatter={(d) => {
                const [y, m, day] = String(d ?? '').split('-')
                return `${y}年${Number(m)}月${Number(day)}日`
              }}
              formatter={(v) => [`${Math.round(Number(v ?? 0)).toLocaleString()} kg`, '在庫見込み']}
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
            />
            <Area
              type="stepAfter"
              dataKey="kg"
              stroke={COLOR.stock}
              strokeWidth={1.8}
              fill={COLOR.stock}
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            <ReferenceLine
              x={todayStr}
              stroke={COLOR.today}
              strokeDasharray="4 3"
              label={{ value: '今日', position: 'insideTopLeft', fontSize: 10, fill: COLOR.today }}
            />
            {buckets.map(m => (
              <ReferenceDot
                key={`bucket-${m.d}`}
                x={m.d}
                y={kgAt.get(m.d) ?? 0}
                r={3.5}
                fill={COLOR.comp}
                stroke="#fff"
                strokeWidth={1.5}
                label={{ value: m.label, position: 'top', fontSize: 9, fill: COLOR.comp }}
              />
            ))}
            {markers.map(m => (
              <g key={m.n}>
                {has(m.deadline) && (
                  <ReferenceLine
                    x={m.deadline}
                    stroke={COLOR.deadline}
                    strokeDasharray="4 3"
                    label={{ value: lbl('手配', m.n), position: 'insideTop', fontSize: 10, fill: COLOR.deadline }}
                  />
                )}
                {has(m.brew) && (
                  <ReferenceLine
                    x={m.brew}
                    stroke={COLOR.brew}
                    label={{ value: lbl(m.isFixed ? '仕込済' : '仕込', m.n), position: 'insideBottomLeft', fontSize: 10, fill: COLOR.brew }}
                  />
                )}
                {has(m.completion) && (
                  <ReferenceLine
                    x={m.completion}
                    stroke={COLOR.comp}
                    label={{ value: lbl('完成', m.n), position: 'insideTop', fontSize: 10, fill: COLOR.comp }}
                  />
                )}
                {has(m.stockOut) && (
                  <ReferenceLine
                    x={m.stockOut}
                    stroke={COLOR.out}
                    strokeDasharray="4 3"
                    label={{ value: lbl('切れ', m.n), position: 'insideBottomRight', fontSize: 10, fill: COLOR.out }}
                  />
                )}
              </g>
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-1">
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px] mr-1" style={{ background: COLOR.stock, opacity: 0.5 }} />在庫見込み</span>
        <span style={{ color: COLOR.deadline }}>┆ 手配締切</span>
        <span style={{ color: COLOR.brew }}>│ 仕込み日</span>
        <span style={{ color: COLOR.comp }}>│ 完成（補充）</span>
        {buckets.length > 0 && <span style={{ color: COLOR.comp }}>● 熟成中ロット完成（桶番号）</span>}
        <span style={{ color: COLOR.out }}>┆ 在庫切れ</span>
      </div>
    </div>
  )
}

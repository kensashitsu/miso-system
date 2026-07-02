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
  // 補充ジャンプ地点の桶番号ラベル（熟成中ロット=緑 / 仮登録=紫で色分け）
  supplyMarkers?: { d: string; label: string; kind: 'fermenting' | 'registered' }[]
}

const COLOR = {
  stock:     '#0284c7',  // sky-600
  deadline:  '#f59e0b',  // amber-500
  brew:      '#2563eb',  // blue-600
  comp:      '#059669',  // emerald-600
  regBucket: '#8b5cf6',  // violet-500（仮登録の桶番号）
  out:       '#e11d48',  // rose-600
  today:     '#9ca3af',  // gray-400
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
  // 同じ日に熟成中と仮登録が重なる日は、仮登録側のラベルを一段上にずらして衝突回避
  const dupDays = new Set(
    buckets.filter(m => m.kind === 'registered' && buckets.some(o => o.kind === 'fermenting' && o.d === m.d)).map(m => m.d)
  )
  const hasFermenting = buckets.some(m => m.kind === 'fermenting')
  const hasRegistered = buckets.some(m => m.kind === 'registered')
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
            {buckets.map(m => {
              const color = m.kind === 'registered' ? COLOR.regBucket : COLOR.comp
              const dy = m.kind === 'registered' && dupDays.has(m.d) ? -12 : 0
              return (
                <ReferenceDot
                  key={`bucket-${m.kind}-${m.d}`}
                  x={m.d}
                  y={kgAt.get(m.d) ?? 0}
                  r={3.5}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1.5}
                  label={{ value: m.label, position: 'top', fontSize: 9, fill: color, dy }}
                />
              )
            })}
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
        {hasFermenting && <span style={{ color: COLOR.comp }}>● 熟成中ロット完成（桶）</span>}
        {hasRegistered && <span style={{ color: COLOR.regBucket }}>● 仮登録の完成（桶）</span>}
        <span style={{ color: COLOR.out }}>┆ 在庫切れ</span>
      </div>
    </div>
  )
}

'use client'

import { useMemo } from 'react'
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ReferenceDot, ResponsiveContainer, Legend,
} from 'recharts'
import type { PlacedBrew } from '@/lib/brewCombine'

// まとめ提案の根拠。
//
// 割り当ては「同じ週を取り合ったら安全在庫ラインまでの余裕が少ない品種が枠を取る」
// というルールなので、縦軸を **ラインからの余裕（kg）** にすれば、割り当ての理由が
// そのまま絵になる。0 の線が安全在庫ラインで、線が 0 を割り込む手前に仕込みが入る。
//
// kgの実数を3品種そのまま重ねると、ラインの高さ（無添加1,600／田舎1,600・冬2,000／
// 山吹は通年なし）が品種ごとに違うので上下関係に意味が出ない。差分にすると
// 「どの品種が先に苦しくなるか」が同じ土俵で比べられる。
//
// 色は品種の identity（緑＝無添加／茶橙＝田舎／藍＝山吹）を保ちつつ、線として
// 読める明るさに寄せたもの。色覚特性・コントラストの検証を通してある。
export const SERIES_COLOR: Record<string, string> = {
  '無添加麦みそ': '#12A47A',
  '田舎みそ':     '#C97A0E',
  '山吹みそ':     '#6355E0',
}

export interface StockSeriesInput {
  misoType:         string
  effectiveStock:   number
  getDailyRateFn:   (date: Date) => number
  safetyLineFn:     ((date: Date) => number) | null
  baseSupplyEvents: { date: Date; kg: number }[]
  batchKg:          number
}

interface Row { d: string; [key: string]: number | string | null }

export default function CombinedStockChart({
  series,
  placed,
  days = 240,
}: {
  series: StockSeriesInput[]
  placed: PlacedBrew[]   // 置き直したあとの仕込み（完成日に生産量が入る）
  days?:  number
}) {
  const today = startOfDay(new Date())

  const { rows, marks } = useMemo(() => {
    const rows: Row[] = []
    const marks: { d: string; kg: number; misoType: string; kind: '仕込み' | '完成' }[] = []

    // 品種ごとに日次で在庫を積む。補充は「熟成中＋仮登録の完成」＋「まとめ提案の完成」
    const stateByType = new Map<string, { stock: number; supply: Map<string, number> }>()
    for (const s of series) {
      const supply = new Map<string, number>()
      for (const e of s.baseSupplyEvents) {
        const k = format(e.date, 'yyyy-MM-dd')
        supply.set(k, (supply.get(k) ?? 0) + e.kg)
      }
      // 仮登録済み（isFixed）の完成は baseSupplyEvents に既に入っているので足さない（二重計上になる）
      for (const b of placed.filter(b => b.misoType === s.misoType && !b.isFixed)) {
        const k = format(b.completionDate, 'yyyy-MM-dd')
        supply.set(k, (supply.get(k) ?? 0) + s.batchKg)
      }
      stateByType.set(s.misoType, { stock: s.effectiveStock, supply })
    }

    for (let i = 0; i < days; i++) {
      const date = addDays(today, i)
      const k    = format(date, 'yyyy-MM-dd')
      const row: Row = { d: k }
      for (const s of series) {
        const st = stateByType.get(s.misoType)!
        st.stock += st.supply.get(k) ?? 0
        st.stock -= s.getDailyRateFn(date)
        const line = s.safetyLineFn ? s.safetyLineFn(date) : 0
        row[s.misoType] = Math.round(st.stock - line)
      }
      rows.push(row)
    }

    // 仕込み・完成の点はその日の余裕の高さに置く（線の上に乗る）
    for (const b of placed) {
      for (const [kind, date] of [['仕込み', b.brewDate], ['完成', b.completionDate]] as const) {
        const k = format(date, 'yyyy-MM-dd')
        const row = rows.find(r => r.d === k)
        const v = row?.[b.misoType]
        if (typeof v === 'number') marks.push({ d: k, kg: v, misoType: b.misoType, kind })
      }
    }
    return { rows, marks }
  }, [series, placed, days, today])

  if (series.length === 0 || rows.length === 0) return null

  // 目盛りは月初だけ。日付を全部出すと読めない
  const monthTicks = rows.filter(r => r.d.endsWith('-01')).map(r => r.d)
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-xs font-semibold text-gray-900">なぜこの組み方になるか</h4>
        <span className="text-[11px] text-muted-foreground">
          縦軸は安全在庫ラインからの余裕。0を割り込む手前に仕込みが入る。同じ週を取り合ったら余裕の少ない品種が枠を取る
        </span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#eceae6" vertical={false} />
          <XAxis
            dataKey="d"
            ticks={monthTicks}
            tickFormatter={v => format(new Date(v + 'T00:00:00'), 'M月')}
            tick={{ fontSize: 11, fill: '#6b7280' }}
            axisLine={{ stroke: '#e5e7eb' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
            width={54}
            tickFormatter={v => `${(v as number).toLocaleString()}`}
          />
          {/* 0＝安全在庫ライン。ここを割ると在庫が薄い */}
          <ReferenceLine y={0} stroke="#9ca3af" strokeWidth={2} />
          <Tooltip
            labelFormatter={v => format(new Date(String(v) + 'T00:00:00'), 'yyyy/M/d')}
            formatter={(value, name) => [`${Number(value).toLocaleString()} kg`, String(name)]}
            contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e5e7eb' }}
          />
          <Legend
            verticalAlign="top"
            height={24}
            iconType="plainline"
            wrapperStyle={{ fontSize: 11 }}
          />
          {series.map(s => (
            <Line
              key={s.misoType}
              type="monotone"
              dataKey={s.misoType}
              stroke={SERIES_COLOR[s.misoType] ?? '#6b7280'}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          {marks.map((m, i) => (
            <ReferenceDot
              key={`${m.d}-${m.misoType}-${m.kind}-${i}`}
              x={m.d}
              y={m.kg}
              r={m.kind === '仕込み' ? 4 : 5}
              fill={m.kind === '仕込み' ? '#ffffff' : (SERIES_COLOR[m.misoType] ?? '#6b7280')}
              stroke={SERIES_COLOR[m.misoType] ?? '#6b7280'}
              strokeWidth={2}

            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="mt-1 text-[11px] text-muted-foreground">
        白丸＝仕込み日／塗り丸＝完成日（その日に生産量が入る）。線が0より下にある期間は
        安全在庫ラインを割っている見込みです
      </p>
    </div>
  )
}

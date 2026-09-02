'use client'

// 計算の根拠の可視化：在庫推移グラフ
// 有効在庫が消費ペースで減り、完成補充でジャンプし、在庫切れに向かう様子を
// 手配締切・仕込み日・完成日・在庫切れ日の縦線とともに時間軸で表示する。
import { useState } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'

export interface StockPoint {
  d:  string   // 'yyyy-MM-dd'
  kg: number
  // その日に適用される安全在庫ライン(kg)。冬季（11〜12月）は厚くなるため日ごとに持つ
  safety?: number
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
  // 補充ジャンプ地点の桶番号ラベル（熟成中ロット=緑 / 仮登録=紫で色分け）。
  // sub は2行目に小さく出す補足（仕込み日・熟成日数）
  supplyMarkers?: { d: string; label: string; sub?: string; kind: 'fermenting' | 'registered' }[]
  // 安全在庫ライン（設定されている品種のみ）。「在庫切れ」の縦線はゼロではなくこのラインへの到達日
  safetyStockKg?: number | null
  // 'yyyy-MM' → その月の需要見込み(kg)。月の境目に薄い縦線とラベルで出す
  monthlyDemand?: Record<string, number>
}

const COLOR = {
  stock:     '#0284c7',  // sky-600
  deadline:  '#f59e0b',  // amber-500
  brew:      '#2563eb',  // blue-600
  comp:      '#059669',  // emerald-600
  regBucket: '#8b5cf6',  // violet-500（仮登録の桶番号）
  out:       '#e11d48',  // rose-600
  today:     '#9ca3af',  // gray-400
  safety:    '#d97706',  // amber-600（安全在庫ライン）
}

// 桶番号ラベル（1行目）と仕込み日・熟成日数（2行目）を積んで描く。
// 1行に繋げると隣の補充点のラベルと重なって読めなくなるため2行に分ける
function bucketLabel(label: string, sub: string | undefined, color: string, dy: number) {
  return (props: { viewBox?: { x?: number; y?: number } }) => {
    const { x = 0, y = 0 } = props.viewBox ?? {}
    return (
      // 安全在庫ラインや在庫の線と重なっても読めるよう、白い縁取り（ハロー）を敷く
      <text
        x={x} y={y + dy} textAnchor="middle" fill={color}
        stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
      >
        <tspan x={x} dy={sub ? -14 : -6} fontSize={9}>{label}</tspan>
        {sub && <tspan x={x} dy={9} fontSize={8} fillOpacity={0.75}>{sub}</tspan>}
      </text>
    )
  }
}

function fmtMd(d: string): string {
  const [, m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
}

// 'yyyy-MM-dd' 同士の日数差（熟成日数の表示用）
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86400000)
}

// 表示期間の選択肢。仮登録を先の方まで入れると1年半分の系列になり、
// 直近の数週間が潰れて読めなくなるため既定は6ヶ月にする（2026-09-02ユーザー指摘）
const RANGE_OPTIONS = [
  { key: '3m',  label: '3ヶ月', months: 3 },
  { key: '6m',  label: '6ヶ月', months: 6 },
  { key: '1y',  label: '1年',   months: 12 },
  { key: 'all', label: '全期間', months: null },
] as const
type RangeKey = typeof RANGE_OPTIONS[number]['key']
const DEFAULT_RANGE: RangeKey = '6m'

// todayStr から months ヶ月後の 'yyyy-MM-dd'
function addMonthsStr(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1 + months, d))
  return dt.toISOString().slice(0, 10)
}

export default function StockProjectionChart({ points: allPoints, markers, todayStr, supplyMarkers, safetyStockKg, monthlyDemand }: Props) {
  const [rangeKey, setRangeKey] = useState<RangeKey>(DEFAULT_RANGE)
  const range   = RANGE_OPTIONS.find(r => r.key === rangeKey) ?? RANGE_OPTIONS[1]
  const lastStr = allPoints.length > 0 ? allPoints[allPoints.length - 1].d : todayStr
  // 期間を絞ってもデータが残らない場合（先の方しか無い等）は全期間にフォールバック
  const endStr  = range.months == null ? lastStr : addMonthsStr(todayStr, range.months)
  const clipped = allPoints.filter(p => p.d <= endStr)
  const points  = clipped.length >= 2 ? clipped : allPoints
  const isClipped = points.length < allPoints.length

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
  // 月の境目（表示範囲に入っている各月の初日。先頭月は最初の点）に需要見込みを出す。
  // 線の傾き＝その月の消費ペースなので、傾きが変わる理由がその場で読める
  const monthMarks = (() => {
    if (!monthlyDemand) return []
    const seen = new Set<string>()
    const out: { d: string; label: string }[] = []
    // 右端に寄りすぎるとラベルが切れるので、残り日数が少ない月は出さない
    const lastIdx = points.length - 1
    for (let i = 0; i < points.length; i++) {
      const ym = points[i].d.slice(0, 7)
      if (seen.has(ym)) continue
      seen.add(ym)
      if (lastIdx - i < 12) continue
      const kg = monthlyDemand[ym]
      if (kg == null) continue
      out.push({ d: points[i].d, label: `${Number(ym.slice(5))}月 ${kg.toLocaleString()}kg` })
    }
    return out
  })()

  const hasFermenting = buckets.some(m => m.kind === 'fermenting')
  const hasRegistered = buckets.some(m => m.kind === 'registered')
  // 季節でラインが変わるか（変わるなら階段線で描く）
  const hasSeasonalSafety = points.some(p => p.safety != null && p.safety !== points[0].safety)
  // ※通年ライン未設定でも季節ラインだけ設定されている品種（例: 山吹みそ）があるため、
  //   safetyStockKg が null でも階段線は描く
  const multi = markers.length > 1
  const lbl = (base: string, n: number) => (multi ? `${base}${n}` : base)
  // 縦線は本数を絞る。手配締切・在庫切れは「これから最初に来る1本」だけ出す
  const nextStockOut = markers
    .filter(m => has(m.stockOut) && m.stockOut! >= todayStr)
    .sort((a, b) => a.stockOut!.localeCompare(b.stockOut!))[0] ?? null

  // X軸ラベルは8個程度に間引く
  const tickStep = Math.max(1, Math.ceil(points.length / 8))
  const ticks = points.filter((_, i) => i % tickStep === 0).map(p => p.d)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-end gap-1 text-[11px]">
        <span className="text-muted-foreground mr-1">表示期間</span>
        {RANGE_OPTIONS.map(o => (
          <button
            key={o.key}
            type="button"
            onClick={() => setRangeKey(o.key)}
            className={`px-2 py-0.5 rounded border transition-colors ${
              o.key === rangeKey
                ? 'bg-slate-900 text-white border-slate-900'
                : 'border-gray-200 text-muted-foreground hover:bg-gray-50'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* top余白は桶番号ラベルが2行になったぶん広げている */}
          <ComposedChart data={points} margin={{ top: 30, right: 8, bottom: 0, left: 0 }}>
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
              // 系列ごとに名前を出す（安全在庫ラインまで「在庫見込み」と表示されていた不具合の修正）
              formatter={(v, name) => [`${Math.round(Number(v ?? 0)).toLocaleString()} kg`, String(name ?? '在庫見込み')]}
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
            />
            <Area
              type="stepAfter"
              dataKey="kg"
              name="在庫見込み（熟成済＋小分け）"
              stroke={COLOR.stock}
              strokeWidth={1.8}
              fill={COLOR.stock}
              fillOpacity={0.12}
              isAnimationActive={false}
            />
            {/* 月の境目と需要見込み（他の線より先に描いて背面に置く） */}
            {monthMarks.map(m => (
              <ReferenceLine
                key={`month-${m.d}`}
                x={m.d}
                stroke="#e5e7eb"
                strokeWidth={1}
                // 「今日」のラベルと同じ高さに来ると重なるので一段下げる
                label={{ value: m.label, position: 'insideTopLeft', fontSize: 9, fill: '#94a3b8', dy: 12 }}
              />
            ))}
            <ReferenceLine
              x={todayStr}
              stroke={COLOR.today}
              strokeDasharray="4 3"
              label={{ value: '今日', position: 'insideTopLeft', fontSize: 10, fill: COLOR.today }}
            />
            {(safetyStockKg != null || hasSeasonalSafety) && (
              hasSeasonalSafety ? (
                // 冬季（11〜12月）はラインが変わるので、水平線ではなく日ごとの階段で描く
                <Line
                  type="stepAfter"
                  dataKey="safety"
                  stroke={COLOR.safety}
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  name="安全在庫ライン"
                />
              ) : (
                <ReferenceLine
                  y={safetyStockKg ?? undefined}
                  stroke={COLOR.safety}
                  strokeDasharray="4 3"
                  label={{ value: `安全在庫ライン ${(safetyStockKg ?? 0).toLocaleString()}kg`, position: 'insideBottomRight', fontSize: 10, fill: COLOR.safety }}
                />
              )
            )}
            {buckets.map(m => {
              const color = m.kind === 'registered' ? COLOR.regBucket : COLOR.comp
              // 同じ日に熟成中と仮登録が重なる日は、2行分（約20px）上へ逃がす
              const dy = m.kind === 'registered' && dupDays.has(m.d) ? -21 : 0
              return (
                <ReferenceDot
                  key={`bucket-${m.kind}-${m.d}`}
                  x={m.d}
                  y={kgAt.get(m.d) ?? 0}
                  r={3.5}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1.5}
                  label={bucketLabel(m.label, m.sub, color, dy)}
                />
              )
            })}
            {/* 仕込み日：ラベルを外し細い薄線だけにする（正確な日付は上の表を参照）。
                ラベル付きの縦線を回数分出すと重なって読めなくなるため */}
            {markers.filter(m => has(m.brew)).map(m => (
              <ReferenceLine
                key={`brew-${m.n}`}
                x={m.brew}
                stroke={COLOR.brew}
                strokeOpacity={0.35}
                strokeWidth={1}
              />
            ))}
            {/* 完成日：在庫が跳ね上がる点に打つ。確定分は桶番号ラベルが別途出るので新規提案のみ。
                桶のラベルと同じく、2行目に仕込み日と熟成日数を添える */}
            {markers.filter(m => !m.isFixed && has(m.completion)).map(m => (
              <ReferenceDot
                key={`comp-${m.n}`}
                x={m.completion}
                y={kgAt.get(m.completion!) ?? 0}
                r={3.5}
                fill={COLOR.comp}
                stroke="#fff"
                strokeWidth={1.5}
                label={bucketLabel(
                  lbl('完成', m.n),
                  `${fmtMd(m.brew)}仕込 ${daysBetween(m.brew, m.completion)}日`,
                  COLOR.comp,
                  0,
                )}
              />
            ))}
            {/* 在庫切れは直近の1本だけ縦線で出す（全回分出すと線だらけで読めない）。
                手配締切は上の表に載っているのでグラフには出さない */}
            {nextStockOut && (
              <ReferenceLine
                x={nextStockOut.stockOut!}
                stroke={COLOR.out}
                strokeDasharray="4 3"
                label={{ value: lbl('切れ', nextStockOut.n), position: 'insideBottomRight', fontSize: 10, fill: COLOR.out }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground pl-1">
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px] mr-1" style={{ background: COLOR.stock, opacity: 0.5 }} />在庫見込み（熟成済＋小分け）</span>
        <span style={{ color: COLOR.brew }}>│ 仕込み日</span>
        <span style={{ color: COLOR.comp }}>● 完成（補充）</span>
        {hasFermenting && <span style={{ color: COLOR.comp }}>● 熟成中ロット完成（桶）</span>}
        {hasRegistered && <span style={{ color: COLOR.regBucket }}>● 仮登録の完成（桶）</span>}
        <span style={{ color: COLOR.out }}>┆ 直近の在庫切れ</span>
        {monthMarks.length > 0 && <span className="text-gray-400">│ 月の境目＝その月の需要見込み</span>}
        {isClipped && <span>（{fmtMd(points[points.length - 1].d)} 以降は表示範囲外）</span>}
      </div>
    </div>
  )
}

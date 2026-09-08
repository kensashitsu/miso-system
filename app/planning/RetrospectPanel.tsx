'use client'

import { useState, useTransition } from 'react'
import { format } from 'date-fns'
import { ChevronDown, History } from 'lucide-react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceDot, ResponsiveContainer,
} from 'recharts'
import { getRetrospect, type RetrospectData } from './retrospect-action'
import { SERIES_COLOR } from './CombinedStockChart'

// 振り返り：予測ではなく**実際に起きたこと**で在庫推移を再現し、
// 安全在庫ラインを割った期間と、いつ仕込んでおけばよかったかを出す。
//
// 「今年は夏の仕込みが少なくて秋口から在庫が薄くなった」を、記憶ではなく数字で残すための画面。
// 出た結果は設定（安全在庫ラインなど）の見直しに使う。年20〜30回しか事例が増えないので
// 機械に学習させるのではなく、人が毎年これを見て設定を直す形にしている。
const SAFETY_COLOR = '#d97706'

export default function RetrospectPanel() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<RetrospectData | null>(null)
  const [isPending, startTransition] = useTransition()

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !data) {
      startTransition(async () => setData(await getRetrospect()))
    }
  }

  return (
    <div className="mb-4 rounded-lg border no-print">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <History className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-gray-900">振り返り</span>
        <span className="text-[11px] text-muted-foreground">
          実績だけで在庫推移を再現し、いつ・何回仕込んでおけばよかったかを出します
        </span>
        <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="border-t p-3">
          {isPending && <p className="py-6 text-center text-sm text-muted-foreground">計算しています…</p>}
          {!isPending && data?.note && (
            <p className="py-6 text-center text-sm text-muted-foreground">{data.note}</p>
          )}
          {!isPending && data && !data.note && (
            <>
              <p className="mb-3 text-[11px] text-muted-foreground">
                {data.startDate} 〜 {data.endDate}。起点は {data.baseYearMonth} の月末在庫（熟成済＋小分け）、
                消費は出荷実績の日割り、補充は実際に完成したロット。予測は使っていません
              </p>
              {data.results.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  振り返れる品種がありません（起点の在庫スナップショットか出荷実績が不足）
                </p>
              )}
              {data.results.map(r => {
                const color = SERIES_COLOR[r.misoType] ?? '#6b7280'
                const kgOn = (d: string) => r.points.find(p => p.d === d)?.kg
                return (
                  <div key={r.misoType} className="mb-4 last:mb-0">
                    <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
                      <span className="text-[11px] font-medium text-gray-800">{r.misoType}</span>
                      <span className="text-[11px] text-muted-foreground">
                        実際 {r.brewDates.length} 回
                        {r.runs.length === 0
                          ? '・ラインを割った期間はありません'
                          : `・${r.runs.length} 回ラインを割り、最も深いところで ${r.peakDeficitKg.toLocaleString()}kg 不足（1回 ${r.batchKg.toLocaleString()}kg で ${r.missingBatches} 回分）`}
                      </span>
                    </div>

                    <ResponsiveContainer width="100%" height={150}>
                      <ComposedChart data={r.points} margin={{ top: 18, right: 12, bottom: 0, left: 4 }}>
                        <CartesianGrid stroke="#f1efec" vertical={false} />
                        <XAxis
                          dataKey="d"
                          ticks={r.points.filter(p => p.d.endsWith('-01')).map(p => p.d)}
                          tickFormatter={v => format(new Date(v + 'T00:00:00'), 'M月')}
                          tick={{ fontSize: 11, fill: '#6b7280' }}
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
                            name === 'safety' ? '安全在庫ライン' : '実在庫',
                          ]}
                        />
                        <Area
                          type="stepAfter" dataKey="kg" name="実在庫"
                          stroke={color} strokeWidth={1.8} fill={color} fillOpacity={0.1}
                          isAnimationActive={false}
                        />
                        <Line
                          type="stepAfter" dataKey="safety" name="safety"
                          stroke={SAFETY_COLOR} strokeDasharray="4 3" strokeWidth={1.5}
                          dot={false} isAnimationActive={false}
                        />
                        {/* 実際に仕込んだ日（白丸） */}
                        {r.brewDates.map(bd => {
                          const y = kgOn(bd)
                          if (y == null) return null
                          return (
                            <ReferenceDot key={`b-${bd}`} x={bd} y={y} r={4}
                              fill="#ffffff" stroke={color} strokeWidth={2} />
                          )
                        })}
                        {/* 仕込んでおくべきだった日（赤の×印） */}
                        {r.shouldHaveBrewed.map(s => {
                          const y = kgOn(s.d)
                          if (y == null) return null
                          return (
                            <ReferenceDot
                              key={`s-${s.d}`} x={s.d} y={y} r={5}
                              fill="#fff1f2" stroke="#e11d48" strokeWidth={2}
                              label={{
                                value: 'ここで1回', position: 'top',
                                fontSize: 9, fill: '#e11d48',
                              }}
                            />
                          )
                        })}
                      </ComposedChart>
                    </ResponsiveContainer>

                    {r.runs.length > 0 && (
                      <div className="mt-1 space-y-0.5 text-[11px]">
                        {r.shouldHaveBrewed.map(s => (
                          <p key={s.d} className="text-muted-foreground">
                            <span className="font-medium text-rose-700">
                              {format(new Date(s.d + 'T00:00:00'), 'M/d')} ごろに1回
                            </span>
                            {' '}← {format(new Date(s.forRunFrom + 'T00:00:00'), 'M/d')} の不足に間に合わせるため（熟成{s.fermentDays}日）
                            {s.hadBrewNear
                              ? '。この前後には実際に仕込んでいるので、日ではなく量が足りていません'
                              : '。この前後には仕込みがありません'}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              <p className="mt-2 text-[11px] text-muted-foreground">
                白丸＝実際に仕込んだ日／赤丸＝仕込んでおくべきだった日。
                安全在庫ラインは今の設定で当てているので、設定を変えるとこの評価も変わります。
                月初に段差が出るのは、月末在庫の実測に合わせ直しているためです（段差の大きさ＝再現と実測のズレ）
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

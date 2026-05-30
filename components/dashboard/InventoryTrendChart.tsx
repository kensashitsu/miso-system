'use client'

import { useState } from 'react'
import { subMonths, format, startOfMonth } from 'date-fns'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { ChevronDown, ChevronUp } from 'lucide-react'

const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const

// 凡例の定義
const LEGEND_ITEMS = [
  { key: 'fermenting', label: '熟成中',     color: '#7B9EC2' },
  { key: 'aged',       label: '熟成済在庫', color: '#C8963E' },
  { key: 'packaged',   label: '小分け製品', color: '#6BA58A' },
] as const

type SnapshotRow = {
  yearMonth:    string
  misoType:     string
  fermentingKg: number
  agedKg:       number | null
  packagedKg:   number | null
}

type ChartRow = {
  ym:         string
  label:      string
  hasData:    boolean
  fermenting: number
  aged:       number
  packaged:   number
  // ツールチップ用の元の値（APIなしの場合はnull）
  agedRaw:    number | null
  packagedRaw: number | null
}

function CustomTooltip({ active, payload }: {
  active?: boolean
  payload?: Array<{ payload: ChartRow }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  if (!d.hasData) return null

  const fmt = (v: number | null) =>
    v != null ? `${Math.round(v).toLocaleString()} kg` : '—'
  const total = d.fermenting + (d.agedRaw ?? 0) + (d.packagedRaw ?? 0)

  return (
    <div style={{
      fontSize: 12, borderRadius: 8,
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
      background: 'white', padding: '10px 14px', lineHeight: 2,
      border: '1px solid #f0f0f0',
    }}>
      <p style={{ fontWeight: 700, marginBottom: 2, color: '#374151' }}>{d.label}</p>
      {LEGEND_ITEMS.map(item => (
        <p key={item.key} style={{ color: item.color, margin: 0 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: item.color, marginRight: 6, verticalAlign: 'middle' }} />
          {item.label}：{item.key === 'fermenting' ? fmt(d.fermenting) : item.key === 'aged' ? fmt(d.agedRaw) : fmt(d.packagedRaw)}
        </p>
      ))}
      <p style={{ fontWeight: 600, color: '#111827', borderTop: '1px solid #f3f4f6', marginTop: 6, paddingTop: 6 }}>
        合計：{total.toLocaleString()} kg
      </p>
    </div>
  )
}

export default function InventoryTrendChart({ snapshots }: { snapshots: SnapshotRow[] }) {
  const [isOpen,       setIsOpen]       = useState(true)
  const [selectedType, setSelectedType] = useState<string>(MISO_TYPES[0])

  const today  = new Date()
  const months = Array.from({ length: 13 }, (_, i) =>
    format(subMonths(startOfMonth(today), 12 - i), 'yyyy-MM')
  )

  const snapshotMap: Record<string, SnapshotRow> = {}
  for (const s of snapshots) {
    if (s.misoType === selectedType) snapshotMap[s.yearMonth] = s
  }

  const chartData: ChartRow[] = months.map(ym => {
    const s     = snapshotMap[ym]
    const label = ym.slice(2).replace('-', '/')
    return {
      ym, label,
      hasData:     !!s,
      fermenting:  s ? Math.round(s.fermentingKg) : 0,
      aged:        s?.agedKg     != null ? Math.round(s.agedKg)     : 0,
      packaged:    s?.packagedKg != null ? Math.round(s.packagedKg) : 0,
      agedRaw:     s?.agedKg     ?? null,
      packagedRaw: s?.packagedKg ?? null,
    }
  })

  const dataCount  = chartData.filter(d => d.hasData).length
  const hasAnyData = dataCount > 0

  // Y軸の最大値
  const maxVal = Math.max(0, ...chartData.map(d => d.fermenting + d.aged + d.packaged))
  const yMax   = Math.ceil(maxVal / 1000) * 1000 || 10000

  return (
    <section>
      <button
        type="button"
        onClick={() => setIsOpen(p => !p)}
        className="w-full flex items-center justify-between mb-3 group"
      >
        <div className="text-left">
          <h2 className="text-base font-semibold text-gray-700">在庫推移</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            月末スナップショット（蓄積中：{dataCount}ヶ月分）
          </p>
        </div>
        <span className="flex items-center gap-1 text-xs text-gray-400 group-hover:text-gray-600 transition-colors">
          {isOpen
            ? <><ChevronUp   className="h-4 w-4" />閉じる</>
            : <><ChevronDown className="h-4 w-4" />開く</>}
        </span>
      </button>

      {isOpen && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          {/* 品種タブ（アンダーライン式） */}
          <div className="flex border-b border-gray-100 px-4">
            {MISO_TYPES.map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setSelectedType(type)}
                className={`px-3 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  selectedType === type
                    ? 'border-gray-800 text-gray-900'
                    : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          <div className="px-4 pt-4 pb-3">
            {!hasAnyData ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-sm">まだデータがありません</p>
                <p className="text-xs mt-1">毎月1日に自動蓄積されます</p>
              </div>
            ) : (
              <>
                {/* 手書き凡例 */}
                <div className="flex gap-4 mb-3 px-1">
                  {LEGEND_ITEMS.map(item => (
                    <span key={item.key} className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: item.color, display: 'inline-block' }} />
                      {item.label}
                    </span>
                  ))}
                </div>

                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }} barCategoryGap="35%">
                    <CartesianGrid strokeDasharray="2 4" stroke="#F3F4F6" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: '#9CA3AF' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#9CA3AF' }}
                      axisLine={false}
                      tickLine={false}
                      domain={[0, yMax]}
                      tickFormatter={v => v === 0 ? '' : `${Math.round(Number(v) / 1000)}t`}
                      tickCount={5}
                    />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: '#F9FAFB' }} />

                    <Bar dataKey="fermenting" stackId="a" fill="#7B9EC2" radius={[0,0,0,0]} maxBarSize={40}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={d.hasData ? '#7B9EC2' : 'transparent'} />
                      ))}
                    </Bar>
                    <Bar dataKey="aged" stackId="a" fill="#C8963E" radius={[0,0,0,0]} maxBarSize={40}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={d.hasData ? '#C8963E' : 'transparent'} />
                      ))}
                    </Bar>
                    <Bar dataKey="packaged" stackId="a" fill="#6BA58A" radius={[3,3,0,0]} maxBarSize={40}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={d.hasData ? '#6BA58A' : 'transparent'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

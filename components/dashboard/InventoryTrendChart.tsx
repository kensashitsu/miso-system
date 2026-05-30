'use client'

import { useState } from 'react'
import { subMonths, format, startOfMonth } from 'date-fns'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { ChevronDown, ChevronUp } from 'lucide-react'

const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const

type SnapshotRow = {
  yearMonth:    string
  misoType:     string
  fermentingKg: number
  agedKg:       number | null
  packagedKg:   number | null
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ payload: Record<string, unknown> }>; label?: string }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as { hasData: boolean; fermenting: number | null; aged: number | null; packaged: number | null }
  if (!d?.hasData) return null
  const fmt = (v: number | null) => v != null ? `${v.toLocaleString()} kg` : '—'
  const total = (d.fermenting ?? 0) + (d.aged ?? 0) + (d.packaged ?? 0)
  return (
    <div style={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(var(--border))', background: 'white', padding: '8px 12px', lineHeight: 1.8 }}>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{label}</p>
      <p style={{ color: '#3B82F6' }}>熟成中：{fmt(d.fermenting)}</p>
      <p style={{ color: '#F59E0B' }}>熟成済在庫：{fmt(d.aged)}</p>
      <p style={{ color: '#10B981' }}>小分け製品：{fmt(d.packaged)}</p>
      <p style={{ fontWeight: 600, borderTop: '1px solid #e5e7eb', marginTop: 4, paddingTop: 4 }}>
        合計：{total.toLocaleString()} kg
      </p>
    </div>
  )
}

export default function InventoryTrendChart({ snapshots }: { snapshots: SnapshotRow[] }) {
  const [isOpen,        setIsOpen]        = useState(true)
  const [selectedType,  setSelectedType]  = useState<string>(MISO_TYPES[0])

  const today  = new Date()
  const months = Array.from({ length: 13 }, (_, i) =>
    format(subMonths(startOfMonth(today), 12 - i), 'yyyy-MM')
  )

  const snapshotMap: Record<string, SnapshotRow> = {}
  for (const s of snapshots) {
    if (s.misoType === selectedType) snapshotMap[s.yearMonth] = s
  }

  const chartData = months.map(ym => {
    const s     = snapshotMap[ym]
    const label = ym.slice(2).replace('-', '/')
    if (!s) return { ym, label, hasData: false, fermenting: null, aged: null, packaged: null }
    return {
      ym, label, hasData: true,
      fermenting: Math.round(s.fermentingKg),
      aged:       s.agedKg     != null ? Math.round(s.agedKg)     : null,
      packaged:   s.packagedKg != null ? Math.round(s.packagedKg) : null,
    }
  })

  const dataCount  = chartData.filter(d => d.hasData).length
  const hasAnyData = dataCount > 0

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
            月末スナップショット推移（蓄積中：{dataCount}ヶ月分）
          </p>
        </div>
        <span className="flex items-center gap-1 text-xs text-gray-400 group-hover:text-gray-600 transition-colors">
          {isOpen
            ? <><ChevronUp   className="h-4 w-4" />閉じる</>
            : <><ChevronDown className="h-4 w-4" />開く</>}
        </span>
      </button>

      {isOpen && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-4">
          {/* 品種タブ */}
          <div className="flex gap-1.5 flex-wrap mb-4">
            {MISO_TYPES.map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setSelectedType(type)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  selectedType === type
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {!hasAnyData ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm">まだデータがありません</p>
              <p className="text-xs mt-1">毎月1日に自動蓄積されます</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--border))"
                  tickFormatter={v => `${Math.round(Number(v) / 100) / 10}t`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={v =>
                    v === 'fermenting' ? '熟成中' :
                    v === 'aged'       ? '熟成済在庫' : '小分け製品'
                  }
                />
                <Bar dataKey="fermenting" name="fermenting" stackId="a" fill="#3B82F6" opacity={0.75} />
                <Bar dataKey="aged"       name="aged"       stackId="a" fill="#F59E0B" opacity={0.75} />
                <Bar dataKey="packaged"   name="packaged"   stackId="a" fill="#10B981" opacity={0.75} radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </section>
  )
}

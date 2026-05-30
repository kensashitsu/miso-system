'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'

type SnapshotRow = {
  id:           string
  yearMonth:    string
  misoType:     string
  fermentingKg: number
  agedKg:       number | null
  packagedKg:   number | null
  recordedAt:   Date
}

function Kg({ value }: { value: number | null }) {
  if (value == null) return <span className="text-gray-300">—</span>
  return (
    <>
      <span className="font-medium">{Math.round(value).toLocaleString()}</span>
      <span className="text-gray-400 text-xs ml-0.5">kg</span>
    </>
  )
}

export default function InventorySnapshotCard({ snapshots }: { snapshots: SnapshotRow[] }) {
  const [isOpen, setIsOpen] = useState(false)

  const months = [...new Set(snapshots.map(s => s.yearMonth))].sort().reverse()

  return (
    <section>
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
        <button
          type="button"
          onClick={() => setIsOpen(p => !p)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/50 transition-colors rounded-xl"
        >
          <div>
            <h2 className="text-base font-semibold text-gray-700 text-left">月末在庫スナップショット</h2>
            <p className="text-xs text-muted-foreground text-left mt-0.5">
              {months.length > 0 ? `${months.length}ヶ月分（${months[months.length - 1]} 〜 ${months[0]}）` : 'データなし'}
            </p>
          </div>
          <span className="flex items-center gap-1 text-xs text-gray-400">
            {isOpen ? <><ChevronUp className="h-4 w-4" />閉じる</> : <><ChevronDown className="h-4 w-4" />開く</>}
          </span>
        </button>

        {isOpen && (
          <div className="border-t border-gray-100">
            {snapshots.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                データがありません。GitHub Actionsで月末スナップショットを実行してください。
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <th className="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">年月</th>
                      <th className="text-left px-3 py-2.5 text-xs text-gray-400 font-medium">品種</th>
                      <th className="text-right px-3 py-2.5 text-xs text-gray-400 font-medium">熟成中</th>
                      <th className="text-right px-3 py-2.5 text-xs text-gray-400 font-medium">熟成済在庫</th>
                      <th className="text-right px-3 py-2.5 text-xs text-gray-400 font-medium">小分け製品</th>
                      <th className="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">工場内合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map(ym => {
                      const rows = snapshots.filter(s => s.yearMonth === ym)
                      return rows.map((row, idx) => {
                        const total = row.fermentingKg + (row.agedKg ?? 0) + (row.packagedKg ?? 0)
                        return (
                          <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/40 transition-colors">
                            <td className="px-4 py-2.5 tabular-nums text-gray-600 font-medium">
                              {idx === 0 ? ym : ''}
                            </td>
                            <td className="px-3 py-2.5">
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
                                style={getMisoTypeBadgeStyle(row.misoType)}
                              >
                                {row.misoType}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums"><Kg value={row.fermentingKg} /></td>
                            <td className="px-3 py-2.5 text-right tabular-nums"><Kg value={row.agedKg} /></td>
                            <td className="px-3 py-2.5 text-right tabular-nums"><Kg value={row.packagedKg} /></td>
                            <td className="px-4 py-2.5 text-right tabular-nums font-medium"><Kg value={total} /></td>
                          </tr>
                        )
                      })
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

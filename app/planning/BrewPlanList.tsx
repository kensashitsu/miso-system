'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Trash2, ArrowRight, CheckCircle, CalendarPlus } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { buildGoogleCalendarUrl } from '@/lib/googleCalendarLink'
import { deleteBrewPlan, deleteBrewPlans } from './brew-plan-actions'

export interface BrewPlanItem {
  id:                    string
  misoType:              string
  brewDate:              Date
  completionDate:        Date
  fermentationDays:      number
  location:              string
  bucketNumbers:         string | null
  materialOrderDeadline: Date
  status:                string
  lotId:                 string | null
}

export default function BrewPlanList({ plans }: { plans: BrewPlanItem[] }) {
  const [isPending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  if (plans.length === 0) return null

  const pending = plans.filter(p => p.status === '仮登録')
  const done    = plans.filter(p => p.status === '本登録済')
  const rows    = [...pending, ...done]

  const allSelected = rows.length > 0 && rows.every(p => selectedIds.has(p.id))

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(rows.map(p => p.id)))
  }

  function toggleOne(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleBulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`選択した${selectedIds.size}件を削除しますか？`)) return
    const ids = [...selectedIds]
    startTransition(async () => {
      await deleteBrewPlans(ids)
      setSelectedIds(new Set())
    })
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold">仮登録リスト</h2>
        {selectedIds.size > 0 && (
          <button
            type="button"
            disabled={isPending}
            onClick={handleBulkDelete}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition-colors disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            選択した{selectedIds.size}件を削除
          </button>
        )}
      </div>
      <Card>
        <CardHeader className="pb-2 pt-4">
          <p className="text-xs text-muted-foreground">
            仮登録した仕込み計画の一覧です。内容を確認してロット登録に進んでください。
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 border-b text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="すべて選択"
                      className="h-3.5 w-3.5 align-middle"
                    />
                  </th>
                  <th className="text-left px-3 py-2 font-medium">品種</th>
                  <th className="text-left px-3 py-2 font-medium">仕込み予定日</th>
                  <th className="text-left px-3 py-2 font-medium">完成予定日</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">場所</th>
                  <th className="text-left px-3 py-2 font-medium">状態</th>
                  <th className="text-right px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(plan => {
                  const isRegistered = plan.status === '本登録済'
                  return (
                    <tr key={plan.id} className={`border-b last:border-0 ${isRegistered ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(plan.id)}
                          onChange={() => toggleOne(plan.id)}
                          aria-label={`${plan.misoType}を選択`}
                          className="h-3.5 w-3.5 align-middle"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
                          style={getMisoTypeBadgeStyle(plan.misoType)}
                        >
                          {plan.misoType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums font-medium">
                        {(() => {
                          const dow = ['日','月','火','水','木','金','土'][plan.brewDate.getDay()]
                          return `${format(plan.brewDate, 'M/d')}（${dow}）`
                        })()}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {format(plan.completionDate, 'M/d')}
                          <span className="text-[10px]">({plan.fermentationDays}日)</span>
                          {!isRegistered && (
                            <a
                              href={buildGoogleCalendarUrl({
                                misoType:      plan.misoType,
                                bucketNumbers: plan.bucketNumbers,
                                brewDate:      plan.brewDate,
                                targetDate:    plan.completionDate,
                                isActual:      false,
                              })}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                              aria-label="Googleカレンダーに追加"
                              title="Googleカレンダーに追加"
                            >
                              <CalendarPlus className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        {plan.location}
                      </td>
                      <td className="px-3 py-2.5">
                        {isRegistered ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                            <CheckCircle className="h-3 w-3" />
                            本登録済
                          </span>
                        ) : (
                          <span className="text-amber-600 font-medium">仮登録</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {!isRegistered && (
                            <Link
                              href={`/lots/new?brewPlanId=${plan.id}`}
                              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors whitespace-nowrap"
                            >
                              ロット登録へ
                              <ArrowRight className="h-3 w-3" />
                            </Link>
                          )}
                          {isRegistered && plan.lotId && (
                            <Link
                              href={`/lots/${plan.lotId}`}
                              className="text-[11px] px-2 py-0.5 rounded border text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                            >
                              ロット確認
                            </Link>
                          )}
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => {
                              if (!confirm('この仮登録を削除しますか？')) return
                              startTransition(() => deleteBrewPlan(plan.id))
                            }}
                            className="p-1 rounded text-muted-foreground/60 hover:text-rose-500 hover:bg-rose-50 transition-colors disabled:opacity-40"
                            title="削除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

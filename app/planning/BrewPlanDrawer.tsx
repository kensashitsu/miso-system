'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Trash2, ArrowRight, ChevronUp, ChevronDown, CalendarPlus } from 'lucide-react'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { buildGoogleCalendarUrl } from '@/lib/googleCalendarLink'
import { deleteBrewPlan, deleteBrewPlans } from '@/app/planning/brew-plan-actions'

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

export default function BrewPlanDrawer({ plans }: { plans: BrewPlanItem[] }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 本登録済（ロット化済み）は自動でリストから外れるため、ここに来るのは仮登録のみのはず
  const pending = plans.filter(p => p.status === '仮登録')

  if (pending.length === 0) return null

  const allSelected = pending.length > 0 && pending.every(p => selectedIds.has(p.id))

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(pending.map(p => p.id)))
  }

  function toggleOne(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearManualPin(plan: BrewPlanItem) {
    // この仮登録と同じ日付で仕込み提案側に手動固定(調整済)ピンが残っていた場合、
    // 仮登録が消えた瞬間にその古いピンが復活して推奨日が固まってしまうため、
    // 削除と同時に消しておく（仕込み提案画面はlocalStorageで手動ピンを管理・
    // 回ごとに1回目=品種名のみ、2回目以降=品種名#インデックスのキー）。
    const brewDateStr = format(plan.brewDate, 'yyyy-MM-dd')
    for (let idx = 0; idx < 5; idx++) {
      const key = `planning_manualDate_${idx === 0 ? plan.misoType : `${plan.misoType}#${idx}`}`
      if (localStorage.getItem(key) === brewDateStr) {
        localStorage.removeItem(key)
      }
    }
  }

  function handleBulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`選択した${selectedIds.size}件を削除しますか？`)) return
    const targets = pending.filter(p => selectedIds.has(p.id))
    targets.forEach(clearManualPin)
    const ids = targets.map(p => p.id)
    startTransition(async () => {
      await deleteBrewPlans(ids)
      setSelectedIds(new Set())
    })
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 no-print">
      <div className="max-w-[1400px] mx-auto px-4">
      {/* 展開時のパネル */}
      {isOpen && (
        <div className="bg-white border-t border-x border-gray-200 rounded-t-xl shadow-lg overflow-hidden max-h-[55vh] flex flex-col">
            {selectedIds.size > 0 && (
              <div className="flex items-center justify-end px-3 py-2 border-b bg-white shrink-0">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleBulkDelete}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition-colors disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  選択した{selectedIds.size}件を削除
                </button>
              </div>
            )}
          <div className="overflow-y-auto overflow-x-auto flex-1 min-h-0">
            <table className="w-full min-w-[500px] text-xs">
              <thead className="sticky top-0 bg-muted/40 border-b">
                <tr className="text-muted-foreground">
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
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">桶番号</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">場所</th>
                  <th className="text-left px-3 py-2 font-medium">状態</th>
                  <th className="text-right px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(plan => {
                  return (
                    <tr key={plan.id} className="border-b last:border-0">
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
                            className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                            aria-label="Googleカレンダーに追加"
                            title="Googleカレンダーに追加"
                          >
                            <CalendarPlus className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums hidden sm:table-cell">
                        {plan.bucketNumbers ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        {plan.location}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-amber-600 font-medium">仮登録</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/lots/new?brewPlanId=${plan.id}`}
                            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors whitespace-nowrap"
                          >
                            ロット登録へ
                            <ArrowRight className="h-3 w-3" />
                          </Link>
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => {
                              if (!confirm('この仮登録を削除しますか？')) return
                              clearManualPin(plan)
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
        </div>
      )}

      {/* 常時表示バー */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="w-full bg-white border-t border-x border-gray-200 px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 text-sm font-medium">
          <span className="inline-flex items-center gap-1.5 text-amber-700">
            <span className="inline-flex items-center justify-center bg-amber-100 text-amber-700 rounded-full w-5 h-5 text-[11px] font-bold">{pending.length}</span>
            仮登録
          </span>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {isOpen ? (
            <><ChevronDown className="h-4 w-4" />閉じる</>
          ) : (
            <><ChevronUp className="h-4 w-4" />一覧を見る</>
          )}
        </span>
      </button>
      </div>
    </div>
  )
}

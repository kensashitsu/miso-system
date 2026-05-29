'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Trash2, ArrowRight, CheckCircle, ChevronUp, ChevronDown } from 'lucide-react'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { deleteBrewPlan } from '@/app/planning/brew-plan-actions'
import type { BrewPlanItem } from './BrewPlanList'

export default function BrewPlanDrawer({ plans }: { plans: BrewPlanItem[] }) {
  const [isOpen, setIsOpen] = useState(true)
  const [isPending, startTransition] = useTransition()

  if (plans.length === 0) return null

  const pending = plans.filter(p => p.status === '仮登録')
  const done    = plans.filter(p => p.status === '本登録済')

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 no-print">
      <div className="max-w-5xl mx-auto px-4">
      {/* 展開時のパネル */}
      {isOpen && (
        <div className="bg-white border-t border-x border-gray-200 rounded-t-xl shadow-lg overflow-hidden max-h-[55vh] flex flex-col">
          <div className="overflow-y-auto overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/40 border-b">
                <tr className="text-muted-foreground">
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
                {[...pending, ...done].map(plan => {
                  const isRegistered = plan.status === '本登録済'
                  return (
                    <tr key={plan.id} className={`border-b last:border-0 ${isRegistered ? 'opacity-60' : ''}`}>
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
                        {format(plan.completionDate, 'M/d')}
                        <span className="ml-1 text-[10px]">({plan.fermentationDays}日)</span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums hidden sm:table-cell">
                        {plan.bucketNumbers ?? '—'}
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
        </div>
      )}

      {/* 常時表示バー */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="w-full bg-white border-t border-x border-gray-200 px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 text-sm font-medium">
          {pending.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <span className="inline-flex items-center justify-center bg-amber-100 text-amber-700 rounded-full w-5 h-5 text-[11px] font-bold">{pending.length}</span>
              仮登録
            </span>
          )}
          {done.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle className="h-3.5 w-3.5" />
              本登録済 {done.length}件
            </span>
          )}
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

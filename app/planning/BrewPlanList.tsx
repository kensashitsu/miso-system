'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Trash2, ArrowRight, CheckCircle } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { deleteBrewPlan } from './brew-plan-actions'

export interface BrewPlanItem {
  id:                    string
  misoType:              string
  brewDate:              Date
  completionDate:        Date
  fermentationDays:      number
  location:              string
  materialOrderDeadline: Date
  status:                string
  lotId:                 string | null
}

export default function BrewPlanList({ plans }: { plans: BrewPlanItem[] }) {
  const [isPending, startTransition] = useTransition()

  if (plans.length === 0) return null

  const pending = plans.filter(p => p.status === '仮登録')
  const done    = plans.filter(p => p.status === '本登録済')

  return (
    <section>
      <h2 className="text-base font-semibold mb-3">仮登録リスト</h2>
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
                  <th className="text-left px-3 py-2 font-medium">品種</th>
                  <th className="text-left px-3 py-2 font-medium">仕込み予定日</th>
                  <th className="text-left px-3 py-2 font-medium">完成予定日</th>
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

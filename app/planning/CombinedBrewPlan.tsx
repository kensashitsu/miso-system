'use client'

import { useMemo, useState, useTransition } from 'react'
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import {
  combineBrewPlans, REASON_LABEL, YAMABUKI, INAKA, MUTENKA,
  type CombineCandidate, type PlacedBrew,
} from '@/lib/brewCombine'
import { createBrewPlan } from './brew-plan-actions'
import CombinedStockChart, { type StockSeriesInput } from './CombinedStockChart'

// 3品種（無添加・田舎・山吹）をまとめた仕込み提案。
// 品種ごとの提案は在庫切れからの逆算をそれぞれ独立にやるため、田舎と無添加が
// 同じ週を欲しがると片方が押し出され、山吹の「単独では仕込めない」も表現できない。
// ここでは品種ごとの提案を入力として、現場の組み合わせルールで週の枠へ割り当て直す。
// ルールの中身は lib/brewCombine.ts を参照。

export interface CombinedPlanInput {
  misoType:      string
  location:      string
  orderLeadDays: number
  // 根拠グラフ用（在庫推移の引き直しに要る）
  effectiveStock:   number
  getDailyRateFn:   (date: Date) => number
  safetyLineFn:     ((date: Date) => number) | null
  baseSupplyEvents: { date: Date; kg: number }[]
  batchKg:          number
  getCompletion?: (brewDate: Date) => { days: number; completionDate: Date }
  batches: {
    brewDate:              Date
    completionDate:        Date
    fermentationDays:      number
    materialOrderDeadline: Date
    stockOutDate:          Date
    isFixed?:              boolean
    bucketNumbers?:        string | null
  }[]
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'] as const
const TARGET_TYPES = [MUTENKA, INAKA, YAMABUKI]

export default function CombinedBrewPlan({
  inputs,
  blockedWeeks,
  savedKeys,
  onSaved,
}: {
  inputs:        CombinedPlanInput[]
  blockedWeeks:  string[]
  savedKeys:     Set<string>          // すでに仮登録済みのキー（品種::yyyy-MM-dd）
  onSaved:       (key: string) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const today = startOfDay(new Date())

  const weeks = useMemo(() => {
    const candidates: CombineCandidate[] = []
    const getCompletion: Record<string, (d: Date) => { days: number; completionDate: Date }> = {}
    for (const p of inputs) {
      if (!TARGET_TYPES.includes(p.misoType)) continue
      if (p.getCompletion) getCompletion[p.misoType] = p.getCompletion
      for (const b of p.batches) {
        candidates.push({
          misoType:              p.misoType,
          location:              p.location,
          brewDate:              b.brewDate,
          completionDate:        b.completionDate,
          fermentationDays:      b.fermentationDays,
          materialOrderDeadline: b.materialOrderDeadline,
          stockOutDate:          b.stockOutDate,
          orderLeadDays:         p.orderLeadDays,
          isFixed:               b.isFixed === true,
          bucketNumbers:         b.bucketNumbers ?? null,
        })
      }
    }
    return combineBrewPlans(candidates, {
      blockedWeeks: new Set(blockedWeeks),
      getCompletion,
    })
  }, [inputs, blockedWeeks])

  const keyOf = (b: PlacedBrew) => `${b.misoType}::${format(b.brewDate, 'yyyy-MM-dd')}`

  const register = (b: PlacedBrew) => {
    const key = keyOf(b)
    setSavingKey(key)
    startTransition(async () => {
      // JST午前0時はUTCで前日になるため、日付文字列からUTC midnightに正規化する
      const toUTC = (d: Date) => `${format(d, 'yyyy-MM-dd')}T00:00:00Z`
      await createBrewPlan({
        misoType:                 b.misoType,
        brewDateISO:              toUTC(b.brewDate),
        completionDateISO:        toUTC(b.completionDate),
        fermentationDays:         b.fermentationDays,
        location:                 b.location,
        materialOrderDeadlineISO: toUTC(b.materialOrderDeadline),
      })
      onSaved(key)
      setSavingKey(null)
    })
  }

  if (weeks.length === 0) {
    return (
      <p className="rounded-lg border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        まとめて出せる提案がありません（現在庫を入力すると提案が出ます）
      </p>
    )
  }

  const cell = (b: PlacedBrew | null) => {
    if (!b) return <span className="text-muted-foreground/50">—</span>
    const key    = keyOf(b)
    const saved  = b.isFixed || savedKeys.has(key)
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {/* 「その週の水曜」では何日か分からないので、日付そのものを先頭に出す */}
        <span className="tabular-nums font-medium text-foreground whitespace-nowrap">
          {format(b.brewDate, 'M/d')}（{DOW[b.brewDate.getDay()]}）
        </span>
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
          style={getMisoTypeBadgeStyle(b.misoType)}
        >
          {b.misoType}
        </span>
        <span className="tabular-nums text-muted-foreground">
          完成 {format(b.completionDate, 'M/d')}
          <span className="text-foreground/40">（{b.fermentationDays}日）</span>
        </span>
        {!b.fits && (
          <span
            className="rounded bg-rose-100 px-1 py-0.5 text-[10px] font-medium text-rose-700"
            title={`在庫切れ ${format(b.stockOutDate, 'M/d')} に ${Math.abs(b.marginDays)} 日遅れます`}
          >
            {Math.abs(b.marginDays)}日遅れ
          </span>
        )}
        {saved ? (
          <span className="text-[10px] text-emerald-700">仮登録済み</span>
        ) : (
          <button
            type="button"
            onClick={() => register(b)}
            disabled={isPending}
            className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-40"
          >
            {savingKey === key ? '保存中' : '仮登録'}
          </button>
        )}
      </span>
    )
  }

  // 置き直したあとの仕込み（グラフの補充と点に使う）
  const placed = weeks.flatMap(w => [w.wed, w.thu].filter(Boolean) as PlacedBrew[])
  const series: StockSeriesInput[] = inputs
    .filter(p => TARGET_TYPES.includes(p.misoType))
    .map(p => ({
      misoType:         p.misoType,
      effectiveStock:   p.effectiveStock,
      getDailyRateFn:   p.getDailyRateFn,
      safetyLineFn:     p.safetyLineFn,
      baseSupplyEvents: p.baseSupplyEvents,
      batchKg:          p.batchKg,
    }))

  return (
    <div className="space-y-2">
      <CombinedStockChart series={series} placed={placed} />
      <div className="rounded-lg border overflow-hidden">
        <div className="grid grid-cols-[7rem_1fr_1fr_10rem] gap-x-3 bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>週</span>
          <span>水曜</span>
          <span>木曜</span>
          <span>組み方</span>
        </div>
        <div className="divide-y">
          {weeks.map(w => {
            const brews  = [w.wed, w.thu].filter(Boolean) as PlacedBrew[]
            const isPair = brews.length === 2
            const moved  = brews.find(b => b.reason === 'contention' || b.reason === 'yamabuki-wait')
            const isPast = w.weekMonday < today
            return (
              <div
                key={format(w.weekMonday, 'yyyy-MM-dd')}
                className={`grid grid-cols-[7rem_1fr_1fr_10rem] items-center gap-x-3 px-3 py-2 text-xs ${isPast ? 'bg-muted/20' : ''}`}
              >
                <span className="tabular-nums text-muted-foreground">
                  {format(w.weekMonday, 'M/d')} の週
                </span>
                <span>{cell(w.wed)}</span>
                <span>{cell(w.thu)}</span>
                <span className="text-[10px] text-muted-foreground">
                  {isPair ? 'セット' : '単発'}
                  {moved && `・${REASON_LABEL[moved.reason]}`}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        現場のルール（水木のみ／山吹は木曜で前日に田舎か無添加が要る／セットは水＝田舎・木＝無添加）に
        合わせて、品種ごとの提案を週の枠へ置き直しています。同じ週が埋まっていた回は後ろへ送り、
        その結果ずれた完成予定日と原料手配の締切も引き直しています。
      </p>
    </div>
  )
}

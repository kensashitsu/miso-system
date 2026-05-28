"use client"

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, LineChart } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { differenceInDays, format, startOfDay } from 'date-fns'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import LotSimulationModal, { type LotSimConfig } from './LotSimulationModal'

type ColoringRisk = 'normal' | 'warning' | 'danger'

export { type LotSimConfig }

export interface LotCardProps {
  id: string
  lotNumber: string
  misoType: string
  brewedAtISO: string
  elapsedDays: number
  accumulatedTemp: number
  targetTempSum: number
  currentLocation: string
  estimatedCompletionISO: string | null
  completedAtISO: string | null
  coloringRisk: ColoringRisk
  status: string
  bucketNumbers: string | null
  buckets: Array<{
    bucketNumber: number
    initialKg:    number
    remainingKg:  number | null
    status:       string
  }>
  variant?: 'completed' | 'needs-action'
  forceSignal?: { open: boolean } | null
  simConfig?: LotSimConfig
  locationTransitions?: Array<{ date: string; from: string; to: string }>
}

const RISK_BADGE_CLASS: Record<ColoringRisk, string> = {
  normal:  'bg-emerald-50 text-emerald-700 border border-emerald-200/50',
  warning: 'bg-amber-50 text-amber-700 border border-amber-200/50',
  danger:  'bg-rose-50 text-rose-700 border border-rose-200/50',
}

const RISK_LABEL: Record<ColoringRisk, string> = {
  normal:  '通常',
  warning: '要注意',
  danger:  'リスク高',
}

const PROGRESS_COLOR: Record<ColoringRisk, string> = {
  normal:  'bg-emerald-500',
  warning: 'bg-amber-500',
  danger:  'bg-rose-500',
}

const CARD_BORDER: Record<ColoringRisk, string> = {
  normal:  'border-gray-100',
  warning: 'border-amber-200',
  danger:  'border-rose-300',
}

export default function LotCard({
  id,
  lotNumber,
  misoType,
  brewedAtISO,
  elapsedDays,
  accumulatedTemp,
  targetTempSum,
  currentLocation,
  estimatedCompletionISO,
  completedAtISO,
  coloringRisk,
  status,
  bucketNumbers,
  buckets,
  variant,
  forceSignal,
  simConfig,
  locationTransitions,
}: LotCardProps) {
  const [detailOpen,  setDetailOpen]  = useState(false)
  const [simModalOpen, setSimModalOpen] = useState(false)

  useEffect(() => {
    if (forceSignal == null) return
    setDetailOpen(forceSignal.open)
  }, [forceSignal])

  const rawPct      = targetTempSum > 0 ? (accumulatedTemp / targetTempSum) * 100 : 0
  // バー幅は常に 100% 上限。完成済みは実際の値（例: 120.3%）をテキストで表示
  const barWidth    = Math.min(100, rawPct)
  const progressPercent = Math.round(rawPct * 10) / 10
  const brewDate        = new Date(brewedAtISO)
  const completionDate  = estimatedCompletionISO ? new Date(estimatedCompletionISO) : null
  const completedAt     = completedAtISO ? new Date(completedAtISO) : null
  const today           = new Date()

  const daysUntilCompletion = completionDate
    ? Math.round((completionDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    : null

  const cardCls = [
    'h-full rounded-xl shadow-sm',
    CARD_BORDER[coloringRisk],
    variant === 'completed'    ? 'bg-gray-50/60' : '',
    variant === 'needs-action' ? 'border-l-[3px] border-l-rose-500' : '',
  ].filter(Boolean).join(' ')

  return (
    <>
    <Link href={`/lots/${id}`} className="block hover:opacity-90 transition-opacity">
      <Card className={cardCls}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base font-bold text-gray-900 tracking-tight">{lotNumber}</CardTitle>
            <div className="flex flex-wrap gap-1 justify-end">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
                style={getMisoTypeBadgeStyle(misoType)}
              >
                {misoType}
              </span>
              {status !== '熟成中' && (
                <Badge variant="secondary" className="text-xs whitespace-nowrap">{status}</Badge>
              )}
            </div>
          </div>
          {bucketNumbers && (
            <div className="flex flex-wrap gap-1 mt-1">
              {bucketNumbers.split('・').map(n => (
                <span
                  key={n}
                  className="inline-flex items-center rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600"
                >
                  {n}号
                </span>
              ))}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {/* 熟成度・進捗バー */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-muted-foreground">熟成度</span>
              <span className="font-medium tabular-nums">{progressPercent}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${PROGRESS_COLOR[coloringRisk]}`}
                style={{ width: `${barWidth}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span className="tabular-nums">
                {Math.round(accumulatedTemp)} / {targetTempSum} ℃・日
              </span>
              <span className={`font-medium px-2 py-0.5 rounded-full text-xs ${RISK_BADGE_CLASS[coloringRisk]}`}>
                {RISK_LABEL[coloringRisk]}
              </span>
            </div>
          </div>

          {/* 現在地 + 詳細トグルボタン */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">現在地</span>
            <div className="flex items-center gap-2">
              <span className="font-medium">{currentLocation}</span>
              <button
                type="button"
                onClick={e => { e.preventDefault(); e.stopPropagation(); setDetailOpen(v => !v) }}
                className="p-0.5 rounded text-muted-foreground hover:bg-muted/60 transition-colors"
                aria-label={detailOpen ? '詳細を閉じる' : '詳細を開く'}
              >
                {detailOpen
                  ? <ChevronUp   className="h-3.5 w-3.5" />
                  : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* 詳細（折りたたみ対象：桶別残量・日付情報） */}
          {detailOpen && (
            <div className="space-y-2 pt-1 border-t border-gray-100">

              {/* 桶別残量 */}
              {buckets.length > 0 && (
                <div className={`grid gap-1.5 ${buckets.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {buckets.map(b => {
                    const isEmpty  = b.status === '空'
                    const isActive = b.status === '使用中'
                    const isWaiting = b.status === '待機中'
                    const displayKg = isEmpty
                      ? 0
                      : isActive
                        ? (b.remainingKg ?? b.initialKg)
                        : b.initialKg
                    const pct = b.initialKg > 0 ? (displayKg / b.initialKg) * 100 : 0
                    const barColor = isEmpty   ? 'bg-gray-200'
                                   : isWaiting ? 'bg-slate-400'
                                   : pct >= 60  ? 'bg-emerald-500'
                                   : pct >= 30  ? 'bg-amber-400'
                                   :              'bg-rose-500'
                    const cellCls = isEmpty
                      ? 'rounded-lg border px-2 py-1.5 bg-gray-50 border-gray-100 space-y-1'
                      : 'rounded-lg border px-2 py-1.5 bg-white border-gray-100 space-y-1'
                    return (
                      <div key={b.bucketNumber} className={cellCls}>
                        <div className="flex items-center gap-1">
                          <span className={`text-xs font-medium whitespace-nowrap ${isActive ? '' : 'text-muted-foreground'}`}>
                            {b.bucketNumber}号桶
                          </span>
                          <span className={`text-[10px] px-1 rounded leading-4 whitespace-nowrap ${
                            isActive ? 'bg-blue-50 text-blue-600' : 'bg-muted text-muted-foreground'
                          }`}>
                            {b.status}
                          </span>
                          <span className={`text-xs tabular-nums ml-auto whitespace-nowrap ${
                            isActive ? 'font-medium' : 'text-muted-foreground'
                          }`}>
                            {Math.round(displayKg).toLocaleString()}kg
                          </span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${barColor}`}
                            style={{ width: `${Math.max(pct, isEmpty ? 0 : 2)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* 熟成中：仕込み日・完成予定日 */}
              {status === '熟成中' && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">仕込み</span>
                    <span className="font-medium tabular-nums">
                      {format(brewDate, 'yyyy/MM/dd')}
                      <span className="text-muted-foreground ml-1 text-xs">（{elapsedDays}日経過）</span>
                    </span>
                  </div>
                  {completionDate && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">完成予定</span>
                      <span className={`font-medium ${
                        daysUntilCompletion !== null && daysUntilCompletion <= 7 ? 'text-orange-600' : ''
                      }`}>
                        {format(completionDate, 'M月d日')}
                        <span className="text-muted-foreground ml-1 text-xs">
                          （あと{daysUntilCompletion}日）
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* 完成：仕込み日・完成日・熟成日数 */}
              {status === '完成' && (() => {
                if (!completedAt) return (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">状態</span>
                    <span className="text-blue-600 font-medium">完成・待機中</span>
                  </div>
                )
                const diffDays  = Math.round((today.getTime() - completedAt.getTime()) / (1000 * 60 * 60 * 24))
                const agingDays = differenceInDays(startOfDay(completedAt), startOfDay(brewDate))
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">仕込み</span>
                      <span className="font-medium tabular-nums">
                        {format(brewDate, 'yyyy/MM/dd')}
                        <span className="text-muted-foreground ml-1 text-xs">（{elapsedDays}日経過）</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">完成日</span>
                      <span className="font-medium">
                        {format(completedAt, 'M月d日')}
                        <span className="text-muted-foreground ml-1 text-xs">
                          {diffDays < 0
                            ? `（あと${Math.abs(diffDays)}日）`
                            : diffDays === 0
                              ? '（本日）'
                              : `（${diffDays}日前）`}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">熟成日数</span>
                      <span className="font-medium tabular-nums">{agingDays}日</span>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {/* 熟成シミュレーションボタン（熟成中のみ） */}
          {status === '熟成中' && simConfig && (
            <div className="pt-1.5 border-t border-gray-100 mt-1">
              <button
                type="button"
                onClick={e => { e.preventDefault(); e.stopPropagation(); setSimModalOpen(true) }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-primary hover:text-primary/80 py-1 rounded transition-colors hover:bg-primary/5"
              >
                <LineChart className="h-3.5 w-3.5" />
                熟成シミュレーション
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>

    {/* モーダル（Linkの外に配置してネストを回避） */}
    {status === '熟成中' && simConfig && simModalOpen && (
      <LotSimulationModal
        isOpen={simModalOpen}
        onClose={() => setSimModalOpen(false)}
        lotNumber={lotNumber}
        misoType={misoType}
        brewedAtISO={brewedAtISO}
        elapsedDays={elapsedDays}
        accumulatedTemp={accumulatedTemp}
        targetTempSum={targetTempSum}
        currentLocation={currentLocation}
        simConfig={simConfig}
        locationTransitions={locationTransitions}
        completedAtISO={completedAtISO}
      />
    )}
    </>
  )
}

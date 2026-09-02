"use client"

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, LineChart, CalendarPlus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { differenceInDays, format, startOfDay } from 'date-fns'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { buildGoogleCalendarUrl } from '@/lib/googleCalendarLink'
import { bucketRemainingKg } from '@/lib/lotStock'
import LotSimulationModal, { type LotSimConfig } from './LotSimulationModal'

type ColoringRisk = 'normal' | 'warning' | 'danger'

export { type LotSimConfig }

export interface LotCardProps {
  id: string
  lotNumber: string
  misoType: string
  brewedAtISO: string
  elapsedDays: number
  accumulatedTemp: number         // 完成までの積算（熟成中は今日まで）
  postCompletionTemp?: number | null  // 完成後に進んだ積算（完成ロットのみ）
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
  isPrototype?: boolean
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

// 熟成度%から着色リスクを求める（バーの色分け用。判定基準は calcColoringRisk と同じ）
function riskOfPct(pct: number): ColoringRisk {
  if (pct >= 150) return 'danger'
  if (pct >= 120) return 'warning'
  return 'normal'
}

// 「あと3日」「本日」「5日前」の表記（日付単位。時刻の差で1日ズレないよう startOfDay 基準で数える）
function relativeDayLabel(days: number): string {
  if (days === 0) return '本日'
  return days > 0 ? `あと${days}日` : `${Math.abs(days)}日前`
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
  postCompletionTemp,
  targetTempSum,
  currentLocation,
  estimatedCompletionISO,
  completedAtISO,
  coloringRisk,
  status,
  bucketNumbers,
  buckets,
  isPrototype,
  variant,
  forceSignal,
  simConfig,
  locationTransitions,
}: LotCardProps) {
  const [detailOpen,  setDetailOpen]  = useState(true)
  const [simModalOpen, setSimModalOpen] = useState(false)

  useEffect(() => {
    if (forceSignal == null) return
    setDetailOpen(forceSignal.open)
  }, [forceSignal])

  const rawPct      = targetTempSum > 0 ? (accumulatedTemp / targetTempSum) * 100 : 0
  const progressPercent = Math.round(rawPct * 10) / 10
  // 完成後も置き場の温度に応じて熟成は進む。完成時点の熟成度と分けて表示する
  const postTemp    = postCompletionTemp ?? 0
  const hasPost     = postTemp > 0
  const totalPct    = targetTempSum > 0 ? ((accumulatedTemp + postTemp) / targetTempSum) * 100 : 0

  // バーの目盛り。100%を満杯にすると、完成後も熟成が進んで累計218%といったロットが
  // 「満杯」としか描けず、完成後の分が1ピクセルも出ない（2026-09-02修正）。
  // 目標を超えている（＝着色リスクを見たい）ロットだけ物差しを200%まで広げ、
  // 100%（完成）・120%（要注意）・150%（リスク高）に目盛りを立てる。
  // 熟成中で目標未達のロットは従来どおり100%＝満杯（完成までの進捗が読みやすいため）
  const RISK_SCALE_MAX = 200
  const useRiskScale = hasPost || rawPct > 100
  const scaleMax     = useRiskScale ? RISK_SCALE_MAX : 100
  const toWidth      = (pct: number) => Math.max(0, Math.min(100, (pct / scaleMax) * 100))
  const barWidth     = toWidth(rawPct)
  const postBarWidth = Math.max(0, toWidth(totalPct) - barWidth)
  const isOverScale  = totalPct > scaleMax
  // 目盛りの位置（%）。物差しが100%のときは出さない
  const scaleTicks   = useRiskScale
    ? [
        { pct: 100, label: '完成' },
        { pct: 120, label: '要注意' },
        { pct: 150, label: 'リスク高' },
      ].filter(t => t.pct < scaleMax)
    : []
  const brewDate        = new Date(brewedAtISO)
  const completionDate  = estimatedCompletionISO ? new Date(estimatedCompletionISO) : null
  const completedAt     = completedAtISO ? new Date(completedAtISO) : null
  const today           = new Date()

  // 時刻込みの引き算だと夜間に1日短く出てダッシュボードのバナー（サーバー側は日付単位）と
  // 食い違うため、日付単位で数える
  const daysUntilCompletion = completionDate
    ? differenceInDays(startOfDay(completionDate), startOfDay(today))
    : null
  // 予定の熟成日数（仕込み日→完成予定日）。完成ロットの「熟成日数」と対になる
  const plannedAgingDays = completionDate
    ? differenceInDays(startOfDay(completionDate), startOfDay(brewDate))
    : null

  // Googleカレンダーへの予定追加リンク
  const detailsExtra = `目標積算温度：${targetTempSum}℃・日`
  const googleCalendarUrl = completionDate
    ? buildGoogleCalendarUrl({ misoType, bucketNumbers, brewDate, targetDate: completionDate, detailsExtra, isActual: false })
    : null
  const googleCalendarUrlActual = completedAt
    ? buildGoogleCalendarUrl({ misoType, bucketNumbers, brewDate, targetDate: completedAt, detailsExtra, isActual: true })
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
        <CardHeader className="pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm sm:text-base font-bold text-gray-900 tracking-tight">{lotNumber}</CardTitle>
            <div className="flex flex-wrap gap-1 justify-end">
              {isPrototype && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap bg-violet-100 text-violet-700 border border-violet-200">
                  試作
                </span>
              )}
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

        <CardContent className="space-y-3 px-3 sm:px-6 pb-3 sm:pb-6">
          {/* 熟成度・進捗バー */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-muted-foreground">{hasPost ? '熟成度（完成時）' : '熟成度'}</span>
              {/* バーが2色（完成まで／完成後）なので、数字も両方出さないと
                  どちらの色がどの値か読めない（2026-09-02ユーザー指摘） */}
              <span className="font-medium tabular-nums">
                {progressPercent}%
                {hasPost && (
                  <span className={`ml-1 ${coloringRisk === 'danger' ? 'text-rose-600' : 'text-amber-600'}`}>
                    → 累計 {Math.round(totalPct * 10) / 10}%
                  </span>
                )}
              </span>
            </div>
            <div className="relative w-full">
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden flex">
                {/* 完成までの分。色は完成時点の熟成度で決める（完成後の上乗せは次のセグメント） */}
                <div
                  className={`h-full transition-all ${PROGRESS_COLOR[riskOfPct(rawPct)]}`}
                  style={{ width: `${barWidth}%` }}
                />
                {/* 完成後に進んだ分（色を変えて区別） */}
                {postBarWidth > 0 && (
                  <div
                    className={`h-full transition-all ${coloringRisk === 'danger' ? 'bg-rose-400' : 'bg-amber-400'}`}
                    style={{ width: `${postBarWidth}%` }}
                    title="完成後に進んだ熟成"
                  />
                )}
              </div>
              {/* 目盛り（完成100% / 要注意120% / リスク高150%） */}
              {scaleTicks.map(t => (
                <span
                  key={t.pct}
                  className="absolute top-0 h-2 w-px bg-white/80"
                  style={{ left: `${(t.pct / scaleMax) * 100}%` }}
                  title={`${t.label} ${t.pct}%`}
                  aria-hidden
                />
              ))}
              {/* 目盛りを振り切れた分（青天井に伸ばすと他のロットと比べられなくなるため印だけ） */}
              {isOverScale && (
                <span className="absolute -top-0.5 -right-1 text-[10px] leading-none text-rose-500" title={`目盛り${scaleMax}%を超過`}>
                  ▶
                </span>
              )}
            </div>
            {useRiskScale && (
              <div className="relative h-3 mt-0.5 text-[9px] text-gray-400 select-none" aria-hidden>
                {scaleTicks.map(t => (
                  <span key={t.pct} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(t.pct / scaleMax) * 100}%` }}>
                    {t.pct}
                  </span>
                ))}
                <span className="absolute right-0 whitespace-nowrap">{scaleMax}%</span>
              </div>
            )}
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span className="tabular-nums">
                {Math.round(accumulatedTemp)} / {targetTempSum} ℃・日
              </span>
              <span
                className={`font-medium px-2 py-0.5 rounded-full text-xs ${RISK_BADGE_CLASS[coloringRisk]}`}
                title={hasPost ? `完成後の熟成も含めた累計 ${Math.round(totalPct)}% で判定` : undefined}
              >
                {RISK_LABEL[coloringRisk]}
              </span>
            </div>
            {hasPost && (
              <div className="flex justify-between text-xs mt-1 pt-1 border-t border-dashed border-gray-100">
                <span className="text-muted-foreground">
                  完成後の熟成
                  <span className="text-gray-400 ml-1">（{currentLocation}）</span>
                </span>
                <span className="tabular-nums text-amber-700">
                  +{Math.round(postTemp)} ℃・日
                  <span className="text-muted-foreground ml-1">（累計 {Math.round(totalPct * 10) / 10}%）</span>
                </span>
              </div>
            )}
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
                    // 在庫サマリーの合計と同じ数え方にする（lib/lotStock.ts）
                    const displayKg = bucketRemainingKg(b.status, b.remainingKg, b.initialKg)
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
                      <span className="text-muted-foreground">
                        {daysUntilCompletion !== null && daysUntilCompletion < 0 ? '完成予定（超過）' : '完成予定'}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className={`font-medium ${
                          daysUntilCompletion !== null && daysUntilCompletion <= 7 ? 'text-orange-600' : ''
                        }`}>
                          {format(completionDate, 'M月d日')}
                          <span className="text-muted-foreground ml-1 text-xs">
                            （{relativeDayLabel(daysUntilCompletion!)}）
                          </span>
                        </span>
                        <a
                          href={googleCalendarUrl!}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                          aria-label="Googleカレンダーに追加"
                          title="Googleカレンダーに追加"
                        >
                          <CalendarPlus className="h-3.5 w-3.5" />
                        </a>
                      </span>
                    </div>
                  )}
                  {plannedAgingDays !== null && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">熟成日数（予定）</span>
                      {/* 残り日数は上の「完成予定」行に出ているので、ここは日数だけ */}
                      <span className="font-medium tabular-nums">{plannedAgingDays}日</span>
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
                const diffDays  = differenceInDays(startOfDay(today), startOfDay(completedAt))
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
                      <span className="flex items-center gap-1.5">
                      <span className="font-medium">
                        {format(completedAt, 'M月d日')}
                        <span className="text-muted-foreground ml-1 text-xs">
                          （{relativeDayLabel(-diffDays)}）
                        </span>
                      </span>
                      <a
                        href={googleCalendarUrlActual!}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                        aria-label="Googleカレンダーに追加"
                        title="Googleカレンダーに追加"
                      >
                        <CalendarPlus className="h-3.5 w-3.5" />
                      </a>
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

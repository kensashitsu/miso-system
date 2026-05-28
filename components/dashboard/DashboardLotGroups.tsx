'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import LotCard, { type LotCardProps, type LotSimConfig } from './lot-card'

interface Props {
  agingLots:       LotCardProps[]
  completedLots:   LotCardProps[]
  needsActionLots: LotCardProps[]
  simConfig?:      LotSimConfig
}

const MISO_TYPE_ORDER = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ']

export default function DashboardLotGroups({ agingLots, completedLots, needsActionLots, simConfig }: Props) {
  const [forceSignal, setForceSignal] = useState<{ open: boolean } | null>(null)
  const [allOpen, setAllOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<string | null>(null)

  function toggleAll() {
    const next = !allOpen
    setAllOpen(next)
    setForceSignal({ open: next })
  }

  const allLots = [...agingLots, ...completedLots, ...needsActionLots]

  if (allLots.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        現在管理中のロットはありません
      </p>
    )
  }

  // 実在する品種のみフィルタボタンを表示（表示順固定）
  const availableTypes = MISO_TYPE_ORDER.filter(t => allLots.some(l => l.misoType === t))

  const filter = (lots: LotCardProps[]) =>
    selectedType ? lots.filter(l => l.misoType === selectedType) : lots

  const filteredAging       = filter(agingLots)
  const filteredCompleted   = filter(completedLots)
  const filteredNeedsAction = filter(needsActionLots)

  // 最初に表示されるグループを判定（ボタンをそこの見出し横に配置）
  const firstGroup =
    filteredAging.length > 0       ? 'aging' :
    filteredCompleted.length > 0   ? 'completed' :
    'needs-action'

  const toggleButton = (
    <Button variant="outline" size="sm" onClick={toggleAll} className="text-xs h-7 gap-1.5">
      {allOpen
        ? <><ChevronUp   className="h-3.5 w-3.5" />折りたたむ</>
        : <><ChevronDown className="h-3.5 w-3.5" />すべて展開</>}
    </Button>
  )

  return (
    <div className="space-y-6">

      {/* 品種フィルター */}
      {availableTypes.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelectedType(null)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              selectedType === null
                ? 'bg-gray-900 border-gray-900 text-white'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            すべて
          </button>
          {availableTypes.map(type => (
            <button
              key={type}
              type="button"
              onClick={() => setSelectedType(selectedType === type ? null : type)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                selectedType === type
                  ? 'bg-gray-900 border-gray-900 text-white'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}

    <div className="space-y-8">

      {filteredAging.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold">
              熟成中ロット
              <span className="ml-2 text-sm font-normal text-muted-foreground">{filteredAging.length}件</span>
            </h2>
            {firstGroup === 'aging' && toggleButton}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredAging.map(lot => (
              <LotCard key={lot.id} {...lot} forceSignal={forceSignal} simConfig={simConfig} />
            ))}
          </div>
        </section>
      )}

      {filteredCompleted.length > 0 && (
        <section className={filteredAging.length > 0 ? 'border-t pt-6' : ''}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold">
              完成・待機中
              <span className="ml-2 text-sm font-normal text-muted-foreground">{filteredCompleted.length}件</span>
            </h2>
            {firstGroup === 'completed' && toggleButton}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCompleted.map(lot => (
              <LotCard key={lot.id} {...lot} variant="completed" forceSignal={forceSignal} />
            ))}
          </div>
        </section>
      )}

      {filteredNeedsAction.length > 0 && (
        <section className={filteredAging.length > 0 || filteredCompleted.length > 0 ? 'border-t pt-6' : ''}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold">
              要対応
              <span className="ml-2 text-sm font-normal text-muted-foreground">{filteredNeedsAction.length}件</span>
            </h2>
            {firstGroup === 'needs-action' && toggleButton}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredNeedsAction.map(lot => (
              <LotCard key={lot.id} {...lot} variant="needs-action" forceSignal={forceSignal} />
            ))}
          </div>
        </section>
      )}

      {filteredAging.length === 0 && filteredCompleted.length === 0 && filteredNeedsAction.length === 0 && (
        <p className="text-muted-foreground text-sm py-8 text-center">
          該当するロットはありません
        </p>
      )}

    </div>
    </div>
  )
}

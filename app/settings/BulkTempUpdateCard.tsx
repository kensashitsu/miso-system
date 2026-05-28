'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { bulkMoveLocation } from './actions'

export interface ActiveLot {
  id:        string
  lotNumber: string
  misoType:  string
  location:  string
}

type SourceType = '暖房' | '冷房' | '常温'
type DestType   = '暖房' | '冷房' | '常温' | '冷蔵庫'

const SOURCE_LABEL: Record<SourceType, string> = {
  '暖房': '暖房中',
  '冷房': '冷房中',
  '常温': '常温中',
}
const SOURCE_BADGE: Record<SourceType, string> = {
  '暖房': 'border-amber-200 bg-amber-50/70 text-amber-700',
  '冷房': 'border-blue-200 bg-blue-50/70 text-blue-700',
  '常温': 'border-emerald-200 bg-emerald-50/70 text-emerald-700',
}

interface SectionProps {
  sourceType:         SourceType
  lots:               ActiveLot[]
  heatingDefaultTemp: number
  coolingDefaultTemp: number
}

function BulkMoveSection({ sourceType, lots, heatingDefaultTemp, coolingDefaultTemp }: SectionProps) {
  const router = useRouter()

  const initDestType: DestType = sourceType === '冷房' ? '冷房' : '暖房'
  const [destType,    setDestType]    = useState<DestType>(initDestType)
  const [destTemp,    setDestTemp]    = useState(
    initDestType === '冷房' ? String(coolingDefaultTemp) : String(heatingDefaultTemp)
  )
  const [confirming,  setConfirming]  = useState(false)
  const [savedDest,   setSavedDest]   = useState('')   // 確定時の移動先を保存して結果表示に使う
  const [result,      setResult]      = useState<{ count?: number; error?: string } | null>(null)
  const [isPending,   startTransition] = useTransition()

  function handleDestTypeChange(type: DestType) {
    setDestType(type)
    if (type === '暖房') setDestTemp(String(heatingDefaultTemp))
    if (type === '冷房') setDestTemp(String(coolingDefaultTemp))
  }

  const newLocation = (() => {
    if (destType === '常温' || destType === '冷蔵庫') return destType
    const t = parseInt(destTemp, 10)
    return (!isNaN(t) && t >= 10 && t <= 40) ? `${destType}${t}℃` : ''
  })()

  const isValid = newLocation !== '' && lots.length > 0

  function handleClickMove() {
    if (!isValid) return
    setSavedDest(newLocation)
    setResult(null)
    setConfirming(true)
  }

  function handleConfirm() {
    startTransition(async () => {
      const res = await bulkMoveLocation(sourceType, savedDest)
      setConfirming(false)
      if (res.success) {
        setResult(res)
        setTimeout(() => {
          setResult(null)
          router.refresh()
        }, 1500)
      } else {
        setResult(res)
      }
    })
  }

  return (
    <div className="space-y-3">
      {/* ヘッダー */}
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${SOURCE_BADGE[sourceType]}`}>
          {SOURCE_LABEL[sourceType]}
        </span>
        <span className="text-sm text-muted-foreground">
          {lots.length === 0 ? '対象ロットなし' : `${lots.length}件`}
        </span>
      </div>

      {lots.length === 0 ? (
        <p className="text-xs text-muted-foreground pl-1">
          現在{SOURCE_LABEL[sourceType]}の熟成ロットはありません。
        </p>
      ) : (
        <>
          {/* ロット一覧 */}
          <div className="flex flex-wrap gap-1.5">
            {lots.map(lot => (
              <div
                key={lot.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-xs"
              >
                <span
                  className="inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                  style={getMisoTypeBadgeStyle(lot.misoType)}
                >
                  {lot.misoType.replace('みそ', '')}
                </span>
                <span className="tabular-nums font-medium text-gray-800">{lot.lotNumber}</span>
                <span className="text-muted-foreground">{lot.location}</span>
              </div>
            ))}
          </div>

          {/* 移動先セレクタ */}
          {!confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground shrink-0">移動先：</span>
              <select
                value={destType}
                onChange={e => handleDestTypeChange(e.target.value as DestType)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="暖房">暖房</option>
                <option value="冷房">冷房</option>
                <option value="常温">常温</option>
                <option value="冷蔵庫">冷蔵庫</option>
              </select>
              {(destType === '暖房' || destType === '冷房') && (
                <>
                  <Input
                    type="number"
                    step="1"
                    min="10"
                    max="40"
                    inputMode="numeric"
                    value={destTemp}
                    onChange={e => setDestTemp(e.target.value)}
                    className="min-h-[40px] w-20"
                  />
                  <span className="text-sm text-muted-foreground shrink-0">℃</span>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleClickMove}
                disabled={!isValid || isPending}
              >
                一括移動する
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5">
              <p className="text-sm text-amber-800 flex-1 min-w-0">
                {SOURCE_LABEL[sourceType]}の <span className="font-semibold">{lots.length}</span> ロットを{' '}
                <span className="font-semibold">{savedDest}</span> に移動します。よろしいですか？
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" onClick={handleConfirm} disabled={isPending}>
                  {isPending ? '移動中...' : '確定する'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={isPending}
                >
                  キャンセル
                </Button>
              </div>
            </div>
          )}

          {/* 結果メッセージ */}
          {result && !confirming && (
            result.error ? (
              <p className="text-xs text-rose-600">{result.error}</p>
            ) : (
              <p className="text-xs text-emerald-600 font-medium">
                {result.count}件のロットを {savedDest} に移動しました。
              </p>
            )
          )}
        </>
      )}
    </div>
  )
}

interface Props {
  heatingLots:        ActiveLot[]
  coolingLots:        ActiveLot[]
  normalLots:         ActiveLot[]
  heatingDefaultTemp: number
  coolingDefaultTemp: number
}

export default function BulkTempUpdateCard({
  heatingLots,
  coolingLots,
  normalLots,
  heatingDefaultTemp,
  coolingDefaultTemp,
}: Props) {
  const sections: { sourceType: SourceType; lots: ActiveLot[] }[] = [
    { sourceType: '暖房', lots: heatingLots },
    { sourceType: '冷房', lots: coolingLots },
    { sourceType: '常温', lots: normalLots },
  ]

  return (
    <Card className="rounded-xl border border-gray-100 shadow-sm">
      <CardHeader>
        <CardTitle className="text-base text-gray-900">熟成中ロットの場所一括変更</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          現在暖房中・冷房中・常温中の熟成ロットをまとめて別の場所に移動します。
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {sections.map(({ sourceType, lots }, i) => (
          <div key={sourceType}>
            {i > 0 && <div className="border-t border-gray-100 mb-6" />}
            <BulkMoveSection
              sourceType={sourceType}
              lots={lots}
              heatingDefaultTemp={heatingDefaultTemp}
              coolingDefaultTemp={coolingDefaultTemp}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

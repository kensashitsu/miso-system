'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { moveLot } from './actions'
import { getStockPreview, type StockChangeItem } from '@/app/lots/stock-preview-action'
import StockPreviewPanel from '@/components/StockPreviewPanel'

const BASE_LOCATIONS = ['暖房', '冷房', '常温', '冷蔵庫'] as const
type BaseLocation = typeof BASE_LOCATIONS[number]

interface Props {
  lotId: string
  lotNumber: string
  misoType: string
  isPrototype: boolean
  yieldKg: number
  currentLocation: string
  currentStatus: string
  heatingDefaultTemp: number
  coolingDefaultTemp: number
}

export default function MoveForm({ lotId, lotNumber, misoType, isPrototype, yieldKg, currentLocation, currentStatus, heatingDefaultTemp, coolingDefaultTemp }: Props) {
  const [locationType, setLocationType] = useState<BaseLocation | null>(null)
  const [heatTemp,     setHeatTemp]     = useState(String(heatingDefaultTemp))
  const [coolTemp,     setCoolTemp]     = useState(String(coolingDefaultTemp))
  const [moveDate,     setMoveDate]     = useState(format(new Date(), 'yyyy-MM-dd'))
  const [markAsComplete, setMarkAsComplete] = useState(false)
  const [stockPreview, setStockPreview] = useState<StockChangeItem[] | null | 'loading'>(null)
  const [skipStockUpdate, setSkipStockUpdate] = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [isPending,    startTransition] = useTransition()
  const router = useRouter()

  // markAsComplete が変わったら在庫プレビューを取得
  useEffect(() => {
    if (isPrototype || !markAsComplete) {
      setStockPreview(null)
      setSkipStockUpdate(false)
      return
    }
    setStockPreview('loading')
    setSkipStockUpdate(false)
    getStockPreview(misoType, 'complete', yieldKg)
      .then(items => setStockPreview(items))
      .catch(() => setStockPreview([]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markAsComplete])

  // 現在地の種別（比較用）
  const currentBaseType: BaseLocation | null =
    (BASE_LOCATIONS as readonly string[]).find(b =>
      currentLocation === b ||
      currentLocation.startsWith(b)
    ) as BaseLocation | null ?? null

  // 保存する場所名を生成
  function buildLocationString(): string | null {
    if (!locationType) return null
    if (locationType === '暖房') return `暖房${heatTemp}℃`
    if (locationType === '冷房') return `冷房${coolTemp}℃`
    return locationType
  }

  // 現在地と同じかどうか判定（温度も含めて比較）
  function isSameAsCurrent(loc: BaseLocation): boolean {
    if (loc === '常温' || loc === '冷蔵庫') return currentLocation === loc
    return currentLocation === buildLocationIfType(loc)
  }

  function buildLocationIfType(loc: BaseLocation): string {
    if (loc === '暖房') return `暖房${heatTemp}℃`
    if (loc === '冷房') return `冷房${coolTemp}℃`
    return loc
  }

  // 現在地ラベル（表示用）
  function currentLocationLabel(): string {
    return currentLocation
  }

  function handleSubmit() {
    const loc = buildLocationString()
    if (!loc) return
    setError(null)
    startTransition(async () => {
      const result = await moveLot(lotId, loc, moveDate, markAsComplete, skipStockUpdate)
      if (result?.error) { setError(result.error); return }
      router.push(`/lots/${lotId}`)
    })
  }

  const locationString = buildLocationString()
  const canSubmit = !!locationString && !isPending

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">場所移動の記録</h1>
        <p className="text-sm text-muted-foreground mt-1">{lotNumber}</p>
      </div>

      {/* 現在地 */}
      <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-4 py-3 text-sm">
        <span className="text-muted-foreground">現在地：</span>
        <span className="font-semibold ml-1">{currentLocationLabel()}</span>
      </div>

      {/* 移動日 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">移動日</label>
        <input
          type="date"
          value={moveDate}
          onChange={e => setMoveDate(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-base"
        />
      </div>

      {/* 移動先選択 */}
      <div className="space-y-2">
        <p className="text-sm font-medium">移動先を選択</p>
        <div className="flex flex-col gap-2">
          {BASE_LOCATIONS.map(loc => {
            const isCurrent  = currentBaseType === loc
            const isSelected = locationType === loc
            return (
              <div key={loc} className="space-y-2">
                <button
                  type="button"
                  disabled={isCurrent}
                  onClick={() => !isCurrent && setLocationType(loc)}
                  className={[
                    'w-full rounded-lg border px-4 py-4 text-left transition-colors',
                    isCurrent
                      ? 'cursor-default border-gray-100 bg-gray-50 text-gray-400'
                      : isSelected
                        ? 'border-gray-900 bg-gray-900 text-white'
                        : 'border-gray-200 bg-white text-gray-900 hover:bg-gray-50',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-base font-semibold">{loc}</span>
                      {loc === '冷蔵庫' && (
                        <span className={`block text-xs mt-0.5 ${isSelected ? 'text-white/70' : 'text-gray-400'}`}>
                          積算温度は加算されません（0℃/日）
                        </span>
                      )}
                      {isCurrent && (
                        <span className="block text-xs mt-0.5 text-muted-foreground">現在地</span>
                      )}
                    </div>
                    {isSelected && (
                      <span className="text-lg text-white font-bold shrink-0 ml-2">✓</span>
                    )}
                  </div>
                </button>

                {/* 暖房・冷房の温度入力（選択時のみ表示） */}
                {isSelected && (loc === '暖房' || loc === '冷房') && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 bg-gray-50/70">
                    <label className="text-sm font-medium whitespace-nowrap">設定温度</label>
                    <input
                      type="number"
                      min="10"
                      max="40"
                      step="1"
                      value={loc === '暖房' ? heatTemp : coolTemp}
                      onChange={e => loc === '暖房' ? setHeatTemp(e.target.value) : setCoolTemp(e.target.value)}
                      className="w-24 rounded-md border bg-background px-3 py-1.5 text-base tabular-nums"
                    />
                    <span className="text-sm">℃</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      有効積算：{Math.max(Number(loc === '暖房' ? heatTemp : coolTemp) - 10, 0)}℃/日
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 熟成完了オプション（熟成中のみ表示） */}
      {currentStatus === '熟成中' && (
        <div className="space-y-3">
          <label className="flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors">
            <input
              type="checkbox"
              checked={markAsComplete}
              onChange={e => setMarkAsComplete(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-foreground"
            />
            <div>
              <p className="text-sm font-medium">移動と同時に熟成完了にする</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                ステータスを「熟成中」→「完成」に変更します
              </p>
            </div>
          </label>

          {/* 在庫プレビュー（完成チェック時のみ） */}
          {markAsComplete && !isPrototype && (
            <div className="rounded-xl border border-gray-100 px-4 py-3 space-y-3">
              <p className="text-sm font-medium text-gray-700">在庫システムへの反映内容を確認してください</p>
              <StockPreviewPanel state={stockPreview} />
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!skipStockUpdate}
                  onChange={e => setSkipStockUpdate(!e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-foreground"
                />
                <span className="text-sm">在庫システムへ反映する</span>
              </label>
              {skipStockUpdate && (
                <div className={stockPreview !== 'loading' && stockPreview !== null ? 'opacity-40 pointer-events-none' : 'hidden'}>
                  <StockPreviewPanel state={stockPreview} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* 実行・キャンセル */}
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.back()}
          disabled={isPending}
          className="flex-1 rounded-lg border bg-background px-4 py-3 text-sm font-medium disabled:opacity-50"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex-1 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {isPending ? '保存中...' : '移動を記録'}
        </button>
      </div>
    </div>
  )
}

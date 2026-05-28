'use client'

import { useState, useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { runSarimaxForecast } from './forecast-actions'

interface Props {
  // 最終更新日時（サーバーから渡される。未更新時はnull）
  updatedAt: string | null
}

export default function ForecastUpdater({ updatedAt }: Props) {
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  function handleUpdate() {
    startTransition(async () => {
      setStatus(null)
      const result = await runSarimaxForecast()

      if (result.ok) {
        setStatus({ type: 'success', message: result.message })
        // 3秒後にメッセージを消す
        setTimeout(() => setStatus(null), 3000)
      } else {
        setStatus({ type: 'error', message: result.message })
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <Button
        variant="outline"
        size="sm"
        onClick={handleUpdate}
        disabled={isPending}
        className="h-8 text-xs gap-1.5"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isPending ? 'animate-spin' : ''}`} />
        {isPending ? '更新中...' : 'SARIMAX予測を更新'}
      </Button>

      {/* 最終更新日時 */}
      {updatedAt && !status && (
        <span className="text-[10px] text-muted-foreground">
          最終更新: {updatedAt}
        </span>
      )}

      {/* ステータスメッセージ */}
      {status && (
        <span className={`text-[10px] max-w-xs text-right ${
          status.type === 'success' ? 'text-green-600' : 'text-red-600'
        }`}>
          {status.type === 'success' ? '更新しました' : status.message}
        </span>
      )}
    </div>
  )
}

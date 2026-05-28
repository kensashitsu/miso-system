'use client'

import { useState, useTransition } from 'react'
import { format } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { testApiConnections, type ApiStatusResult } from './api-actions'

function StatusBadge({ ok, latency, error }: { ok: boolean; latency: number; error?: string }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/70 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        正常 {latency}ms
      </span>
    )
  }
  return (
    <div className="space-y-0.5">
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50/70 px-2 py-0.5 text-xs font-medium text-rose-700">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        エラー
      </span>
      {error && <p className="text-xs text-rose-600 pl-1">{error}</p>}
    </div>
  )
}

export default function ApiStatusCard() {
  const [result, setResult] = useState<ApiStatusResult | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleTest() {
    startTransition(async () => {
      const res = await testApiConnections()
      setResult(res)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-gray-900">外部API連携</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          seizou.mitsuura.jp との接続ステータス。APIキーは .env.local で管理しています。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="space-y-1.5">
            <p className="font-medium">熟成済在庫 API</p>
            <p className="text-xs text-muted-foreground font-mono">/api/stock/aged</p>
            {result ? (
              <StatusBadge {...result.stock} />
            ) : (
              <span className="text-xs text-muted-foreground">未確認</span>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="font-medium">月別出荷実績 API</p>
            <p className="text-xs text-muted-foreground font-mono">/api/sales/monthly</p>
            {result ? (
              <StatusBadge {...result.sales} />
            ) : (
              <span className="text-xs text-muted-foreground">未確認</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 border-t border-gray-100 pt-3">
          <Button
            onClick={handleTest}
            disabled={isPending}
            variant="outline"
            size="sm"
          >
            {isPending ? '確認中...' : '接続テスト'}
          </Button>
          {result && (
            <span className="text-xs text-muted-foreground">
              最終確認：{format(new Date(result.testedAt), 'M月d日 HH:mm:ss')}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

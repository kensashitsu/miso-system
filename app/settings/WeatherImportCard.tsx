'use client'

import { useState, useTransition } from 'react'
import { format } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { getWeatherStatus, importWeatherRange, type WeatherStatus } from './weather-actions'

export default function WeatherImportCard({ initialStatus }: { initialStatus: WeatherStatus }) {
  const currentYear = new Date().getFullYear()
  const [status,   setStatus]   = useState(initialStatus)
  const [yearFrom, setYearFrom] = useState(String(currentYear - 4))
  const [yearTo,   setYearTo]   = useState(String(currentYear - 1))
  const [result,   setResult]   = useState<{ imported: number; errors: string[] } | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleImport = () => {
    setResult(null)
    startTransition(async () => {
      const res = await importWeatherRange(parseInt(yearFrom), parseInt(yearTo))
      setResult({ imported: res.imported, errors: res.errors })
      const newStatus = await getWeatherStatus()
      setStatus(newStatus)
    })
  }

  const totalMonths = (() => {
    const from = parseInt(yearFrom)
    const to   = parseInt(yearTo)
    if (isNaN(from) || isNaN(to) || from > to) return 0
    return (to - from + 1) * 12
  })()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">気象データ（防府アメダス）</CardTitle>
        <p className="text-sm text-muted-foreground">
          常温ロットの熟成完了予定推計に使用します。気象庁の過去データを月単位で取り込みます。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* 取得済みデータの状態 */}
        <div className="rounded-lg bg-muted px-4 py-3 text-sm space-y-1">
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground shrink-0">取得済み：</span>
            <span className="font-medium">
              {status.count > 0 ? `${status.count.toLocaleString()} 日分` : 'データなし'}
            </span>
          </div>
          {status.earliest && status.latest && (
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground shrink-0">期間：</span>
              <span className="tabular-nums">
                {format(new Date(status.earliest), 'yyyy年M月d日')}
                〜
                {format(new Date(status.latest), 'yyyy年M月d日')}
              </span>
            </div>
          )}
        </div>

        {/* 取得範囲 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="wf-from">取得開始年</Label>
            <Input
              id="wf-from"
              type="number"
              step="1"
              min="2010"
              max={currentYear}
              inputMode="numeric"
              value={yearFrom}
              onChange={e => setYearFrom(e.target.value)}
              className="min-h-[44px]"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wf-to">取得終了年</Label>
            <Input
              id="wf-to"
              type="number"
              step="1"
              min="2010"
              max={currentYear}
              inputMode="numeric"
              value={yearTo}
              onChange={e => setYearTo(e.target.value)}
              className="min-h-[44px]"
            />
          </div>
        </div>
        {totalMonths > 0 && (
          <p className="text-xs text-muted-foreground">
            約 {totalMonths} ヶ月分を取得します（目安：{Math.ceil(totalMonths * 0.7 / 60)} 分程度）
          </p>
        )}

        {/* 結果表示 */}
        {result && (
          <div className={`rounded-lg border px-4 py-3 text-sm space-y-1 ${
            result.errors.length > 0
              ? 'border-orange-300 bg-orange-50 text-orange-800'
              : 'border-green-300 bg-green-50 text-green-800'
          }`}>
            <p className="font-medium">
              {result.imported} 日分を取り込みました。
              {result.errors.length > 0 && `（エラー ${result.errors.length} 件）`}
            </p>
            {result.errors.slice(0, 5).map((e, i) => (
              <p key={i} className="text-xs opacity-80">{e}</p>
            ))}
            {result.errors.length > 5 && (
              <p className="text-xs opacity-80">他 {result.errors.length - 5} 件のエラー</p>
            )}
          </div>
        )}

        {isPending && (
          <div className="text-sm text-muted-foreground animate-pulse">
            取り込み中... 月ごとに気象庁から順次取得しています。このまましばらくお待ちください。
          </div>
        )}

        <Button onClick={handleImport} disabled={isPending} className="min-h-[44px]">
          {isPending ? '取り込み中...' : '過去データを取り込む'}
        </Button>

        <p className="text-xs text-muted-foreground">
          気象庁「過去の気象データ検索」（防府アメダス）より日平均気温を取得します。
          既存データは上書き更新されます。
        </p>
      </CardContent>
    </Card>
  )
}

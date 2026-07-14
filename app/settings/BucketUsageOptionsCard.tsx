'use client'

import { useState, useTransition } from 'react'
import { X, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { updateBucketUsageOptions } from './actions'

interface Props {
  misoTypes:                 string[]  // 設定できる品種名（レシピ由来）
  initialProductNamesByType: Record<string, string[]>
  initialOperatorNames:      string[]
}

// 文字列リストの編集UI（追加・削除）
function ListEditor({
  placeholder, items, onChange,
}: {
  placeholder: string
  items: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (!items.includes(v)) onChange([...items, v])
    setDraft('')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {items.length === 0 && (
          <span className="text-xs text-muted-foreground py-1">まだ登録がありません</span>
        )}
        {items.map(item => (
          <span key={item} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 pl-3 pr-1 py-1 text-sm">
            {item}
            <button
              type="button"
              onClick={() => onChange(items.filter(i => i !== item))}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-red-600"
              aria-label={`${item}を削除`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={placeholder}
          className="max-w-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-4 w-4 mr-1" />追加
        </Button>
      </div>
    </div>
  )
}

export default function BucketUsageOptionsCard({ misoTypes, initialProductNamesByType, initialOperatorNames }: Props) {
  const [productNamesByType, setProductNamesByType] = useState<Record<string, string[]>>(initialProductNamesByType)
  const [operatorNames,      setOperatorNames]      = useState<string[]>(initialOperatorNames)
  const [message, setMessage] = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const setTypeList = (type: string, next: string[]) =>
    setProductNamesByType(prev => ({ ...prev, [type]: next }))

  const handleSave = () => {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await updateBucketUsageOptions({ productNamesByType, operatorNames })
      if (res.success) setMessage('保存しました。')
      else setError(res.globalError ?? '保存に失敗しました。')
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">桶使用記録の選択肢（製品名・操作者）</CardTitle>
        <p className="text-sm text-muted-foreground">
          ロット詳細の桶「使用記録」で選ぶプルダウン候補を管理します。製品名は<strong>品種ごと</strong>に、操作者は全品種共通で設定します。
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <p className="text-sm font-medium">製品名（品種ごと）</p>
          {misoTypes.map(type => (
            <div key={type} className="rounded-lg border p-3 space-y-2">
              <span
                className="inline-block text-xs font-medium px-2 py-0.5 rounded-full border"
                style={getMisoTypeBadgeStyle(type)}
              >
                {type}
              </span>
              <ListEditor
                placeholder="例: 光うらの麦みそ 1kg"
                items={productNamesByType[type] ?? []}
                onChange={next => setTypeList(type, next)}
              />
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">操作者名（全品種共通）</p>
          <ListEditor
            placeholder="例: 山田"
            items={operatorNames}
            onChange={setOperatorNames}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={handleSave} disabled={isPending}>
            {isPending ? '保存中...' : '保存'}
          </Button>
          {message && <span className="text-sm text-emerald-600">{message}</span>}
          {error   && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

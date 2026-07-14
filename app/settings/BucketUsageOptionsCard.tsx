'use client'

import { useState, useTransition } from 'react'
import { X, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { updateBucketUsageOptions } from './actions'

interface Props {
  initialProductNames:  string[]
  initialOperatorNames: string[]
}

// 文字列リストの編集UI（追加・削除・並び替えなし）
function ListEditor({
  label, placeholder, items, onChange,
}: {
  label: string
  placeholder: string
  items: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (items.includes(v)) { setDraft(''); return }
    onChange([...items, v])
    setDraft('')
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
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

export default function BucketUsageOptionsCard({ initialProductNames, initialOperatorNames }: Props) {
  const [productNames,  setProductNames]  = useState<string[]>(initialProductNames)
  const [operatorNames, setOperatorNames] = useState<string[]>(initialOperatorNames)
  const [message, setMessage] = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSave = () => {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await updateBucketUsageOptions({ productNames, operatorNames })
      if (res.success) setMessage('保存しました。')
      else setError(res.globalError ?? '保存に失敗しました。')
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">桶使用記録の選択肢（製品名・操作者）</CardTitle>
        <p className="text-sm text-muted-foreground">
          ロット詳細の桶「使用記録」で選ぶ製品名・操作者のプルダウン候補を管理します。全ロット共通で反映されます。
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <ListEditor
          label="製品名"
          placeholder="例: 光うらの麦みそ 1kg"
          items={productNames}
          onChange={setProductNames}
        />
        <ListEditor
          label="操作者名"
          placeholder="例: 山田"
          items={operatorNames}
          onChange={setOperatorNames}
        />
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

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { ChevronDown, ChevronUp, AlertTriangle, Search } from 'lucide-react'
import { updateCompletedAt } from '@/app/lots/[id]/actions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'

const STATUSES   = ['熟成中', '完成', '品質低下出荷', '種みそ転用', '出荷済'] as const

export interface TraceSearchValues {
  lotNumber:     string
  misoType:      string
  brewedFrom:    string
  brewedTo:      string
  status:        string
  soybeanOrigin: string
  soybeanLotNo:  string
  kojiSupplier:  string
  saltLotNo:     string
  bucketNumber:  string
}

export interface TraceLot {
  id:              string
  lotNumber:       string
  misoType:        string
  brewedAtISO:     string
  status:          string
  elapsedDays:     number | null
  accumulatedTemp: number
  targetTempSum:   number
  coloringRisk:    'normal' | 'warning' | 'danger'
  currentLocation: string
  bucketNumbers:   string | null
  soybeanOrigin:   string | null
}

interface Props {
  misoTypes:            string[]   // 品種の選択肢（MisoRecipe.sortOrder順）
  lots:                 TraceLot[]
  hasSearched:          boolean
  ingredientAlertCount: number
  ingredientAlertLabel: string
  defaultValues:        TraceSearchValues
}

// 出荷済ロットの completedAt は「熟成完了日」ではなく仕込帳から取り込んだ
// 「使用開始日」が入っているため、熟成日数が実際より長く出る。数字に注記を付ける
const SHIPPED_AGING_NOTE =
  '出荷済ロットの完成日は仕込帳の「使用開始日」のため、実際の熟成日数より長く出ます'

function statusBadgeClass(status: string): string {
  if (status === '熟成中')       return 'border-blue-200 bg-blue-50/70 text-blue-700'
  if (status === '完成')         return 'border-emerald-200 bg-emerald-50/70 text-emerald-700'
  if (status === '種みそ転用')   return 'border-purple-200 bg-purple-50/70 text-purple-700'
  if (status === '品質低下出荷') return 'border-amber-200 bg-amber-50/70 text-amber-700'
  if (status === '出荷済')       return 'border-gray-200 bg-gray-50 text-gray-500'
  return 'border-gray-200 bg-gray-50 text-gray-500'
}

function riskBadgeClass(risk: string): string {
  if (risk === 'danger')  return 'border-rose-200/50 bg-rose-50 text-rose-700'
  if (risk === 'warning') return 'border-amber-200/50 bg-amber-50 text-amber-700'
  return 'border-emerald-200/50 bg-emerald-50 text-emerald-700'
}

function riskLabel(risk: string): string {
  if (risk === 'danger')  return 'リスク高'
  if (risk === 'warning') return '要注意'
  return '通常'
}

export default function TraceClient({
  misoTypes,
  lots,
  hasSearched,
  ingredientAlertCount,
  ingredientAlertLabel,
  defaultValues,
}: Props) {
  const router = useRouter()
  const [isFormOpen, setIsFormOpen] = useState(true)
  const [form, setForm] = useState<TraceSearchValues>(defaultValues)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingCompletedAt, setEditingCompletedAt] = useState<string | null>(null) // lot.id
  const [completedAtDraft, setCompletedAtDraft] = useState('')
  const [completedAtSaveError, setCompletedAtSaveError] = useState<string | null>(null)
  const [isSaving, startSaveTransition] = useTransition()

  function handleCompletedAtSave(lotId: string) {
    if (!completedAtDraft) return
    setCompletedAtSaveError(null)
    startSaveTransition(async () => {
      const result = await updateCompletedAt(lotId, completedAtDraft + 'T00:00:00')
      if (result.error) { setCompletedAtSaveError(result.error); return }
      setEditingCompletedAt(null)
      router.refresh()
    })
  }

  const set = (key: keyof TraceSearchValues, value: string) =>
    setForm(f => ({ ...f, [key]: value }))

  function handleSearch() {
    const params = new URLSearchParams()
    params.set('searched', '1')
    if (form.lotNumber)          params.set('lotNumber',     form.lotNumber)
    if (form.misoType !== 'all') params.set('misoType',      form.misoType)
    if (form.brewedFrom)         params.set('brewedFrom',    form.brewedFrom)
    if (form.brewedTo)           params.set('brewedTo',      form.brewedTo)
    if (form.status !== 'all')   params.set('status',        form.status)
    if (form.soybeanOrigin)      params.set('soybeanOrigin', form.soybeanOrigin)
    if (form.soybeanLotNo)       params.set('soybeanLotNo',  form.soybeanLotNo)
    if (form.kojiSupplier)       params.set('kojiSupplier',  form.kojiSupplier)
    if (form.saltLotNo)          params.set('saltLotNo',     form.saltLotNo)
    if (form.bucketNumber)       params.set('bucketNumber',  form.bucketNumber)
    router.push(`/trace?${params.toString()}`)
  }

  function handleClear() {
    setForm({
      lotNumber: '', misoType: 'all', brewedFrom: '', brewedTo: '',
      status: 'all', soybeanOrigin: '', soybeanLotNo: '',
      kojiSupplier: '', saltLotNo: '', bucketNumber: '',
    })
    router.push('/trace')
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      <h1 className="hidden sm:block text-2xl font-bold text-gray-900 tracking-tight">トレース検索</h1>

      {/* 検索フォーム */}
      <Card className="rounded-xl border border-gray-100 shadow-sm">
        <CardHeader
          className="cursor-pointer select-none pb-3"
          onClick={() => setIsFormOpen(v => !v)}
        >
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-gray-900">検索条件</CardTitle>
            {isFormOpen
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </CardHeader>

        {isFormOpen && (
          <CardContent className="space-y-4 pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              <div className="space-y-1.5">
                <Label className="text-sm">ロット番号</Label>
                <Input
                  placeholder="例: 202506（部分一致）"
                  value={form.lotNumber}
                  onChange={e => set('lotNumber', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">品種</Label>
                <Select
                  value={form.misoType}
                  onValueChange={(v: string | null) => set('misoType', v ?? 'all')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全品種" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全品種</SelectItem>
                    {misoTypes.map(t => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">仕込み日（開始）</Label>
                <Input
                  type="date"
                  value={form.brewedFrom}
                  onChange={e => set('brewedFrom', e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">仕込み日（終了）</Label>
                <Input
                  type="date"
                  value={form.brewedTo}
                  onChange={e => set('brewedTo', e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">ステータス</Label>
                <Select
                  value={form.status}
                  onValueChange={(v: string | null) => set('status', v ?? 'all')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="全て" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全て</SelectItem>
                    {STATUSES.map(s => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">桶番号（完全一致）</Label>
                <Input
                  type="number"
                  min="0"
                  max="30"
                  placeholder="例: 13"
                  value={form.bucketNumber}
                  onChange={e => set('bucketNumber', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                />
              </div>

            </div>

            {/* 原料フィールド */}
            <div className="border-t pt-4">
              <p className="text-xs text-muted-foreground font-medium mb-3">原料トレース（部分一致）</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                <div className="space-y-1.5">
                  <Label className="text-sm">大豆産地</Label>
                  <Input
                    placeholder="例: 山口県産"
                    value={form.soybeanOrigin}
                    onChange={e => set('soybeanOrigin', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">大豆ロット番号</Label>
                  <Input
                    placeholder="例: SB-2025-001"
                    value={form.soybeanLotNo}
                    onChange={e => set('soybeanLotNo', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">麹仕入れ先</Label>
                  <Input
                    placeholder="例: ○○麹店"
                    value={form.kojiSupplier}
                    onChange={e => set('kojiSupplier', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">塩ロット番号</Label>
                  <Input
                    placeholder="例: SL-2025-012"
                    value={form.saltLotNo}
                    onChange={e => set('saltLotNo', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  />
                </div>

              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={handleSearch} className="gap-1.5">
                <Search className="h-4 w-4" />
                検索
              </Button>
              <Button variant="outline" onClick={handleClear}>
                クリア
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 原料アラートバナー */}
      {ingredientAlertCount > 0 && ingredientAlertLabel && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">
              {ingredientAlertLabel}を使用しているロット：{ingredientAlertCount}件
            </p>
            <p className="text-xs mt-0.5 text-rose-600">
              品質問題が発生している場合、これらのロットすべてに影響する可能性があります。
            </p>
          </div>
        </div>
      )}

      {/* 検索結果 */}
      {hasSearched && (
        lots.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            該当するロットが見つかりませんでした
          </p>
        ) : (
          <div className="rounded-xl border border-gray-100 overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50/60 border-b border-gray-100">
              <span className="text-sm font-medium">検索結果</span>
              <span className="text-xs text-muted-foreground">{lots.length}件</span>
            </div>

            {/* モバイル: カードビュー */}
            <div className="sm:hidden divide-y divide-gray-50">
              {lots.map(lot => (
                <div
                  key={lot.id}
                  className="px-4 py-3 cursor-pointer hover:bg-gray-50/60 transition-colors active:bg-gray-100/60"
                  onClick={() => { setSelectedId(lot.id); router.push(`/lots/${lot.id}`) }}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm tabular-nums">{lot.lotNumber}</span>
                      <span
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        style={getMisoTypeBadgeStyle(lot.misoType)}
                      >
                        {lot.misoType}
                      </span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium shrink-0 ${statusBadgeClass(lot.status)}`}>
                      {lot.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>仕込み <span className="text-gray-700 tabular-nums">{format(new Date(lot.brewedAtISO), 'yyyy/MM/dd')}</span></span>
                    <span>現在地 <span className="text-gray-700">{lot.currentLocation}</span></span>
                    <span>積算温度 <span className="text-gray-700 tabular-nums">{lot.accumulatedTemp.toLocaleString()}/{lot.targetTempSum}℃</span></span>
                    {lot.elapsedDays !== null
                      ? <span>熟成 <span
                          className="text-gray-700 tabular-nums"
                          title={lot.status === '出荷済' ? SHIPPED_AGING_NOTE : undefined}
                        >{lot.elapsedDays}日{lot.status === '出荷済' && <span className="text-gray-400">※</span>}</span></span>
                      : lot.status !== '熟成中'
                        ? <span onClick={e => e.stopPropagation()}>
                            {editingCompletedAt === lot.id ? (
                              <span className="flex items-center gap-1">
                                <input
                                  type="date"
                                  autoFocus
                                  value={completedAtDraft}
                                  onChange={e => setCompletedAtDraft(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleCompletedAtSave(lot.id) }
                                    if (e.key === 'Escape') { setEditingCompletedAt(null) }
                                  }}
                                  className="border border-input rounded px-1 py-0.5 w-28 bg-background text-xs"
                                />
                                <button type="button" onClick={() => handleCompletedAtSave(lot.id)} disabled={!completedAtDraft || isSaving} className="px-1.5 py-0.5 rounded bg-primary text-primary-foreground text-xs disabled:opacity-40">保存</button>
                              </span>
                            ) : (
                              <button type="button" onClick={() => { setCompletedAtDraft(format(new Date(), 'yyyy-MM-dd')); setCompletedAtSaveError(null); setEditingCompletedAt(lot.id) }} className="border border-dashed border-gray-300 text-gray-400 rounded px-1.5 py-0.5 text-xs">完成日入力</button>
                            )}
                          </span>
                        : null
                    }
                    {lot.bucketNumbers && <span>桶 <span className="text-gray-700">{lot.bucketNumbers}号</span></span>}
                    {lot.soybeanOrigin && <span>大豆 <span className="text-gray-700">{lot.soybeanOrigin}</span></span>}
                  </div>
                  {lot.status === '熟成中' && (
                    <div className="mt-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${riskBadgeClass(lot.coloringRisk)}`}>
                        {riskLabel(lot.coloringRisk)}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* デスクトップ: テーブルビュー */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/40">
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">ロット番号</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">品種</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">仕込み日</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">熟成日数</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">ステータス</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">積算温度</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">現在地</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">桶番号</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 tracking-wider uppercase whitespace-nowrap">大豆産地</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map(lot => (
                    <tr
                      key={lot.id}
                      className={`border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${
                        selectedId === lot.id
                          ? 'bg-gray-100/60 border-l-4 border-l-gray-900'
                          : 'hover:bg-gray-50/60 border-l-4 border-l-transparent'
                      }`}
                      onClick={() => {
                        setSelectedId(lot.id)
                        router.push(`/lots/${lot.id}`)
                      }}
                    >
                      <td className="px-3 py-2.5 font-medium tabular-nums whitespace-nowrap">
                        {lot.lotNumber}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                          style={getMisoTypeBadgeStyle(lot.misoType)}
                        >
                          {lot.misoType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap text-muted-foreground">
                        {format(new Date(lot.brewedAtISO), 'yyyy/MM/dd')}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
                        {lot.elapsedDays !== null ? (
                          <span title={lot.status === '出荷済' ? SHIPPED_AGING_NOTE : undefined}>
                            <span className="font-medium text-gray-700">{lot.elapsedDays}</span>
                            <span className="text-muted-foreground text-xs ml-0.5">日</span>
                            {lot.status === '出荷済' && <span className="text-gray-400 text-xs">※</span>}
                          </span>
                        ) : editingCompletedAt === lot.id ? (
                          <div className="flex items-center gap-1 justify-end">
                            <input
                              type="date"
                              autoFocus
                              value={completedAtDraft}
                              onChange={e => setCompletedAtDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); handleCompletedAtSave(lot.id) }
                                if (e.key === 'Escape') { setEditingCompletedAt(null) }
                              }}
                              className="text-xs border border-input rounded px-1.5 py-0.5 w-32 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                            <button
                              type="button"
                              onClick={() => handleCompletedAtSave(lot.id)}
                              disabled={!completedAtDraft || isSaving}
                              className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-40"
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingCompletedAt(null)}
                              className="text-xs px-2 py-0.5 rounded border text-muted-foreground"
                            >
                              取消
                            </button>
                            {completedAtSaveError && <span className="text-xs text-red-500">{completedAtSaveError}</span>}
                          </div>
                        ) : lot.status !== '熟成中' ? (
                          <button
                            type="button"
                            onClick={() => { setCompletedAtDraft(format(new Date(), 'yyyy-MM-dd')); setCompletedAtSaveError(null); setEditingCompletedAt(lot.id) }}
                            className="text-xs px-2 py-0.5 rounded border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600"
                          >
                            完成日を入力
                          </button>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusBadgeClass(lot.status)}`}>
                          {lot.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="tabular-nums">
                            {lot.accumulatedTemp.toLocaleString()}
                            <span className="text-muted-foreground text-xs ml-0.5">
                              /{lot.targetTempSum}℃
                            </span>
                          </span>
                          {lot.status === '熟成中' && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${riskBadgeClass(lot.coloringRisk)}`}>
                              {riskLabel(lot.coloringRisk)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                        {lot.currentLocation}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                        {lot.bucketNumbers ? `${lot.bucketNumbers}号` : '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                        {lot.soybeanOrigin ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {!hasSearched && (
        <p className="text-muted-foreground text-sm py-8 text-center">
          検索条件を入力して「検索」ボタンを押してください
        </p>
      )}
    </div>
  )
}

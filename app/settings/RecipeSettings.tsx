'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createRecipe, updateRecipe, deactivateRecipe } from './recipe-actions'
import type { MisoRecipe } from '@/lib/recipes'
import { type MoistureSettings, calcMushiSoybeanMoisture } from '@/lib/settings'

const GRAIN_OPTIONS  = ['裸麦', '砕米', '無洗米'] as const
const LOCATIONS      = ['暖房', '冷房', '常温'] as const
const SOY_ORIGINS    = ['山口県産', 'カナダ産', 'アメリカ産'] as const

type FormState = {
  name: string; grainLabel: string
  grainKg: string; soybeanKg: string; saltKg: string; mizuameKg: string
  targetTempSum: string
  defaultLocation: string; soybeanOrigin: string; sortOrder: string
  taneKojiG: string
  safetyStockKg: string
  winterSafetyStockKg: string
  summerSafetyStockKg: string
}

const EMPTY_FORM: FormState = {
  name: '', grainLabel: '裸麦',
  grainKg: '', soybeanKg: '', saltKg: '', mizuameKg: '0',
  targetTempSum: '',
  defaultLocation: '暖房', soybeanOrigin: '', sortOrder: '0',
  taneKojiG: '0',
  safetyStockKg: '',
  winterSafetyStockKg: '',
  summerSafetyStockKg: '',
}

function recipeToForm(r: MisoRecipe): FormState {
  return {
    name:            r.name,
    grainLabel:      r.grainLabel,
    grainKg:         String(r.grainKg),
    soybeanKg:       String(r.soybeanKg),
    saltKg:          String(r.saltKg),
    mizuameKg:       String(r.mizuameKg),
    targetTempSum:   String(r.targetTempSum),
    defaultLocation: r.defaultLocation,
    soybeanOrigin:   r.soybeanOrigin ?? '',
    sortOrder:       String(r.sortOrder),
    taneKojiG:       String(r.taneKojiG),
    safetyStockKg:   r.safetyStockKg != null ? String(r.safetyStockKg) : '',
    winterSafetyStockKg: r.winterSafetyStockKg != null ? String(r.winterSafetyStockKg) : '',
    summerSafetyStockKg: r.summerSafetyStockKg != null ? String(r.summerSafetyStockKg) : '',
  }
}

function formToData(f: FormState, totalWeightKg: number) {
  const n = (v: string) => parseFloat(v) || 0
  return {
    name:            f.name.trim(),
    grainLabel:      f.grainLabel,
    grainKg:         n(f.grainKg),
    soybeanKg:       n(f.soybeanKg),
    saltKg:          n(f.saltKg),
    mizuameKg:       n(f.mizuameKg),
    totalWeightKg,
    targetTempSum:   n(f.targetTempSum),
    defaultLocation: f.defaultLocation,
    soybeanOrigin:   f.soybeanOrigin.trim() || null,
    sortOrder:       parseInt(f.sortOrder) || 0,
    taneKojiG:       n(f.taneKojiG),
    safetyStockKg:   f.safetyStockKg.trim() === '' ? null : n(f.safetyStockKg),
    winterSafetyStockKg: f.winterSafetyStockKg.trim() === '' ? null : n(f.winterSafetyStockKg),
    summerSafetyStockKg: f.summerSafetyStockKg.trim() === '' ? null : n(f.summerSafetyStockKg),
  }
}

// レシピ一覧用の指標を計算
function calcRecipeMetrics(r: MisoRecipe, m: MoistureSettings) {
  const isBareMugi    = r.grainLabel === '裸麦'
  const kojiKg        = r.grainKg * (isBareMugi ? m.kojiRatio : m.komeKojiRatio)
  const mushiSoyKg    = r.soybeanKg * m.soybeanRatio
  const kojiMoist     = isBareMugi ? m.mugiKoji : m.komeKoji
  const mushiSoyMoist = calcMushiSoybeanMoisture(m.soybean, m.soybeanRatio)
  const suibunRyo     = kojiKg * kojiMoist + mushiSoyKg * mushiSoyMoist + r.mizuameKg * m.mizuame
  const shikomi       = r.totalWeightKg
  return {
    kojibuai: r.soybeanKg > 0 && r.grainKg > 0
      ? Math.round(r.grainKg / r.soybeanKg * 100) / 10
      : null,
    enshobun: shikomi > 0 ? Math.round(r.saltKg / shikomi * 1000) / 10 : null,
    suibun:   shikomi > 0 ? Math.round(suibunRyo / shikomi * 1000) / 10 : null,
  }
}

// ── レシピフォーム（新規・編集共通） ─────────────────────────
function RecipeForm({
  initial,
  editId,
  onDone,
  moisture,
}: {
  initial: FormState
  editId?: string
  onDone: () => void
  moisture: MoistureSettings
}) {
  const [form, setForm]     = useState<FormState>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState('')
  const [isPending, startTransition]  = useTransition()

  const set = (key: keyof FormState, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const input = (key: keyof FormState) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
    className: 'min-h-[44px]',
  })

  const numInput = (key: keyof FormState) => ({
    ...input(key),
    type: 'number' as const,
    step: '0.1',
    min: '0',
    inputMode: 'decimal' as const,
  })

  // 仕立て自動計算
  const nv = (v: string) => parseFloat(v) || 0
  const isBareMugi = form.grainLabel === '裸麦'
  const kojiKg     = isBareMugi
    ? Math.round(nv(form.grainKg) * moisture.kojiRatio * 10) / 10
    : Math.round(nv(form.grainKg) * moisture.komeKojiRatio * 10) / 10
  const mushiSoyKg = Math.round(nv(form.soybeanKg) * moisture.soybeanRatio * 10) / 10
  const shikomiCalc = Math.round(
    (kojiKg + mushiSoyKg + nv(form.saltKg) + nv(form.mizuameKg)) * 10
  ) / 10

  // 麹歩合・塩分・水分
  const mushiSoyMoist = calcMushiSoybeanMoisture(moisture.soybean, moisture.soybeanRatio)
  const kojiMoist     = isBareMugi ? moisture.mugiKoji : moisture.komeKoji
  const suibunRyo     = kojiKg * kojiMoist + mushiSoyKg * mushiSoyMoist + nv(form.mizuameKg) * moisture.mizuame
  const kojibuai      = nv(form.soybeanKg) > 0 && nv(form.grainKg) > 0
    ? Math.round(nv(form.grainKg) / nv(form.soybeanKg) * 100) / 10
    : null
  const enshobun      = shikomiCalc > 0 ? Math.round(nv(form.saltKg) / shikomiCalc * 1000) / 10 : null
  const suibun        = shikomiCalc > 0 ? Math.round(suibunRyo / shikomiCalc * 1000) / 10 : null

  const handleSubmit = () => {
    setErrors({})
    setGlobalError('')
    const data = formToData(form, shikomiCalc)
    startTransition(async () => {
      const result = editId
        ? await updateRecipe(editId, data)
        : await createRecipe(data)
      if (result.errors)      setErrors(result.errors)
      if (result.globalError) setGlobalError(result.globalError)
      if (result.success)     onDone()
    })
  }

  const e = (key: string) => errors[key]

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
      <h4 className="text-sm font-semibold">{editId ? 'レシピを編集' : '新規みそを追加'}</h4>

      {globalError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {globalError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* 品種名 */}
        <div className="space-y-1">
          <Label htmlFor="rf-name">品種名 <span className="text-red-500">*</span></Label>
          <Input id="rf-name" {...input('name')} placeholder="例: 特製麦みそ" />
          {e('name') && <p className="text-xs text-red-500">{e('name')}</p>}
        </div>

        {/* 穀物 */}
        <div className="space-y-1">
          <Label>穀物 <span className="text-red-500">*</span></Label>
          <Select value={form.grainLabel} onValueChange={v => set('grainLabel', v ?? '裸麦')}>
            <SelectTrigger className="w-full min-h-[44px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRAIN_OPTIONS.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
            </SelectContent>
          </Select>
          {e('grainLabel') && <p className="text-xs text-red-500">{e('grainLabel')}</p>}
        </div>

        {/* 穀物 kg */}
        <div className="space-y-1">
          <Label htmlFor="rf-grain">{form.grainLabel || '穀物'} デフォルト量 (kg) <span className="text-red-500">*</span></Label>
          <Input id="rf-grain" {...numInput('grainKg')} />
          {e('grainKg') && <p className="text-xs text-red-500">{e('grainKg')}</p>}
        </div>

        {/* 大豆 */}
        <div className="space-y-1">
          <Label htmlFor="rf-soy">大豆 デフォルト量 (kg)</Label>
          <Input id="rf-soy" {...numInput('soybeanKg')} />
        </div>

        {/* 塩 */}
        <div className="space-y-1">
          <Label htmlFor="rf-salt">塩 デフォルト量 (kg)</Label>
          <Input id="rf-salt" {...numInput('saltKg')} />
        </div>

        {/* 水飴 */}
        <div className="space-y-1">
          <Label htmlFor="rf-miz">水飴 デフォルト量 (kg) <span className="text-muted-foreground text-xs">（0=使用しない）</span></Label>
          <Input id="rf-miz" {...numInput('mizuameKg')} />
        </div>

        {/* 仕立（自動計算） */}
        <div className="space-y-1">
          <Label>仕立デフォルト (kg)
            <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
            <span className="ml-1 text-xs font-normal text-muted-foreground">（麹+蒸煮大豆+塩+水飴）</span>
          </Label>
          <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 min-h-[44px]">
            <span className="font-semibold tabular-nums text-blue-900">
              {shikomiCalc > 0 ? shikomiCalc : '—'}
            </span>
          </div>
          {e('totalWeightKg') && <p className="text-xs text-red-500">{e('totalWeightKg')}</p>}
        </div>

        {/* 麹歩合・塩分・水分（自動計算・全幅） */}
        {(kojibuai !== null || enshobun !== null || suibun !== null) && (
          <div className="sm:col-span-2 grid grid-cols-3 gap-3">
            {([
              { label: '麹歩合', value: kojibuai !== null ? `${kojibuai} 割` : '—' },
              { label: '塩分',   value: enshobun !== null ? `${enshobun} %` : '—' },
              { label: '水分',   value: suibun   !== null ? `${suibun} %`   : '—' },
            ] as const).map(({ label, value }) => (
              <div key={label} className="space-y-1">
                <p className="text-xs text-muted-foreground">{label}
                  <span className="ml-1 text-blue-500">自動計算</span>
                </p>
                <div className="flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 min-h-[36px]">
                  <span className="font-semibold tabular-nums text-blue-900 text-sm">{value}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 目標積算温度 */}
        <div className="space-y-1">
          <Label htmlFor="rf-temp">目標積算温度 (℃・日) <span className="text-red-500">*</span></Label>
          <Input id="rf-temp" {...numInput('targetTempSum')} />
          {e('targetTempSum') && <p className="text-xs text-red-500">{e('targetTempSum')}</p>}
        </div>

        {/* 初期場所 */}
        <div className="space-y-1">
          <Label>初期場所</Label>
          <Select value={form.defaultLocation} onValueChange={v => set('defaultLocation', v ?? '暖房')}>
            <SelectTrigger className="w-full min-h-[44px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCATIONS.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* 大豆産地 */}
        <div className="space-y-1">
          <Label>大豆産地デフォルト <span className="text-muted-foreground text-xs">（任意）</span></Label>
          <Select value={form.soybeanOrigin || null} onValueChange={v => set('soybeanOrigin', v ?? '')}>
            <SelectTrigger className="w-full min-h-[44px]">
              <SelectValue placeholder="選択してください" />
            </SelectTrigger>
            <SelectContent>
              {SOY_ORIGINS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* 表示順 */}
        <div className="space-y-1">
          <Label htmlFor="rf-sort">表示順</Label>
          <Input id="rf-sort" type="number" step="1" min="0" {...input('sortOrder')} />
        </div>

        {/* 種麹 */}
        <div className="space-y-1">
          <Label htmlFor="rf-tane">種麹 デフォルト量 (g) <span className="text-muted-foreground text-xs">（0=使用しない）</span></Label>
          <Input id="rf-tane" type="number" step="1" min="0" inputMode="numeric" {...input('taneKojiG')} />
        </div>

        {/* 安全在庫ライン */}
        <div className="space-y-1">
          <Label htmlFor="rf-safety">安全在庫ライン・熟成済＋小分け (kg) <span className="text-muted-foreground text-xs">（空欄=設定しない）</span></Label>
          <Input id="rf-safety" type="number" step="1" min="0" inputMode="decimal" {...input('safetyStockKg')} placeholder="例: 1600" />
          <p className="text-[11px] text-muted-foreground">
            判定対象は「熟成済バラ＋小分け製品」の合算です（熟成中ロットは含みません）。
            ダッシュボードの警告も仕込み計画の在庫切れ判定も、この合算で統一しています。
          </p>
        </div>

        {/* 冬季（11〜2月）の安全在庫ライン */}
        <div className="space-y-1">
          <Label htmlFor="rf-safety-winter">
            冬季(11〜2月)の安全在庫ライン (kg) <span className="text-muted-foreground text-xs">（空欄=通年同じ）</span>
          </Label>
          <Input id="rf-safety-winter" type="number" step="1" min="0" inputMode="decimal" {...input('winterSafetyStockKg')} placeholder="例: 2400" />
          <p className="text-[11px] text-muted-foreground">
            冬は外気が低く、完成後に常温へ出せば着色がほとんど進まないため、出荷ピークに備えて在庫を厚く持てます。
          </p>
        </div>

        {/* 夏季（5〜8月）の安全在庫ライン */}
        <div className="space-y-1">
          <Label htmlFor="rf-safety-summer">
            夏季(5〜8月)の安全在庫ライン (kg) <span className="text-muted-foreground text-xs">（空欄=通年同じ・0=底を作らない）</span>
          </Label>
          <Input id="rf-safety-summer" type="number" step="1" min="0" inputMode="decimal" {...input('summerSafetyStockKg')} placeholder="例: 0" />
          <p className="text-[11px] text-muted-foreground">
            夏は完成後13〜20日で着色リスク高に達します。底を上げると滞留が延びて不利なため薄めに設定します。
          </p>
        </div>

      </div>

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSubmit} disabled={isPending} className="min-h-[44px]">
          {isPending ? '保存中...' : editId ? '更新する' : '追加する'}
        </Button>
        <Button variant="outline" onClick={onDone} disabled={isPending} className="min-h-[44px]">
          キャンセル
        </Button>
      </div>
    </div>
  )
}

// ── メインコンポーネント ─────────────────────────────────────
export default function RecipeSettings({ recipes, moisture }: { recipes: MisoRecipe[]; moisture: MoistureSettings }) {
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [deleteError, setDeleteError] = useState('')

  const handleDeactivate = (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？\n（既存のロットには影響しません）`)) return
    setDeleteError('')
    startTransition(async () => {
      const result = await deactivateRecipe(id)
      if (result.globalError) setDeleteError(result.globalError)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">品種・配合レシピ</CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              ロット登録フォームのデフォルト配合値として使用します。
            </p>
          </div>
          {!showCreate && (
            <Button
              size="sm"
              onClick={() => { setShowCreate(true); setEditingId(null) }}
              className="shrink-0"
            >
              ＋ 新規みそを追加
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        {deleteError && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {deleteError}
          </div>
        )}

        {/* 新規追加フォーム */}
        {showCreate && (
          <RecipeForm
            initial={EMPTY_FORM}
            onDone={() => setShowCreate(false)}
            moisture={moisture}
          />
        )}

        {/* レシピ一覧 */}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-muted-foreground text-xs">
                <th className="text-left px-3 py-2">品種名</th>
                <th className="text-left px-3 py-2">穀物</th>
                <th className="text-right px-3 py-2">穀物 kg</th>
                <th className="text-right px-3 py-2">大豆 kg</th>
                <th className="text-right px-3 py-2">塩 kg</th>
                <th className="text-right px-3 py-2">仕立 kg</th>
                <th className="text-right px-3 py-2">麹歩合</th>
                <th className="text-right px-3 py-2">塩分</th>
                <th className="text-right px-3 py-2">水分</th>
                <th className="text-right px-3 py-2">目標℃・日</th>
                <th className="text-right px-3 py-2">種麹(g)</th>
                <th className="text-right px-3 py-2">安全在庫(kg)</th>
                <th className="text-right px-3 py-2">冬季(kg)</th>
                <th className="text-right px-3 py-2">夏季(kg)</th>
                <th className="text-center px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {recipes.map(r => (
                <>
                  {(() => { const mx = calcRecipeMetrics(r, moisture); return (
                  <tr key={r.id} className={`border-b last:border-0 ${editingId === r.id ? 'bg-muted/30' : ''}`}>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.grainLabel}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.grainKg}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.soybeanKg}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.saltKg}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.totalWeightKg}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{mx.kojibuai !== null ? `${mx.kojibuai}割` : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{mx.enshobun !== null ? `${mx.enshobun}%` : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{mx.suibun !== null ? `${mx.suibun}%` : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.targetTempSum}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.taneKojiG > 0 ? r.taneKojiG : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.safetyStockKg != null ? r.safetyStockKg.toLocaleString() : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.winterSafetyStockKg != null ? r.winterSafetyStockKg.toLocaleString() : '—'}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{r.summerSafetyStockKg != null ? r.summerSafetyStockKg.toLocaleString() : '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 justify-center">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setEditingId(editingId === r.id ? null : r.id)
                            setShowCreate(false)
                          }}
                        >
                          {editingId === r.id ? '閉じる' : '編集'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                          disabled={isPending}
                          onClick={() => handleDeactivate(r.id, r.name)}
                        >
                          削除
                        </Button>
                      </div>
                    </td>
                  </tr>
                  ); })()}
                  {editingId === r.id && (
                    <tr key={`${r.id}-edit`}>
                      <td colSpan={13} className="px-3 py-3">
                        <RecipeForm
                          initial={recipeToForm(r)}
                          editId={r.id}
                          onDone={() => setEditingId(null)}
                          moisture={moisture}
                        />
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {recipes.length === 0 && (
                <tr>
                  <td colSpan={13} className="text-center py-8 text-muted-foreground text-sm">
                    品種が登録されていません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

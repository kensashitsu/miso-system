'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Plus, Trash2, Save, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { formatProductTemp, GRAIN_TYPES } from '@/lib/cooling'
import { saveCoolingRun, deleteCoolingRun } from './actions'

export interface StepView {
  id:             string
  fan:            number | null
  belt:           number | null
  productTempMin: number | null
  productTempMax: number | null
  productTempRaw: string | null
  memo:           string | null
}

export interface RunView {
  id:           string
  runDateISO:   string          // yyyy-MM-dd
  grainType:    string
  airTemp1FC:   number | null
  airTemp2FC:   number | null
  roomTempC:    number | null
  memo:         string | null
  lot:          { id: string; lotNumber: string; misoType: string } | null
  plannedLabel: string | null   // ロット未登録でも仮登録があればその品種
  steps:        StepView[]
}

type StepDraft = { fan: string; belt: string; productTempRaw: string; memo: string }
const emptyStep = (): StepDraft => ({ fan: '', belt: '', productTempRaw: '', memo: '' })

function numOrNull(v: string) {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** ファン・ベルト→品温 の一行要約（過去の回を見比べるときはこれだけ読めば足りる） */
function stepSummary(step: StepView) {
  const temp = formatProductTemp(step)
  const setting = [
    step.fan  === null ? null : `ファン${step.fan}`,
    step.belt === null ? null : `ベルト${step.belt}`,
  ].filter(Boolean).join(' ') || '設定なし'
  return temp ? `${setting} → ${temp}℃` : setting
}

export default function CoolingBoard({ runs }: { runs: RunView[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const today = format(new Date(), 'yyyy-MM-dd')
  const [runDate,   setRunDate]   = useState(today)
  const [grainType, setGrainType] = useState<string>('麦')
  const [t1F,  setT1F]  = useState('')
  const [t2F,  setT2F]  = useState('')
  const [room, setRoom] = useState('')
  const [memo, setMemo] = useState('')
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()])
  const [message, setMessage] = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [visible, setVisible] = useState(20)

  const runByDate = useMemo(() => new Map(runs.map(r => [r.runDateISO, r])), [runs])
  const editing = runByDate.get(runDate) ?? null

  // 日付を選び直したら、その日の記録があれば読み込んで編集にする
  function pickDate(next: string) {
    setRunDate(next)
    setMessage(null)
    setError(null)
    const found = runByDate.get(next)
    if (!found) {
      setGrainType('麦'); setT1F(''); setT2F(''); setRoom(''); setMemo(''); setSteps([emptyStep()])
      return
    }
    setGrainType(found.grainType)
    setT1F(found.airTemp1FC?.toString() ?? '')
    setT2F(found.airTemp2FC?.toString() ?? '')
    setRoom(found.roomTempC?.toString() ?? '')
    setMemo(found.memo ?? '')
    setSteps(
      found.steps.length > 0
        ? found.steps.map(s => ({
            fan:            s.fan?.toString()  ?? '',
            belt:           s.belt?.toString() ?? '',
            productTempRaw: formatProductTemp(s),
            memo:           s.memo ?? '',
          }))
        : [emptyStep()]
    )
  }

  // ── これまでの放冷の絞り込み ──
  const [fGrain, setFGrain] = useState('すべて')
  const [fType,  setFType]  = useState('すべて')
  const [fYear,  setFYear]  = useState('すべて')
  const [fTempMin, setFTempMin] = useState('')
  const [fTempMax, setFTempMax] = useState('')
  const [fWord,  setFWord]  = useState('')

  // 絞り込みを変えたら表示件数を最初に戻す（20件だけ見えている状態のままだと結果が隠れる）
  function changeFilter<T>(set: (v: T) => void) {
    return (v: T) => { set(v); setVisible(20) }
  }

  const misoTypes = useMemo(
    () => [...new Set(runs.map(r => r.lot?.misoType).filter((v): v is string => !!v))],
    [runs]
  )
  const years = useMemo(
    () => [...new Set(runs.map(r => r.runDateISO.slice(0, 4)))].sort((a, b) => (a < b ? 1 : -1)),
    [runs]
  )

  const filtered = useMemo(() => {
    const min = numOrNull(fTempMin)
    const max = numOrNull(fTempMax)
    const word = fWord.trim()
    return runs.filter(run => {
      if (fGrain !== 'すべて' && run.grainType !== fGrain) return false
      if (fType  !== 'すべて' && run.lot?.misoType !== fType) return false
      if (fYear  !== 'すべて' && !run.runDateISO.startsWith(fYear)) return false
      if (min !== null && (run.airTemp1FC === null || run.airTemp1FC < min)) return false
      if (max !== null && (run.airTemp1FC === null || run.airTemp1FC > max)) return false
      if (word) {
        // 備考・品温の書き込み・ロット番号を横断で探す
        const haystack = [
          run.memo,
          run.lot?.lotNumber,
          run.lot?.misoType,
          ...run.steps.map(st => st.memo),
          ...run.steps.map(st => st.productTempRaw),
        ].filter(Boolean).join(' ')
        if (!haystack.includes(word)) return false
      }
      return true
    })
  }, [runs, fGrain, fType, fYear, fTempMin, fTempMax, fWord])

  const filterOn = fGrain !== 'すべて' || fType !== 'すべて' || fYear !== 'すべて' || fTempMin !== '' || fTempMax !== '' || fWord !== ''

  function resetFilter() {
    setFGrain('すべて'); setFType('すべて'); setFYear('すべて')
    setFTempMin(''); setFTempMax(''); setFWord('')
    setVisible(20)
  }

  // 入力中の気温に近い過去の回。ベルトを何番にするかの当たりを付けるための参照
  const reference = useMemo(() => {
    const target = numOrNull(t1F)
    if (target === null) return []
    return runs
      .filter(r => r.grainType === grainType && r.airTemp1FC !== null && r.runDateISO !== runDate)
      .map(r => ({ run: r, diff: Math.abs((r.airTemp1FC as number) - target) }))
      .sort((a, b) => a.diff - b.diff || (a.run.runDateISO < b.run.runDateISO ? 1 : -1))
      .slice(0, 3)
  }, [runs, t1F, grainType, runDate])

  // 仕込みは放冷の2日後
  const brewDate = useMemo(() => {
    const [y, m, d] = runDate.split('-').map(Number)
    if (!y) return null
    return new Date(Date.UTC(y, m - 1, d) + 2 * 86400000)
  }, [runDate])

  function handleSave() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await saveCoolingRun({
        runDate,
        grainType,
        airTemp1FC: numOrNull(t1F),
        airTemp2FC: numOrNull(t2F),
        roomTempC:  numOrNull(room),
        memo,
        steps: steps.map(s => ({
          fan:            numOrNull(s.fan),
          belt:           numOrNull(s.belt),
          productTempRaw: s.productTempRaw,
          memo:           s.memo,
        })),
      })
      if (res.success) {
        setMessage(editing ? '上書き保存しました。' : '保存しました。')
        router.refresh()
      } else {
        setError(res.globalError ?? Object.values(res.errors ?? {})[0] ?? '保存できませんでした。')
      }
    })
  }

  function handleDelete(id: string) {
    if (!confirm('この日の放冷記録を削除します。よろしいですか？')) return
    startTransition(async () => {
      const res = await deleteCoolingRun(id)
      if (res.success) router.refresh()
      else setError(res.globalError ?? '削除できませんでした。')
    })
  }

  return (
    <div className="space-y-6">
      {/* ── 入力 ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {editing ? `${format(new Date(runDate), 'M月d日')}の記録を編集` : '放冷の記録'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">日付</label>
              <Input type="date" value={runDate} onChange={e => pickDate(e.target.value)} className="w-40" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">原料</label>
              <div className="flex gap-1">
                {GRAIN_TYPES.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGrainType(g)}
                    className={[
                      'px-3 py-2 rounded-md border text-sm transition-colors',
                      grainType === g
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted/60',
                    ].join(' ')}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            {([['気温（1F）', t1F, setT1F], ['気温（2F）', t2F, setT2F], ['室温', room, setRoom]] as const).map(
              ([label, value, set]) => (
                <div key={label} className="space-y-1">
                  <label className="text-xs text-muted-foreground">{label}</label>
                  <Input
                    type="number"
                    step="0.25"
                    inputMode="decimal"
                    value={value}
                    onChange={e => set(e.target.value)}
                    className="w-24"
                    placeholder="℃"
                  />
                </div>
              )
            )}
          </div>

          {brewDate && (
            <p className="text-xs text-muted-foreground">
              仕込みは2日後の {format(brewDate, 'M月d日')}
              {editing?.lot
                ? `（${editing.lot.lotNumber} ${editing.lot.misoType}）`
                : editing?.plannedLabel
                  ? `（仮登録：${editing.plannedLabel}）`
                  : ''}
            </p>
          )}

          {/* 設定を変えた都度の行 */}
          <div className="space-y-2">
            <div className="hidden sm:grid grid-cols-[5rem_5rem_7rem_1fr_2rem] gap-2 text-xs text-muted-foreground px-1">
              <span>ファン</span>
              <span>ベルト</span>
              <span>品温</span>
              <span>備考</span>
              <span />
            </div>
            {steps.map((step, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-[5rem_5rem_7rem_1fr_2rem] gap-2 items-center">
                <Input
                  type="number" step="1" inputMode="decimal" placeholder="ファン"
                  value={step.fan}
                  onChange={e => setSteps(s => s.map((x, j) => (j === i ? { ...x, fan: e.target.value } : x)))}
                />
                <Input
                  type="number" step="0.5" inputMode="decimal" placeholder="ベルト"
                  value={step.belt}
                  onChange={e => setSteps(s => s.map((x, j) => (j === i ? { ...x, belt: e.target.value } : x)))}
                />
                <Input
                  placeholder="37～38"
                  value={step.productTempRaw}
                  onChange={e => setSteps(s => s.map((x, j) => (j === i ? { ...x, productTempRaw: e.target.value } : x)))}
                />
                <Input
                  placeholder="備考"
                  value={step.memo}
                  onChange={e => setSteps(s => s.map((x, j) => (j === i ? { ...x, memo: e.target.value } : x)))}
                />
                <button
                  type="button"
                  onClick={() => setSteps(s => (s.length === 1 ? [emptyStep()] : s.filter((_, j) => j !== i)))}
                  className="text-muted-foreground hover:text-red-600 p-1 rounded hover:bg-muted/60 justify-self-start"
                  aria-label="この行を削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setSteps(s => [...s, emptyStep()])}>
              <Plus className="h-4 w-4 mr-1" />
              設定を変えた行を足す
            </Button>
            <p className="text-xs text-muted-foreground">
              品温は「37～38」「30℃以下」のように幅や但し書きのまま入れて構いません（そのまま残ります）。
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">その日の備考</label>
            <Input value={memo} onChange={e => setMemo(e.target.value)} placeholder="浸漬30分 / 会長操作 など" />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {message && <p className="text-sm text-emerald-700">{message}</p>}

          <Button onClick={handleSave} disabled={pending}>
            <Save className="h-4 w-4 mr-1" />
            {pending ? '保存中…' : editing ? '上書き保存' : '保存'}
          </Button>
        </CardContent>
      </Card>

      {/* ── 気温が近い日の設定 ── */}
      {reference.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">気温が近い日の設定（{grainType}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {reference.map(({ run }) => (
              <div key={run.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => pickDate(run.runDateISO)} className="font-medium hover:underline">
                    {format(new Date(run.runDateISO), 'yyyy年M月d日')}
                  </button>
                  <span className="text-muted-foreground text-xs">1F {run.airTemp1FC}℃</span>
                  {run.lot && (
                    <Badge variant="outline" className={`text-[10px] ${getMisoTypeBadgeStyle(run.lot.misoType)}`}>
                      {run.lot.misoType}
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground text-xs mt-0.5">
                  {run.steps.map(s => stepSummary(s)).join(' ／ ')}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── これまでの記録 ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            これまでの放冷（{filterOn ? `${filtered.length} / ${runs.length}件` : `${runs.length}件`}）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 絞り込み */}
          <div className="flex flex-wrap items-end gap-2 pb-1">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">原料</label>
              <select
                value={fGrain}
                onChange={e => changeFilter(setFGrain)(e.target.value)}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                {['すべて', ...GRAIN_TYPES].map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">品種</label>
              <select
                value={fType}
                onChange={e => changeFilter(setFType)(e.target.value)}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                {['すべて', ...misoTypes].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">年</label>
              <select
                value={fYear}
                onChange={e => changeFilter(setFYear)(e.target.value)}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                {['すべて', ...years].map(y => <option key={y} value={y}>{y === 'すべて' ? y : `${y}年`}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">気温（1F）</label>
              <div className="flex items-center gap-1">
                <Input
                  type="number" step="0.5" inputMode="decimal" placeholder="下限"
                  value={fTempMin} onChange={e => changeFilter(setFTempMin)(e.target.value)}
                  className="w-20"
                />
                <span className="text-xs text-muted-foreground">〜</span>
                <Input
                  type="number" step="0.5" inputMode="decimal" placeholder="上限"
                  value={fTempMax} onChange={e => changeFilter(setFTempMax)(e.target.value)}
                  className="w-20"
                />
              </div>
            </div>
            <div className="space-y-1 flex-1 min-w-[12rem]">
              <label className="text-xs text-muted-foreground">キーワード（備考・品温・ロット番号）</label>
              <Input
                value={fWord}
                onChange={e => changeFilter(setFWord)(e.target.value)}
                placeholder="会長操作 / かたまり など"
              />
            </div>
            {filterOn && (
              <Button variant="outline" size="sm" onClick={resetFilter}>
                <X className="h-4 w-4 mr-1" />絞り込みを解除
              </Button>
            )}
          </div>

          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">条件に当てはまる放冷はありません。</p>
          )}

          {filtered.slice(0, visible).map(run => (
            <div key={run.id} className="rounded-lg border border-gray-100 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" onClick={() => pickDate(run.runDateISO)} className="font-medium hover:underline">
                  {format(new Date(run.runDateISO), 'yyyy年M月d日')}
                </button>
                <Badge variant="outline" className="text-[10px]">{run.grainType}</Badge>
                <span className="text-xs text-muted-foreground">
                  1F {run.airTemp1FC ?? '—'} ／ 2F {run.airTemp2FC ?? '—'} ／ 室 {run.roomTempC ?? '—'} ℃
                </span>
                {run.lot ? (
                  <Link href={`/lots/${run.lot.id}`} className="text-xs text-primary hover:underline">
                    {run.lot.lotNumber} {run.lot.misoType}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {run.plannedLabel ? `仮登録：${run.plannedLabel}` : 'ロット未紐付け'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(run.id)}
                  className="ml-auto text-muted-foreground hover:text-red-600 p-1 rounded hover:bg-muted/60"
                  aria-label="削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {run.steps.map(s => stepSummary(s)).join(' ／ ')}
              </div>
              {(run.memo || run.steps.some(s => s.memo)) && (
                <div className="text-xs text-muted-foreground mt-1">
                  {[run.memo, ...run.steps.map(s => s.memo)].filter(Boolean).join(' ／ ')}
                </div>
              )}
            </div>
          ))}
          {visible < filtered.length && (
            <Button variant="outline" size="sm" onClick={() => setVisible(v => v + 20)}>
              もっと見る（残り{filtered.length - visible}件）
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

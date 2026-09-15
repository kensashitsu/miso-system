'use client'

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Plus, Trash2, Save, X, Pencil } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { formatProductTemp, GRAIN_TYPES } from '@/lib/cooling'
import { type CoolingModel, predictProductTemp, suggestBelt, habitualBelt } from '@/lib/coolingModel'
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

const Blank = ({ label }: { label: string }) => (
  <span className="italic text-gray-400">{label}未記入</span>
)

/**
 * ファン・ベルト→品温 の一行要約（過去の回を見比べるときはこれだけ読めば足りる）。
 * 未記入の項目は「品温未記入」と薄字で出す——空のまま詰めると、設定を何度も変えた日が
 * 1回しか調整していないように見えてしまうため（2026-09-11 ユーザー指摘）。
 */
function StepSummary({ step }: { step: StepView }) {
  const temp = formatProductTemp(step)
  return (
    <span className="whitespace-nowrap">
      {step.fan !== null && <>ファン{step.fan} </>}
      {step.belt !== null ? `ベルト${step.belt}` : <Blank label="ベルト" />}
      {' → '}
      {temp ? `${temp}℃` : <Blank label="品温" />}
    </span>
  )
}

/** ／ 区切りで並べる */
function StepSummaryList({ steps }: { steps: StepView[] }) {
  return (
    <>
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          {i > 0 && <span className="text-gray-300"> ／ </span>}
          <StepSummary step={step} />
        </Fragment>
      ))}
    </>
  )
}

const round1 = (n: number) => Math.round(n * 10) / 10

export default function CoolingBoard({
  runs, model, initialEditDate,
}: {
  runs: RunView[]
  model: CoolingModel | null
  initialEditDate?: string   // ロット詳細の「この記録を編集」から ?date= で開いたとき
}) {
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
  const [targetTemp, setTargetTemp] = useState('')

  const runByDate = useMemo(() => new Map(runs.map(r => [r.runDateISO, r])), [runs])
  // 編集中の記録。日付で引くと、編集中に日付を直した瞬間に別の日を読み込んでしまうので id で持つ
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId ? runs.find(r => r.id === editingId) ?? null : null
  const dateMoved = editing !== null && editing.runDateISO !== runDate
  const formRef = useRef<HTMLDivElement>(null)

  function fillForm(run: RunView | null) {
    setGrainType(run?.grainType ?? '麦')
    setT1F(run?.airTemp1FC?.toString() ?? '')
    setT2F(run?.airTemp2FC?.toString() ?? '')
    setRoom(run?.roomTempC?.toString() ?? '')
    setMemo(run?.memo ?? '')
    setSteps(
      run && run.steps.length > 0
        ? run.steps.map(s => ({
            fan:            s.fan?.toString()  ?? '',
            belt:           s.belt?.toString() ?? '',
            productTempRaw: formatProductTemp(s),
            memo:           s.memo ?? '',
          }))
        : [emptyStep()]
    )
  }

  /** 記録を入力欄に読み込んで編集にする。一覧は下の方にあるので入力欄までスクロールする */
  function loadRun(run: RunView) {
    setEditingId(run.id)
    setRunDate(run.runDateISO)
    fillForm(run)
    setMessage(null)
    setError(null)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function startNew() {
    setEditingId(null)
    setRunDate(today)
    fillForm(null)
    setMessage(null)
    setError(null)
  }

  // 日付欄を変えたとき：編集中ならその記録の日付を直すだけ。新規入力中にもう記録がある日を選んだら読み込む
  function pickDate(next: string) {
    setRunDate(next)
    setMessage(null)
    setError(null)
    if (editingId) return
    const found = runByDate.get(next)
    if (found) loadRun(found)
  }

  useEffect(() => {
    if (!initialEditDate) return
    const found = runByDate.get(initialEditDate)
    if (found) loadRun(found)
    // 開いたときに一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // ── 予測と提案（麦のみ。砕米は記録が少なくファンも毎回違うので出さない） ──
  const air = numOrNull(t1F)
  const canPredict = model !== null && grainType === '麦' && air !== null
  const habit    = canPredict ? habitualBelt(model, air) : null
  const target   = numOrNull(targetTemp)
  const suggested = canPredict && target !== null ? suggestBelt(model, air, target) : null
  const airOutOfRange = canPredict && (air < model.airMin || air > model.airMax)
  const beltOutOfRange = (belt: number | null) =>
    model !== null && belt !== null && (belt < model.beltMin || belt > model.beltMax)

  /** その行のベルト（空欄なら前の行から変えていない）で当てた品温 */
  function predictedTempForRow(i: number) {
    if (!canPredict) return null
    for (let j = i; j >= 0; j--) {
      const belt = numOrNull(steps[j].belt)
      if (belt !== null) return predictProductTemp(model, air, belt)
    }
    return null
  }

  function applySuggestedBelt() {
    if (suggested === null) return
    const value = String(Math.round(suggested))
    setSteps(s => s.map((x, j) => (j === 0 ? { ...x, belt: value, fan: x.fan || '50' } : x)))
  }

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
        id: editingId ?? undefined,
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
      if (res.success) {
        if (id === editingId) startNew()
        router.refresh()
      } else setError(res.globalError ?? '削除できませんでした。')
    })
  }

  return (
    <div className="space-y-6">
      {/* ── 入力 ── */}
      <div ref={formRef} className="scroll-mt-20">
      <Card className={editing ? 'ring-2 ring-amber-300' : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {editing ? `${format(new Date(editing.runDateISO), 'yyyy年M月d日')}の記録を編集中` : '放冷の記録（新規）'}
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
              {dateMoved
                ? '（保存すると日付を移し、2日後に仕込んだロットへ紐付け直します）'
                : editing?.lot
                  ? `（${editing.lot.lotNumber} ${editing.lot.misoType}）`
                  : editing?.plannedLabel
                    ? `（仮登録：${editing.plannedLabel}）`
                    : ''}
            </p>
          )}

          {/* 予測と提案 */}
          <div className="rounded-lg border border-sky-100 bg-sky-50/50 px-3 py-3 space-y-2 text-sm">
            <div className="font-medium text-sky-900">ベルトと品温の目安</div>
            {grainType !== '麦' ? (
              <p className="text-xs text-muted-foreground">
                砕米は記録が少なく、ファンも毎回変えているため予測は出していません。
              </p>
            ) : model === null ? (
              <p className="text-xs text-muted-foreground">記録が足りないため予測を作れません。</p>
            ) : air === null ? (
              <p className="text-xs text-muted-foreground">気温（1F）を入れると、ベルトと品温の目安が出ます。</p>
            ) : (
              <>
                {habit !== null && (
                  <p>
                    いつもの設定なら <span className="font-semibold">ベルト {Math.round(habit)}</span>
                    {' → '}品温 約<span className="font-semibold">{round1(predictProductTemp(model, air, habit))}℃</span>
                    <span className="text-xs text-muted-foreground ml-1">（この気温の日に最初に選んでいたベルト）</span>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <span>品温を</span>
                  <Input
                    type="number" step="0.5" inputMode="decimal" placeholder="38"
                    value={targetTemp} onChange={e => setTargetTemp(e.target.value)}
                    className="w-20 h-8 bg-white"
                  />
                  <span>℃にするなら</span>
                  {suggested !== null ? (
                    <>
                      <span className="font-semibold">ベルト {Math.round(suggested)}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 bg-white" onClick={applySuggestedBelt}>
                        1行目に入れる
                      </Button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                {(airOutOfRange || beltOutOfRange(suggested)) && (
                  <p className="text-xs text-amber-700">
                    {airOutOfRange
                      ? `この気温は記録の範囲（${model.airMin}〜${model.airMax}℃）の外なので、目安程度に見てください。`
                      : `このベルトは記録の範囲（${model.beltMin}〜${model.beltMax}）の外なので、目安程度に見てください。`}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  ベルト1つで品温は約{round1(model.beltCoef)}℃動きます（1℃変えるならベルト約{Math.round(1 / model.beltCoef)}）。
                  品温の予測は8割が±{round1(model.p80)}℃以内（{model.sinceISO.slice(0, 4)}年以降の{model.days}日・{model.samples}件で検証、ファン50のとき）。
                </p>
              </>
            )}
          </div>

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
                  placeholder={(() => {
                    const p = predictedTempForRow(i)
                    return p === null ? '37～38' : `予測 ${round1(p)}`
                  })()}
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

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} disabled={pending}>
              <Save className="h-4 w-4 mr-1" />
              {pending ? '保存中…' : editing ? '上書き保存' : '保存'}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={startNew} disabled={pending}>
                <X className="h-4 w-4 mr-1" />編集をやめて新規入力に戻る
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      </div>

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
                  <button type="button" onClick={() => loadRun(run)} className="font-medium hover:underline">
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
                  <StepSummaryList steps={run.steps} />
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
            <div
              key={run.id}
              className={run.id === editingId
                ? 'rounded-lg border border-amber-300 bg-amber-50/60 px-3 py-2'
                : 'rounded-lg border border-gray-100 px-3 py-2'}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" onClick={() => loadRun(run)} className="font-medium hover:underline">
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
                  onClick={() => loadRun(run)}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/60"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {run.id === editingId ? '編集中' : '編集'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(run.id)}
                  className="text-muted-foreground hover:text-red-600 p-1 rounded hover:bg-muted/60"
                  aria-label="削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                <StepSummaryList steps={run.steps} />
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

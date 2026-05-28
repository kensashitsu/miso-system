'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { format, addDays, differenceInDays } from 'date-fns'
import { ChevronLeft, ChevronDown } from 'lucide-react'
import { Button }   from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { createLot } from './actions'
import {
  type MoistureSettings,
  calcMushiSoybeanMoisture,
} from '@/lib/settings'
import type { MisoRecipe } from '@/lib/recipes'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'

// 温調室の熟成完了予定日を計算
function calcCompletion(
  brewedAt: string,
  targetTempSum: string,
  location: string,
  dailyTempMap: Record<string, number>
): Date | null {
  if (!brewedAt || !targetTempSum || !location) return null
  if (!(location in dailyTempMap)) return null
  const target = parseFloat(targetTempSum)
  const brew   = new Date(brewedAt)
  if (isNaN(target) || target <= 0 || isNaN(brew.getTime())) return null
  const daily = dailyTempMap[location]
  if (daily <= 0) return null  // 冷蔵庫など積算停止中
  return addDays(brew, Math.ceil(target / daily))
}

// 常温の熟成完了予定日を過去気象データの月日平均から推計
function calcCompletionKaijo(
  brewedAt: string,
  targetTempSum: string,
  weatherAvg: Record<string, number>
): Date | null {
  if (!brewedAt || !targetTempSum || Object.keys(weatherAvg).length === 0) return null
  const target = parseFloat(targetTempSum)
  const brew   = new Date(brewedAt)
  if (isNaN(target) || target <= 0 || isNaN(brew.getTime())) return null

  let day = new Date(brew)
  let accumulated = 0
  for (let i = 0; i < 730; i++) {
    const key = format(day, 'MM-dd')
    accumulated += weatherAvg[key] ?? 0
    if (accumulated >= target) return day
    day = addDays(day, 1)
  }
  return null  // 2年以内に到達しない
}

// 白みそ アルコール = 仕立て × 2.5%
const ALCOHOL_RATE = 0.025

// 種水・塩は固定（設定不要）
const MOISTURE_SEED_WATER = 1.00
const MOISTURE_SALT       = 0.00

const LOCATIONS           = ['暖房', '冷房', '常温', '冷蔵庫'] as const
const BUCKET_NUMBERS      = Array.from({ length: 31 }, (_, i) => i)       // 0〜30（白みそ用・単桶選択、0号桶は白みそ専用）
const SOYBEAN_ORIGIN_OPTIONS = ['山口県産', 'カナダ産', 'アメリカ産'] as const

// 今日の日付を yyyy-MM-dd 形式で取得
const todayStr = format(new Date(), 'yyyy-MM-dd')

// 桶番号ペア一覧（1・2 〜 29・30、計15ペア）
const BUCKET_PAIRS = Array.from({ length: 15 }, (_, i) => `${i * 2 + 1}・${i * 2 + 2}`)

type FormState = {
  misoType: string; brewedAt: string
  targetTempSum: string; initialLocation: string
  bucketNumbers: string
  mugiOrKomeKg: string; soybeanKg: string; saltKg: string
  mizuameKg: string; seedWaterL: string
  soybeanOrigin: string; seedMisoKg: string
  taneKojiG: string
  kojiCondition: string; soybeanHardness: string
  airTempC: string; productTempC: string; steamingPressure: string
  coolingMin: string; memo: string
  soybeanArrivalDate: string; soybeanSupplier: string; soybeanLotNo: string
  kojiMadeAt: string; kojiSupplier: string
  saltBrand: string; saltLotNo: string
  mizuameBrand: string; mizuameLotNo: string
}

const INITIAL: FormState = {
  misoType: '', brewedAt: todayStr,
  targetTempSum: '', initialLocation: '暖房',
  bucketNumbers: '',
  mugiOrKomeKg: '', soybeanKg: '', saltKg: '',
  mizuameKg: '0', seedWaterL: '0',
  soybeanOrigin: '', seedMisoKg: '0',
  taneKojiG: '0',
  kojiCondition: '', soybeanHardness: '',
  airTempC: '', productTempC: '', steamingPressure: '', coolingMin: '', memo: '',
  soybeanArrivalDate: '', soybeanSupplier: '', soybeanLotNo: '',
  kojiMadeAt: '', kojiSupplier: '',
  saltBrand: '', saltLotNo: '',
  mizuameBrand: '', mizuameLotNo: '',
}

// ------- ヘルパーコンポーネント -------

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="text-xs text-red-500 mt-0.5">{msg}</p>
}

// 自動計算値の読み取り専用表示
function AutoField({ value, note, large }: { value: string; note: string; large?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 ${large ? 'min-h-[48px]' : 'min-h-[44px]'}`}>
      <span className={`tabular-nums text-blue-900 ${large ? 'text-lg font-bold' : 'font-semibold'}`}>
        {value}
      </span>
      <span className="text-xs text-blue-500 ml-auto">{note}</span>
    </div>
  )
}

function Req() {
  return <span className="text-red-500 ml-0.5">*</span>
}

function Opt() {
  return <span className="text-muted-foreground text-xs font-normal ml-1">（任意）</span>
}

// ------- メインコンポーネント -------

export default function LotNewForm({ moisture, recipes, weatherAvg, suggestedBucketNumbers, initialValues, brewPlanId }: {
  moisture: MoistureSettings
  recipes: MisoRecipe[]
  weatherAvg: Record<string, number>
  suggestedBucketNumbers: string
  initialValues?: { misoType?: string; brewedAt?: string; bucketNumbers?: string }
  brewPlanId?: string
}) {
  const [form, setForm] = useState<FormState>(() => {
    const base: FormState = { ...INITIAL, bucketNumbers: initialValues?.bucketNumbers ?? suggestedBucketNumbers }
    if (initialValues?.brewedAt) base.brewedAt = initialValues.brewedAt
    if (initialValues?.misoType) {
      const recipe = recipes.find(r => r.name === initialValues.misoType)
      if (recipe) {
        base.misoType        = initialValues.misoType
        base.targetTempSum   = String(recipe.targetTempSum)
        base.soybeanOrigin   = recipe.soybeanOrigin ?? ''
        base.mizuameKg       = String(recipe.mizuameKg)
        base.initialLocation = recipe.defaultLocation
        base.mugiOrKomeKg    = String(recipe.grainKg)
        base.soybeanKg       = String(recipe.soybeanKg)
        base.saltKg          = String(recipe.saltKg)
        base.taneKojiG       = String(recipe.taneKojiG)
      }
    }
    return base
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState('')
  const [isPending, startTransition] = useTransition()

  const set = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))

  const setVal = (key: keyof FormState, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }))

  // base-ui Select の onValueChange は (value: string | null) を返す
  const handleMisoTypeChange = (value: string | null) => {
    if (!value) return
    const recipe = recipes.find(r => r.name === value)
    if (!recipe) return
    setForm(prev => ({
      ...prev,
      misoType:        value,
      targetTempSum:   String(recipe.targetTempSum),
      soybeanOrigin:   recipe.soybeanOrigin ?? '',
      mizuameKg:       String(recipe.mizuameKg),
      initialLocation: recipe.defaultLocation,
      mugiOrKomeKg:    String(recipe.grainKg),
      soybeanKg:       String(recipe.soybeanKg),
      saltKg:          String(recipe.saltKg),
      taneKojiG:       String(recipe.taneKojiG),
      bucketNumbers:   '',   // 品種切替時にリセット（白みそ/ペアで選択肢が異なるため）
    }))
  }

  const handleSubmit = () => {
    setErrors({})
    setGlobalError('')

    const num     = (v: string) => parseFloat(v)          // 必須数値
    const numOpt  = (v: string) => v.trim() ? parseFloat(v)  : null  // 任意数値
    const strOpt  = (v: string) => v.trim() || null               // 任意文字列

    const data = {
      misoType:      form.misoType,
      brewedAt:      form.brewedAt,
      totalWeightKg: shikomiCalc,
      targetTempSum: num(form.targetTempSum),
      initialLocation: resolvedLocation,
      bucketNumbers: strOpt(form.bucketNumbers),
      mugiOrKomeKg:  num(form.mugiOrKomeKg),
      kojiKg:        isBareMugi ? (bakujiKg ?? 0) : (komeKojiKg ?? 0),
      soybeanKg:     num(form.soybeanKg),
      saltKg:        num(form.saltKg),
      mizuameKg:     showMizuame ? num(form.mizuameKg) : 0,
      seedWaterL:    num(form.seedWaterL),
      shikomiKg:     shikomiCalc,
      soybeanOrigin: strOpt(form.soybeanOrigin),
      seedMisoKg:    num(form.seedMisoKg),
      taneKojiG:     num(form.taneKojiG),
      kojiCondition:    numOpt(form.kojiCondition),
      soybeanHardness:  strOpt(form.soybeanHardness),
      airTempC:         numOpt(form.airTempC),
      productTempC:     numOpt(form.productTempC),
      steamingPressure: strOpt(form.steamingPressure),
      coolingMin:       strOpt(form.coolingMin),
      memo:             strOpt(form.memo),
      soybeanArrivalDate: strOpt(form.soybeanArrivalDate),
      soybeanSupplier:    strOpt(form.soybeanSupplier),
      soybeanLotNo:       strOpt(form.soybeanLotNo),
      kojiMadeAt:         strOpt(form.kojiMadeAt),
      kojiSupplier:       strOpt(form.kojiSupplier),
      saltBrand:          strOpt(form.saltBrand),
      saltLotNo:          strOpt(form.saltLotNo),
      mizuameBrand:       strOpt(form.mizuameBrand),
      mizuameLotNo:       strOpt(form.mizuameLotNo),
      brewPlanId:         brewPlanId ?? null,
    }

    startTransition(async () => {
      const result = await createLot(data)
      if (result?.errors)      setErrors(result.errors)
      if (result?.globalError) setGlobalError(result.globalError)
      // redirect が発生した場合はここに到達しない
    })
  }

  // 選択中レシピから品種情報を取得
  const selectedRecipe = recipes.find(r => r.name === form.misoType)
  const grainLabel  = selectedRecipe?.grainLabel ?? '穀物'
  const isBareMugi  = selectedRecipe?.grainLabel === '裸麦'
  const isShiroMiso = form.misoType === '白みそ'
  const showMizuame = (selectedRecipe?.mizuameKg ?? 0) > 0
  const e = (key: string) => errors[key]

  // 数値パーサ（0にフォールバック）
  const nv = (v: string) => parseFloat(v) || 0

  // ── 自動計算値 ────────────────────────────
  // 麦麹（裸麦 × kojiRatio）　※ 無添加麦みそ・田舎みそのみ
  const bakujiKg = isBareMugi && nv(form.mugiOrKomeKg) > 0
    ? Math.round(nv(form.mugiOrKomeKg) * moisture.kojiRatio * 10) / 10
    : null

  // 米麹（砕米・無洗米 × komeKojiRatio）　※ 山吹みそ・白みそのみ
  const komeKojiKg = !isBareMugi && nv(form.mugiOrKomeKg) > 0
    ? Math.round(nv(form.mugiOrKomeKg) * moisture.komeKojiRatio * 10) / 10
    : null

  // 蒸煮大豆（大豆 × soybeanRatio）
  const mushiSoyKg = nv(form.soybeanKg) > 0
    ? Math.round(nv(form.soybeanKg) * moisture.soybeanRatio * 10) / 10
    : null

  // 仕立て（麦麹 or 米麹 + 蒸煮大豆 + 塩 + 種水 + 水飴 + 種味噌）
  const kojiForCalc = isBareMugi ? (bakujiKg ?? 0) : (komeKojiKg ?? 0)
  const shikomiCalc = Math.round(
    (kojiForCalc + (mushiSoyKg ?? 0) + nv(form.saltKg) +
     nv(form.seedWaterL) + nv(form.mizuameKg) + nv(form.seedMisoKg)) * 10
  ) / 10

  // アルコール（白みそのみ：仕立て × 2.5%）
  const alcoholCalc = isShiroMiso && shikomiCalc > 0
    ? Math.round(shikomiCalc * ALCOHOL_RATE * 10) / 10
    : null

  // 塩分（%）= 塩 ÷ 仕立て × 100
  const enshobun = shikomiCalc > 0
    ? Math.round((nv(form.saltKg) / shikomiCalc) * 1000) / 10
    : null

  // 水分（%）= 各材料の水分量合計 ÷ 仕立て × 100
  // 麦麹水分率・蒸煮大豆水分率は原料含水量から設定画面の式で導出
  // 麦麹は実測値を使用（コウジ菌代謝で理論値より高くなるため）
  const mushiSoybRate    = calcMushiSoybeanMoisture(moisture.soybean, moisture.soybeanRatio)
  const kojiMoistureRate = isBareMugi ? moisture.mugiKoji : moisture.komeKoji
  const suibunRyo =
    kojiForCalc         * kojiMoistureRate   +  // 麦麹 or 米麹（加工後・導出 or 直接設定）
    (mushiSoyKg ?? 0)   * mushiSoybRate      +  // 蒸煮大豆（加工後・導出）
    nv(form.saltKg)     * MOISTURE_SALT      +  // 塩（固定0%）
    nv(form.seedWaterL) * MOISTURE_SEED_WATER+  // 種水（固定100%）
    nv(form.mizuameKg)  * moisture.mizuame   +  // 水飴
    nv(form.seedMisoKg) * moisture.seedMiso      // 種味噌
  const suibun = shikomiCalc > 0
    ? Math.round((suibunRyo / shikomiCalc) * 1000) / 10
    : null

  // 麹歩合（割）= 穀物（原料）÷ 大豆（原料）× 10
  const kojibuai = nv(form.soybeanKg) > 0 && nv(form.mugiOrKomeKg) > 0
    ? Math.round(nv(form.mugiOrKomeKg) / nv(form.soybeanKg) * 100) / 10
    : null
  // ─────────────────────────────────────────

  // 場所名から日次有効積算温度を取得（暖房/冷房/温調室はregexで温度抽出、冷蔵庫は設定値）
  const TEMP_LOC_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/
  function getNewFormDailyTemp(loc: string): number {
    const m = loc.match(TEMP_LOC_RE)
    if (m) return Math.max(Number(m[1]) - 10, 0)
    if (loc === '冷蔵庫') return Math.max(moisture.fridgeTemp - 10, 0)
    return 0
  }
  // 完成予定日計算用に暖房/冷房の場合は設定値で仮決め
  const resolvedLocation =
    form.initialLocation === '暖房' ? `暖房${moisture.room1Temp}℃` :
    form.initialLocation === '冷房' ? `冷房${moisture.room2Temp}℃` :
    form.initialLocation
  const dailyTempMap: Record<string, number> = {
    [resolvedLocation]: getNewFormDailyTemp(resolvedLocation),
  }

  // 熟成完了予定日（暖房・冷房・温調室）
  const estimatedCompletion = calcCompletion(form.brewedAt, form.targetTempSum, resolvedLocation, dailyTempMap)
  // 熟成完了予定日（常温：過去気象データの月日平均から推計）
  const estimatedCompletionKaijo = form.initialLocation === '常温'
    ? calcCompletionKaijo(form.brewedAt, form.targetTempSum, weatherAvg)
    : null

  // 数値 input 共通 className
  const numCls = 'min-h-[44px]'
  const numProps = { type: 'number' as const, inputMode: 'decimal' as const, className: numCls }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div>
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ChevronLeft className="h-4 w-4" />
          ダッシュボードへ戻る
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">ロット登録</h1>
      </div>

      {/* グローバルエラー */}
      {globalError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {globalError}
        </div>
      )}

      {/* ━━━━ Section ①：基本情報 ━━━━ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">① 基本情報</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* 行1：品種 / 仕込み日 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>品種<Req /></Label>
              <div className="flex items-center gap-2">
                <Select value={form.misoType} onValueChange={handleMisoTypeChange}>
                  <SelectTrigger className="flex-1 min-h-[44px]">
                    <SelectValue placeholder="選択してください" />
                  </SelectTrigger>
                  <SelectContent>
                    {recipes.map(r => (
                      <SelectItem key={r.id} value={r.name}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.misoType && (
                  <span
                    className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0"
                    style={getMisoTypeBadgeStyle(form.misoType)}
                  >
                    {form.misoType}
                  </span>
                )}
              </div>
              <FieldError msg={e('misoType')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="brewedAt">仕込み日<Req /></Label>
              <Input id="brewedAt" type="date" value={form.brewedAt}
                onChange={set('brewedAt')} className="min-h-[44px]" />
              <FieldError msg={e('brewedAt')} />
            </div>
          </div>

          {/* 桶番号 */}
          <div className="space-y-1">
            <Label>
              桶番号<Opt />
              <span className="text-xs font-normal text-muted-foreground ml-2">
                {isShiroMiso ? '（白みそ：1桶）' : '（ペア選択・2桶）'}
              </span>
            </Label>
            <div className="flex items-center gap-2 flex-wrap">
              {isShiroMiso ? (
                // 白みそ：単桶選択（1〜30号）
                <Select
                  value={form.bucketNumbers || '__none__'}
                  onValueChange={(v: string | null) => setVal('bucketNumbers', v === '__none__' || !v ? '' : v)}
                >
                  <SelectTrigger className="w-44 min-h-[44px]">
                    <SelectValue placeholder="指定なし" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">指定なし</SelectItem>
                    {BUCKET_NUMBERS.map(n => (
                      <SelectItem key={n} value={String(n)}>{n} 号</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                // 白みそ以外：ペア選択（1・2〜29・30号）
                <Select
                  value={form.bucketNumbers || '__none__'}
                  onValueChange={(v: string | null) => setVal('bucketNumbers', v === '__none__' || !v ? '' : v)}
                >
                  <SelectTrigger className="w-44 min-h-[44px]">
                    <SelectValue placeholder="指定なし" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">指定なし</SelectItem>
                    {BUCKET_PAIRS.map(pair => (
                      <SelectItem key={pair} value={pair}>{pair} 号</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {form.bucketNumbers ? (
                <span className="text-sm text-muted-foreground">{form.bucketNumbers} 号桶</span>
              ) : (
                <span className="text-sm text-muted-foreground">桶番号未選択</span>
              )}
            </div>
            {/* 初期重量プレビュー */}
            {form.bucketNumbers && form.bucketNumbers !== '' && shikomiCalc > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                {isShiroMiso
                  ? `初期重量（歩留まり${Math.round(moisture.yieldRate * 100)}%）：${Math.floor(shikomiCalc * moisture.yieldRate).toLocaleString()} kg`
                  : `各桶の初期重量（歩留まり${Math.round(moisture.yieldRate * 100)}%）：${Math.floor(shikomiCalc * moisture.yieldRate / 2).toLocaleString()} kg`
                }
              </p>
            )}
          </div>

          {/* 行2：初期場所 / 目標積算温度 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>初期場所<Req /></Label>
              <div className="flex gap-1.5">
                {LOCATIONS.map(loc => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => setVal('initialLocation', loc)}
                    className={`flex-1 py-2 rounded-md border text-sm min-h-[44px] transition-colors ${
                      form.initialLocation === loc
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input hover:bg-muted'
                    }`}
                  >
                    {loc}
                  </button>
                ))}
              </div>
              <FieldError msg={e('initialLocation')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="targetTempSum">目標積算温度<Req /></Label>
              <div className="flex items-center gap-2">
                <Input id="targetTempSum" type="number" step="1" min="1"
                  inputMode="decimal" className="min-h-[44px]"
                  value={form.targetTempSum} onChange={set('targetTempSum')}
                  placeholder="例: 700" />
                <span className="text-sm text-muted-foreground shrink-0">℃・日</span>
              </div>
              <FieldError msg={e('targetTempSum')} />
            </div>
          </div>

          {/* 行3：熟成完了予定（全幅バー） */}
          {(() => {
            const completion = estimatedCompletion ?? estimatedCompletionKaijo
            const isEstimate = !estimatedCompletion && !!estimatedCompletionKaijo
            if (completion) {
              return (
                <div className="rounded-md bg-muted px-4 py-3">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">
                        熟成完了予定{isEstimate ? '（過去実績より推計）' : ''}
                      </p>
                      <p className="text-lg font-bold">{format(completion, 'yyyy年M月d日')}</p>
                    </div>
                    <div style={{ color: 'var(--muted-foreground)', fontSize: '15px' }}>／</div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">あと</p>
                      <p className="text-lg font-bold">
                        {differenceInDays(completion, new Date(form.brewedAt))}
                        <span className="text-sm font-normal text-muted-foreground ml-0.5">日</span>
                      </p>
                    </div>
                  </div>
                </div>
              )
            }
            if (form.initialLocation === '常温' && form.targetTempSum) {
              return (
                <div className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
                  常温：気象データ蓄積後に完了予定日を推計表示します
                </div>
              )
            }
            if (form.initialLocation === '冷蔵庫' && form.targetTempSum) {
              return (
                <div className="rounded-md bg-sky-50 border border-sky-200 px-4 py-3 text-sm text-sky-700">
                  冷蔵庫保管中：有効積算温度は加算されません（0℃/日）
                </div>
              )
            }
            return null
          })()}

          {/* 行4：仕立量・麹歩合・塩分・水分 */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '0',
            borderTop: '0.5px solid var(--border)',
            marginTop: '12px',
            paddingTop: '12px',
          }}>
            {[
              { label: '仕立量', value: shikomiCalc > 0   ? shikomiCalc.toLocaleString() : null, unit: 'kg' },
              { label: '麹歩合', value: kojibuai  !== null ? kojibuai.toFixed(1)           : null, unit: '割' },
              { label: '塩分',   value: enshobun  !== null ? enshobun.toFixed(1)            : null, unit: '%'  },
              { label: '水分',   value: suibun    !== null ? suibun.toFixed(1)              : null, unit: '%'  },
            ].map(({ label, value, unit }, i, arr) => (
              <div key={label} style={{
                textAlign: 'left',
                padding: '4px 12px',
                paddingLeft: i === 0 ? '0' : '12px',
                borderRight: i < arr.length - 1 ? '0.5px solid var(--border)' : 'none',
              }}>
                <div style={{ fontSize: '11px', color: 'var(--muted-foreground)', marginBottom: '2px' }}>
                  {label}
                </div>
                <div style={{ fontSize: '18px', fontWeight: 500, lineHeight: 1.2 }}>
                  {value ?? '—'}
                  {value !== null && (
                    <span style={{ fontSize: '11px', color: 'var(--muted-foreground)', marginLeft: '2px' }}>
                      {unit}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {e('totalWeightKg') && <FieldError msg={e('totalWeightKg')} />}

        </CardContent>
      </Card>

      {/* ━━━━ Section ②：原料配合 ━━━━ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">② 原料配合</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* 穀物入力（裸麦 / 砕米 / 無洗米） */}
            <div className="space-y-1.5">
              <Label htmlFor="mugiOrKomeKg">{grainLabel} (kg)<Req /></Label>
              <Input id="mugiOrKomeKg" {...numProps} step="0.1" min="0"
                value={form.mugiOrKomeKg} onChange={set('mugiOrKomeKg')} />
              <FieldError msg={e('mugiOrKomeKg')} />
            </div>

            {/* 麦麹（裸麦タイプ）or 米麹（米タイプ）─ どちらも自動計算 */}
            {isBareMugi ? (
              <div className="space-y-1.5">
                <Label>麦麹 (kg)
                  <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
                </Label>
                <AutoField
                  value={bakujiKg !== null ? `${bakujiKg}` : '—'}
                  note={`${grainLabel} × ${moisture.kojiRatio}`}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>米麹 (kg)
                  <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
                </Label>
                <AutoField
                  value={komeKojiKg !== null ? `${komeKojiKg}` : '—'}
                  note={`${grainLabel} × ${moisture.komeKojiRatio}`}
                />
              </div>
            )}

            {/* 大豆入力 */}
            <div className="space-y-1.5">
              <Label htmlFor="soybeanKg">大豆 (kg)<Req /></Label>
              <Input id="soybeanKg" {...numProps} step="0.1" min="0"
                value={form.soybeanKg} onChange={set('soybeanKg')} />
              <FieldError msg={e('soybeanKg')} />
            </div>

            {/* 蒸煮大豆（自動計算） */}
            <div className="space-y-1.5">
              <Label>蒸煮大豆 (kg)
                <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
              </Label>
              <AutoField
                value={mushiSoyKg !== null ? `${mushiSoyKg}` : '—'}
                note={`大豆 × ${moisture.soybeanRatio}`}
              />
            </div>

            {/* 塩 */}
            <div className="space-y-1.5">
              <Label htmlFor="saltKg">塩 (kg)<Req /></Label>
              <Input id="saltKg" {...numProps} step="0.1" min="0"
                value={form.saltKg} onChange={set('saltKg')} />
              <FieldError msg={e('saltKg')} />
            </div>

            {/* 種水 */}
            <div className="space-y-1.5">
              <Label htmlFor="seedWaterL">種水 (ℓ)<Opt /></Label>
              <Input id="seedWaterL" {...numProps} step="0.1" min="0"
                value={form.seedWaterL} onChange={set('seedWaterL')} />
            </div>

            {/* 水飴（田舎みそ・山吹みそのみ） */}
            {showMizuame && (
              <div className="space-y-1.5">
                <Label htmlFor="mizuameKg">水飴 (kg)<Opt /></Label>
                <Input id="mizuameKg" {...numProps} step="0.1" min="0"
                  value={form.mizuameKg} onChange={set('mizuameKg')} />
              </div>
            )}

            {/* 種味噌 */}
            <div className="space-y-1.5">
              <Label htmlFor="seedMisoKg">種味噌使用量 (kg)<Opt /></Label>
              <Input id="seedMisoKg" {...numProps} step="0.1" min="0"
                value={form.seedMisoKg} onChange={set('seedMisoKg')} />
            </div>

            {/* 種麹 */}
            <div className="space-y-1.5">
              <Label htmlFor="taneKojiG">種麹使用量 (g)<Opt /></Label>
              <Input id="taneKojiG" type="number" inputMode="numeric" step="1" min="0"
                className={numCls} value={form.taneKojiG} onChange={set('taneKojiG')} />
            </div>

            {/* 仕立て（自動計算・全幅） */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label>仕立 (kg)
                <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （麦麹/麹 + 蒸煮大豆 + 塩 + 種水 + 水飴 + 種味噌）
                </span>
              </Label>
              <AutoField
                value={shikomiCalc > 0 ? `${shikomiCalc}` : '—'}
                note="合計"
                large
              />
              <FieldError msg={e('shikomiKg')} />
            </div>


            {/* アルコール（白みそのみ：仕立て × 2.5%） */}
            {isShiroMiso && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label>アルコール添加量 (kg)
                  <span className="ml-1 text-xs font-normal text-blue-600">自動計算</span>
                  <span className="ml-1 text-xs font-normal text-muted-foreground">（仕立て × 2.5%）</span>
                </Label>
                <AutoField
                  value={alcoholCalc !== null ? `${alcoholCalc}` : '—'}
                  note={`仕立て × ${ALCOHOL_RATE * 100}%`}
                />
              </div>
            )}

            {/* 大豆産地 */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label>大豆産地<Opt /></Label>
              <Select
                value={form.soybeanOrigin || null}
                onValueChange={(v) => setVal('soybeanOrigin', v ?? '')}
              >
                <SelectTrigger className="w-full min-h-[44px]">
                  <SelectValue placeholder="産地を選択してください" />
                </SelectTrigger>
                <SelectContent>
                  {SOYBEAN_ORIGIN_OPTIONS.map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </div>
        </CardContent>
      </Card>

      {/* ━━━━ Section ③：製造記録（折りたたみ） ━━━━ */}
      <Card>
        <details className="group">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between p-6 pb-3">
              <h3 className="font-semibold text-base leading-none">
                ③ 製造記録
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  （任意・タップして展開）
                </span>
              </h3>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </div>
          </summary>
          <div className="px-6 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              <div className="space-y-1.5">
                <Label htmlFor="kojiCondition">出麹評価（3〜9）<Opt /></Label>
                <Input id="kojiCondition" type="number" inputMode="numeric" step="1" min="3" max="9"
                  value={form.kojiCondition} onChange={set('kojiCondition')}
                  className="min-h-[44px]" placeholder="例: 7" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="soybeanHardness">大豆硬度メモ<Opt /></Label>
                <Input id="soybeanHardness" type="text" value={form.soybeanHardness}
                  onChange={set('soybeanHardness')} className="min-h-[44px]"
                  placeholder="例: 317-294-305" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="airTempC">仕込み時気温 (℃)<Opt /></Label>
                <Input id="airTempC" {...numProps} step="0.1"
                  value={form.airTempC} onChange={set('airTempC')} placeholder="例: 15.5" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="productTempC">仕込み時品温 (℃)<Opt /></Label>
                <Input id="productTempC" {...numProps} step="0.1"
                  value={form.productTempC} onChange={set('productTempC')} placeholder="例: 28.0" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="steamingPressure">蒸煮条件<Opt /></Label>
                <Input id="steamingPressure" type="text" value={form.steamingPressure}
                  onChange={set('steamingPressure')} className="min-h-[44px]"
                  placeholder="例: 0.07-34" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="coolingMin">冷却時間<Opt /></Label>
                <Input id="coolingMin" type="text" value={form.coolingMin}
                  onChange={set('coolingMin')} className="min-h-[44px]"
                  placeholder="例: 30分" />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="memo">備考<Opt /></Label>
                <Textarea id="memo" value={form.memo} onChange={set('memo')}
                  className="min-h-[80px]" placeholder="自由記述..." />
              </div>

            </div>
          </div>
        </details>
      </Card>

      {/* ━━━━ Section ④：原料ロット情報（折りたたみ） ━━━━ */}
      <Card>
        <details className="group">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between p-6 pb-3">
              <h3 className="font-semibold text-base leading-none">
                ④ 原料ロット情報
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  （任意・タップして展開）
                </span>
              </h3>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </div>
          </summary>
          <div className="px-6 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              {/* 大豆 */}
              <div className="sm:col-span-2 text-sm font-medium text-muted-foreground pt-1">大豆</div>
              <div className="space-y-1.5">
                <Label htmlFor="soybeanArrivalDate">入荷日<Opt /></Label>
                <Input id="soybeanArrivalDate" type="date" value={form.soybeanArrivalDate}
                  onChange={set('soybeanArrivalDate')} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="soybeanSupplier">仕入れ先<Opt /></Label>
                <Input id="soybeanSupplier" type="text" value={form.soybeanSupplier}
                  onChange={set('soybeanSupplier')} className="min-h-[44px]"
                  placeholder="例: ○○農協" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="soybeanLotNo">ロット番号<Opt /></Label>
                <Input id="soybeanLotNo" type="text" value={form.soybeanLotNo}
                  onChange={set('soybeanLotNo')} className="min-h-[44px]" />
              </div>

              {/* 裸麦 */}
              <div className="sm:col-span-2 text-sm font-medium text-muted-foreground pt-1">裸麦</div>
              <div className="space-y-1.5">
                <Label htmlFor="kojiMadeAt">製造日<Opt /></Label>
                <Input id="kojiMadeAt" type="date" value={form.kojiMadeAt}
                  onChange={set('kojiMadeAt')} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kojiSupplier">仕入れ先<Opt /></Label>
                <Input id="kojiSupplier" type="text" value={form.kojiSupplier}
                  onChange={set('kojiSupplier')} className="min-h-[44px]" />
              </div>

              {/* 塩 */}
              <div className="sm:col-span-2 text-sm font-medium text-muted-foreground pt-1">塩</div>
              <div className="space-y-1.5">
                <Label htmlFor="saltBrand">銘柄<Opt /></Label>
                <Input id="saltBrand" type="text" value={form.saltBrand}
                  onChange={set('saltBrand')} className="min-h-[44px]"
                  placeholder="例: 赤穂の塩" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="saltLotNo">ロット番号<Opt /></Label>
                <Input id="saltLotNo" type="text" value={form.saltLotNo}
                  onChange={set('saltLotNo')} className="min-h-[44px]" />
              </div>

              {/* 水飴 */}
              <div className="sm:col-span-2 text-sm font-medium text-muted-foreground pt-1">水飴</div>
              <div className="space-y-1.5">
                <Label htmlFor="mizuameBrand">銘柄<Opt /></Label>
                <Input id="mizuameBrand" type="text" value={form.mizuameBrand}
                  onChange={set('mizuameBrand')} className="min-h-[44px]" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mizuameLotNo">ロット番号<Opt /></Label>
                <Input id="mizuameLotNo" type="text" value={form.mizuameLotNo}
                  onChange={set('mizuameLotNo')} className="min-h-[44px]" />
              </div>

            </div>
          </div>
        </details>
      </Card>

      {/* 送信ボタン */}
      <div className="pb-8">
        <Button
          onClick={handleSubmit}
          disabled={isPending}
          size="lg"
          className="w-full sm:w-auto min-h-[48px] px-8 text-base"
        >
          {isPending ? '登録中...' : 'ロットを登録する'}
        </Button>
      </div>
    </div>
  )
}

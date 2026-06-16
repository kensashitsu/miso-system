'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { updateMoistureSettings } from './actions'
import {
  type MoistureSettings,
  DEFAULT_MOISTURE,
  calcMugiKojiMoisture, calcKomeKojiMoisture, calcMushiSoybeanMoisture,
} from '@/lib/settings'

// 比率・温度フィールドは % 変換しない
const RATIO_KEYS = new Set<keyof MoistureSettings>(['kojiRatio', 'komeKojiRatio', 'soybeanRatio', 'room1Temp', 'room2Temp', 'fridgeTemp', 'heatingDefaultTemp', 'coolingDefaultTemp', 'q10Value', 'brewBufferDays'])

type FormState = Record<keyof MoistureSettings, string>

function toForm(m: MoistureSettings): FormState {
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [
      k,
      RATIO_KEYS.has(k as keyof MoistureSettings)
        ? String(v)
        : String(Math.round(v * 1000) / 10),
    ])
  ) as FormState
}

function fmt(n: number, dec = 1) { return n.toFixed(dec) }

// ── 乾物量変化テーブル ──────────────────────────────────────
type DryMatterRow = { label: string; weight: number; moisture: number; dm: number }

function DryMatterTable({ rows, changeLabel }: { rows: DryMatterRow[]; changeLabel?: string }) {
  const baseDm   = rows[0].dm
  const dmChange = rows[rows.length - 1].dm - baseDm
  const dmRate   = baseDm > 0 ? (dmChange / baseDm) * 100 : 0
  const isNeg    = dmChange < -0.05

  return (
    <div className="overflow-x-auto rounded-lg border border-muted">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-muted-foreground text-xs">
            <th className="text-left px-3 py-2 font-medium">材料</th>
            <th className="text-right px-3 py-2 font-medium whitespace-nowrap">重量（kg）</th>
            <th className="text-right px-3 py-2 font-medium whitespace-nowrap">水分率</th>
            <th className="text-right px-3 py-2 font-medium whitespace-nowrap">乾物量（kg）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">{r.label}</td>
              <td className="text-right px-3 py-2 tabular-nums">{fmt(r.weight)}</td>
              <td className="text-right px-3 py-2 tabular-nums">{fmt(r.moisture * 100)} %</td>
              <td className="text-right px-3 py-2 tabular-nums font-medium">{fmt(r.dm)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={`border-t ${isNeg ? 'bg-orange-50' : 'bg-blue-50'}`}>
            <td className="px-3 py-2 text-xs font-medium text-muted-foreground" colSpan={3}>
              乾物変化{changeLabel && <span className="ml-1">（{changeLabel}）</span>}
            </td>
            <td className={`text-right px-3 py-2 tabular-nums font-bold ${
              isNeg ? 'text-orange-700' : 'text-blue-700'
            }`}>
              {dmChange >= 0 ? '+' : ''}{fmt(dmChange)} kg
              <span className="ml-1.5 text-xs font-normal opacity-80">
                （{dmRate >= 0 ? '+' : ''}{fmt(dmRate)} %）
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── パーセント入力欄 ─────────────────────────────────────────
function PctInput({
  id, value, onChange, error,
}: {
  id: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; error?: string
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" step="0.1" min="0" max="100" inputMode="decimal"
          value={value} onChange={onChange} className="min-h-[44px]" />
        <span className="text-sm text-muted-foreground shrink-0">%</span>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </>
  )
}

// ── 重量比入力欄 ─────────────────────────────────────────────
function RatioInput({
  id, value, onChange, error,
}: {
  id: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; error?: string
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground shrink-0">×</span>
        <Input id={id} type="number" step="0.01" min="0.01" inputMode="decimal"
          value={value} onChange={onChange} className="min-h-[44px]" />
        <span className="text-sm text-muted-foreground shrink-0">倍</span>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </>
  )
}

// ── 理論値表示欄 ─────────────────────────────────────────────
function TheoryField({ value, formula }: { value: number; formula: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 min-h-[44px] rounded-md border border-dashed border-muted-foreground/40 bg-muted px-3">
        <span className="tabular-nums text-muted-foreground">{fmt(value)} %</span>
      </div>
      <p className="text-xs text-muted-foreground">{formula}</p>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
export default function MoistureSettingsForm({ moisture }: { moisture: MoistureSettings }) {
  const [form, setForm]     = useState<FormState>(toForm(moisture))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved]   = useState(false)
  const [globalError, setGlobalError] = useState('')
  const [isPending, startTransition]  = useTransition()

  const set = (key: keyof MoistureSettings) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm(prev => ({ ...prev, [key]: e.target.value }))
      setSaved(false)
    }

  // 含水量：%文字列 → 小数
  const raw = (key: keyof MoistureSettings) => parseFloat(form[key]) / 100 || 0
  // 比率：そのまま数値
  const kojiR = parseFloat(form.kojiRatio)     || DEFAULT_MOISTURE.kojiRatio
  const komeR = parseFloat(form.komeKojiRatio) || DEFAULT_MOISTURE.komeKojiRatio
  const soyR  = parseFloat(form.soybeanRatio)  || DEFAULT_MOISTURE.soybeanRatio

  // 理論値
  const theoryMugiKoji  = calcMugiKojiMoisture(raw('hadakaMugi'), kojiR)
  const theoryKomeKoji  = calcKomeKojiMoisture(raw('kome'), komeR)
  const derivedMushiSoy = calcMushiSoybeanMoisture(raw('soybean'), soyR)

  // 乾物量（原料100kgあたり）
  const mugiRows: DryMatterRow[] = [
    { label: `裸麦（原料）`,        weight: 100,          moisture: raw('hadakaMugi'), dm: 100 * (1 - raw('hadakaMugi')) },
    { label: `麦麹（×${kojiR}）`, weight: 100 * kojiR, moisture: raw('mugiKoji'),  dm: 100 * kojiR * (1 - raw('mugiKoji')) },
  ]
  const komeRows: DryMatterRow[] = [
    { label: `砕米・無洗米（原料）`, weight: 100,          moisture: raw('kome'),     dm: 100 * (1 - raw('kome')) },
    { label: `米麹（×${komeR}）`,  weight: 100 * komeR, moisture: raw('komeKoji'), dm: 100 * komeR * (1 - raw('komeKoji')) },
  ]
  const soyRows: DryMatterRow[] = [
    { label: `大豆（原料）`,           weight: 100,         moisture: raw('soybean'),   dm: 100 * (1 - raw('soybean')) },
    { label: `蒸煮大豆（×${soyR}）`, weight: 100 * soyR, moisture: derivedMushiSoy, dm: 100 * soyR * (1 - derivedMushiSoy) },
  ]

  const handleSave = () => {
    setErrors({})
    setGlobalError('')
    setSaved(false)
    const data = Object.fromEntries(
      (Object.keys(form) as (keyof MoistureSettings)[]).map(k => [k, parseFloat(form[k])])
    )
    startTransition(async () => {
      const result = await updateMoistureSettings(data)
      if (result.errors)      setErrors(result.errors)
      if (result.globalError) setGlobalError(result.globalError)
      if (result.success)     setSaved(true)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">水分計算用の含水量・処理比率設定</CardTitle>
        <p className="text-sm text-muted-foreground">
          含水量は時期により変化するため、分析値が得られたら都度更新してください。
        </p>
      </CardHeader>
      <CardContent className="space-y-6">

        {globalError && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {globalError}
          </div>
        )}
        {saved && (
          <div className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
            設定を保存しました。
          </div>
        )}

        {/* ── 裸麦・麦麹（無添加麦みそ・田舎みそ） ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">裸麦・麦麹（無添加麦みそ・田舎みそ）</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label htmlFor="kojiRatio">
                重量比<span className="text-xs font-normal text-muted-foreground ml-1">（裸麦→麦麹）</span>
              </Label>
              <RatioInput id="kojiRatio" value={form.kojiRatio} onChange={set('kojiRatio')} error={errors.kojiRatio} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hadakaMugi">
                裸麦の含水量<span className="text-xs font-normal text-muted-foreground ml-1">（原料）</span>
              </Label>
              <PctInput id="hadakaMugi" value={form.hadakaMugi} onChange={set('hadakaMugi')} error={errors.hadakaMugi} />
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">麦麹の水分率（理論値）<span className="text-xs font-normal ml-1">参考</span></Label>
              <TheoryField value={theoryMugiKoji * 100} formula={`((×${kojiR}−1)+裸麦含水量)÷${kojiR}`} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mugiKoji">
                麦麹の水分率<span className="text-xs font-normal text-orange-600 ml-1">実測値・計算に使用</span>
              </Label>
              <PctInput id="mugiKoji" value={form.mugiKoji} onChange={set('mugiKoji')} error={errors.mugiKoji} />
              <p className="text-xs text-muted-foreground">コウジ菌の代謝で乾物が減るため理論値より高くなります</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">乾物量の変化（原料100kgあたり）</p>
            <DryMatterTable rows={mugiRows} changeLabel="コウジ菌による消費" />
          </div>
        </section>

        {/* ── 砕米・無洗米・米麹（山吹みそ・白みそ） ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">砕米・無洗米・米麹（山吹みそ・白みそ）</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label htmlFor="komeKojiRatio">
                重量比<span className="text-xs font-normal text-muted-foreground ml-1">（砕米・無洗米→米麹）</span>
              </Label>
              <RatioInput id="komeKojiRatio" value={form.komeKojiRatio} onChange={set('komeKojiRatio')} error={errors.komeKojiRatio} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kome">
                砕米・無洗米の含水量<span className="text-xs font-normal text-muted-foreground ml-1">（原料）</span>
              </Label>
              <PctInput id="kome" value={form.kome} onChange={set('kome')} error={errors.kome} />
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">米麹の水分率（理論値）<span className="text-xs font-normal ml-1">参考</span></Label>
              <TheoryField value={theoryKomeKoji * 100} formula={`((×${komeR}−1)+砕米含水量)÷${komeR}`} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="komeKoji">
                米麹の水分率<span className="text-xs font-normal text-orange-600 ml-1">実測値・計算に使用</span>
              </Label>
              <PctInput id="komeKoji" value={form.komeKoji} onChange={set('komeKoji')} error={errors.komeKoji} />
              <p className="text-xs text-muted-foreground">コウジ菌の代謝で乾物が減るため理論値より高くなります</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">乾物量の変化（原料100kgあたり）</p>
            <DryMatterTable rows={komeRows} changeLabel="コウジ菌による消費" />
          </div>
        </section>

        {/* ── 大豆・蒸煮大豆（全品種） ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">大豆・蒸煮大豆（全品種）</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label htmlFor="soybeanRatio">
                重量比<span className="text-xs font-normal text-muted-foreground ml-1">（大豆→蒸煮大豆）</span>
              </Label>
              <RatioInput id="soybeanRatio" value={form.soybeanRatio} onChange={set('soybeanRatio')} error={errors.soybeanRatio} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="soybean">
                大豆の含水量<span className="text-xs font-normal text-muted-foreground ml-1">（原料）</span>
              </Label>
              <PctInput id="soybean" value={form.soybean} onChange={set('soybean')} error={errors.soybean} />
            </div>
            <div className="space-y-1">
              <Label>
                蒸煮大豆の水分率<span className="text-xs font-normal text-blue-600 ml-1">自動計算・計算に使用</span>
              </Label>
              <div className="flex items-center gap-2 min-h-[44px] rounded-md border border-blue-200 bg-blue-50 px-3">
                <span className="font-semibold tabular-nums text-blue-900">{fmt(derivedMushiSoy * 100)} %</span>
              </div>
              <p className="text-xs text-muted-foreground">
                ((×{soyR}−1)+大豆含水量)÷{soyR}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">乾物量の変化（原料100kgあたり）</p>
            <DryMatterTable rows={soyRows} changeLabel="水分吸収のみ・乾物は不変" />
          </div>
        </section>

        {/* ── その他 ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">その他の含水量</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {([
              { key: 'mizuame'  as const, label: '水飴',   note: '田舎みそ・山吹みそ' },
              { key: 'seedMiso' as const, label: '種味噌', note: '使用する場合' },
            ]).map(({ key, label, note }) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={key}>
                  {label}<span className="text-xs font-normal text-muted-foreground ml-1">（%）</span>
                </Label>
                <p className="text-xs text-muted-foreground">{note}</p>
                <PctInput id={key} value={form[key]} onChange={set(key)} error={errors[key]} />
              </div>
            ))}
          </div>
        </section>

        {/* ── 温度管理設定 ── */}
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">温度管理設定</h3>
            <p className="text-xs text-muted-foreground mt-0.5">場所移動時の温度入力欄の初期値</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {([
              { key: 'heatingDefaultTemp' as const, label: '暖房デフォルト温度', min: 10, max: 40 },
              { key: 'coolingDefaultTemp' as const, label: '冷房デフォルト温度', min: 10, max: 40 },
              { key: 'fridgeTemp'         as const, label: '冷蔵庫温度',         min: 1,  max: 15 },
            ]).map(({ key, label, min, max }) => {
              const tempVal   = parseFloat(form[key]) || DEFAULT_MOISTURE[key]
              const effective = Math.max(tempVal - 10, 0)
              const isFridge  = key === 'fridgeTemp'
              return (
                <div key={key} className="space-y-1">
                  <Label htmlFor={key}>{label}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={key}
                      type="number"
                      step="1"
                      min={min}
                      max={max}
                      inputMode="numeric"
                      value={form[key]}
                      onChange={set(key)}
                      className="min-h-[44px]"
                    />
                    <span className="text-sm text-muted-foreground shrink-0">℃</span>
                  </div>
                  {errors[key] && <p className="text-xs text-red-500">{errors[key]}</p>}
                  <p className="text-xs text-muted-foreground">
                    有効積算温度：
                    <span className="font-medium text-foreground">
                      {effective}℃/日
                      {isFridge && effective === 0 ? '（熟成停止）' : ''}
                    </span>
                  </p>
                </div>
              )
            })}
          </div>

          {/* Q10補正係数 */}
          <div className="space-y-1">
            <Label htmlFor="q10Value">Q10値（常温熟成の補正係数）</Label>
            <div className="flex items-center gap-2">
              <Input
                id="q10Value"
                type="number"
                step="0.1"
                min="1.0"
                max="10.0"
                inputMode="decimal"
                value={form.q10Value}
                onChange={set('q10Value')}
                className="min-h-[44px] w-28"
              />
            </div>
            {errors.q10Value && <p className="text-xs text-red-500">{errors.q10Value}</p>}
            <p className="text-xs text-muted-foreground leading-relaxed">
              常温熟成時の温度感受性係数。値が大きいほど高温での熟成が速く進む予測になります。
              御社の実績「熟成日数」（6〜9月仕込みの常温は中央値約29日）に照合した推奨値は <span className="font-medium text-foreground">2.0</span> です。
              （範囲：1.0〜10.0、1.0 = 補正なし）
            </p>
          </div>

          {/* 仕込み計画用参照温度 */}
          <div className="rounded-lg border border-dashed border-muted-foreground/30 px-4 py-3 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">仕込み計画・気象シミュレーター用の参照温度</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {([
                { key: 'room1Temp' as const, label: '暖房参照温度' },
                { key: 'room2Temp' as const, label: '冷房参照温度' },
              ]).map(({ key, label }) => {
                const tempVal   = parseFloat(form[key]) || DEFAULT_MOISTURE[key]
                const effective = Math.max(tempVal - 10, 0)
                return (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={key} className="text-muted-foreground">{label}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={key}
                        type="number"
                        step="1"
                        min="10"
                        max="40"
                        inputMode="numeric"
                        value={form[key]}
                        onChange={set(key)}
                        className="min-h-[44px]"
                      />
                      <span className="text-sm text-muted-foreground shrink-0">℃</span>
                    </div>
                    {errors[key] && <p className="text-xs text-red-500">{errors[key]}</p>}
                    <p className="text-xs text-muted-foreground">有効積算：{effective}℃/日</p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* ── 仕込み計画バッファ ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">仕込み計画バッファ日数</h3>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="brewBufferDays">バッファ日数</Label>
            <p className="text-xs text-muted-foreground">
              推奨仕込み日の計算式：在庫切れ予測日 − 熟成日数 − バッファ日数。
              完成後の品質確認・冷却・出荷準備に必要な日数を設定してください。0日で無効化。
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="brewBufferDays"
                type="number"
                step="1"
                min="0"
                max="60"
                inputMode="numeric"
                value={form.brewBufferDays}
                onChange={set('brewBufferDays')}
                className="min-h-[44px] w-28"
              />
              <span className="text-sm text-muted-foreground">日</span>
            </div>
            {errors.brewBufferDays && <p className="text-xs text-red-500">{errors.brewBufferDays}</p>}
          </div>
        </section>

        {/* ── 歩留まり率 ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">歩留まり率（桶別残量の初期値計算に使用）</h3>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="yieldRate">歩留まり率</Label>
            <p className="text-xs text-muted-foreground">仕立量に対する歩留まりの目安。桶初期重量 = 仕立量 × 歩留まり率</p>
            <div className="flex items-center gap-2">
              <Input
                id="yieldRate"
                type="number"
                step="0.1"
                min="50"
                max="100"
                inputMode="decimal"
                value={form.yieldRate}
                onChange={set('yieldRate')}
                className="min-h-[44px] w-28"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {errors.yieldRate && <p className="text-xs text-red-500">{errors.yieldRate}</p>}
          </div>
        </section>

        {/* 固定値 */}
        <div className="rounded-lg bg-muted px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">固定値（変更不可）</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
            <span className="text-muted-foreground">種水</span>
            <span className="font-medium tabular-nums">100 %</span>
            <span className="text-muted-foreground">塩</span>
            <span className="font-medium tabular-nums">0 %</span>
          </div>
        </div>

        <Button onClick={handleSave} disabled={isPending} className="min-h-[44px]">
          {isPending ? '保存中...' : '設定を保存する'}
        </Button>
      </CardContent>
    </Card>
  )
}

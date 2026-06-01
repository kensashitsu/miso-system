'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { AlertTriangle, Info } from 'lucide-react'

// ── モデル定数（無添加麦みそキャリブレーション） ─────────────────────────────
// 拘束条件:
//   ① T_peak = 165℃・日（文献値: 完成積算温度600の約28%）
//   ② B(600) / B_max = 0.30（完成時点で糖は最大値の30%）
// → r = k_mic/k_amy = 2.0 で両条件が成立
const K_AMY_BASE   = 0.00420   // /℃・日（kojiQ=6）
const K_MIC_BASE   = 0.00840   // /℃・日（aw=0.83・塩分10.9%）
const AW_BASE      = 0.83
const AW_MIN_MIC   = 0.75      // 微生物活性下限aw
const KOJI_HO_BASE = 24.1      // 無添加麦みそ基準麹歩合（割）
const PH_INITIAL   = 6.8       // 仕込み直後pH
const T_COMPLETE   = 600       // 基準完成積算温度（℃・日）
const T_MAX        = 900
const STEP         = 5
// 酵素と微生物のQ10（温度感受性の違い）
// アミラーゼ Q10≈2.0、微生物（糖消費）Q10≈4.0 の差が低温仕込みで甘味を生む
const Q10_ENZ = 2.0
const Q10_MIC = 4.0
const T_REF   = 25   // キャリブレーション基準温度（暖房℃）
// 麹歩合1割あたりの塩分変化率（高麹歩合ほど低塩：実データ近似）
const SALT_KOJI_RATE = 0.175
// 収穫窓の糖閾値
const WINDOW_SWEET   = 0.50  // 甘味重視：糖がピークの50%以上
const WINDOW_BALANCE = 0.25  // 品質バランス：糖がピークの25%以上（600℃・日付近まで含む）
// 速醸の収穫窓：糖×アミノ酸の積がこの値を超えたら閉じる（Maillard基質が過剰＝着色リスク）
const SOKKO_BA_CLOSE = 0.75
// 苦味ペプチド→アミノ酸の分解レート比（kPeptidase = kPro × R_BITTER）
// r=2 のとき苦味ピーク = ln(2)/kPro（糖ピーク計算と対称的な構造）
const R_BITTER = 2.0

// ── 型定義 ───────────────────────────────────────────────────────────────────
type ChartPoint = {
  x:        number   // 積算温度（℃・日）
  A:        number   // デンプン残存 100〜0%
  B:        number   // 糖（B_max = 100 に正規化）
  protein:  number   // タンパク質残存 100〜0%
  bitter:   number   // 苦味ペプチド（タンパク質の何%が苦味中間体として存在するか）
  AA:       number   // アミノ酸蓄積 0〜100%（二段階: タンパク質→苦味ペプチド→アミノ酸）
  pH:       number
  maillard: number   // 着色指数 0〜100（B × AA × f_aw）
}

type ModelOutput = {
  points:       ChartPoint[]
  tPeak:        number
  tAAPeak:      number    // AA=90%（タンパク質の90%がアミノ酸に変換）の積算温度（二段階モデル）
  tBitterPeak:  number    // 苦味ペプチドがピークに達する積算温度
  bitterMax:    number    // 苦味ペプチドのピーク値（%）
  bMax:         number
  aw:           number
  phFinal:      number
  windowStart:  number | null   // ℃・日
  windowEnd:    number | null
}

// ── コアモデル関数 ────────────────────────────────────────────────────────────
function fAwMaillard(aw: number): number {
  // 着色（Maillard）速度はaw≈0.77で最大・釣り鐘型
  return Math.max(0, 1 - Math.abs(aw - 0.77) / 0.15)
}

function runModel(
  kojiHo: number, saltPct: number, kojiQ: number, locTemp: number,
  bThreshold: number = WINDOW_SWEET, isSokko: boolean = false
): ModelOutput {
  const aw      = 0.99 - 0.015 * saltPct
  const kAmyBase = K_AMY_BASE * (kojiQ / 6.0) * (kojiHo / KOJI_HO_BASE)
  const fMaillard = fAwMaillard(aw)

  let kAmy: number, kMic: number, r: number, phFinal: number

  if (isSokko) {
    // 速醸：高温でアミラーゼを活性化、微生物は死滅（kMic=0）
    kAmy    = kAmyBase * Math.pow(Q10_ENZ, (locTemp - T_REF) / 10)
    kMic    = 0
    r       = 0
    phFinal = PH_INITIAL  // 微生物がいないのでpHは変化しない
  } else {
    kAmy    = kAmyBase
    kMic    = Math.max(0.0001, K_MIC_BASE * (aw - AW_MIN_MIC) / (AW_BASE - AW_MIN_MIC))
    r       = (kMic / kAmy) * Math.pow(Q10_MIC / Q10_ENZ, (locTemp - T_REF) / 10)
    phFinal = 4.5 + 0.05 * saltPct
  }

  const kPro = 0.5 * kAmy

  // Q10補正込みの有効微生物レート（r = kMic/kAmy × Q10_factor なので kMicEff = kAmy × r）
  // raw kMic ではなく kMicEff をB計算に使うことで r < 1 でも B(T) が常に非負になる
  const kMicEff = isSokko ? 0 : kAmy * r

  // タンパク質→苦味ペプチド→アミノ酸の二段階分解レート
  const kPeptidase = kPro * R_BITTER  // 苦味ペプチドの分解レート（kPro の R_BITTER 倍）

  // 糖ピーク時刻・B_max
  let tPeak: number, bMax: number
  if (isSokko) {
    // 速醸: B = 1 - exp(-kAmy×T)（単調増加、ピークなし）
    tPeak = T_MAX
    bMax  = 1
  } else if (Math.abs(r - 1) > 0.001) {
    tPeak = Math.log(r) / (kAmy * (r - 1))
    bMax  = (1 / (r - 1)) * (Math.exp(-kAmy * tPeak) - Math.exp(-kMicEff * tPeak))
  } else {
    tPeak = 1 / kAmy
    bMax  = kAmy * tPeak * Math.exp(-kAmy * tPeak)
  }

  // 苦味ピーク時刻・最大苦味（タンパク質→苦味ペプチド→アミノ酸 と同型の中間極大）
  const tBitterPeak  = Math.log(R_BITTER) / (kPro * (R_BITTER - 1))  // = ln(2)/kPro
  const bitterAtPeak = Math.max(0, (1 / (R_BITTER - 1)) * (Math.exp(-kPro * tBitterPeak) - Math.exp(-kPeptidase * tBitterPeak)))
  const bitterMax    = bitterAtPeak * 100

  const points: ChartPoint[] = []
  let windowStart: number | null = null
  let windowEnd:   number | null = null

  for (let i = 0; i <= T_MAX / STEP; i++) {
    const T = i * STEP
    const A = Math.exp(-kAmy * T)

    let Braw: number
    if (isSokko) {
      Braw = 1 - A  // 全デンプンが糖へ（微生物消費なし）
    } else if (Math.abs(r - 1) > 0.001) {
      Braw = (1 / (r - 1)) * (Math.exp(-kAmy * T) - Math.exp(-kMicEff * T))
    } else {
      Braw = kAmy * T * Math.exp(-kAmy * T)
    }

    // 苦味ペプチド（タンパク質の何%が苦味中間体として存在するか）
    const proteinFrac = Math.exp(-kPro * T)
    const bitterRaw   = Math.max(0, (1 / (R_BITTER - 1)) * (proteinFrac - Math.exp(-kPeptidase * T)))
    const bitter      = bitterRaw * 100
    // アミノ酸：二段階反応の最終生成物（= 1 - タンパク質残存 - 苦味ペプチド）
    // R_BITTER=2 のとき AA = (1 - exp(-kPro×T))² と等価
    const AAnorm  = Math.max(0, (1 - proteinFrac - bitterRaw)) * 100
    const protein = proteinFrac * 100

    const Bnorm   = Math.max(0, bMax > 0 ? (Braw / bMax) * 100 : 0)
    const C       = Math.max(0, 1 - A - Math.max(0, Braw))
    const pH      = PH_INITIAL - (PH_INITIAL - phFinal) * C
    const maillard = (Bnorm / 100) * (AAnorm / 100) * fMaillard * 100

    // 速醸は「糖×アミノ酸 > 0.75」でMaillard基質が過剰になったら収穫窓を閉じる
    const inWindow = Braw > bThreshold * bMax && AAnorm > 30 && pH >= 4.8
      && (!isSokko || (Bnorm / 100) * (AAnorm / 100) < SOKKO_BA_CLOSE)
    if (inWindow && windowStart === null) windowStart = T
    if (windowStart !== null && !inWindow && windowEnd === null) windowEnd = T

    points.push({ x: T, A: A * 100, B: Bnorm, protein, bitter, AA: AAnorm, pH, maillard })
  }

  // AA=90% は二段階モデルで (1-exp(-kPro×T))² = 0.9 → T = -ln(1-√0.9)/kPro
  const tAAPeak = -Math.log(1 - Math.sqrt(0.9)) / kPro

  return { points, tPeak, tAAPeak, tBitterPeak, bitterMax, bMax, aw, phFinal, windowStart, windowEnd }
}

// ── カスタムツールチップ ──────────────────────────────────────────────────────
function ChartTooltip({
  active, payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartPoint }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const T = Math.round(d.x)
  return (
    <div style={{
      fontSize: 12, borderRadius: 8, background: 'white',
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
      padding: '10px 14px', border: '1px solid #f0f0f0', lineHeight: 2,
    }}>
      <p style={{ fontWeight: 700, color: '#374151', marginBottom: 2 }}>
        {T} ℃・日
      </p>
      <p style={{ color: '#9CA3AF', margin: 0 }}>デンプン残存：{d.A.toFixed(1)}%</p>
      <p style={{ color: '#5DCAA5', margin: 0 }}>タンパク質残存：{d.protein.toFixed(1)}%</p>
      <p style={{ color: '#B07D47', margin: 0 }}>苦味ペプチド：{d.bitter.toFixed(1)}%</p>
      <p style={{ color: '#C8963E', margin: 0 }}>糖（相対）：{d.B.toFixed(1)}%</p>
      <p style={{ color: '#34D399', margin: 0 }}>アミノ酸蓄積：{d.AA.toFixed(1)}%</p>
      <p style={{ color: '#E07B7B', margin: 0 }}>着色指数：{d.maillard.toFixed(1)}</p>
      <p style={{ color: '#9B7FC8', margin: 0 }}>pH：{d.pH.toFixed(2)}</p>
    </div>
  )
}

// ── ステッパー入力 ────────────────────────────────────────────────────────────
function Stepper({
  label, sub, value, min, max, step, unit, decimals = 1, onChange,
}: {
  label: string; sub?: string; value: number; min: number; max: number
  step: number; unit: string; decimals?: number
  onChange: (v: number) => void
}) {
  // フォーカス中は文字列として保持し、確定時にのみ親へ通知する
  const [draft, setDraft] = useState<string | null>(null)
  const round = (v: number) => Math.round(v * 10 ** decimals) / 10 ** decimals
  const fmt   = (v: number) => decimals > 0 ? v.toFixed(decimals) : String(v)
  const commit = (raw: string) => {
    const v = parseFloat(raw)
    if (!isNaN(v)) onChange(Math.min(max, Math.max(min, round(v))))
    setDraft(null)
  }
  const btnCls = 'w-7 h-7 rounded border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-500 text-base flex items-center justify-center transition-colors select-none'
  return (
    <div className="flex items-center gap-2 py-2.5 border-b border-gray-50 last:border-b-0">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-gray-700">{label}</span>
        {sub && <span className="text-xs text-gray-400 ml-1.5">{sub}</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={() => onChange(Math.max(min, round(value - step)))} className={btnCls}>−</button>
        <input
          type="text"
          inputMode="decimal"
          value={draft !== null ? draft : fmt(value)}
          onFocus={e => { setDraft(fmt(value)); setTimeout(() => e.target.select(), 0) }}
          onChange={e => setDraft(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur() } }}
          className="w-16 text-center tabular-nums font-semibold text-sm border border-gray-200 rounded px-1 py-1 text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-violet-400 focus:border-violet-400"
        />
        <button type="button" onClick={() => onChange(Math.min(max, round(value + step)))} className={btnCls}>+</button>
        <span className="text-xs text-gray-400 w-6 shrink-0">{unit}</span>
      </div>
    </div>
  )
}

// ── メトリクスカード ──────────────────────────────────────────────────────────
function MetricCard({
  label, value, sub, diffText, diffGood,
}: {
  label:     string
  value:     string
  sub:       string
  diffText?: string
  diffGood?: boolean | null   // true=緑 false=琥珀 null=グレー
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-white shadow-sm p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold text-gray-900 mt-0.5 tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
      {diffText && (
        <p className={`text-xs mt-1 font-medium ${
          diffGood === true  ? 'text-emerald-600' :
          diffGood === false ? 'text-amber-600' :
          'text-gray-400'
        }`}>{diffText}</p>
      )}
    </div>
  )
}

// ── 原料逆算 ────────────────────────────────────────────────────────────────
// 仕立量・麹歩合・塩分%・水分目標から全原料量を計算
// 連立方程式の解析解（CLAUDE.md「試作シミュレーター」セクション参照）
function calcIngredients(
  shikomiKg: number,
  kojiHo:    number,
  saltPct:   number,
  α:         number,   // kojiRatio
  β:         number,   // soybeanRatio
  mKoji:     number,   // 麦麹含水率
  mSoy:      number,   // 蒸煮大豆水分率
  M:         number,   // 目標水分率
) {
  const R = kojiHo / 10
  const P = saltPct / 100
  const soybeanKg  = shikomiKg * (1 - P - M) / (R * α * (1 - mKoji) + β * (1 - mSoy))
  const grainKg    = R * soybeanKg
  const saltKg     = P * shikomiKg
  const kojiKg       = grainKg * α
  const mushiDaizuKg = soybeanKg * β
  const seedWaterL   = M * shikomiKg - (grainKg * α * mKoji + soybeanKg * β * mSoy)
  return { grainKg, kojiKg, soybeanKg, mushiDaizuKg, saltKg, seedWaterL }
}

// ── メインコンポーネント ──────────────────────────────────────────────────────
export default function BrewSimulator({
  baseKojiHo,
  baseSaltPct,
  hadakaMugiMoisture,
  mugiKojiMoisture,
  soybeanRawMoisture,
  steamedSoyMoisture,
  kojiRatio,
  soybeanRatio,
  targetMoisture,
  targetMoistureSampleCount,
  room1Temp,
  room2Temp,
  weatherMonthlyDailyAvg,
  weatherMonthlyTempC,
}: {
  baseKojiHo:                number
  baseSaltPct:               number
  hadakaMugiMoisture:        number
  mugiKojiMoisture:          number
  soybeanRawMoisture:        number
  steamedSoyMoisture:        number
  kojiRatio:                 number
  soybeanRatio:              number
  targetMoisture:            number
  targetMoistureSampleCount: number
  room1Temp:                 number
  room2Temp:                 number
  weatherMonthlyDailyAvg:    Record<number, number>
  weatherMonthlyTempC:       Record<number, number>
}) {
  const [kojiHo,            setKojiHo]            = useState(baseKojiHo)
  const [saltPct,           setSaltPct]           = useState(baseSaltPct)
  const [shikomiKg,         setShikomiKg]         = useState(80)
  const [targetMoisturePct, setTargetMoisturePct] = useState(
    Math.round(targetMoisture * 1000) / 10
  )
  const [selectedLocation, setSelectedLocation] = useState<'暖房' | '冷房' | '常温' | '速醸'>('暖房')
  const [brewMonth,        setBrewMonth]        = useState(() => new Date().getMonth() + 1)
  const [sokkoTemp,        setSokkoTemp]        = useState(55)
  const [linkSalt,         setLinkSalt]         = useState(true)
  const [windowMode,       setWindowMode]       = useState<'sweet' | 'balance'>('balance')

  const isSokko    = selectedLocation === '速醸'
  const bThreshold = windowMode === 'sweet' ? WINDOW_SWEET : WINDOW_BALANCE

  const handleKojiHoChange = (v: number) => {
    setKojiHo(v)
    if (linkSalt) {
      const linked = Math.round(
        Math.min(14, Math.max(5, baseSaltPct + (baseKojiHo - v) * SALT_KOJI_RATE)) * 10
      ) / 10
      setSaltPct(linked)
    }
  }

  const dailyAccum = selectedLocation === '暖房' ? room1Temp - 10
    : selectedLocation === '冷房'  ? Math.max(room2Temp - 10, 0)
    : selectedLocation === '常温'  ? (weatherMonthlyDailyAvg[brewMonth] ?? 4)
    : sokkoTemp - 10  // 速醸

  // 仕込み温度（℃）：Q10補正でrを調整するために使用
  const locTemp = selectedLocation === '暖房' ? room1Temp
    : selectedLocation === '冷房'  ? room2Temp
    : selectedLocation === '常温'  ? (weatherMonthlyTempC[brewMonth] ?? 14)
    : sokkoTemp  // 速醸

  // 速醸時はグラフ範囲を縮小（全変化が数日分に収まる）
  const chartMax = isSokko ? 300 : T_MAX

  // 出麹評価は固定（6=標準）。result・base とも同じ温度・同じモードで比較
  const result = useMemo(() => runModel(kojiHo, saltPct, 6, locTemp, bThreshold, isSokko), [kojiHo, saltPct, locTemp, bThreshold, isSokko])
  const base   = useMemo(() => runModel(baseKojiHo, baseSaltPct, 6, locTemp, bThreshold, isSokko), [baseKojiHo, baseSaltPct, locTemp, bThreshold, isSokko])

  // 仕立量が10kg以下の場合はg/mL表示
  const useGrams = shikomiKg <= 10
  const shikomiStep = shikomiKg <= 5 ? 0.5 : shikomiKg <= 50 ? 5 : shikomiKg <= 200 ? 10 : 50
  const fmtQty = (value: number, unit: string): string => {
    if (useGrams) {
      return unit === 'L'
        ? `${Math.round(value * 1000)} mL`
        : `${Math.round(value * 1000)} g`
    }
    return `${(Math.round(value * 10) / 10).toFixed(1)} ${unit}`
  }

  const tPeakRatio    = result.tPeak / T_COMPLETE
  const basePeakRatio = base.tPeak   / T_COMPLETE

  const windowWidth     = result.windowStart != null && result.windowEnd != null
    ? result.windowEnd - result.windowStart : null
  const baseWindowWidth = base.windowStart != null && base.windowEnd != null
    ? base.windowEnd - base.windowStart : null
  const windowRatio = windowWidth != null && baseWindowWidth != null
    ? windowWidth / baseWindowWidth : null

  const phDiff = result.phFinal - base.phFinal

  // 原料逆算（目標水分%をユーザー調整値で使用）
  const ingredients = useMemo(() => calcIngredients(
    shikomiKg, kojiHo, saltPct,
    kojiRatio, soybeanRatio,
    mugiKojiMoisture, steamedSoyMoisture,
    targetMoisturePct / 100,
  ), [shikomiKg, kojiHo, saltPct, kojiRatio, soybeanRatio, mugiKojiMoisture, steamedSoyMoisture, targetMoisturePct])

  // 基準配合の原料量（デンプン絶対量の比較用）
  const baseIngredients = useMemo(() => calcIngredients(
    shikomiKg, baseKojiHo, baseSaltPct,
    kojiRatio, soybeanRatio,
    mugiKojiMoisture, steamedSoyMoisture,
    targetMoisturePct / 100,
  ), [shikomiKg, baseKojiHo, baseSaltPct, kojiRatio, soybeanRatio, mugiKojiMoisture, steamedSoyMoisture, targetMoisturePct])

  // 甘味ポテンシャル = bMax比 × 穀物量比
  // bMaxは「デンプンの何割が糖になるか」の比率、grainKgは「デンプンの絶対量」を代理
  const sweetnessPotential = (base.bMax > 0 && baseIngredients.grainKg > 0)
    ? (result.bMax * ingredients.grainKg) / (base.bMax * baseIngredients.grainKg)
    : 1

  // 各原料の含水率（%表示用）
  const moisturePct = {
    grain:    hadakaMugiMoisture  * 100,
    koji:     mugiKojiMoisture    * 100,
    soybean:  soybeanRawMoisture  * 100,
    mushi:    steamedSoyMoisture  * 100,
  }

  // 「仕込む」ボタン用URL：収穫窓中央を目標積算温度に使用
  const brewTargetTempSum = result.windowStart != null && result.windowEnd != null
    ? Math.round((result.windowStart + result.windowEnd) / 2)
    : result.windowStart != null
      ? Math.round(result.windowStart * 1.2)
      : 400

  const brewUrl = (() => {
    const p = new URLSearchParams({
      prototype:     'true',
      targetTempSum: String(brewTargetTempSum),
      grainKg:       String(Math.round(ingredients.grainKg    * 10) / 10),
      kojiKg:        String(Math.round(ingredients.kojiKg     * 10) / 10),
      soybeanKg:     String(Math.round(ingredients.soybeanKg  * 10) / 10),
      saltKg:        String(Math.round(ingredients.saltKg     * 10) / 10),
      seedWaterL:    String(Math.round(ingredients.seedWaterL * 10) / 10),
      shikomiKg:     String(shikomiKg),
    })
    return `/lots/new?${p.toString()}`
  })()

  const tPeakDays = dailyAccum > 0 ? Math.round(result.tPeak / dailyAccum) : null

  // 収穫窓の警告レベル
  const isWindowNarrow = windowRatio != null && windowRatio < 0.7
  const isWindowMissing = result.windowStart === null

  // 収穫窓アニメーション（モード切替時にx1/x2を補間）
  const [animWindow, setAnimWindow] = useState<{ start: number | null; end: number | null }>({
    start: result.windowStart, end: result.windowEnd,
  })
  const animWindowRef = useRef(animWindow)
  const rafRef        = useRef<number | null>(null)

  useEffect(() => {
    const from = { ...animWindowRef.current }
    const to   = { start: result.windowStart, end: result.windowEnd }
    if (from.start === to.start && from.end === to.end) return

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)

    const DURATION  = 400
    const startTime = performance.now()
    const lerp = (a: number | null, b: number | null): number | null =>
      a != null && b != null ? a + (b - a) * (1 - (1 - Math.min(1, (performance.now() - startTime) / DURATION)) ** 3) : b

    const tick = (now: number) => {
      const t    = Math.min((now - startTime) / DURATION, 1)
      const ease = 1 - (1 - t) ** 3
      const cur  = {
        start: from.start != null && to.start != null ? from.start + (to.start - from.start) * ease : to.start,
        end:   from.end   != null && to.end   != null ? from.end   + (to.end   - from.end)   * ease : to.end,
      }
      animWindowRef.current = cur
      setAnimWindow({ ...cur })
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else        rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [result.windowStart, result.windowEnd])

  return (
    <div className="space-y-5">

      {/* ── 配合設定 × 原料逆算 2カラム統合カード ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-2">

          {/* 左：配合設定 */}
          <div className="p-5 sm:border-r border-b sm:border-b-0 border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">配合設定
              <span className="text-xs font-normal text-gray-400 ml-2">裸麦使用・水飴なし</span>
            </h2>
            <Stepper label="仕立量"
              value={shikomiKg} min={1} max={2000} step={shikomiStep} unit="kg" decimals={shikomiKg <= 5 ? 1 : 0}
              onChange={setShikomiKg} />
            <Stepper label="麹歩合" sub={`基準 ${baseKojiHo.toFixed(1)}割`}
              value={kojiHo} min={5} max={100} step={0.5} unit="割" decimals={1}
              onChange={handleKojiHoChange} />
            <div className="flex items-center gap-2 py-1">
              <Stepper label="塩分" sub={`基準 ${baseSaltPct.toFixed(1)}%`}
                value={saltPct} min={5} max={14} step={0.1} unit="%" decimals={1}
                onChange={setSaltPct} />
              <button
                type="button"
                onClick={() => setLinkSalt(v => !v)}
                title={linkSalt ? '麹歩合との連動をオフにする' : '麹歩合と連動させる'}
                className={`shrink-0 text-xs px-2 py-0.5 rounded border transition-colors ${
                  linkSalt
                    ? 'bg-violet-100 text-violet-700 border-violet-300'
                    : 'bg-gray-50 text-gray-400 border-gray-200'
                }`}
              >
                連動
              </button>
            </div>
            <Stepper
              label="目標水分"
              sub={targetMoistureSampleCount > 0
                ? `実績${targetMoistureSampleCount}件平均`
                : 'レシピ参考値'}
              value={targetMoisturePct} min={35} max={55} step={0.5} unit="%" decimals={1}
              onChange={setTargetMoisturePct} />
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2">
              <p className="text-xs text-gray-400">水分活性 aw = {result.aw.toFixed(3)}</p>
              <p className="text-xs text-gray-400">対水食塩濃度 = {(saltPct / targetMoisturePct * 100).toFixed(1)}%</p>
            </div>
          </div>

          {/* 右：原料逆算 */}
          <div className="p-5 flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-gray-700">原料逆算</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-1.5 text-xs text-gray-400 font-medium">処理前</th>
                  <th className="text-right pb-1.5 text-xs text-gray-400 font-medium">重量</th>
                  <th className="pb-1.5 w-4"></th>
                  <th className="text-left pb-1.5 text-xs text-gray-400 font-medium pl-1">処理後</th>
                  <th className="text-right pb-1.5 text-xs text-gray-400 font-medium">重量</th>
                </tr>
              </thead>
              <tbody>
                {/* 裸麦 → 麦麹 */}
                <tr className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-600">裸麦</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-900">{fmtQty(ingredients.grainKg, 'kg')}</div>
                    <div className="tabular-nums text-xs text-sky-600">水分 {moisturePct.grain.toFixed(1)}%</div>
                  </td>
                  <td className="py-1.5 text-center text-gray-300 text-xs align-top pt-2.5">→</td>
                  <td className="py-1.5 text-gray-500 pl-1">麦麹</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-700">{fmtQty(ingredients.kojiKg, 'kg')}</div>
                    <div className="tabular-nums text-xs text-sky-600">水分 {moisturePct.koji.toFixed(1)}%</div>
                  </td>
                </tr>
                {/* 大豆 → 蒸煮大豆 */}
                <tr className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-600">大豆</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-900">{fmtQty(ingredients.soybeanKg, 'kg')}</div>
                    <div className="tabular-nums text-xs text-sky-600">水分 {moisturePct.soybean.toFixed(1)}%</div>
                  </td>
                  <td className="py-1.5 text-center text-gray-300 text-xs align-top pt-2.5">→</td>
                  <td className="py-1.5 text-gray-500 pl-1">蒸煮大豆</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-700">{fmtQty(ingredients.mushiDaizuKg, 'kg')}</div>
                    <div className="tabular-nums text-xs text-sky-600">水分 {moisturePct.mushi.toFixed(1)}%</div>
                  </td>
                </tr>
                {/* 塩 */}
                <tr className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-600">塩</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-900">{fmtQty(ingredients.saltKg, 'kg')}</div>
                    <div className="text-xs text-gray-300">水分 0%</div>
                  </td>
                  <td colSpan={3} className="py-1.5 text-right text-xs text-gray-400">塩分 {saltPct.toFixed(1)}%</td>
                </tr>
                {/* 種水 */}
                <tr className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-600">種水</td>
                  <td className="py-1.5 text-right">
                    {ingredients.seedWaterL < 0
                      ? <span className="text-rose-500 text-xs">計算不可</span>
                      : <div className="tabular-nums font-semibold text-gray-900">{fmtQty(ingredients.seedWaterL, 'L')}</div>
                    }
                  </td>
                  <td colSpan={3} className="py-1.5 text-right text-xs text-gray-400">水分 {targetMoisturePct.toFixed(1)}%調整</td>
                </tr>
                {/* 仕立量合計 */}
                <tr className="border-t border-gray-200">
                  <td colSpan={2} className="pt-2 pb-1 font-semibold text-gray-700">仕立量合計</td>
                  <td></td>
                  <td colSpan={2} className="pt-2 pb-1 text-right">
                    <span className="tabular-nums font-bold text-gray-900">
                      {useGrams ? `${Math.round(shikomiKg * 1000)} g` : `${shikomiKg} kg`}
                    </span>
                    <span className="text-xs text-gray-400 ml-1.5">目標 {brewTargetTempSum}℃・日</span>
                  </td>
                </tr>
              </tbody>
            </table>

            {ingredients.seedWaterL < 0 ? (
              <p className="text-xs text-rose-600 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                原料水分が目標を超えています。塩分を増やすか麹歩合を下げてください。
              </p>
            ) : (
              <a href={brewUrl}
                className="flex items-center justify-center gap-2 w-full rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium py-2.5 transition-colors mt-auto"
              >
                この配合でロット登録へ →
              </a>
            )}
          </div>

        </div>
      </div>

      {/* ── 進行度グラフ ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
        <div className="flex flex-wrap items-center gap-2 mb-0.5">
          <h2 className="text-sm font-semibold text-gray-700">発酵進行度</h2>
          <div className="ml-auto flex rounded border border-gray-200 overflow-hidden text-xs">
            {(['暖房', '冷房', '常温', '速醸'] as const).map(loc => (
              <button
                key={loc}
                type="button"
                onClick={() => setSelectedLocation(loc)}
                className={`px-2.5 py-1 transition-colors ${
                  selectedLocation === loc
                    ? loc === '速醸' ? 'bg-rose-500 text-white' : 'bg-violet-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                {loc}
              </button>
            ))}
          </div>
          {selectedLocation === '常温' && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-500">仕込み開始月</span>
              <select
                value={brewMonth}
                onChange={e => setBrewMonth(Number(e.target.value))}
                className="border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 text-xs"
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                  <option key={m} value={m}>{m}月</option>
                ))}
              </select>
              <span className="text-gray-400">（月平均 {(weatherMonthlyTempC[brewMonth] ?? 14).toFixed(1)}℃）</span>
            </div>
          )}
          {selectedLocation === '速醸' && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-gray-500">加温温度</span>
              <select
                value={sokkoTemp}
                onChange={e => setSokkoTemp(Number(e.target.value))}
                className="border border-rose-200 rounded px-1.5 py-0.5 bg-white text-gray-700 text-xs"
              >
                {[45, 48, 50, 52, 55, 58, 60, 63, 65].map(t => (
                  <option key={t} value={t}>{t}℃</option>
                ))}
              </select>
              <span className="text-gray-400">微生物死滅・酵素のみ活性</span>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          X軸：積算温度（℃・日）{isSokko && <span className="text-rose-500 ml-1">※速醸は0〜{chartMax}℃・日表示</span>}　右Y軸：pH
          <span className={`ml-1 ${isSokko ? 'text-rose-500' : 'text-violet-600'}`}>
            {selectedLocation}（{locTemp.toFixed(0)}℃）：{dailyAccum.toFixed(1)} ℃/日換算
          </span>
        </p>

        {/* 凡例 */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-4">
          {[
            { color: '#9CA3AF', label: 'デンプン残存', dash: '4 2' },
            { color: '#5DCAA5', label: 'タンパク質残存', dash: '4 2' },
            { color: '#B07D47', label: '苦味ペプチド（中間体）', dash: '3 2' },
            { color: '#C8963E', label: '糖（甘味源）' },
            { color: '#34D399', label: 'アミノ酸（旨味源）' },
            { color: '#E07B7B', label: '着色指数', dash: '2 2' },
            { color: '#9B7FC8', label: 'pH（右軸）' },
          ].map(({ color, label, dash }) => (
            <span key={label} className="flex items-center gap-1.5 text-xs text-gray-500">
              <svg width="18" height="8" style={{ flexShrink: 0 }}>
                <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth={2} strokeDasharray={dash} />
              </svg>
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span style={{ display: 'inline-block', width: 12, height: 12, background: '#D1FAE5', border: '1px solid #6EE7B7', borderRadius: 2 }} />
            収穫窓
          </span>
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={result.points} margin={{ top: 4, right: 52, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="#F3F4F6" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, chartMax]}
              ticks={isSokko
                ? [0, 50, 100, 150, 200, 250, 300]
                : [0, 150, 300, 450, 600, 750, 900]}
              tickFormatter={v => v === 0 ? '0' : String(v)}
              tick={{ fontSize: 10, fill: '#9CA3AF' }}
              axisLine={false} tickLine={false}
            />
            <YAxis
              yAxisId="left"
              domain={[0, 110]}
              tick={{ fontSize: 10, fill: '#9CA3AF' }}
              axisLine={false} tickLine={false}
              tickFormatter={v => v === 0 ? '' : `${v}%`}
              tickCount={6}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[4.0, 7.2]}
              tick={{ fontSize: 10, fill: '#9B7FC8' }}
              axisLine={false} tickLine={false}
              tickFormatter={v => `pH${Number(v).toFixed(1)}`}
              tickCount={5}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#E5E7EB', strokeWidth: 1 }} />

            {/* 収穫窓ハイライト（アニメーション付き） */}
            {animWindow.start != null && (
              <ReferenceArea
                yAxisId="left"
                x1={animWindow.start}
                x2={animWindow.end ?? T_MAX}
                fill="#D1FAE5"
                fillOpacity={0.55}
                stroke="#6EE7B7"
                strokeWidth={0.5}
              />
            )}

            {/* 縦線：基準完成（600℃・日） */}
            <ReferenceLine
              yAxisId="left" x={T_COMPLETE}
              stroke="#CBD5E1" strokeDasharray="3 3"
              label={{ value: '600', position: 'insideTopRight', fontSize: 9, fill: '#94A3B8' }}
            />
            {/* 縦線：基準の糖ピーク */}
            {Math.abs(result.tPeak - base.tPeak) > 12 && (
              <ReferenceLine
                yAxisId="left" x={base.tPeak}
                stroke="#FCD34D" strokeDasharray="2 3" strokeWidth={1}
                label={{ value: '基準糖ピーク', position: 'insideTopLeft', fontSize: 9, fill: '#F59E0B' }}
              />
            )}
            {/* 縦線：現在の糖ピーク */}
            <ReferenceLine
              yAxisId="left" x={result.tPeak}
              stroke="#F59E0B" strokeWidth={1.5}
              label={{ value: '糖ピーク', position: 'insideTopRight', fontSize: 9, fill: '#F59E0B' }}
            />
            {/* 縦線：苦味ペプチドピーク */}
            {result.tBitterPeak <= chartMax && (
              <ReferenceLine
                yAxisId="left" x={result.tBitterPeak}
                stroke="#B07D47" strokeWidth={1} strokeDasharray="2 3"
                label={{ value: '苦味ピーク', position: 'insideTopRight', fontSize: 9, fill: '#B07D47' }}
              />
            )}
            {/* 縦線：アミノ酸ピーク（AA=90%、グラフ範囲内のみ表示） */}
            {result.tAAPeak <= chartMax && (
              <ReferenceLine
                yAxisId="left" x={result.tAAPeak}
                stroke="#34D399" strokeWidth={1.5}
                label={{ value: 'アミノ酸ピーク', position: 'insideTopLeft', fontSize: 9, fill: '#34D399' }}
              />
            )}
            {/* 横線：pH下限 */}
            <ReferenceLine
              yAxisId="right" y={4.8}
              stroke="#FCA5A5" strokeDasharray="2 3" strokeWidth={1}
              label={{ value: '4.8', position: 'right', fontSize: 9, fill: '#FCA5A5' }}
            />

            <Line yAxisId="left"  dataKey="A"        stroke="#9CA3AF" strokeWidth={1.5} strokeDasharray="4 2" dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="protein"  stroke="#5DCAA5" strokeWidth={1.5} strokeDasharray="4 2" dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="bitter"   stroke="#B07D47" strokeWidth={1.5} strokeDasharray="3 2" dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="B"        stroke="#C8963E" strokeWidth={2}   dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="AA"       stroke="#34D399" strokeWidth={2}   dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="maillard" stroke="#E07B7B" strokeWidth={1.5} strokeDasharray="2 2" dot={false} animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="right" dataKey="pH"       stroke="#9B7FC8" strokeWidth={1.5} dot={false} animationDuration={400} animationEasing="ease-out" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── 収穫窓モード切替 + アラート ── */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">収穫窓モード</span>
        <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setWindowMode('balance')}
            className={`px-3 py-1.5 transition-colors ${windowMode === 'balance' ? 'bg-violet-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
          >
            品質バランス
          </button>
          <button
            type="button"
            onClick={() => setWindowMode('sweet')}
            className={`px-3 py-1.5 transition-colors ${windowMode === 'sweet' ? 'bg-violet-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
          >
            甘味重視
          </button>
        </div>
        <span className="text-xs text-gray-400">
          {windowMode === 'balance' ? '糖 ≥ 25%（実際の完成タイミングに対応）' : '糖 ≥ 50%（甘味のピーク付近）'}
        </span>
      </div>

      {isWindowMissing ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>この配合では収穫窓が検出されませんでした。塩分を上げるか麹歩合を下げてください。</span>
        </div>
      ) : (
        <div className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          isWindowNarrow
            ? 'bg-amber-50 border border-amber-200 text-amber-800'
            : 'bg-emerald-50 border border-emerald-200 text-emerald-800'
        }`}>
          {isWindowNarrow
            ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            : <Info className="h-4 w-4 shrink-0 mt-0.5" />
          }
          <div>
            <span className="font-medium">収穫窓：</span>
            {result.windowStart}〜{result.windowEnd ?? '（範囲内で終了せず）'} ℃・日
            {result.windowStart != null && dailyAccum > 0 && (
              <span className="ml-1 text-xs">
                （約 {Math.round(result.windowStart / dailyAccum)}〜{result.windowEnd != null ? Math.round(result.windowEnd / dailyAccum) : '—'} 日・{selectedLocation}）
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── サマリーカード ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="糖ピーク"
          value={`${Math.round(result.tPeak)} ℃・日`}
          sub={`${selectedLocation}約${tPeakDays ?? '—'}日`}
          diffText={
            Math.abs(tPeakRatio - basePeakRatio) > 0.01
              ? `基準比 ${tPeakRatio > basePeakRatio ? '+' : ''}${((tPeakRatio - basePeakRatio) * 100).toFixed(0)}%`
              : '基準と同等'
          }
          diffGood={null}
        />
        <MetricCard
          label="最終pH（到達下限）"
          value={result.phFinal.toFixed(2)}
          sub={result.phFinal < 4.8 ? '酸味が強くなる' : result.phFinal < 5.0 ? 'やや酸味あり' : '穏やかな酸味'}
          diffText={`基準比 ${phDiff >= 0 ? '+' : ''}${phDiff.toFixed(2)}`}
          diffGood={phDiff >= 0 ? true : false}
        />
        <MetricCard
          label="甘味ポテンシャル"
          value={`${sweetnessPotential.toFixed(2)}倍`}
          sub="最大糖産生量 × 穀物量（デンプン絶対量）基準比"
          diffText={sweetnessPotential > 1 ? `+${((sweetnessPotential - 1) * 100).toFixed(0)}%` : `${((sweetnessPotential - 1) * 100).toFixed(0)}%`}
          diffGood={sweetnessPotential >= 1 ? true : false}
        />
        <MetricCard
          label="収穫窓の広さ"
          value={windowWidth != null ? `${windowWidth} ℃・日` : '—'}
          sub={windowRatio != null ? `基準比 ${(windowRatio * 100).toFixed(0)}%` : '窓が開かない'}
          diffText={isWindowMissing ? '条件未達' : isWindowNarrow ? 'タイミングがシビア' : '余裕あり'}
          diffGood={isWindowMissing ? false : isWindowNarrow ? false : true}
        />
      </div>

      {/* ── モデル注記 ── */}
      <div className="text-xs text-muted-foreground bg-gray-50/70 rounded-lg p-4 space-y-1 border border-gray-100">
        <p className="font-medium text-gray-600">モデルの前提と限界</p>
        <p>キャリブレーション基準：無添加麦みそ（麹歩合 {baseKojiHo.toFixed(1)}割・塩分 {baseSaltPct.toFixed(1)}%・目標 600 ℃・日）</p>
        <p>A→B→C連続反応（デンプン→糖→酸・アルコール）とアミノ酸蓄積の並行反応モデル。精度±30〜50%を前提に傾向把握の目的でご利用ください。</p>
        <p>収穫窓の定義：糖 ≥ {windowMode === 'sweet' ? '50' : '25'}%（相対）かつアミノ酸蓄積 ≥ 30%（タンパク質残存 ≤ 70%）かつ pH ≥ 4.8。「品質バランス」モードは無添加麦みそ等の実際の仕上がりタイミング（600℃・日付近）に対応。</p>
        <p>苦味ペプチド：タンパク質→苦味ペプチド→アミノ酸の二段階反応モデル。苦味は熟成中期にピークを持ち、その後アミノ酸（旨味）へ分解される。麹歩合が高いほど苦味ピークが早く・高くなるが解消も速い。</p>
        <p>アミノ酸ピーク：二段階モデルでAA=90%に達する時点（旧一段階モデルより約30%遅い）。麹歩合が低い場合はグラフ範囲外になることがあります。</p>
        <p>場所による影響：アミラーゼ Q10≈2.0・微生物 Q10≈4.0 の差を反映。低温ほど微生物が相対的に減速し糖が長く残る（収穫窓が広がる・甘味が出やすい）。暖房25℃をキャリブレーション基準とした近似値。</p>
        <p>速醸モード：50〜60℃の加温でアミラーゼを最大活性化・微生物を死滅させ数日で糖化を完了させる手法（西京みそ等）。kMic=0・pH変化なし。B線は単調増加（ピークなし）。収穫窓は糖×アミノ酸の積 ≥ {SOKKO_BA_CLOSE}（Maillard基質が過剰になる時点）で閉じる。グラフ範囲は0〜300℃・日（約2〜7日相当）。</p>
      </div>
    </div>
  )
}

'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { AlertTriangle } from 'lucide-react'
import {
  T_COMPLETE, T_MAX, SALT_KOJI_RATE, WINDOW_SWEET, WINDOW_BALANCE, SOKKO_BA_CLOSE,
  KOME_KOJI_HO_BASE, KOME_SALT_PCT_BASE, KOME_T_COMPLETE,
  runModel,
  type GrainType, type ChartPoint,
} from './modelCore'

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
      <p style={{ color: '#6B8FBF', margin: 0 }}>アルコール（推定）：{d.alcohol.toFixed(1)}%</p>
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

// ── 仕上がりプロファイル帯 ────────────────────────────────────────────────────
// 収穫窓中央で評価した味の傾向を、基準配合（＝中央50%）からの差分で一望する。
type TasteDir = 'high-good' | 'low-good' | 'neutral'
interface TasteAxis {
  key:     string
  label:   string
  raw:     number   // この配合の絶対値
  baseRaw: number   // 基準配合の絶対値
  dir:     TasteDir // high-good=多いほど良い / low-good=少ないほど良い / neutral=中立
}

function ProfileBand({
  axes, headline, tone,
}: {
  axes:     TasteAxis[]
  headline: string
  tone:     'good' | 'warn' | 'bad'
}) {
  const toneCls = tone === 'bad'
    ? 'bg-rose-50 border-rose-200 text-rose-800'
    : tone === 'warn'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <h2 className="text-sm font-semibold text-gray-700">仕上がりプロファイル</h2>
        <span className="text-xs text-gray-400">収穫窓中央で評価・┃＝標準みそ（麹歩合10割）</span>
      </div>
      <div className={`rounded-lg border px-3 py-2 text-sm ${toneCls}`}>{headline}</div>
      <div className="space-y-2.5">
        {axes.map(a => {
          const ratio = a.baseRaw > 0 ? a.raw / a.baseRaw : 1
          // 対数目盛：標準みそ(ratio=1)を中央50%に置き、2倍/半分ごとに±25%動く。
          // 自社定番は標準比2〜2.5倍まで振れるため、線形(2倍で頭打ち)だと端で潰れる。
          const fill  = ratio > 0 ? Math.max(0, Math.min(100, 50 + 25 * Math.log2(ratio))) : 0
          const pct   = Math.round((ratio - 1) * 100)
          const level = fill < 20 ? '弱い' : fill < 40 ? 'やや弱い' : fill < 60 ? '中程度' : fill < 80 ? 'やや強い' : '強い'
          // 差分の善し悪し：high-goodは増で緑・low-goodは減で緑・neutralはグレー
          const better = a.dir === 'high-good' ? pct > 0 : a.dir === 'low-good' ? pct < 0 : null
          const barColor = a.dir === 'neutral' ? '#9CA3AF'
            : better === true  ? '#10B981'
            : better === false ? '#F59E0B'
            : '#9CA3AF'
          const pctColor = Math.abs(pct) < 1 ? 'text-gray-400'
            : better === true  ? 'text-emerald-600'
            : better === false ? 'text-amber-600'
            : 'text-gray-400'
          return (
            <div key={a.key} className="flex items-center gap-2 sm:gap-3">
              <span className="text-sm text-gray-700 w-9 shrink-0">{a.label}</span>
              <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden relative">
                <div className="h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${fill}%`, backgroundColor: barColor, opacity: 0.72 }} />
                <div className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-gray-500 z-10" style={{ left: '50%' }} />
              </div>
              <span className="text-xs text-gray-500 w-14 shrink-0 text-right">{level}</span>
              <span className={`text-xs font-medium w-11 shrink-0 text-right tabular-nums ${pctColor}`}>
                {Math.abs(pct) < 1 ? '±0%' : pct > 0 ? `+${pct}%` : `${pct}%`}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-400">
        バーは一般的な標準みそ（麹歩合10割・塩分11%）を中央50%に置いた対数目盛（2倍/半分ごとに±25%）。無添加麦みそ（24.1割）など麹多めの配合は甘味・旨味が右に振れる。苦味・焦げは低いほど良い軸として、標準より低いと緑・高いと琥珀で表示（精度±30〜50%の傾向把握）。
      </p>
    </div>
  )
}

// ── ライン設定（凡例・グラフ共通） ───────────────────────────────────────────
type DotShape = 'circle' | 'diamond' | 'triangle' | 'square' | null

const LINE_CONFIG = [
  { key: 'A',        color: '#9CA3AF', label: 'デンプン残存',           dash: '4 2',    shape: null       as DotShape, sw: 1.2, axis: 'left'  as const },
  { key: 'protein',  color: '#5DCAA5', label: 'タンパク質残存',         dash: '4 2',    shape: null       as DotShape, sw: 1.2, axis: 'left'  as const },
  { key: 'bitter',   color: '#B07D47', label: '苦味ペプチド（中間体）', dash: '3 2',    shape: 'diamond'  as DotShape, sw: 1.5, axis: 'left'  as const },
  { key: 'B',        color: '#C8963E', label: '糖（甘味源）',           dash: undefined, shape: 'circle'  as DotShape, sw: 2.5, axis: 'left'  as const },
  { key: 'AA',       color: '#34D399', label: 'アミノ酸（旨味源）',     dash: undefined, shape: 'triangle' as DotShape, sw: 2.5, axis: 'left'  as const },
  { key: 'alcohol',  color: '#6B8FBF', label: 'アルコール（推定）',     dash: '2 3',    shape: 'square'  as DotShape, sw: 1.5, axis: 'left'  as const },
  { key: 'maillard', color: '#E07B7B', label: '着色指数',               dash: '2 2',    shape: null       as DotShape, sw: 1.2, axis: 'left'  as const },
  { key: 'pH',       color: '#9B7FC8', label: 'pH（右軸）',             dash: undefined, shape: null      as DotShape, sw: 1.5, axis: 'right' as const },
]

// 凡例・グラフのマーカー描画（中心座標を受け取りSVG要素を返す）
function renderMarker(shape: DotShape, color: string, cx: number, cy: number, k: string) {
  if (shape === 'circle')
    return <circle key={k} cx={cx} cy={cy} r={4} fill={color} stroke="white" strokeWidth={1.5} />
  if (shape === 'diamond')
    return <polygon key={k} points={`${cx},${cy-5} ${cx+4},${cy} ${cx},${cy+5} ${cx-4},${cy}`} fill={color} stroke="white" strokeWidth={1} />
  if (shape === 'triangle')
    return <polygon key={k} points={`${cx},${cy-5} ${cx+4.5},${cy+3} ${cx-4.5},${cy+3}`} fill={color} stroke="white" strokeWidth={1} />
  if (shape === 'square')
    return <rect key={k} x={cx-3.5} y={cy-3.5} width={7} height={7} fill={color} stroke="white" strokeWidth={1} />
  return null
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
  mKoji:     number,   // 麹含水率
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

// 種水（seedWaterL）が「計算不可」（負値）にならないための水分%マージン
const SEED_WATER_MARGIN_PCT = 0.5

// 種水=0で達成される水分率（麹＋蒸煮大豆＋塩のみの加重平均）
// 目標水分%がこれを下回ると種水が負値になり「計算不可」になる
function calcMinMoisturePct(
  kojiHo: number, saltPct: number, α: number, β: number, mKoji: number, mSoy: number,
): number {
  const R = kojiHo / 10
  const P = saltPct / 100
  const weighted = (R * α * mKoji + β * mSoy) / (R * α + β)
  return (1 - P) * weighted * 100
}

// 仕上がりプロファイル・各カードの比較基準となる「標準みそ」の麹歩合（世間一般＝10割）。
// ※モデルのキャリブレーション基準（無添加麦みそ24.1割・K_AMY_BASEの定義点）とは別物。
//   24.1割を中央に据えると、24.1は世間的に麹多め（甘口）の部類のため"ふつう"が世の中の
//   感覚からずれる。そこで比較の中央値（50%）だけを一般的な10割に固定する。
const STANDARD_KOJI_HO  = 10
// 標準みその塩分（一般的なみそ＝11%固定。麹歩合連動ではなく世間一般の値とする）
const STANDARD_SALT_PCT = 11

// ── メインコンポーネント ──────────────────────────────────────────────────────
export default function BrewSimulator({
  baseKojiHo,
  baseSaltPct,
  hadakaMugiMoisture,
  mugiKojiMoisture,
  komeMoisture,
  komeKojiMoisture,
  soybeanRawMoisture,
  steamedSoyMoisture,
  kojiRatio,
  komeKojiRatio,
  soybeanRatio,
  targetMoisture,
  targetMoistureSampleCount,
  targetMoistureSuimai,
  targetMoistureShirome,
  room1Temp,
  room2Temp,
  weatherMonthlyDailyAvg,
  weatherMonthlyTempC,
  baseKojiHoSuimai,
  baseSaltPctSuimai,
  baseKojiHoShirome,
  baseSaltPctShirome,
}: {
  baseKojiHo:                number
  baseSaltPct:               number
  hadakaMugiMoisture:        number
  mugiKojiMoisture:          number
  komeMoisture:              number
  komeKojiMoisture:          number
  soybeanRawMoisture:        number
  steamedSoyMoisture:        number
  kojiRatio:                 number
  komeKojiRatio:             number
  soybeanRatio:              number
  targetMoisture:            number
  targetMoistureSampleCount: number
  targetMoistureSuimai:      number
  targetMoistureShirome:     number
  room1Temp:                 number
  room2Temp:                 number
  weatherMonthlyDailyAvg:    Record<number, number>
  weatherMonthlyTempC:       Record<number, number>
  baseKojiHoSuimai:          number
  baseSaltPctSuimai:         number
  baseKojiHoShirome:         number
  baseSaltPctShirome:        number
}) {
  const [grainType,          setGrainType]          = useState<GrainType>('裸麦')
  const [kojiHo,             setKojiHo]             = useState(baseKojiHo)
  const [saltPct,            setSaltPct]            = useState(baseSaltPct)
  const [shikomiKg,          setShikomiKg]          = useState(80)
  const [targetMoisturePct,  setTargetMoisturePct]  = useState(
    Math.round(targetMoisture * 1000) / 10
  )
  const [selectedLocation, setSelectedLocation] = useState<'暖房' | '冷房' | '常温' | '速醸'>('暖房')
  const [brewMonth,        setBrewMonth]        = useState(() => new Date().getMonth() + 1)
  const [sokkoTemp,        setSokkoTemp]        = useState(55)
  const [linkSalt,         setLinkSalt]         = useState(true)
  const [windowMode,       setWindowMode]       = useState<'sweet' | 'balance'>('balance')
  const [hiddenLines,      setHiddenLines]      = useState<Set<string>>(new Set())
  const toggleLine = (key: string) => setHiddenLines(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // ── 品種別キャリブレーション値 ──
  const currentBaseKojiHo  = grainType === '裸麦' ? baseKojiHo  : grainType === '砕米' ? baseKojiHoSuimai  : grainType === '普通米' ? KOME_KOJI_HO_BASE  : baseKojiHoShirome
  const currentBaseSaltPct = grainType === '裸麦' ? baseSaltPct : grainType === '砕米' ? baseSaltPctSuimai : grainType === '普通米' ? KOME_SALT_PCT_BASE : baseSaltPctShirome
  const currentGrainMoisture = grainType === '裸麦' ? hadakaMugiMoisture : komeMoisture
  const currentKojiMoisture  = grainType === '裸麦' ? mugiKojiMoisture   : komeKojiMoisture
  const currentKojiRatioCalc = grainType === '裸麦' ? kojiRatio          : komeKojiRatio
  const currentKojiLabel     = grainType === '裸麦' ? '麦麹' : '米麹'
  // 品種別目標積算温度（グラフ基準線・evalTフォールバック用）
  const currentTComplete        = grainType === '裸麦' ? 600 : grainType === '砕米' ? 550 : grainType === '普通米' ? KOME_T_COMPLETE : 70
  // 収穫窓のタンパク質残存閾値: 無洗米（白みそ）は甘味主体で苦味解消不要のため緩和
  const currentProteinThreshold = grainType === '無洗米' ? 85 : 70
  // 品種別サンプルカウント（裸麦のみ実績あり）
  const currentSampleCount   = grainType === '裸麦' ? targetMoistureSampleCount : 0

  // ── 穀物種別切り替え ──
  const handleGrainTypeChange = (newGrain: GrainType) => {
    const newBaseKojiHo  = newGrain === '裸麦' ? baseKojiHo  : newGrain === '砕米' ? baseKojiHoSuimai  : newGrain === '普通米' ? KOME_KOJI_HO_BASE  : baseKojiHoShirome
    const newBaseSaltPct = newGrain === '裸麦' ? baseSaltPct : newGrain === '砕米' ? baseSaltPctSuimai : newGrain === '普通米' ? KOME_SALT_PCT_BASE : baseSaltPctShirome
    // 普通米は自社実績データがないため、麹歩合の近い山吹みそ実績値を目標水分の参考値として流用
    const newTargetM     = newGrain === '裸麦' ? targetMoisture : newGrain === '無洗米' ? targetMoistureShirome : targetMoistureSuimai
    // 米系（砕米・無洗米・普通米）は実績平均が「種水=0で達成される水分率」を下回ることがあり、
    // その場合は種水が負値（計算不可）になるため下限+マージンに補正する
    const newKojiMoisture  = newGrain === '裸麦' ? mugiKojiMoisture : komeKojiMoisture
    const newKojiRatioCalc = newGrain === '裸麦' ? kojiRatio         : komeKojiRatio
    const minMoisturePct = newGrain === '裸麦' ? 0
      : calcMinMoisturePct(newBaseKojiHo, newBaseSaltPct, newKojiRatioCalc, soybeanRatio, newKojiMoisture, steamedSoyMoisture)
    const targetPct = Math.max(newTargetM * 100, minMoisturePct + SEED_WATER_MARGIN_PCT)
    setGrainType(newGrain)
    setKojiHo(newBaseKojiHo)
    setSaltPct(newBaseSaltPct)
    setTargetMoisturePct(Math.round(Math.max(25, Math.min(55, targetPct)) * 10) / 10)
  }

  const isSokko     = selectedLocation === '速醸'
  const bThreshold  = windowMode === 'sweet' ? WINDOW_SWEET : WINDOW_BALANCE
  const dotInterval = isSokko ? 10 : 30

  // 無洗米の目標積算温度（70℃・日）は速醸専用。速醸以外では目標未確立のため null
  const effectiveTComplete: number | null = (grainType === '無洗米' && !isSokko) ? null : currentTComplete

  const handleKojiHoChange = (v: number) => {
    setKojiHo(v)
    if (linkSalt) {
      const linked = Math.round(
        Math.min(16, Math.max(1, currentBaseSaltPct + (currentBaseKojiHo - v) * SALT_KOJI_RATE)) * 10
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
  const currentChartMax = isSokko ? 300 : T_MAX
  const currentTicks    = isSokko
    ? [0, 50, 100, 150, 200, 250, 300]
    : [0, 150, 300, 450, 600, 750, 900]

  // 比較基準＝標準みそ（麹歩合10割・塩分11%固定）。
  // ※runModelの kojiHoBase 引数は currentBaseKojiHo（=無添加麦24.1割のキャリブレーション
  //   正規化点）のまま。標準みそは「10割・11%の配合をモデルで評価した推計値」であり、
  //   モデルの反応速度アンカーは動かさない。
  const stdSaltPct = STANDARD_SALT_PCT

  // 出麹評価は固定（6=標準）。result・base とも同じ温度・同じモードで比較
  const result = useMemo(
    () => runModel(kojiHo, saltPct, 6, locTemp, bThreshold, isSokko, currentBaseKojiHo, currentTComplete, currentProteinThreshold),
    [kojiHo, saltPct, locTemp, bThreshold, isSokko, currentBaseKojiHo, currentTComplete, currentProteinThreshold]
  )
  const base = useMemo(
    () => runModel(STANDARD_KOJI_HO, stdSaltPct, 6, locTemp, bThreshold, isSokko, currentBaseKojiHo, currentTComplete, currentProteinThreshold),
    [stdSaltPct, locTemp, bThreshold, isSokko, currentBaseKojiHo, currentTComplete, currentProteinThreshold]
  )

  // グラフ用データ：表示範囲外を除外して XAxis のスケール計算を正確にする
  const chartPoints = useMemo(
    () => result.points.filter(p => p.x <= currentChartMax),
    [result.points, currentChartMax]
  )

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

  const tPeakRatio    = effectiveTComplete != null ? result.tPeak / effectiveTComplete : null
  const basePeakRatio = effectiveTComplete != null ? base.tPeak   / effectiveTComplete : null

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
    currentKojiRatioCalc, soybeanRatio,
    currentKojiMoisture, steamedSoyMoisture,
    targetMoisturePct / 100,
  ), [shikomiKg, kojiHo, saltPct, currentKojiRatioCalc, soybeanRatio, currentKojiMoisture, steamedSoyMoisture, targetMoisturePct])

  // 標準みそ（麹歩合10割）の原料量（甘味＝穀物量・旨味＝大豆量の絶対量比較用）
  const baseIngredients = useMemo(() => calcIngredients(
    shikomiKg, STANDARD_KOJI_HO, stdSaltPct,
    currentKojiRatioCalc, soybeanRatio,
    currentKojiMoisture, steamedSoyMoisture,
    targetMoisturePct / 100,
  ), [shikomiKg, stdSaltPct, currentKojiRatioCalc, soybeanRatio, currentKojiMoisture, steamedSoyMoisture, targetMoisturePct])

  // 甘味ポテンシャル = bMax比 × 穀物量比
  // bMaxは「デンプンの何割が糖になるか」の比率、grainKgは「デンプンの絶対量」を代理
  const sweetnessPotential = (base.bMax > 0 && baseIngredients.grainKg > 0)
    ? (result.bMax * ingredients.grainKg) / (base.bMax * baseIngredients.grainKg)
    : 1

  // 各原料の含水率（%表示用）
  const moisturePct = {
    grain:    currentGrainMoisture  * 100,
    koji:     currentKojiMoisture   * 100,
    soybean:  soybeanRawMoisture    * 100,
    mushi:    steamedSoyMoisture    * 100,
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

  const tPeakDays = (result.sugarPeakT != null && dailyAccum > 0)
    ? Math.round(result.sugarPeakT / dailyAccum) : null

  // 収穫窓の警告レベル
  const isWindowNarrow = windowRatio != null && windowRatio < 0.7
  const isWindowMissing = result.windowStart === null

  // ── 仕上がりプロファイル帯（収穫窓中央で評価・基準配合＝中央50%） ──
  const tasteAxes: TasteAxis[] = [
    // 甘味＝最大糖産生量(bMax)×穀物量（デンプン絶対量）。甘味ポテンシャルと同じ指標
    { key: 'sweet',  label: '甘味', raw: result.bMax * ingredients.grainKg, baseRaw: base.bMax * baseIngredients.grainKg, dir: 'high-good' },
    // 旨味＝アミノ酸蓄積率×大豆量（タンパク質絶対量）。甘味と対称にし、低麹歩合で大豆が
    // 増える分（＝タンパク源増）を織り込む。効率のみだと低麹歩合の旨味を過小評価するため
    { key: 'umami',  label: '旨味', raw: result.umamiAt * ingredients.soybeanKg, baseRaw: base.umamiAt * baseIngredients.soybeanKg, dir: 'high-good' },
    { key: 'bitter', label: '苦味', raw: result.bitterAt,     baseRaw: base.bitterAt,     dir: 'low-good'  },
    { key: 'sour',   label: '酸味', raw: result.aromaSour,    baseRaw: base.aromaSour,    dir: 'neutral'   },
    { key: 'roast',  label: '焦げ', raw: result.aromaRoasted, baseRaw: base.aromaRoasted, dir: 'low-good'  },
  ]
  const windowDaysStr = result.windowStart != null && dailyAccum > 0
    ? `仕込みから約${Math.round(result.windowStart / dailyAccum)}〜${result.windowEnd != null ? Math.round(result.windowEnd / dailyAccum) : '—'}日（${selectedLocation}${selectedLocation === '常温' ? `${brewMonth}月` : ''}）が狙い目`
    : null
  const profileHeadline = isWindowMissing
    ? 'この配合では収穫窓が検出されませんでした。塩分を上げるか麹歩合を下げてください。'
    : `${windowDaysStr ?? `収穫窓 ${result.windowStart}〜${result.windowEnd ?? '—'} ℃・日`}／収穫窓の余裕：${isWindowNarrow ? 'シビア（タイミングが狭い）' : '余裕あり'}`
  const profileTone: 'good' | 'warn' | 'bad' = isWindowMissing ? 'bad' : isWindowNarrow ? 'warn' : 'good'

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

      {/* ── 2カラム：左=操作パネル（PCではsticky）/ 右=ライブ結果。配合を変えると右が即変化 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,360px)_1fr] gap-5 items-start">

        {/* ── 左：操作パネル ── */}
        <div className="lg:sticky lg:top-4 space-y-4">

          {/* 配合設定カード */}
          <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">配合設定
              <span className="text-xs font-normal text-gray-400 ml-2">{grainType}使用・水飴なし</span>
            </h2>

            {/* 穀物種別選択 */}
            <div className="flex items-center gap-2 py-2 border-b border-gray-50 mb-1">
              <span className="text-sm text-gray-700 flex-1">穀物</span>
              <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
                {(['裸麦', '砕米', '無洗米', '普通米'] as const).map(grain => (
                  <button
                    key={grain}
                    type="button"
                    onClick={() => handleGrainTypeChange(grain)}
                    className={`px-2.5 py-1.5 transition-colors ${
                      grainType === grain
                        ? 'bg-violet-600 text-white'
                        : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {grain}
                  </button>
                ))}
              </div>
            </div>

            {/* 非裸麦の注意書き */}
            {grainType !== '裸麦' && (
              <div className="mb-2 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded p-2 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {grainType === '砕米'
                    ? '砕米は粒子の細かさでアミラーゼ反応速度が裸麦モデルとずれる可能性があります。定性的傾向の参考としてご利用ください。'
                    : grainType === '普通米'
                      ? '普通米は自社の製造実績データがなく、基準麹歩合・目標積算温度（800℃・日）は一般的な目安値の仮置きです。試作結果に応じて今後調整します。'
                      : 'コアモデルは裸麦ベースのキャリブレーションです。定性的傾向の参考としてご利用ください。'}
                </span>
              </div>
            )}

            <Stepper label="仕立量"
              value={shikomiKg} min={1} max={2000} step={shikomiStep} unit="kg" decimals={shikomiKg <= 5 ? 1 : 0}
              onChange={setShikomiKg} />
            <Stepper label="麹歩合" sub={`基準 ${currentBaseKojiHo.toFixed(1)}割`}
              value={kojiHo} min={5} max={100} step={0.5} unit="割" decimals={1}
              onChange={handleKojiHoChange} />
            <div className="flex items-center gap-2 py-1">
              <Stepper label="塩分" sub={`基準 ${currentBaseSaltPct.toFixed(1)}%`}
                value={saltPct} min={1} max={16} step={0.1} unit="%" decimals={1}
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
              sub={currentSampleCount > 0
                ? `実績${currentSampleCount}件平均`
                : 'レシピ参考値'}
              value={targetMoisturePct} min={25} max={55} step={0.5} unit="%" decimals={1}
              onChange={setTargetMoisturePct} />
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2">
              <p className="text-xs text-gray-400">水分活性 aw = {result.aw.toFixed(3)}</p>
              <p className="text-xs text-gray-400">対水食塩濃度 = {(saltPct / targetMoisturePct * 100).toFixed(1)}%</p>
            </div>

            {/* 仕込み場所・収穫窓モード（結果を左右する入力なのでここに集約） */}
            <div className="border-t border-gray-100 mt-4 pt-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-14 shrink-0">仕込み場所</span>
                <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
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
              </div>
              {selectedLocation === '常温' && (
                <div className="flex items-center gap-1.5 text-xs pl-16">
                  <select
                    value={brewMonth}
                    onChange={e => setBrewMonth(Number(e.target.value))}
                    className="border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 text-xs"
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                      <option key={m} value={m}>{m}月</option>
                    ))}
                  </select>
                  <span className="text-gray-400">月平均 {(weatherMonthlyTempC[brewMonth] ?? 14).toFixed(1)}℃</span>
                </div>
              )}
              {selectedLocation === '速醸' && (
                <div className="flex items-center gap-1.5 text-xs pl-16">
                  <select
                    value={sokkoTemp}
                    onChange={e => setSokkoTemp(Number(e.target.value))}
                    className="border border-rose-200 rounded px-1.5 py-0.5 bg-white text-gray-700 text-xs"
                  >
                    {[45, 48, 50, 52, 55, 58, 60, 63, 65].map(t => (
                      <option key={t} value={t}>{t}℃</option>
                    ))}
                  </select>
                  <span className="text-gray-400">微生物死滅・酵素のみ</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-14 shrink-0">収穫窓</span>
                <div className="flex rounded border border-gray-200 overflow-hidden text-xs">
                  <button
                    type="button"
                    onClick={() => setWindowMode('balance')}
                    className={`px-3 py-1 transition-colors ${windowMode === 'balance' ? 'bg-violet-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                  >
                    品質バランス
                  </button>
                  <button
                    type="button"
                    onClick={() => setWindowMode('sweet')}
                    className={`px-3 py-1 transition-colors ${windowMode === 'sweet' ? 'bg-violet-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                  >
                    甘味重視
                  </button>
                </div>
              </div>
            </div>
          </div>{/* /配合設定カード */}

          {/* 原料逆算カード */}
          <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5 flex flex-col gap-3">
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
                {/* 穀物 → 麹 */}
                <tr className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-600">{grainType}</td>
                  <td className="py-1.5 text-right">
                    <div className="tabular-nums font-semibold text-gray-900">{fmtQty(ingredients.grainKg, 'kg')}</div>
                    <div className="tabular-nums text-xs text-sky-600">水分 {moisturePct.grain.toFixed(1)}%</div>
                  </td>
                  <td className="py-1.5 text-center text-gray-300 text-xs align-top pt-2.5">→</td>
                  <td className="py-1.5 text-gray-500 pl-1">{currentKojiLabel}</td>
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
          </div>{/* /原料逆算カード */}

        </div>{/* ── 左：操作パネル ここまで ── */}

        {/* ── 右：ライブ結果（発酵進行度グラフ＋仕上がりプロファイル） ── */}
        <div className="space-y-5 min-w-0">

      {/* ── 発酵進行度グラフ（メイン） ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
        <div className="flex flex-wrap items-center gap-2 mb-0.5">
          <h2 className="text-sm font-semibold text-gray-700">発酵進行度</h2>
          <span className={`ml-auto text-xs ${isSokko ? 'text-rose-500' : 'text-violet-600'}`}>
            {selectedLocation}（{locTemp.toFixed(0)}℃）：{dailyAccum.toFixed(1)} ℃/日換算
          </span>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          X軸：積算温度（℃・日）{isSokko && <span className="text-rose-500 ml-1">※速醸は0〜{currentChartMax}℃・日表示</span>}{grainType === '無洗米' && !isSokko && <span className="text-amber-500 ml-1">※白みそ通常目標（速醸70℃・日）の基準線は非表示</span>}　右Y軸：pH
          {!isSokko && (
            <span className="ml-2 text-blue-400">
              酵母比率 {(result.fYeast * 100).toFixed(0)}%（塩分{saltPct.toFixed(1)}%・{locTemp.toFixed(0)}℃補正）
            </span>
          )}
        </p>

        {/* 凡例（クリックで表示/非表示切替） */}
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mb-4 items-center">
          {LINE_CONFIG.map(({ key, color, label, dash, shape, sw }) => {
            const hidden = hiddenLines.has(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleLine(key)}
                title={hidden ? '表示する' : '非表示にする'}
                className={`flex items-center gap-1.5 text-xs transition-opacity select-none ${hidden ? 'opacity-25' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <svg width="28" height="10" style={{ flexShrink: 0 }}>
                  <line x1="0" y1="5" x2="28" y2="5" stroke={color} strokeWidth={sw} strokeDasharray={dash} />
                  {shape && renderMarker(shape, color, 14, 5, `leg-${key}`)}
                </svg>
                {label}
              </button>
            )
          })}
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span style={{ display: 'inline-block', width: 12, height: 12, background: '#D1FAE5', border: '1px solid #6EE7B7', borderRadius: 2 }} />
            収穫窓
          </span>
          {hiddenLines.size > 0 && (
            <button
              type="button"
              onClick={() => setHiddenLines(new Set())}
              className="ml-1 text-xs text-violet-500 hover:text-violet-700 underline"
            >
              全て表示
            </button>
          )}
        </div>

        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartPoints} margin={{ top: 22, right: 52, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="#F3F4F6" vertical={false} />
            {/* 下軸：積算温度（℃・日） */}
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, currentChartMax]}
              ticks={currentTicks}
              tickFormatter={v => v === 0 ? '0' : String(v)}
              tick={{ fontSize: 10, fill: '#9CA3AF' }}
              axisLine={false} tickLine={false}
            />
            {/* 上軸：日数換算（常温は月平均での近似） */}
            <XAxis
              xAxisId={1}
              dataKey="x"
              type="number"
              orientation="top"
              domain={[0, currentChartMax]}
              ticks={currentTicks}
              tickFormatter={v => {
                if (v === 0) return '0日'
                if (dailyAccum <= 0) return '—'
                const days = Math.round(v / dailyAccum)
                return selectedLocation === '常温' ? `≈${days}日` : `${days}日`
              }}
              tick={{ fontSize: 9, fill: '#B0B8C4' }}
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
                x2={Math.min(animWindow.end ?? currentChartMax, currentChartMax)}
                fill="#D1FAE5"
                fillOpacity={0.55}
                stroke="#6EE7B7"
                strokeWidth={0.5}
              />
            )}

            {/* 縦線：基準完成（品種別目標℃・日）。無洗米の速醸以外は目標値未確立のため非表示 */}
            {effectiveTComplete != null && (
              <ReferenceLine
                yAxisId="left" x={effectiveTComplete}
                stroke="#CBD5E1" strokeDasharray="3 3"
                label={{ value: String(effectiveTComplete), position: 'insideTopRight', fontSize: 9, fill: '#94A3B8' }}
              />
            )}
            {/* 縦線：基準の糖ピーク（速醸は単調増加でピークが無いため非表示） */}
            {base.sugarPeakT != null && result.sugarPeakT != null && Math.abs(result.sugarPeakT - base.sugarPeakT) > 12 && (
              <ReferenceLine
                yAxisId="left" x={base.sugarPeakT}
                stroke="#FCD34D" strokeDasharray="2 3" strokeWidth={1}
                label={{ value: '基準糖ピーク', position: 'insideTopLeft', fontSize: 9, fill: '#F59E0B' }}
              />
            )}
            {/* 縦線：現在の糖ピーク */}
            {result.sugarPeakT != null && (
              <ReferenceLine
                yAxisId="left" x={result.sugarPeakT}
                stroke="#F59E0B" strokeWidth={1.5}
                label={{ value: '糖ピーク', position: 'insideTopRight', fontSize: 9, fill: '#F59E0B' }}
              />
            )}
            {/* 縦線：苦味ペプチドピーク */}
            {result.tBitterPeak <= currentChartMax && (
              <ReferenceLine
                yAxisId="left" x={result.tBitterPeak}
                stroke="#B07D47" strokeWidth={1} strokeDasharray="2 3"
                label={{ value: '苦味ピーク', position: 'insideTopRight', fontSize: 9, fill: '#B07D47' }}
              />
            )}
            {/* 縦線：アミノ酸ピーク（AA=90%、グラフ範囲内のみ表示） */}
            {result.tAAPeak <= currentChartMax && (
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

            {/* 細い補助ライン（ドットなし） */}
            <Line yAxisId="left"  dataKey="A"        stroke="#9CA3AF" strokeWidth={1.2} strokeDasharray="4 2" dot={false} hide={hiddenLines.has('A')}        animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="protein"  stroke="#5DCAA5" strokeWidth={1.2} strokeDasharray="4 2" dot={false} hide={hiddenLines.has('protein')}   animationDuration={400} animationEasing="ease-out" />
            <Line yAxisId="left"  dataKey="maillard" stroke="#E07B7B" strokeWidth={1.2} strokeDasharray="2 2" dot={false} hide={hiddenLines.has('maillard')}  animationDuration={400} animationEasing="ease-out" />
            {/* 中太ライン（◆ダイヤ） */}
            <Line yAxisId="left"  dataKey="bitter"   stroke="#B07D47" strokeWidth={1.5} strokeDasharray="3 2" hide={hiddenLines.has('bitter')}   animationDuration={400} animationEasing="ease-out"
              dot={(p: any) => p.cx == null || p.index % dotInterval !== 0 ? null : renderMarker('diamond',  '#B07D47', p.cx, p.cy, `bi${p.index}`)} />
            {/* 中太ライン（■スクエア） */}
            <Line yAxisId="left"  dataKey="alcohol"  stroke="#6B8FBF" strokeWidth={1.5} strokeDasharray="2 3" hide={hiddenLines.has('alcohol')}  animationDuration={400} animationEasing="ease-out"
              dot={(p: any) => p.cx == null || p.index % dotInterval !== 0 ? null : renderMarker('square',   '#6B8FBF', p.cx, p.cy, `al${p.index}`)} />
            {/* 太い主ライン（●サークル・▲トライアングル） */}
            <Line yAxisId="left"  dataKey="B"        stroke="#C8963E" strokeWidth={2.5} hide={hiddenLines.has('B')}         animationDuration={400} animationEasing="ease-out"
              dot={(p: any) => p.cx == null || p.index % dotInterval !== 0 ? null : renderMarker('circle',   '#C8963E', p.cx, p.cy, `B${p.index}`)} />
            <Line yAxisId="left"  dataKey="AA"       stroke="#34D399" strokeWidth={2.5} hide={hiddenLines.has('AA')}        animationDuration={400} animationEasing="ease-out"
              dot={(p: any) => p.cx == null || p.index % dotInterval !== 0 ? null : renderMarker('triangle', '#34D399', p.cx, p.cy, `AA${p.index}`)} />
            <Line yAxisId="right" dataKey="pH"       stroke="#9B7FC8" strokeWidth={1.5} dot={false} hide={hiddenLines.has('pH')}  animationDuration={400} animationEasing="ease-out" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>{/* /発酵進行度グラフカード */}

      {/* ── 仕上がりプロファイル帯（グラフ直下・配合変更でライブ更新） ── */}
      <ProfileBand axes={tasteAxes} headline={profileHeadline} tone={profileTone} />

        </div>{/* ── 右：ライブ結果 ここまで ── */}
      </div>{/* ── 2カラムグリッド ここまで ── */}

      {/* ── 香気傾向（全幅・詳細） ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs font-semibold text-gray-600">香気傾向</span>
            <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">定性・精度±100%</span>
            <span className="text-xs text-gray-400">評価点：収穫窓中央{effectiveTComplete != null ? ` or ${effectiveTComplete}℃・日` : '（目標値未確立）'}　縦線＝標準みそ（10割）</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {([
              { key: 'roasted', label: '焦香',     sub: 'カラメル・焦げ',     val: result.aromaRoasted, base: base.aromaRoasted, color: '#C8963E' },
              { key: 'fruity',  label: '花果様香', sub: 'フルーティー・エステル', val: result.aromaFruity,  base: base.aromaFruity,  color: '#34D399' },
              { key: 'sour',    label: '酸香',     sub: '酸味・発酵臭',       val: result.aromaSour,    base: base.aromaSour,    color: '#9B7FC8' },
            ] as const).map(({ key, label, sub, val, base: bVal, color }) => {
              const diff = val - bVal
              const qualLabel = val < 10 ? '弱い' : val < 30 ? 'やや弱い' : val < 55 ? '中程度' : val < 75 ? 'やや強い' : '強い'
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-600">{label}
                      <span className="text-gray-400 ml-1">（{sub}）</span>
                    </span>
                    <span className="tabular-nums text-gray-500">
                      {Math.abs(diff) >= 1 && (
                        <span className={`mr-1 font-medium ${diff > 0 ? 'text-amber-600' : 'text-blue-500'}`}>
                          {diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)}
                        </span>
                      )}
                      {qualLabel}
                    </span>
                  </div>
                  <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden relative">
                    <div className="absolute top-0 bottom-0 w-px bg-gray-400 z-10" style={{ left: `${Math.min(100, bVal)}%` }} />
                    <div className="h-full rounded-full transition-all duration-400 ease-out"
                      style={{ width: `${Math.min(100, val)}%`, backgroundColor: color, opacity: 0.65 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>{/* /香気傾向カード */}

      {/* ── サマリーカード（全幅・詳細指標） ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="糖ピーク"
          value={result.sugarPeakT != null ? `${Math.round(result.sugarPeakT)} ℃・日` : '—'}
          sub={result.sugarPeakT != null ? `${selectedLocation}約${tPeakDays ?? '—'}日` : '速醸は糖化完了型（ピークなし）'}
          diffText={
            result.sugarPeakT != null && tPeakRatio != null && basePeakRatio != null
              ? Math.abs(tPeakRatio - basePeakRatio) > 0.01
                ? `標準みそ比 ${tPeakRatio > basePeakRatio ? '+' : ''}${((tPeakRatio - basePeakRatio) * 100).toFixed(0)}%`
                : '標準みそと同等'
              : undefined
          }
          diffGood={null}
        />
        <MetricCard
          label="最終pH（到達下限）"
          value={result.phFinal.toFixed(2)}
          sub={result.phFinal < 4.8 ? '酸味が強くなる' : result.phFinal < 5.0 ? 'やや酸味あり' : '穏やかな酸味'}
          diffText={`標準みそ比 ${phDiff >= 0 ? '+' : ''}${phDiff.toFixed(2)}`}
          diffGood={phDiff >= 0 ? true : false}
        />
        <MetricCard
          label="甘味ポテンシャル"
          value={`${sweetnessPotential.toFixed(2)}倍`}
          sub="最大糖産生量 × 穀物量（デンプン絶対量）標準みそ比"
          diffText={sweetnessPotential > 1 ? `+${((sweetnessPotential - 1) * 100).toFixed(0)}%` : `${((sweetnessPotential - 1) * 100).toFixed(0)}%`}
          diffGood={sweetnessPotential >= 1 ? true : false}
        />
        <MetricCard
          label="収穫窓の広さ"
          value={windowWidth != null ? `${windowWidth} ℃・日` : '—'}
          sub={windowRatio != null ? `標準みそ比 ${(windowRatio * 100).toFixed(0)}%` : '窓が開かない'}
          diffText={isWindowMissing ? '条件未達' : isWindowNarrow ? 'タイミングがシビア' : '余裕あり'}
          diffGood={isWindowMissing ? false : isWindowNarrow ? false : true}
        />
      </div>

      {/* ── モデル注記 ── */}
      <div className="text-xs text-muted-foreground bg-gray-50/70 rounded-lg p-4 space-y-1 border border-gray-100">
        <p className="font-medium text-gray-600">モデルの前提と限界</p>
        <p>
          キャリブレーション基準：無添加麦みそ（麹歩合 {baseKojiHo.toFixed(1)}割・塩分 {baseSaltPct.toFixed(1)}%・目標 600 ℃・日）。
          {grainType === '砕米' && '砕米選択中：コアモデルは裸麦ベースのキャリブレーション。麹歩合・塩分・目標積算温度は山吹みそ基準値に変更。砕米の表面積効果は非反映のため精度低下の可能性あり。'}
          {grainType === '普通米' && '普通米選択中：コアモデルは裸麦ベースのキャリブレーション。砕米のような表面積効果の懸念がないため麹歩合スケーリングは比較的妥当と考えられますが、自社の製造実績データはありません。基準麹歩合10.9割・目標積算温度800℃・日は一般的な信州味噌型を想定した仮置き値で、試作結果に応じて今後調整します。'}
          {grainType === '無洗米' && (isSokko
            ? '無洗米（速醸）選択中：コアモデルは裸麦ベースのキャリブレーション。目標70℃・日は速醸時の基準値。'
            : '無洗米（非速醸）選択中：コアモデルは裸麦ベースのキャリブレーション。白みそを速醸以外で熟成した場合の参考値として利用可能。目標積算温度は未確立のため基準線は非表示。')}
        </p>
        <p>仕上がりプロファイル・各カードの「基準（中央50%・標準みそ比）」＝一般的な標準みそ（麹歩合 {STANDARD_KOJI_HO} 割・塩分 {STANDARD_SALT_PCT}%）。上記キャリブレーション基準（無添加麦24.1割）とは別で、世間一般の感覚に合わせた比較の中央値。麹多めの自社定番（無添加麦・山吹・白）は標準みそより甘味・旨味が右に振れて表示される。プロファイルのバーは対数目盛（標準を中央に、2倍/半分ごとに±25%）。</p>
        <p>A→B→C連続反応（デンプン→糖→酸・アルコール）とアミノ酸蓄積の並行反応モデル。精度±30〜50%を前提に傾向把握の目的でご利用ください。</p>
        <p>収穫窓の定義：糖 ≥ {windowMode === 'sweet' ? '50' : '25'}%（相対）かつタンパク質残存 ≤ {currentProteinThreshold}%（{grainType === '無洗米' ? '15%以上分解・甘味主体のため緩和' : '苦味ペプチドを含む総分解量 ≥ 30%'}）かつ pH ≥ 4.8。「品質バランス」モードは無添加麦みそ等の実際の仕上がりタイミング（600℃・日付近）に対応。</p>
        <p>苦味ペプチド：タンパク質→苦味ペプチド→アミノ酸の二段階反応モデル。苦味は熟成中期にピークを持ち、その後アミノ酸（旨味）へ分解される。麹歩合が高いほど苦味ピークが早く・高くなるが解消も速い。</p>
        <p>アミノ酸ピーク：二段階モデルでAA=90%に達する時点（旧一段階モデルより約30%遅い）。麹歩合が低い場合はグラフ範囲外になることがあります。</p>
        <p>アルコール（推定）：C（酸・アルコール混合）に酵母比率を乗じた値。酵母比率は「塩分5%・35℃以下で最大40%」を基準に塩分・温度で補正（塩分1%↑→比率2%↓・35℃超で抑制・50℃で死滅）。初期デンプン量に対する割合で表示。速醸は酵母死滅のためアルコール生成なし。精度±50〜80%。</p>
        <p>着色指数：Maillard反応による褐変は不可逆のため、瞬間反応速度（糖×アミノ酸×水分活性係数）の時間積分（累積値）で表示。単調増加。100%＝速度が常に最大の場合に{T_MAX}℃・日で到達する理論最大着色量。</p>
        <p>場所による影響：アミラーゼ Q10≈2.0・微生物 Q10≈4.0 の差を反映。低温ほど微生物が相対的に減速し糖が長く残る（収穫窓が広がる・甘味が出やすい）。暖房25℃をキャリブレーション基準とした近似値。</p>
        <p>速醸モード：50〜60℃の加温でアミラーゼを最大活性化・微生物を死滅させ数日で糖化を完了させる手法（西京みそ等）。kMic=0・pH変化なし。B線は単調増加（ピークなし）。収穫窓は糖×アミノ酸の積 ≥ {SOKKO_BA_CLOSE}（Maillard基質が過剰になる時点）で閉じる。グラフ範囲は0〜300℃・日（約2〜7日相当）。</p>
      </div>
    </div>
  )
}

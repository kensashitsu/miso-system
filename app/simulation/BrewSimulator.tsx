'use client'

import { useState, useMemo } from 'react'
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

// ── 型定義 ───────────────────────────────────────────────────────────────────
type ChartPoint = {
  x:        number   // 麦みそ比（T / 600）
  A:        number   // デンプン残存 0〜100%
  B:        number   // 糖（B_max = 100 に正規化）
  AA:       number   // アミノ酸蓄積 0〜100%
  pH:       number
  maillard: number   // 着色指数 0〜100（B × AA × f_aw）
}

type ModelOutput = {
  points:      ChartPoint[]
  tPeak:       number
  bMax:        number
  aw:          number
  phFinal:     number
  windowStart: number | null   // ℃・日
  windowEnd:   number | null
}

// ── コアモデル関数 ────────────────────────────────────────────────────────────
function fAwMaillard(aw: number): number {
  // 着色（Maillard）速度はaw≈0.77で最大・釣り鐘型
  return Math.max(0, 1 - Math.abs(aw - 0.77) / 0.15)
}

function runModel(kojiHo: number, saltPct: number, kojiQ: number): ModelOutput {
  const aw      = 0.99 - 0.015 * saltPct
  const kAmy    = K_AMY_BASE * (kojiQ / 6.0)
  const kMic    = Math.max(0.0001, K_MIC_BASE * (aw - AW_MIN_MIC) / (AW_BASE - AW_MIN_MIC))
  const r       = kMic / kAmy
  const kPro    = 0.5 * kAmy * (kojiHo / KOJI_HO_BASE)
  const phFinal = 4.5 + 0.05 * saltPct
  const fMaillard = fAwMaillard(aw)

  // 糖ピーク時刻
  const tPeak = Math.abs(r - 1) > 0.001
    ? Math.log(r) / (kAmy * (r - 1))
    : 1 / kAmy   // r≈1 の極限（L'Hôpital）

  // B_max (A₀=1 に正規化)
  const bMax = Math.abs(r - 1) > 0.001
    ? (1 / (r - 1)) * (Math.exp(-kAmy * tPeak) - Math.exp(-kMic * tPeak))
    : kAmy * tPeak * Math.exp(-kAmy * tPeak)

  const points: ChartPoint[] = []
  let windowStart: number | null = null
  let windowEnd:   number | null = null

  for (let i = 0; i <= T_MAX / STEP; i++) {
    const T    = i * STEP
    const A    = Math.exp(-kAmy * T)
    const Braw = Math.abs(r - 1) > 0.001
      ? (1 / (r - 1)) * (Math.exp(-kAmy * T) - Math.exp(-kMic * T))
      : kAmy * T * Math.exp(-kAmy * T)
    const Bnorm     = Math.max(0, bMax > 0 ? (Braw / bMax) * 100 : 0)
    const C         = Math.max(0, 1 - A - Math.max(0, Braw))
    const AAnorm    = (1 - Math.exp(-kPro * T)) * 100
    const pH        = PH_INITIAL - (PH_INITIAL - phFinal) * C
    const maillard  = (Bnorm / 100) * (AAnorm / 100) * fMaillard * 100

    const inWindow = Braw > 0.5 * bMax && AAnorm > 30 && pH >= 4.8
    if (inWindow && windowStart === null) windowStart = T
    if (windowStart !== null && !inWindow && windowEnd === null) windowEnd = T

    points.push({
      x: T / T_COMPLETE,
      A: A * 100,
      B: Bnorm,
      AA: AAnorm,
      pH,
      maillard,
    })
  }

  return { points, tPeak, bMax, aw, phFinal, windowStart, windowEnd }
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
  const T = Math.round(d.x * T_COMPLETE)
  return (
    <div style={{
      fontSize: 12, borderRadius: 8, background: 'white',
      boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
      padding: '10px 14px', border: '1px solid #f0f0f0', lineHeight: 2,
    }}>
      <p style={{ fontWeight: 700, color: '#374151', marginBottom: 2 }}>
        麦みそ比 {d.x.toFixed(2)}（{T} ℃・日）
      </p>
      <p style={{ color: '#9CA3AF', margin: 0 }}>デンプン残存：{d.A.toFixed(1)}%</p>
      <p style={{ color: '#C8963E', margin: 0 }}>糖（相対）：{d.B.toFixed(1)}%</p>
      <p style={{ color: '#5DCAA5', margin: 0 }}>アミノ酸：{d.AA.toFixed(1)}%</p>
      <p style={{ color: '#E07B7B', margin: 0 }}>着色指数：{d.maillard.toFixed(1)}</p>
      <p style={{ color: '#9B7FC8', margin: 0 }}>pH：{d.pH.toFixed(2)}</p>
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
  const kojiKg     = grainKg * α
  const seedWaterL = M * shikomiKg - (grainKg * α * mKoji + soybeanKg * β * mSoy)
  return { grainKg, kojiKg, soybeanKg, saltKg, seedWaterL }
}

// ── メインコンポーネント ──────────────────────────────────────────────────────
export default function BrewSimulator({
  baseKojiHo,
  baseSaltPct,
  mugiKojiMoisture,
  steamedSoyMoisture,
  kojiRatio,
  soybeanRatio,
  targetMoisture,
}: {
  baseKojiHo:         number
  baseSaltPct:        number
  mugiKojiMoisture:   number
  steamedSoyMoisture: number
  kojiRatio:          number
  soybeanRatio:       number
  targetMoisture:     number
}) {
  const [kojiHo,    setKojiHo]    = useState(baseKojiHo)
  const [saltPct,   setSaltPct]   = useState(baseSaltPct)
  const [kojiQ,     setKojiQ]     = useState(6)
  const [shikomiKg, setShikomiKg] = useState(80)

  const result = useMemo(() => runModel(kojiHo,  saltPct, kojiQ), [kojiHo, saltPct, kojiQ])
  const base   = useMemo(() => runModel(baseKojiHo, baseSaltPct, 6), [baseKojiHo, baseSaltPct])

  const tPeakRatio     = result.tPeak / T_COMPLETE
  const basePeakRatio  = base.tPeak   / T_COMPLETE
  const windowStartR   = result.windowStart != null ? result.windowStart / T_COMPLETE : null
  const windowEndR     = result.windowEnd   != null ? result.windowEnd   / T_COMPLETE : null

  const windowWidth     = result.windowStart != null && result.windowEnd != null
    ? result.windowEnd - result.windowStart : null
  const baseWindowWidth = base.windowStart != null && base.windowEnd != null
    ? base.windowEnd - base.windowStart : null
  const windowRatio = windowWidth != null && baseWindowWidth != null
    ? windowWidth / baseWindowWidth : null

  const sweetnessPotential = kojiHo / baseKojiHo
  const phDiff = result.phFinal - base.phFinal

  // 原料逆算
  const ingredients = useMemo(() => calcIngredients(
    shikomiKg, kojiHo, saltPct,
    kojiRatio, soybeanRatio,
    mugiKojiMoisture, steamedSoyMoisture,
    targetMoisture,
  ), [shikomiKg, kojiHo, saltPct, kojiRatio, soybeanRatio, mugiKojiMoisture, steamedSoyMoisture, targetMoisture])

  // 「仕込む」ボタン用URL：収穫窓中央を目標積算温度に使用
  const brewTargetTempSum = result.windowStart != null && result.windowEnd != null
    ? Math.round((result.windowStart + result.windowEnd) / 2)
    : result.windowStart != null
      ? Math.round(result.windowStart * 1.2)
      : 400

  const brewUrl = (() => {
    const p = new URLSearchParams({
      prototype:    'true',
      targetTempSum: String(brewTargetTempSum),
      grainKg:      String(Math.round(ingredients.grainKg   * 10) / 10),
      kojiKg:       String(Math.round(ingredients.kojiKg    * 10) / 10),
      soybeanKg:    String(Math.round(ingredients.soybeanKg * 10) / 10),
      saltKg:       String(Math.round(ingredients.saltKg    * 10) / 10),
      seedWaterL:   String(Math.round(ingredients.seedWaterL * 10) / 10),
      shikomiKg:    String(shikomiKg),
    })
    return `/lots/new?${p.toString()}`
  })()

  const tPeakDays = Math.round(result.tPeak / 15)   // 暖房25℃: 15℃/日

  // 収穫窓の警告レベル
  const isWindowNarrow = windowRatio != null && windowRatio < 0.7
  const isWindowMissing = result.windowStart === null

  return (
    <div className="space-y-5">

      {/* ── 入力コントロール ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5 space-y-5">
        <h2 className="text-sm font-semibold text-gray-700">配合設定（裸麦使用・水飴なし）</h2>

        {/* 麹歩合 */}
        <div>
          <div className="flex justify-between items-baseline mb-1.5">
            <label className="text-sm text-gray-600">麹歩合</label>
            <span className="text-sm font-semibold text-gray-900 tabular-nums">
              {kojiHo.toFixed(1)}割
              <span className="text-xs text-muted-foreground font-normal ml-2">
                基準 {baseKojiHo.toFixed(1)}割
              </span>
            </span>
          </div>
          <input
            type="range" min={15} max={45} step={0.5}
            value={kojiHo}
            onChange={e => setKojiHo(parseFloat(e.target.value))}
            className="w-full accent-amber-500 h-1.5"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>15割（旨味重視）</span>
            <span>45割（甘味重視）</span>
          </div>
        </div>

        {/* 塩分% */}
        <div>
          <div className="flex justify-between items-baseline mb-1.5">
            <label className="text-sm text-gray-600">塩分</label>
            <span className="text-sm font-semibold text-gray-900 tabular-nums">
              {saltPct.toFixed(1)}%
              <span className="text-xs text-muted-foreground font-normal ml-2">
                基準 {baseSaltPct.toFixed(1)}%
              </span>
            </span>
          </div>
          <input
            type="range" min={5} max={14} step={0.1}
            value={saltPct}
            onChange={e => setSaltPct(parseFloat(e.target.value))}
            className="w-full accent-sky-500 h-1.5"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>5%（甘・酸味強）</span>
            <span>14%（辛口・保存性高）</span>
          </div>
        </div>

        {/* 出麹評価 */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600 shrink-0">出麹評価（麹品質）</label>
          <select
            value={kojiQ}
            onChange={e => setKojiQ(parseInt(e.target.value))}
            className="text-sm border border-gray-200 rounded-md px-2 py-1 text-gray-700 bg-white"
          >
            {[3, 4, 5, 6, 7, 8, 9].map(v => (
              <option key={v} value={v}>
                {v}（{v <= 4 ? '低品質' : v === 5 ? 'やや低い' : v === 6 ? '標準' : v === 7 ? '良好' : '高品質'}）
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">水分活性 aw = {result.aw.toFixed(3)}</span>
        </div>
      </div>

      {/* ── サマリーカード ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="糖ピーク（麦みそ比）"
          value={`${tPeakRatio.toFixed(2)}倍`}
          sub={`${Math.round(result.tPeak)} ℃・日 / 暖房約${tPeakDays}日`}
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
          sub="基準（無添加麦みそ）比"
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

      {/* ── 収穫窓アラート ── */}
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
            麦みそ比 {windowStartR?.toFixed(2)}〜{windowEndR?.toFixed(2) ?? '（範囲内で終了せず）'}
            {result.windowStart != null && (
              <span className="ml-1 text-xs">
                （約 {Math.round(result.windowStart / 15)}〜{result.windowEnd != null ? Math.round(result.windowEnd / 15) : '—'} 日・暖房時）
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 原料逆算セクション ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700">原料逆算</h2>

        {/* 仕立量スライダー */}
        <div>
          <div className="flex justify-between items-baseline mb-1.5">
            <label className="text-sm text-gray-600">目標仕立量</label>
            <span className="text-sm font-semibold text-gray-900 tabular-nums">{shikomiKg} kg</span>
          </div>
          <input
            type="range" min={30} max={500} step={10}
            value={shikomiKg}
            onChange={e => setShikomiKg(parseInt(e.target.value))}
            className="w-full accent-violet-500 h-1.5"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>30 kg</span><span>500 kg</span>
          </div>
        </div>

        {/* 原料一覧 */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-1.5 text-xs text-gray-400 font-medium">原料</th>
                <th className="text-right py-1.5 text-xs text-gray-400 font-medium">計算値</th>
                <th className="text-right py-1.5 text-xs text-gray-400 font-medium">備考</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[
                { label: '裸麦（穀物）',  value: ingredients.grainKg,    unit: 'kg',  note: `麹歩合 ${kojiHo.toFixed(1)}割` },
                { label: '麦麹（参考）',  value: ingredients.kojiKg,     unit: 'kg',  note: `裸麦×${kojiRatio}` },
                { label: '大豆',          value: ingredients.soybeanKg,  unit: 'kg',  note: '' },
                { label: '塩',            value: ingredients.saltKg,     unit: 'kg',  note: `塩分 ${saltPct.toFixed(1)}%` },
                { label: '種水',          value: ingredients.seedWaterL, unit: 'L',   note: `水分 ${(targetMoisture * 100).toFixed(1)}%に調整` },
              ].map(({ label, value, unit, note }) => (
                <tr key={label} className="hover:bg-gray-50/40">
                  <td className="py-2 text-gray-700 font-medium">{label}</td>
                  <td className="py-2 text-right tabular-nums font-semibold text-gray-900">
                    {value < 0
                      ? <span className="text-rose-500">計算不可</span>
                      : `${(Math.round(value * 10) / 10).toFixed(1)} ${unit}`
                    }
                  </td>
                  <td className="py-2 text-right text-xs text-muted-foreground">{note}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 bg-gray-50/60">
                <td className="py-2 font-semibold text-gray-700">仕立量合計</td>
                <td className="py-2 text-right tabular-nums font-bold text-gray-900">{shikomiKg} kg</td>
                <td className="py-2 text-right text-xs text-muted-foreground">
                  目標積算温度 {brewTargetTempSum} ℃・日
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 種水が負の場合の警告 */}
        {ingredients.seedWaterL < 0 && (
          <p className="text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            原料の水分だけで目標水分を超えています。塩分を増やすか麹歩合を下げてください。
          </p>
        )}

        {/* 仕込むボタン */}
        {ingredients.seedWaterL >= 0 && (
          <a
            href={brewUrl}
            className="flex items-center justify-center gap-2 w-full rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium py-2.5 transition-colors"
          >
            この配合でロット登録へ →
          </a>
        )}
      </div>

      {/* ── 進行度グラフ ── */}
      <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-0.5">発酵進行度</h2>
        <p className="text-xs text-muted-foreground mb-4">
          X軸：麦みそ比（1.0 = 無添加麦みそ基準 600 ℃・日）　右Y軸：pH
        </p>

        {/* 凡例 */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-4">
          {[
            { color: '#9CA3AF', label: 'デンプン残存', dash: '4 2' },
            { color: '#C8963E', label: '糖（甘味源）' },
            { color: '#5DCAA5', label: 'アミノ酸（旨味源）' },
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
              domain={[0, 1.5]}
              ticks={[0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]}
              tickFormatter={v => String(v.toFixed(2))}
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

            {/* 収穫窓ハイライト */}
            {windowStartR != null && (
              <ReferenceArea
                yAxisId="left"
                x1={windowStartR}
                x2={windowEndR ?? 1.5}
                fill="#D1FAE5"
                fillOpacity={0.55}
                stroke="#6EE7B7"
                strokeWidth={0.5}
              />
            )}

            {/* 縦線：基準完成 */}
            <ReferenceLine
              yAxisId="left" x={1.0}
              stroke="#CBD5E1" strokeDasharray="3 3"
              label={{ value: '基準完成', position: 'insideTopRight', fontSize: 9, fill: '#94A3B8' }}
            />
            {/* 縦線：基準の糖ピーク */}
            {Math.abs(tPeakRatio - basePeakRatio) > 0.02 && (
              <ReferenceLine
                yAxisId="left" x={basePeakRatio}
                stroke="#FCD34D" strokeDasharray="2 3" strokeWidth={1}
                label={{ value: '基準糖ピーク', position: 'insideTopLeft', fontSize: 9, fill: '#F59E0B' }}
              />
            )}
            {/* 縦線：現在の糖ピーク */}
            <ReferenceLine
              yAxisId="left" x={tPeakRatio}
              stroke="#F59E0B" strokeWidth={1.5}
              label={{ value: '糖ピーク', position: 'insideTopRight', fontSize: 9, fill: '#F59E0B' }}
            />
            {/* 横線：pH下限 */}
            <ReferenceLine
              yAxisId="right" y={4.8}
              stroke="#FCA5A5" strokeDasharray="2 3" strokeWidth={1}
              label={{ value: '4.8', position: 'right', fontSize: 9, fill: '#FCA5A5' }}
            />

            <Line yAxisId="left"  dataKey="A"        stroke="#9CA3AF" strokeWidth={1.5} strokeDasharray="4 2" dot={false} isAnimationActive={false} />
            <Line yAxisId="left"  dataKey="B"        stroke="#C8963E" strokeWidth={2}   dot={false} isAnimationActive={false} />
            <Line yAxisId="left"  dataKey="AA"       stroke="#5DCAA5" strokeWidth={2}   dot={false} isAnimationActive={false} />
            <Line yAxisId="left"  dataKey="maillard" stroke="#E07B7B" strokeWidth={1.5} strokeDasharray="2 2" dot={false} isAnimationActive={false} />
            <Line yAxisId="right" dataKey="pH"       stroke="#9B7FC8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── モデル注記 ── */}
      <div className="text-xs text-muted-foreground bg-gray-50/70 rounded-lg p-4 space-y-1 border border-gray-100">
        <p className="font-medium text-gray-600">モデルの前提と限界</p>
        <p>キャリブレーション基準：無添加麦みそ（麹歩合 {baseKojiHo.toFixed(1)}割・塩分 {baseSaltPct.toFixed(1)}%・目標 600 ℃・日）</p>
        <p>A→B→C連続反応（デンプン→糖→酸・アルコール）とアミノ酸蓄積の並行反応モデル。精度±30〜50%を前提に傾向把握の目的でご利用ください。</p>
        <p>収穫窓の定義：糖 ≥ 50%（相対）かつアミノ酸 ≥ 30% かつ pH ≥ 4.8</p>
      </div>
    </div>
  )
}

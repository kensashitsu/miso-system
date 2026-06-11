'use client'

import { useState, useMemo } from 'react'
import type { GrainType } from './modelCore'
import {
  K_AMY_BASE, K_MIC_BASE, AW_BASE, AW_MIN_MIC,
  PH_INITIAL, T_MAX, STEP, Q10_ENZ, Q10_MIC, T_REF,
  R_BITTER, SOKKO_BA_CLOSE,
} from './modelCore'

// ── 型定義 ──────────────────────────────────────────────────────────────────
type Metric = 'windowWidth' | 'bMax' | 'tPeak' | 'phFinal'

type GridPoint = {
  kojiHo:      number
  saltPct:     number
  windowWidth: number   // 0 = 収穫窓なし
  tPeak:       number
  bMax:        number
  phFinal:     number
}

// ── 軽量モデル計算（ChartPoints配列なし・グリッド専用） ─────────────────────
function calcGridPoint(
  kojiHo: number, saltPct: number, locTemp: number,
  bThreshold: number, isSokko: boolean,
  kojiHoBase: number, proteinThreshold: number,
): GridPoint {
  const aw       = 0.99 - 0.015 * saltPct
  const kAmyBase = K_AMY_BASE * (kojiHo / kojiHoBase)

  let kAmy: number, r: number, phFinal: number
  if (isSokko) {
    kAmy    = kAmyBase * Math.pow(Q10_ENZ, (locTemp - T_REF) / 10)
    r       = 0
    phFinal = PH_INITIAL
  } else {
    kAmy    = kAmyBase
    const kMic = Math.max(0.0001, K_MIC_BASE * (aw - AW_MIN_MIC) / (AW_BASE - AW_MIN_MIC))
    r       = (kMic / kAmy) * Math.pow(Q10_MIC / Q10_ENZ, (locTemp - T_REF) / 10)
    phFinal = 4.5 + 0.05 * saltPct
  }

  const kPro       = 0.5 * kAmy
  const kPeptidase = kPro * R_BITTER
  const kMicEff    = isSokko ? 0 : kAmy * r

  let tPeak: number, bMax: number
  if (isSokko) {
    tPeak = T_MAX; bMax = 1
  } else if (Math.abs(r - 1) > 0.001) {
    tPeak = Math.log(r) / (kAmy * (r - 1))
    bMax  = (1 / (r - 1)) * (Math.exp(-kAmy * tPeak) - Math.exp(-kMicEff * tPeak))
  } else {
    tPeak = 1 / kAmy
    bMax  = kAmy * tPeak * Math.exp(-kAmy * tPeak)
  }

  let windowStart: number | null = null
  let windowEnd:   number | null = null

  for (let i = 0; i <= T_MAX / STEP; i++) {
    const T = i * STEP
    const A = Math.exp(-kAmy * T)
    let Braw: number
    if (isSokko) {
      Braw = 1 - A
    } else if (Math.abs(r - 1) > 0.001) {
      Braw = (1 / (r - 1)) * (Math.exp(-kAmy * T) - Math.exp(-kMicEff * T))
    } else {
      Braw = kAmy * T * Math.exp(-kAmy * T)
    }
    const proteinFrac = Math.exp(-kPro * T)
    const bitterRaw   = Math.max(0, (1 / (R_BITTER - 1)) * (proteinFrac - Math.exp(-kPeptidase * T)))
    const protein     = proteinFrac * 100
    const C           = Math.max(0, 1 - A - Math.max(0, Braw))
    const pH          = PH_INITIAL - (PH_INITIAL - phFinal) * C
    const AAnorm      = Math.max(0, 1 - proteinFrac - bitterRaw)
    const Bnorm       = bMax > 0 ? Math.max(0, Braw / bMax) : 0

    const inWindow = Braw > bThreshold * bMax
      && protein < proteinThreshold
      && pH >= 4.8
      && (!isSokko || Bnorm * AAnorm < SOKKO_BA_CLOSE)

    if (inWindow  && windowStart === null) windowStart = T
    if (windowStart !== null && !inWindow && windowEnd === null) windowEnd = T
  }

  const windowWidth = windowStart != null ? (windowEnd ?? T_MAX) - windowStart : 0
  return { kojiHo, saltPct, windowWidth, tPeak, bMax, phFinal }
}

// ── カラーマッピング ──────────────────────────────────────────────────────────
type ColorStop = { val: number; h: number; s: number; l: number }

function colorFromStops(value: number, stops: ColorStop[]): string {
  if (!stops.length) return '#9CA3AF'
  if (value <= stops[0].val) {
    const { h, s, l } = stops[0]
    return `hsl(${h},${s}%,${l}%)`
  }
  const last = stops[stops.length - 1]
  if (value >= last.val) return `hsl(${last.h},${last.s}%,${last.l}%)`
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1]
    if (value >= a.val && value <= b.val) {
      const t = (value - a.val) / (b.val - a.val)
      const h = a.h + (b.h - a.h) * t
      const s = a.s + (b.s - a.s) * t
      const l = a.l + (b.l - a.l) * t
      return `hsl(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%)`
    }
  }
  return '#9CA3AF'
}

type MetricCfg = { label: string; unit: string; desc: string; stops: ColorStop[]; fmt: (v: number) => string }

const METRIC_CFG: Record<Metric, MetricCfg> = {
  windowWidth: {
    label: '収穫窓幅', unit: '℃・日',
    desc: '緑＝広い（仕上げタイミングに余裕）　灰＝収穫窓なし',
    stops: [
      { val: 0,   h: 0,   s: 0,  l: 83 },
      { val: 1,   h: 0,   s: 68, l: 57 },
      { val: 150, h: 38,  s: 90, l: 52 },
      { val: 400, h: 140, s: 52, l: 42 },
    ],
    fmt: v => v > 0 ? `${Math.round(v)}℃・日` : '窓なし',
  },
  bMax: {
    label: '糖ピーク量', unit: '',
    desc: '橙＝高い（甘味ポテンシャル大）　青＝低い',
    stops: [
      { val: 0,    h: 220, s: 58, l: 60 },
      { val: 0.12, h: 200, s: 15, l: 90 },
      { val: 0.30, h: 28,  s: 88, l: 52 },
    ],
    fmt: v => (v * 100).toFixed(1) + '%',
  },
  tPeak: {
    label: '糖ピーク時刻', unit: '℃・日',
    desc: '緑＝早熟（甘味が早く来る）　赤＝晩熟',
    stops: [
      { val: 50,  h: 140, s: 52, l: 42 },
      { val: 200, h: 52,  s: 88, l: 52 },
      { val: 500, h: 0,   s: 68, l: 56 },
    ],
    fmt: v => `${Math.round(v)}℃・日`,
  },
  phFinal: {
    label: '最終pH', unit: '',
    desc: '青＝穏やかな酸味　赤＝酸い（pH4.8以下は収穫窓外）',
    stops: [
      { val: 4.5, h: 0,   s: 68, l: 55 },
      { val: 5.0, h: 30,  s: 88, l: 52 },
      { val: 5.8, h: 52,  s: 85, l: 50 },
      { val: 6.5, h: 200, s: 52, l: 48 },
    ],
    fmt: v => v.toFixed(2),
  },
}

// ── 品種別デフォルトグリッド範囲 ─────────────────────────────────────────────
const GRID_RANGES: Record<GrainType, { koji: [number, number]; salt: [number, number] }> = {
  '裸麦':  { koji: [10, 50], salt: [5,  14] },
  '砕米':  { koji: [10, 50], salt: [5,  14] },
  '無洗米': { koji: [10, 55], salt: [1,  12] },
}

const N    = 20   // グリッド分割数（各軸）
const CELL = 16   // セルサイズ (px)
const ML = 34, MR = 70, MT = 16, MB = 32

// ── メインコンポーネント ──────────────────────────────────────────────────────
export default function DesignMap({
  grainType,
  currentKojiHo,
  currentSaltPct,
  locTemp,
  bThreshold,
  isSokko,
  kojiHoBase,
  proteinThreshold,
}: {
  grainType:        GrainType
  currentKojiHo:   number
  currentSaltPct:  number
  locTemp:          number
  bThreshold:       number
  isSokko:          boolean
  kojiHoBase:       number
  proteinThreshold: number
}) {
  const [metric,       setMetric]       = useState<Metric>('windowWidth')
  const [hoveredPoint, setHoveredPoint] = useState<GridPoint | null>(null)
  const [hoverXY,      setHoverXY]      = useState<{ x: number; y: number } | null>(null)

  const { koji: kojiRange, salt: saltRange } = GRID_RANGES[grainType]
  const cfg = METRIC_CFG[metric]

  // グリッド全点の計算（品種・場所・モードが変わるときのみ再計算）
  const grid = useMemo<GridPoint[]>(() => {
    const pts: GridPoint[] = []
    for (let si = 0; si < N; si++) {
      for (let ki = 0; ki < N; ki++) {
        const kh = kojiRange[0] + (kojiRange[1] - kojiRange[0]) * ki / (N - 1)
        const sp = saltRange[0] + (saltRange[1] - saltRange[0]) * si / (N - 1)
        pts.push(calcGridPoint(kh, sp, locTemp, bThreshold, isSokko, kojiHoBase, proteinThreshold))
      }
    }
    return pts
  }, [kojiRange, saltRange, locTemp, bThreshold, isSokko, kojiHoBase, proteinThreshold])

  const gridW = N * CELL
  const gridH = N * CELL
  const svgW  = ML + gridW + MR
  const svgH  = MT + gridH + MB

  // 現在配合のピクセル座標（マーカー用）
  const mCX = ML + ((currentKojiHo  - kojiRange[0]) / (kojiRange[1] - kojiRange[0])) * gridW
  const mCY = MT + gridH - ((currentSaltPct - saltRange[0]) / (saltRange[1] - saltRange[0])) * gridH
  const markerVisible =
    currentKojiHo  >= kojiRange[0] && currentKojiHo  <= kojiRange[1] &&
    currentSaltPct >= saltRange[0] && currentSaltPct <= saltRange[1]

  const minVal = cfg.stops[0].val
  const maxVal = cfg.stops[cfg.stops.length - 1].val

  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm p-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-700">設計マップ
          <span className="text-xs font-normal text-gray-400 ml-2">麹歩合 × 塩分%</span>
        </h2>
        <div className="ml-auto flex rounded border border-gray-200 overflow-hidden text-xs">
          {(Object.keys(METRIC_CFG) as Metric[]).map(m => (
            <button key={m} type="button" onClick={() => setMetric(m)}
              className={`px-2.5 py-1.5 transition-colors ${
                metric === m ? 'bg-violet-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
              }`}>
              {METRIC_CFG[m].label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        {cfg.desc}
        <span className="ml-2 font-medium text-gray-500">●＝現在の配合</span>
      </p>

      {/* ヒートマップ */}
      <div
        className="overflow-x-auto"
        onMouseLeave={() => { setHoveredPoint(null); setHoverXY(null) }}
      >
        <svg
          width={svgW} height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ display: 'block' }}
        >
          {/* グリッドセル */}
          {grid.map((pt, idx) => {
            const ki  = idx % N
            const si  = Math.floor(idx / N)
            const x   = ML + ki * CELL
            const y   = MT + (N - 1 - si) * CELL   // 塩分: 上が高い
            const val = metric === 'windowWidth' ? pt.windowWidth
              : metric === 'bMax'    ? pt.bMax
              : metric === 'tPeak'   ? pt.tPeak
              : pt.phFinal
            return (
              <rect key={idx} x={x} y={y} width={CELL} height={CELL}
                fill={colorFromStops(val, cfg.stops)}
                style={{ cursor: 'crosshair' }}
                onMouseEnter={e => {
                  setHoveredPoint(pt)
                  setHoverXY({ x: e.clientX, y: e.clientY })
                }}
              />
            )
          })}

          {/* 現在配合マーカー */}
          {markerVisible && (
            <>
              <circle cx={mCX} cy={mCY} r={7} fill="none" stroke="white"   strokeWidth={3} />
              <circle cx={mCX} cy={mCY} r={7} fill="none" stroke="#111827" strokeWidth={1.5} />
            </>
          )}

          {/* X軸ラベル（麹歩合） */}
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const val = kojiRange[0] + (kojiRange[1] - kojiRange[0]) * t
            return (
              <text key={t} x={ML + t * gridW} y={MT + gridH + 18}
                textAnchor="middle" fontSize={9} fill="#9CA3AF">
                {val.toFixed(0)}割
              </text>
            )
          })}
          <text x={ML + gridW / 2} y={svgH - 3}
            textAnchor="middle" fontSize={9} fill="#6B7280">麹歩合</text>

          {/* Y軸ラベル（塩分%） */}
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const val = saltRange[0] + (saltRange[1] - saltRange[0]) * t
            const y   = MT + gridH - t * gridH
            return (
              <text key={t} x={ML - 5} y={y + 3.5}
                textAnchor="end" fontSize={9} fill="#9CA3AF">
                {val.toFixed(1)}%
              </text>
            )
          })}
          <text x={10} y={MT + gridH / 2}
            textAnchor="middle" fontSize={9} fill="#6B7280"
            transform={`rotate(-90,10,${MT + gridH / 2})`}>塩分%</text>

          {/* カラーバー（グラデーション + ラベル） */}
          <defs>
            <linearGradient id="cbar" x1="0" y1="1" x2="0" y2="0">
              {cfg.stops.map((s, i) => {
                const off = maxVal > minVal ? (s.val - minVal) / (maxVal - minVal) : 0
                return (
                  <stop key={i} offset={`${(off * 100).toFixed(1)}%`}
                    stopColor={`hsl(${s.h},${s.s}%,${s.l}%)`} />
                )
              })}
            </linearGradient>
          </defs>
          <rect x={ML + gridW + 12} y={MT} width={12} height={gridH}
            fill="url(#cbar)" rx={2} />
          {cfg.stops.map((s, i) => {
            const frac = maxVal > minVal ? (s.val - minVal) / (maxVal - minVal) : 0
            const y    = MT + gridH - frac * gridH
            return (
              <text key={i} x={ML + gridW + 28} y={y + 3.5} fontSize={8.5} fill="#6B7280">
                {cfg.fmt(s.val)}
              </text>
            )
          })}
        </svg>
      </div>

      {/* ホバーツールチップ */}
      {hoveredPoint && hoverXY && (
        <div
          className="fixed z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2.5 text-xs"
          style={{ left: hoverXY.x + 14, top: hoverXY.y - 10 }}
        >
          <p className="font-semibold text-gray-700 mb-1.5">
            {hoveredPoint.kojiHo.toFixed(1)}割 / 塩分{hoveredPoint.saltPct.toFixed(1)}%
          </p>
          <p className={`mb-0.5 ${hoveredPoint.windowWidth > 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
            収穫窓幅：{METRIC_CFG.windowWidth.fmt(hoveredPoint.windowWidth)}
          </p>
          <p className="text-amber-600 mb-0.5">糖ピーク：{METRIC_CFG.tPeak.fmt(hoveredPoint.tPeak)}</p>
          <p className="text-sky-600 mb-0.5">糖ピーク量：{METRIC_CFG.bMax.fmt(hoveredPoint.bMax)}</p>
          <p className="text-purple-500">pH下限：{METRIC_CFG.phFinal.fmt(hoveredPoint.phFinal)}</p>
        </div>
      )}
    </div>
  )
}

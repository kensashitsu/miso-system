'use client'

import { useState, useEffect } from 'react'
import { subMonths, format, startOfMonth } from 'date-fns'
import {
  ComposedChart, Bar, Cell, Area, XAxis, YAxis, CartesianGrid,
  ReferenceLine, ResponsiveContainer, Tooltip, Legend,
} from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { holtWinters, getTimeSeries } from '@/lib/forecast'

const MISO_TYPES       = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const
const FORECAST_OPTIONS = [3, 6, 12] as const

// SARIMAX予測データの型（品種ごと）
interface SarimaxEntry {
  months:   string[]
  forecast: number[]
  lower90:  number[]
  upper90:  number[]
}

interface Props {
  shipmentMap:         Record<string, Record<string, number>>
  sarimaxForecast?:    Record<string, SarimaxEntry>
  sarimaxPastForecast?: Record<string, Record<string, number>>
  sarimaxMape?:        Record<string, number>
}

// 直近3年同月平均
function get3YearAvg(data: Record<string, number>, month: number, year: number): number | null {
  const values: number[] = []
  for (let i = 1; i <= 3; i++) {
    const ym = `${year - i}-${String(month).padStart(2, '0')}`
    if (data[ym] != null) values.push(data[ym])
  }
  return values.length > 0
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null
}

// 過去各月の「その時点までのデータでHWを適用した予測値」
function calcHistoricalForecasts(
  typeData:  Record<string, number>,
  targetYMs: string[],
): Record<string, number> {
  const sortedAllYMs = Object.keys(typeData).sort()
  const result: Record<string, number> = {}

  for (const targetYM of targetYMs) {
    const histYMs    = sortedAllYMs.filter(ym => ym < targetYM)
    const histValues = histYMs.map(ym => typeData[ym])
    if (histValues.length < 12) continue

    const hw = holtWinters(histValues, 1)
    if (hw.forecast[0] != null) {
      result[targetYM] = Math.round(hw.forecast[0])
    }
  }
  return result
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ payload: Record<string, number | boolean | null> }>; label?: string }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null

  const fmt = (v: number | null | undefined) =>
    v != null ? `${Math.round(Number(v)).toLocaleString()} kg` : null
  const range = (lo: number | null | undefined, hi: number | null | undefined) =>
    lo != null && hi != null
      ? `${Math.round(Number(lo)).toLocaleString()}〜${Math.round(Number(hi)).toLocaleString()} kg`
      : null

  type Row = { label: string; value: string; sub?: string; color: string }
  const rows: Row[] = []
  if (d.actual    != null) rows.push({ label: '実績',          value: fmt(d.actual as number)!,    color: '#111111' })
  if (d.predicted != null) rows.push({ label: '予測（3年平均）', value: fmt(d.predicted as number)!, color: '#888888' })
  if (d.hwForecast != null) {
    const r = range(d.hwLower as number, d.hwUpper as number)
    rows.push({ label: 'AI予測（HW法）', value: fmt(d.hwForecast as number)!, sub: r ? `予測範囲：${r}` : undefined, color: '#3B82F6' })
  }
  if (d.sarimaxBar != null) {
    const isFut  = d.isFuture as boolean
    const r      = isFut ? range(d.sarimaxLower as number, d.sarimaxUpper as number) : null
    rows.push({
      label: isFut ? 'SARIMAX予測（今月以降）' : 'SARIMAX予測（LOO検証）',
      value: fmt(d.sarimaxBar as number)!,
      sub:   r ? `90%信頼区間：${r}` : undefined,
      color: '#16a34a',
    })
  }

  return (
    <div style={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(var(--border))', background: 'white', padding: '8px 12px', lineHeight: 1.6 }}>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{label}</p>
      {rows.map((r, i) => (
        <div key={i} style={{ marginBottom: r.sub ? 2 : 0 }}>
          <span style={{ color: r.color }}>{r.label}：{r.value}</span>
          {r.sub && <div style={{ color: '#888', fontSize: 11, paddingLeft: 8 }}>{r.sub}</div>}
        </div>
      ))}
    </div>
  )
}

export default function DemandChart({ shipmentMap, sarimaxForecast, sarimaxPastForecast, sarimaxMape }: Props) {
  const [chartHeight, setChartHeight] = useState(300)
  useEffect(() => {
    function update() {
      setChartHeight(window.innerWidth < 640 ? Math.round(window.innerWidth * 9 / 16) : 300)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const [selectedType,     setSelectedType]     = useState<string>(MISO_TYPES[0])
  const [forecastMonths,   setForecastMonths]   = useState<number>(6)
  const [showPastForecast, setShowPastForecast] = useState(true)

  const today        = new Date()
  const currentLabel = format(today, 'yy/MM')
  const hasAnyData   = Object.values(shipmentMap).some(m => Object.keys(m).length > 0)

  const typeData = shipmentMap[selectedType] ?? {}
  const hwInput  = getTimeSeries(typeData)
  const hasEnoughForHW = hwInput.length >= 12

  // 固定パラメータで未来予測（α=0.3 β=0.1 γ=0.3）
  const hwResult = hasEnoughForHW
    ? holtWinters(hwInput, forecastMonths)
    : null

  // 過去12ヶ月の年月リスト
  const past12YMs = Array.from({ length: 12 }, (_, i) =>
    format(subMonths(startOfMonth(today), 12 - i), 'yyyy-MM')
  )

  const historicalForecasts = hasEnoughForHW
    ? calcHistoricalForecasts(typeData, past12YMs)
    : {}

  // MAPE（実績と過去HW予測の両方があるデータのみ）
  const currentYM  = format(startOfMonth(today), 'yyyy-MM')
  const mapeMonths = past12YMs.filter(
    ym => ym < currentYM && typeData[ym] != null && historicalForecasts[ym] != null && typeData[ym] > 0
  )
  const mape = mapeMonths.length > 0
    ? mapeMonths.reduce((sum, ym) => {
        return sum + Math.abs(typeData[ym] - historicalForecasts[ym]) / typeData[ym] * 100
      }, 0) / mapeMonths.length
    : null

  // 3年平均 MAPE
  const mape3yMonths = past12YMs.filter(ym => {
    if (ym >= currentYM || !typeData[ym] || typeData[ym] <= 0) return false
    const m = parseInt(ym.slice(5, 7))
    const y = parseInt(ym.slice(0, 4))
    return get3YearAvg(typeData, m, y) !== null
  })
  const mape3y = mape3yMonths.length > 0
    ? mape3yMonths.reduce((sum, ym) => {
        const m   = parseInt(ym.slice(5, 7))
        const y   = parseInt(ym.slice(0, 4))
        const avg = get3YearAvg(typeData, m, y)!
        return sum + Math.abs(typeData[ym] - avg) / typeData[ym] * 100
      }, 0) / mape3yMonths.length
    : null

  // SARIMAX予測データ（選択品種）
  const sarimaxEntry = sarimaxForecast?.[selectedType]
  const hasSarimax   = sarimaxEntry != null && sarimaxEntry.forecast.length > 0

  // SARIMAXの年月→値のマップ
  const sarimaxByYM: Record<string, { forecast: number; lower90: number; upper90: number }> = {}
  if (sarimaxEntry) {
    for (let i = 0; i < sarimaxEntry.months.length; i++) {
      sarimaxByYM[sarimaxEntry.months[i]] = {
        forecast: sarimaxEntry.forecast[i],
        lower90:  sarimaxEntry.lower90[i],
        upper90:  sarimaxEntry.upper90[i],
      }
    }
  }

  // グラフデータ：過去12ヶ月 + 予測期間
  const chartData = Array.from({ length: 12 + forecastMonths }, (_, i) => {
    const month  = subMonths(startOfMonth(today), 12 - i)
    const ym     = format(month, 'yyyy-MM')
    const label  = format(month, 'yy/MM')
    const actual = typeData[ym] ?? null
    const predicted = get3YearAvg(typeData, month.getMonth() + 1, month.getFullYear())

    const isFuture = i >= 12
    const hwIdx    = isFuture ? i - 12 : -1

    let hwForecast:  number | null = null
    let hwLower:     number | null = null
    let hwBandWidth: number | null = null

    let hwUpper: number | null = null

    if (isFuture && hwResult && hwIdx < hwResult.forecast.length) {
      hwForecast  = hwResult.forecast[hwIdx]
      hwLower     = hwResult.lowerBound[hwIdx]
      hwUpper     = hwResult.upperBound[hwIdx]
      hwBandWidth = hwUpper - hwLower
    } else if (!isFuture && showPastForecast) {
      hwForecast = historicalForecasts[ym] ?? null
    }

    // SARIMAX予測（未来期間のみ）
    let sarimaxForecastVal: number | null = null
    let sarimaxLower:       number | null = null
    let sarimaxUpper:       number | null = null
    let sarimaxBandWidth:   number | null = null

    if (isFuture && sarimaxByYM[ym]) {
      const s            = sarimaxByYM[ym]
      sarimaxForecastVal = s.forecast
      sarimaxLower       = s.lower90
      sarimaxUpper       = s.upper90
      sarimaxBandWidth   = s.upper90 - s.lower90
    }

    // SARIMAX: 未来予測と過去LOOを1つのフィールドに統合（Rechartsのbar spacing問題を回避）
    const sarimaxBar = isFuture
      ? (sarimaxForecastVal)
      : (sarimaxPastForecast?.[selectedType]?.[ym] ?? null)

    return {
      ym, label, actual, predicted,
      hwForecast, hwLower, hwUpper, hwBandWidth,
      sarimaxForecast: sarimaxForecastVal,
      sarimaxLower, sarimaxUpper,
      sarimaxBandWidth,
      sarimaxBar,
      isFuture,
    }
  })

  // Y軸の単位：最大値が10,000kg未満なら kg 表示、以上ならトン表示
  const chartMaxVal = Math.max(0, ...chartData.flatMap(d =>
    [d.actual, d.predicted, d.hwForecast, d.sarimaxBar]
      .filter((v): v is number => typeof v === 'number' && v > 0)
  ))
  const useTonn = chartMaxVal >= 10000
  const yTickFormatter = (v: number | string) =>
    useTonn
      ? `${Math.round(Number(v) / 1000)}t`
      : `${Math.round(Number(v)).toLocaleString()}kg`

  if (!hasAnyData) {
    return (
      <section>
        <h2 className="text-base font-semibold mb-4">① 需要予測グラフ</h2>
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              出荷実績データが未登録です。インポート画面からデータを取り込むと需要予測が利用できます。
            </p>
          </CardContent>
        </Card>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-base font-semibold mb-4">① 需要予測グラフ</h2>
      <Card>
        <CardHeader className="pb-2 space-y-3">
          {/* 品種タブ */}
          <div className="flex gap-1.5 flex-wrap">
            {MISO_TYPES.map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setSelectedType(type)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  selectedType === type
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {/* 予測期間 + 過去精度トグル */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">予測期間：</span>
              {FORECAST_OPTIONS.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setForecastMonths(n)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    forecastMonths === n
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {n}ヶ月
                </button>
              ))}
            </div>

            {hasEnoughForHW ? (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPastForecast}
                  onChange={e => setShowPastForecast(e.target.checked)}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
                過去の予測精度を表示
              </label>
            ) : (
              <span className="text-xs text-muted-foreground">
                HW予測：データ{hwInput.length}ヶ月分（12ヶ月以上必要）
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                stroke="hsl(var(--border))"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--border))"
                tickFormatter={yTickFormatter}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={v => {
                  if (v === 'actual')         return '実績'
                  if (v === 'predicted')       return '予測（3年平均）'
                  if (v === 'hwForecast')      return 'AI予測（HW法）'
                  if (v === 'sarimaxBar')      return 'SARIMAX予測'
                  return null
                }}
              />
              <ReferenceLine
                x={currentLabel}
                stroke="hsl(var(--primary))"
                strokeDasharray="4 2"
                label={{ value: '今月', position: 'insideTopLeft', fontSize: 11, fill: 'hsl(var(--primary))' }}
              />

              {/* HW未来予測の信頼帯（スタックArea） */}
              {hasEnoughForHW && (
                <>
                  <Area type="monotone" dataKey="hwLower"     stackId="hw_ci"
                    stroke="none" fill="transparent" legendType="none"
                    connectNulls={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="hwBandWidth" stackId="hw_ci"
                    stroke="none" fill="#3B82F6" fillOpacity={0.12} legendType="none"
                    connectNulls={false} isAnimationActive={false} />
                </>
              )}

              {/* SARIMAX未来予測の信頼帯（スタックArea） */}
              {hasSarimax && (
                <>
                  <Area type="monotone" dataKey="sarimaxLower"     stackId="sx_ci"
                    stroke="none" fill="transparent" legendType="none"
                    connectNulls={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="sarimaxBandWidth" stackId="sx_ci"
                    stroke="none" fill="#16a34a" fillOpacity={0.12} legendType="none"
                    connectNulls={false} isAnimationActive={false} />
                </>
              )}

              {/* 実績（黒） */}
              <Bar dataKey="actual"    name="actual"    fill="#111111" opacity={0.85} radius={[2,2,0,0]} />
              {/* 3年平均（グレー薄） */}
              <Bar dataKey="predicted" name="predicted" fill="#888888" opacity={0.30} radius={[2,2,0,0]} />
              {/* HW予測（青薄）：過去＋未来 */}
              {hasEnoughForHW && (
                <Bar dataKey="hwForecast" name="hwForecast" fill="#3B82F6" opacity={0.55} radius={[2,2,0,0]} />
              )}
              {/* SARIMAX: 未来予測（濃緑）+ 過去LOO検証（薄緑）を1バーで表示 */}
              {(hasSarimax || sarimaxPastForecast?.[selectedType]) && (
                <Bar dataKey="sarimaxBar" name="sarimaxBar" radius={[2,2,0,0]}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={index}
                      fill="#16a34a"
                      opacity={entry.isFuture ? 0.60 : 0.35}
                    />
                  ))}
                </Bar>
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* 予測精度サマリー */}
          {mape3y !== null || (hasEnoughForHW && showPastForecast) || hasSarimax ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {/* 3年平均精度 */}
              {mape3y !== null && (
                <>
                  <span>
                    3年平均誤差：
                    <span className="font-medium text-foreground ml-1">
                      ±{mape3y.toFixed(1)}%
                    </span>
                    （過去{mape3yMonths.length}ヶ月）
                  </span>
                  <span className={
                    mape3y < 10 ? 'text-green-600 font-medium' :
                    mape3y < 20 ? 'text-orange-600 font-medium' :
                                  'text-red-600 font-medium'
                  }>
                    {mape3y < 10 ? '良好' : mape3y < 20 ? '要注意' : '不正確'}
                  </span>
                  <span className="text-border">|</span>
                </>
              )}
              {/* HW精度 */}
              {hasEnoughForHW && showPastForecast && (
                mape !== null ? (
                  <>
                    <span>
                      HW誤差：
                      <span className="font-medium text-foreground ml-1">
                        ±{mape.toFixed(1)}%
                      </span>
                      （過去{mapeMonths.length}ヶ月）
                    </span>
                    <span className={
                      mape < 10 ? 'text-green-600 font-medium' :
                      mape < 20 ? 'text-orange-600 font-medium' :
                                  'text-red-600 font-medium'
                    }>
                      {mape < 10 ? '良好' : mape < 20 ? '要注意' : '不正確'}
                    </span>
                  </>
                ) : (
                  <span>HW誤差：計算不可</span>
                )
              )}
              {/* SARIMAX精度 */}
              {hasSarimax && (() => {
                const sm = sarimaxMape?.[selectedType]
                return (
                  <span className="text-green-700">
                    SARIMAX誤差：
                    {sm != null ? (
                      <>
                        <span className="font-medium ml-1">±{sm.toFixed(1)}%</span>
                        <span className={`ml-1 font-medium ${
                          sm < 10 ? 'text-green-600' :
                          sm < 20 ? 'text-orange-600' :
                                    'text-red-600'
                        }`}>
                          {sm < 10 ? '良好' : sm < 20 ? '要注意' : '不正確'}
                        </span>
                        <span className="ml-1 text-muted-foreground font-normal">
                          （LOO24ヶ月・HWより厳密な評価）
                        </span>
                      </>
                    ) : (
                      <span className="font-medium ml-1">—</span>
                    )}
                  </span>
                )
              })()}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}

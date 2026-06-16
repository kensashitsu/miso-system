// 予測 vs 実績バックテスト：過去の予測と実績を突き合わせ、品種×方式ごとの
// 偏り(bias)・平均誤差(MAPE)・最も的中する方式を算出する純関数群。
// 仕込み計画の「④ バックテスト表示」と「品種別の自動方式選択」で共有する。

import { holtWinters } from '@/lib/forecast'

export type ForecastMethodKey = 'sarimax' | 'hw' | 'avg'

export interface MethodStat {
  key:     ForecastMethodKey
  label:   string
  n:       number
  biasPct: number | null   // (予測−実績)÷実績の平均×100。マイナス=予測少なめ（欠品側）
  mapePct: number | null   // |（予測−実績)÷実績| の平均×100
}

export interface TypeBacktest {
  type:    string
  stats:   MethodStat[]
  bestKey: ForecastMethodKey | null  // n>=minN の中で最小MAPEの方式
  hasAny:  boolean
}

const METHOD_LABEL: Record<ForecastMethodKey, string> = {
  sarimax: 'SARIMAX',
  hw:      'AI予測(HW)',
  avg:     '3年平均',
}

// 直近3年同月平均（targetYM時点で利用可能な実績のみ）
function get3YearAvg(data: Record<string, number>, ym: string): number | null {
  const [y, m] = ym.split('-').map(Number)
  const values: number[] = []
  for (let i = 1; i <= 3; i++) {
    const key = `${y - i}-${String(m).padStart(2, '0')}`
    if (data[key] != null) values.push(data[key])
  }
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
}

// 各対象月について「その月より前の実績のみ」でHW予測した値（先読み防止）
function calcHWHistorical(typeData: Record<string, number>, targetYMs: string[]): Record<string, number> {
  const sortedYMs = Object.keys(typeData).sort()
  const result: Record<string, number> = {}
  for (const target of targetYMs) {
    const hist = sortedYMs.filter(ym => ym < target).map(ym => typeData[ym])
    if (hist.length < 12) continue
    const hw = holtWinters(hist, 1)
    if (hw.forecast[0] != null) result[target] = hw.forecast[0]
  }
  return result
}

// 実績 vs 予測の偏り(bias)・平均誤差(MAPE)を集計
function computeStats(
  actual: Record<string, number>,
  pred:   Record<string, number>,
  ymList: string[],
): { n: number; biasPct: number | null; mapePct: number | null } {
  let n = 0, sumBias = 0, sumAbs = 0
  for (const ym of ymList) {
    const a = actual[ym]
    const p = pred[ym]
    if (a == null || p == null || a <= 0) continue
    n++
    const e = (p - a) / a
    sumBias += e
    sumAbs  += Math.abs(e)
  }
  return n === 0
    ? { n: 0, biasPct: null, mapePct: null }
    : { n, biasPct: (sumBias / n) * 100, mapePct: (sumAbs / n) * 100 }
}

// 現在の年月（'yyyy-MM'）
function currentYM(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function computeBacktest(
  types:                string[],
  shipmentMap:          Record<string, Record<string, number>>,
  sarimaxPastForecast?: Record<string, Record<string, number>>,
  opts?:                { window?: number; minN?: number },
): TypeBacktest[] {
  const window = opts?.window ?? 24
  const minN   = opts?.minN   ?? 3
  const nowYM  = currentYM()

  return types.map(type => {
    const actual = shipmentMap[type] ?? {}
    const evalYMs = Object.keys(actual)
      .filter(ym => ym < nowYM && actual[ym] > 0)
      .sort()
      .slice(-window)

    const sarimaxPred = sarimaxPastForecast?.[type] ?? {}
    const hwPred      = calcHWHistorical(actual, evalYMs)
    const avgPred: Record<string, number> = {}
    for (const ym of evalYMs) {
      const a = get3YearAvg(actual, ym)
      if (a != null) avgPred[ym] = a
    }

    const stats: MethodStat[] = [
      { key: 'sarimax', label: METHOD_LABEL.sarimax, ...computeStats(actual, sarimaxPred, evalYMs) },
      { key: 'hw',      label: METHOD_LABEL.hw,      ...computeStats(actual, hwPred,      evalYMs) },
      { key: 'avg',     label: METHOD_LABEL.avg,     ...computeStats(actual, avgPred,     evalYMs) },
    ]

    const eligible = stats.filter(s => s.n >= minN && s.mapePct != null)
    const bestKey  = eligible.length > 0
      ? eligible.reduce((best, s) => (s.mapePct! < best.mapePct! ? s : best)).key
      : null

    return { type, stats, bestKey, hasAny: stats.some(s => s.n > 0) }
  })
}

// バックテストから「品種ごとに自動採用する方式」を抽出。
// 最小MAPEの方式が信頼しきい値(maxMape)以下のときのみ採用（白みそ等の低精度品種は除外）。
export function pickAutoMethods(
  backtest: TypeBacktest[],
  maxMape = 30,
): Record<string, ForecastMethodKey> {
  const out: Record<string, ForecastMethodKey> = {}
  for (const t of backtest) {
    if (!t.bestKey) continue
    const best = t.stats.find(s => s.key === t.bestKey)
    if (best?.mapePct != null && best.mapePct <= maxMape) out[t.type] = t.bestKey
  }
  return out
}

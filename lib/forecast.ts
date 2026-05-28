// ホルト・ウィンタース法（加法モデル・季節周期12ヶ月）
// 固定パラメータ: α=0.3 β=0.1 γ=0.3

export interface ForecastResult {
  forecast:   number[]   // 予測値
  upperBound: number[]   // 予測上限（+1σ）
  lowerBound: number[]   // 予測下限（-1σ, min 0）
}

export function holtWinters(
  data:           number[],
  forecastMonths: number,
  alpha = 0.3,
  beta  = 0.1,
  gamma = 0.3,
  m     = 12,
): ForecastResult {
  const n     = data.length
  const empty = Array(forecastMonths).fill(null) as number[]
  if (n < m) return { forecast: empty, upperBound: empty, lowerBound: empty }

  // 初期化
  const L0 = data.slice(0, m).reduce((a, b) => a + b, 0) / m
  let T0 = 0
  if (n >= 2 * m) {
    const avg2 = data.slice(m, 2 * m).reduce((a, b) => a + b, 0) / m
    T0 = (avg2 - L0) / m
  }
  const seasonals = data.slice(0, m).map(y => y - L0)
  const fitted: number[] = []
  let L = L0, T = T0

  // 平滑化
  for (let t = 0; t < n; t++) {
    const si    = t % m
    const prevL = L, prevT = T, prevS = seasonals[si]
    if (t < m) {
      fitted.push(L0 + T0 * (t + 1) + prevS)
    } else {
      L             = alpha * (data[t] - prevS) + (1 - alpha) * (prevL + prevT)
      T             = beta  * (L - prevL)        + (1 - beta)  * prevT
      seasonals[si] = gamma * (data[t] - L)      + (1 - gamma) * prevS
      fitted.push(L + T + seasonals[si])
    }
  }

  // 残差σ（初期シーズン除外）
  const residuals = fitted.slice(m).map((f, i) => data[m + i] - f)
  const sigma = residuals.length > 0
    ? Math.sqrt(residuals.map(r => r ** 2).reduce((a, b) => a + b, 0) / residuals.length)
    : 0

  // 予測
  const forecast:   number[] = []
  const upperBound: number[] = []
  const lowerBound: number[] = []

  for (let h = 1; h <= forecastMonths; h++) {
    const si   = (n + h - 1) % m
    const fval = Math.max(0, L + h * T + seasonals[si])
    forecast.push(  Math.round(fval))
    upperBound.push(Math.round(fval + sigma))
    lowerBound.push(Math.round(Math.max(0, fval - sigma)))
  }

  return { forecast, upperBound, lowerBound }
}

// shipmentMap の品種データを時系列配列に変換するヘルパー
export function getTimeSeries(data: Record<string, number>): number[] {
  return Object.keys(data).sort().map(ym => data[ym])
}

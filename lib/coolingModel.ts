// 放冷の予測モデル：気温(1F)とベルトから品温を当て、目標品温に必要なベルトを逆算する。
//
// 2026-09-14 に実データ（麦・ファン50・品温付き205行／135日）で検証した形：
//   品温 ≒ a + b×気温(1F) + c×ベルト   （日ごとに抜いて当てると平均誤差0.81℃・8割が±1.26℃以内）
//   2F気温・室温より1F気温の方が当たる。砕米は日数が少なくファンも毎回違うので対象外。
//   2022年分は全体より約1℃低く出ており、直近のデータだけで作る方が当たる（0.75℃）ため、
//   直近 FIT_YEARS 年に絞る。記録が増えれば係数も自動で更新される。

export const FIT_YEARS = 3
const MIN_SAMPLES = 60      // これ未満なら期間を絞らず全データで作る
const DEFAULT_FAN = 50      // ファン未記入の日は既定の50で回している

export interface CoolingRunInput {
  runDate:    Date
  grainType:  string
  airTemp1FC: number | null
  steps: {
    fan:            number | null
    belt:           number | null
    productTempMin: number | null
    productTempMax: number | null
  }[]
}

export interface CoolingModel {
  intercept: number
  airCoef:   number
  beltCoef:  number          // ベルト1つで品温が何℃動くか
  mae:       number          // 日ごとに抜いて当てた平均誤差（℃）
  p80:       number          // 8割がこの誤差以内（℃）
  samples:   number
  days:      number
  sinceISO:  string          // 学習に使った最古の日
  airMin:    number
  airMax:    number
  beltMin:   number
  beltMax:   number
  // いつものベルト（その日の最初の設定）を気温から当てる式。人がふだん選んでいる初手
  habit: { intercept: number; airCoef: number; mae: number } | null
}

type Sample = { day: string; air: number; belt: number; temp: number }

/** 同じ日の中では、空欄のファン・ベルトは前の行から変えていない */
function collect(runs: CoolingRunInput[]) {
  const samples: Sample[] = []
  const firsts: { air: number; belt: number }[] = []
  for (const run of runs) {
    if (run.grainType !== '麦' || run.airTemp1FC === null) continue
    const day = run.runDate.toISOString().slice(0, 10)
    let fan: number | null = null
    let belt: number | null = null
    run.steps.forEach((step, i) => {
      if (step.fan  !== null) fan  = step.fan
      if (step.belt !== null) belt = step.belt
      if ((fan ?? DEFAULT_FAN) !== DEFAULT_FAN || belt === null) return
      if (i === 0) firsts.push({ air: run.airTemp1FC as number, belt })
      // 「30℃以下」のように片側しか無い品温は数値として当てにできないので使わない
      if (step.productTempMin === null || step.productTempMax === null) return
      samples.push({
        day,
        air:  run.airTemp1FC as number,
        belt,
        temp: (step.productTempMin + step.productTempMax) / 2,
      })
    })
  }
  return { samples, firsts }
}

/** 最小二乗（正規方程式をガウスの消去法で解く）。係数は [切片, x1, x2, …] */
function leastSquares(X: number[][], y: number[]): number[] | null {
  const k = X[0].length + 1
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0))
  X.forEach((row, n) => {
    const r = [1, ...row]
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += r[i] * r[j]
      A[i][k] += r[i] * y[n]
    }
  })
  for (let col = 0; col < k; col++) {
    let pivot = col
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    if (Math.abs(A[pivot][col]) < 1e-9) return null
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = A[r][col] / A[col][col]
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c]
    }
  }
  return A.map((row, i) => row[k] / row[i])
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

export function fitCoolingModel(runs: CoolingRunInput[], today = new Date()): CoolingModel | null {
  const cutoff = new Date(today)
  cutoff.setFullYear(cutoff.getFullYear() - FIT_YEARS)
  const recent = runs.filter(r => r.runDate >= cutoff)
  let { samples, firsts } = collect(recent)
  if (samples.length < MIN_SAMPLES) ({ samples, firsts } = collect(runs))
  if (samples.length < 10) return null

  const coef = leastSquares(samples.map(s => [s.air, s.belt]), samples.map(s => s.temp))
  if (!coef || coef[2] <= 0) return null   // ベルトを上げて品温が下がる式は逆算に使えない

  // 1日ぶんまるごと抜いて作った式で、その日を当てる（同じ日の行どうしで答えを覗かない）
  const days = [...new Set(samples.map(s => s.day))]
  const errors: number[] = []
  for (const day of days) {
    const train = samples.filter(s => s.day !== day)
    const c = leastSquares(train.map(s => [s.air, s.belt]), train.map(s => s.temp))
    if (!c) continue
    for (const s of samples.filter(s => s.day === day)) {
      errors.push(Math.abs(s.temp - (c[0] + c[1] * s.air + c[2] * s.belt)))
    }
  }

  const habitCoef = firsts.length >= 10 ? leastSquares(firsts.map(f => [f.air]), firsts.map(f => f.belt)) : null
  const habit = habitCoef
    ? {
        intercept: habitCoef[0],
        airCoef:   habitCoef[1],
        mae: firsts.reduce((a, f) => a + Math.abs(f.belt - (habitCoef[0] + habitCoef[1] * f.air)), 0) / firsts.length,
      }
    : null

  return {
    intercept: coef[0],
    airCoef:   coef[1],
    beltCoef:  coef[2],
    mae:       errors.reduce((a, e) => a + e, 0) / errors.length,
    p80:       percentile(errors, 0.8),
    samples:   samples.length,
    days:      days.length,
    sinceISO:  samples.map(s => s.day).sort()[0],
    airMin:    Math.min(...samples.map(s => s.air)),
    airMax:    Math.max(...samples.map(s => s.air)),
    beltMin:   Math.min(...samples.map(s => s.belt)),
    beltMax:   Math.max(...samples.map(s => s.belt)),
    habit,
  }
}

/** 気温とベルトから品温を当てる */
export function predictProductTemp(model: CoolingModel, air: number, belt: number) {
  return model.intercept + model.airCoef * air + model.beltCoef * belt
}

/** 目標品温にするためのベルト */
export function suggestBelt(model: CoolingModel, air: number, targetTemp: number) {
  return (targetTemp - model.intercept - model.airCoef * air) / model.beltCoef
}

/** いつものベルト（過去の同じくらいの気温の日に、最初に選んでいた設定） */
export function habitualBelt(model: CoolingModel, air: number) {
  return model.habit ? model.habit.intercept + model.habit.airCoef * air : null
}

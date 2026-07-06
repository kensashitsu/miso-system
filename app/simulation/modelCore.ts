// A→B→C連続反応モデルのコア定数・型・計算関数

export const K_AMY_BASE        = 0.00420
export const K_MIC_BASE        = 0.00840
export const AW_BASE           = 0.83
export const AW_MIN_MIC        = 0.75
export const KOJI_HO_BASE      = 24.1
export const PH_INITIAL        = 6.8
export const T_COMPLETE        = 600
export const T_MAX             = 900
export const STEP              = 5
export const Q10_ENZ           = 2.0
export const Q10_MIC           = 4.0
export const T_REF             = 25
export const SALT_KOJI_RATE    = 0.175
export const WINDOW_SWEET      = 0.50
export const WINDOW_BALANCE    = 0.25
export const SOKKO_BA_CLOSE    = 0.75
export const R_BITTER          = 2.0
export const F_YEAST_BASE      = 0.40
export const F_YEAST_SALT_RATE = 0.020
export const YEAST_SUPPRESS_TEMP = 35
export const YEAST_DEATH_TEMP    = 50
export const FRUIT_OPT_TEMP    = 28
export const FRUIT_AROMA_RANGE = 15
export const FRUIT_AROMA_SCALE = 2.5
export const SOUR_AROMA_SCALE  = 100 / 70

// 普通米（米みそ・通常熟成）の暫定基準値：自社の製造実績データがないため、
// 一般的な信州味噌型（麹歩合10〜12割）の目安として仮置き。試作結果により今後調整。
export const KOME_KOJI_HO_BASE  = 10.9
export const KOME_SALT_PCT_BASE = 10.9
export const KOME_T_COMPLETE    = 800

export type GrainType = '裸麦' | '砕米' | '無洗米' | '普通米'

export type ChartPoint = {
  x:        number
  A:        number
  B:        number
  protein:  number
  bitter:   number
  AA:       number
  alcohol:  number
  pH:       number
  maillard: number
}

export type ModelOutput = {
  points:       ChartPoint[]
  tPeak:        number
  sugarPeakT:   number | null   // 糖ピークの積算温度。速醸は単調増加でピークが無いためnull
  tAAPeak:      number
  tBitterPeak:  number
  bitterMax:    number
  bMax:         number
  aw:           number
  phFinal:      number
  fYeast:       number
  umamiAt:      number   // 収穫窓中央(evalT)でのアミノ酸蓄積（%）＝旨味の代理
  bitterAt:     number   // 収穫窓中央(evalT)での苦味ペプチド（%）
  aromaRoasted: number
  aromaFruity:  number
  aromaSour:    number
  windowStart:  number | null
  windowEnd:    number | null
}

export function fAwMaillard(aw: number): number {
  return Math.max(0, 1 - Math.abs(aw - 0.77) / 0.15)
}

export function runModel(
  kojiHo: number, saltPct: number, kojiQ: number, locTemp: number,
  bThreshold:       number  = WINDOW_SWEET,
  isSokko:          boolean = false,
  kojiHoBase:       number  = KOJI_HO_BASE,
  tComplete:        number  = T_COMPLETE,
  proteinThreshold: number  = 70,
): ModelOutput {
  const aw       = 0.99 - 0.015 * saltPct
  const kAmyBase = K_AMY_BASE * (kojiQ / 6.0) * (kojiHo / kojiHoBase)
  const fMaillard = fAwMaillard(aw)

  let kAmy: number, kMic: number, r: number, phFinal: number
  if (isSokko) {
    kAmy    = kAmyBase * Math.pow(Q10_ENZ, (locTemp - T_REF) / 10)
    kMic    = 0
    r       = 0
    phFinal = PH_INITIAL
  } else {
    kAmy    = kAmyBase
    kMic    = Math.max(0.0001, K_MIC_BASE * (aw - AW_MIN_MIC) / (AW_BASE - AW_MIN_MIC))
    r       = (kMic / kAmy) * Math.pow(Q10_MIC / Q10_ENZ, (locTemp - T_REF) / 10)
    phFinal = 4.5 + 0.05 * saltPct
  }

  const kPro       = 0.5 * kAmy
  const kMicEff    = isSokko ? 0 : kAmy * r
  const kPeptidase = kPro * R_BITTER

  const fYeastSalt = Math.max(0.05, Math.min(F_YEAST_BASE, F_YEAST_BASE - F_YEAST_SALT_RATE * (saltPct - 5)))
  const fYeastTemp = isSokko ? 0
    : Math.max(0, Math.min(1, (YEAST_DEATH_TEMP - locTemp) / (YEAST_DEATH_TEMP - YEAST_SUPPRESS_TEMP)))
  const fYeast = fYeastSalt * fYeastTemp

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

  const tBitterPeak  = Math.log(R_BITTER) / (kPro * (R_BITTER - 1))
  const bitterAtPeak = Math.max(0, (1 / (R_BITTER - 1)) * (Math.exp(-kPro * tBitterPeak) - Math.exp(-kPeptidase * tBitterPeak)))
  const bitterMax    = bitterAtPeak * 100

  const points: ChartPoint[] = []
  let windowStart:        number | null = null
  let windowEnd:          number | null = null
  let cumulativeMaillard  = 0

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
    const bitter      = bitterRaw * 100
    const AAnorm      = Math.max(0, (1 - proteinFrac - bitterRaw)) * 100
    const protein     = proteinFrac * 100
    const Bnorm       = Math.max(0, bMax > 0 ? (Braw / bMax) * 100 : 0)
    const C           = Math.max(0, 1 - A - Math.max(0, Braw))
    const alcohol     = C * fYeast * 100
    const pH          = PH_INITIAL - (PH_INITIAL - phFinal) * C
    cumulativeMaillard += (Bnorm / 100) * (AAnorm / 100) * fMaillard * STEP
    const maillard    = cumulativeMaillard * 100 / T_MAX

    const inWindow = Braw > bThreshold * bMax && protein < proteinThreshold && pH >= 4.8
      && (!isSokko || (Bnorm / 100) * (AAnorm / 100) < SOKKO_BA_CLOSE)
    if (inWindow && windowStart === null) windowStart = T
    if (windowStart !== null && !inWindow && windowEnd === null) windowEnd = T

    points.push({ x: T, A: A * 100, B: Bnorm, protein, bitter, AA: AAnorm, alcohol, pH, maillard })
  }

  const tAAPeak = -Math.log(1 - Math.sqrt(0.9)) / kPro

  const evalT = windowStart != null && windowEnd != null
    ? (windowStart + windowEnd) / 2
    : windowStart != null ? Math.min(windowStart * 1.2, T_MAX)
    : isSokko ? T_MAX / 3 : tComplete

  const Ae     = Math.exp(-kAmy * evalT)
  const Braw_e = isSokko ? (1 - Ae)
    : Math.abs(r - 1) > 0.001
      ? Math.max(0, (1 / (r - 1)) * (Ae - Math.exp(-kMicEff * evalT)))
      : kAmy * evalT * Ae
  const Ce = Math.max(0, 1 - Ae - Braw_e)

  const Bnorm_e   = Math.max(0, bMax > 0 ? (Braw_e / bMax) : 0)
  const protein_e = Math.exp(-kPro * evalT)
  const bitter_e  = Math.max(0, (1 / (R_BITTER - 1)) * (protein_e - Math.exp(-kPeptidase * evalT)))
  const AA_e      = Math.max(0, 1 - protein_e - bitter_e)
  const aromaRoasted = Math.min(100, Bnorm_e * AA_e * fMaillard * 100 * 3)

  const fruitFactor = Math.max(0, 1 - Math.abs(locTemp - FRUIT_OPT_TEMP) / FRUIT_AROMA_RANGE)
  const aromaFruity = Math.min(100, Ce * fYeast * fruitFactor * 100 * FRUIT_AROMA_SCALE)
  const aromaSour   = Math.min(100, Ce * (1 - fYeast) * 100 * SOUR_AROMA_SCALE)

  return {
    points, tPeak, sugarPeakT: isSokko ? null : tPeak,
    tAAPeak, tBitterPeak, bitterMax, bMax, aw, phFinal, fYeast,
    umamiAt: AA_e * 100, bitterAt: bitter_e * 100,
    aromaRoasted, aromaFruity, aromaSour, windowStart, windowEnd,
  }
}

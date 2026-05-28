/**
 * 熟成完了日シミュレーション（weatherAvg ベース・前向き予測）
 *
 * calcEstimatedCompletion（tempCalc.ts）は直近30日の実績気温を外挿するため、
 * 春仕込みのロットが夏の高温を見込めず完成日が過大になる。
 * こちらは月日平均（weatherAvg）を用いて今日以降を日別シミュレーションするため、
 * 夏季の常温熟成を正確に予測できる。
 */

import { addDays, format, startOfDay } from 'date-fns'

const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/

type LocationInfo =
  | { kind: 'fixed';   rate: number }   // 暖房・冷房・温調室（固定レート）
  | { kind: 'outdoor' }                 // 常温（weatherAvg を使う）
  | { kind: 'stopped' }                 // 冷蔵庫（率≦0、完成日なし）

function parseLocation(loc: string, fridgeTemp: number): LocationInfo {
  const m = loc.match(TEMP_LOCATION_RE)
  if (m) {
    const rate = Math.max(Number(m[1]) - 10, 0)
    return { kind: 'fixed', rate }
  }
  if (loc === '冷蔵庫') {
    const rate = Math.max(fridgeTemp - 10, 0)
    return rate <= 0 ? { kind: 'stopped' } : { kind: 'fixed', rate }
  }
  return { kind: 'outdoor' }
}

/**
 * 現在の積算温度と現在地から完成予定日を計算する。
 *
 * @param accumulatedTemp  現在の積算温度（℃・日）
 * @param targetTempSum    目標積算温度（℃・日）
 * @param currentLocation  現在の場所文字列（例: '暖房25℃' / '常温' / '冷蔵庫'）
 * @param weatherAvg       MM-dd → effectiveTemp の月日平均 Map（全年履歴から計算）
 * @param q10Value         Q10係数（常温のみ適用）
 * @param heatingBaseTemp  Q10基準温度（= heatingDefaultTemp）
 * @param fridgeTemp       冷蔵庫設定温度（℃）
 * @returns 完成予定日、または null（冷蔵庫など停止中）
 */
export function calcSimulatedCompletionDate(
  accumulatedTemp:  number,
  targetTempSum:    number,
  currentLocation:  string,
  weatherAvg:       Record<string, number>,
  q10Value:         number,
  heatingBaseTemp:  number,
  fridgeTemp:       number,
): Date | null {
  if (targetTempSum <= 0) return null
  if (accumulatedTemp >= targetTempSum) return startOfDay(new Date())

  const info = parseLocation(currentLocation, fridgeTemp)
  if (info.kind === 'stopped') return null

  if (info.kind === 'fixed') {
    if (info.rate <= 0) return null
    const days = Math.ceil((targetTempSum - accumulatedTemp) / info.rate)
    return addDays(startOfDay(new Date()), days)
  }

  // 常温: weatherAvg（過去複数年の月日平均 effectiveTemp）＋ Q10補正で日別前向きシミュレーション
  // addDays は新しい Date を返し元を破壊しない
  let curr  = startOfDay(new Date())
  let accum = accumulatedTemp

  for (let i = 0; i < 730; i++) {
    const eff   = weatherAvg[format(curr, 'MM-dd')] ?? 0
    const daily = (eff > 0 && q10Value !== 1)
      ? eff * Math.pow(q10Value, (eff + 10 - heatingBaseTemp) / 10)
      : eff
    accum = Math.round((accum + daily) * 10) / 10
    if (accum >= targetTempSum) return new Date(curr.getTime())
    curr = addDays(curr, 1)
  }

  return null  // 730日以内に完成しない場合
}

// ─────────────────────────────────────────────────────────────
// グラフ用シミュレーション（WeatherSimulator と完全同一ロジック）
// ─────────────────────────────────────────────────────────────

/** グラフ1点のデータ（WeatherSimulator の SimDay と同等） */
export type ModalSimDay = {
  date:        string
  maturityPct: number  // Q10補正熟成値 ÷ 目標 × 100（%）
  simplePct:   number  // 単純積算 ÷ 目標 × 100（%）
}

const isOutdoor = (m: number) => m >= 6 && m <= 9

/**
 * 仕込み日から完成日まで両線をシミュレーション。
 * WeatherSimulator.tsx の simulate() と同一のロジック：
 *   - 6〜9月: weatherAvg を使用（常温・外気温）
 *   - futureFixedRate=undefined（常温）: 全期間 weatherAvg を使用
 *   - futureFixedRate=数値（暖房/冷房）: 過去は屋内(dailyRoomAccum)/屋外(weatherAvg)モデル
 *   - Q10補正は全期間に適用（WeatherSimulator 準拠）
 *
 * 今日以降に "もしも" 場所を適用する場合は futureFixedRate を指定。
 *   - undefined   → 常温として扱う（全期間 weatherAvg を継続使用）
 *   - 数値（≥0） → 暖房/冷房/冷蔵庫の固定有効積算温度（℃/日）
 */
export function simulateLotForModal(
  brewDate:       Date,
  targetTempSum:  number,
  weatherAvg:     Record<string, number>,
  dailyRoomAccum: number,      // = room1Temp - 10
  q10Value:       number,
  heatingBaseTemp: number,
  futureFixedRate?: number,    // 今日以降の固定レート（undefined = 常温ロジック継続）
): ModalSimDay[] {
  const today = startOfDay(new Date())
  let curr         = new Date(brewDate.getTime())
  let totalSimple  = 0
  let totalMaturity = 0
  const result: ModalSimDay[] = []

  for (let i = 0; i < 730; i++) {
    const isAfterToday = curr.getTime() > today.getTime()
    const month        = curr.getMonth() + 1

    // 有効積算温度の決定
    let eff: number
    if (isAfterToday && futureFixedRate !== undefined) {
      // 今日以降・固定レート（暖房/冷房/冷蔵庫）
      eff = futureFixedRate
    } else if (futureFixedRate === undefined) {
      // 常温: 全期間でweatherAvgを使用（月による屋内/屋外区分なし）
      eff = weatherAvg[format(curr, 'MM-dd')] ?? 0
    } else {
      // 固定レートあり（暖房/冷房）: 過去は屋内/屋外モデル
      eff = isOutdoor(month)
        ? (weatherAvg[format(curr, 'MM-dd')] ?? 0)
        : dailyRoomAccum
    }

    // 単純積算（Q10補正なし）
    totalSimple = Math.round((totalSimple + eff) * 10) / 10

    // Q10補正熟成値（全期間に適用 — WeatherSimulator 準拠）
    const corrected = (eff > 0 && q10Value !== 1)
      ? eff * Math.pow(q10Value, (eff + 10 - heatingBaseTemp) / 10)
      : eff
    totalMaturity = Math.round((totalMaturity + corrected) * 10) / 10

    result.push({
      date:        format(curr, 'yyyy-MM-dd'),
      maturityPct: Math.round(totalMaturity / targetTempSum * 1000) / 10,
      simplePct:   Math.round(totalSimple   / targetTempSum * 1000) / 10,
    })

    // 両線とも200%に達したら終了（100%超の経過を可視化するため200%まで継続）
    if (totalSimple >= targetTempSum * 2 && totalMaturity >= targetTempSum * 2) break
    curr = addDays(curr, 1)
  }

  return result
}

/**
 * 仕込み日起点のシミュレーション（simulateLotForModal準拠）でQ10補正完成予定日を返す。
 * ダッシュボードとロット詳細モーダルの完成予定日を統一するための関数。
 */
export function calcCompletionFromBrew(
  brewDate:        Date,
  targetTempSum:   number,
  currentLocation: string,
  weatherAvg:      Record<string, number>,
  dailyRoomAccum:  number,
  q10Value:        number,
  heatingBaseTemp: number,
  fridgeTemp:      number,
): Date | null {
  if (targetTempSum <= 0) return null

  const info = parseLocation(currentLocation, fridgeTemp)
  if (info.kind === 'stopped') return null

  const futureFixedRate = info.kind === 'fixed' ? info.rate : undefined

  const simDays = simulateLotForModal(
    brewDate, targetTempSum, weatherAvg, dailyRoomAccum, q10Value, heatingBaseTemp, futureFixedRate,
  )

  const day = simDays.find(d => d.maturityPct >= 100)
  if (!day) return null
  return startOfDay(new Date(day.date + 'T00:00:00'))
}

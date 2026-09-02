/**
 * 熟成完了日シミュレーション（weatherAvg ベース・前向き予測）
 *
 * 直近30日の実績気温を外挿する方式だと、春仕込みのロットが夏の高温を見込めず
 * 完成日が過大になる。こちらは月日平均（weatherAvg）を用いて今日以降を日別に
 * シミュレーションするため、夏季の常温熟成を正確に予測できる。
 * さらに actualAccumToday（今日時点の実績積算温度）を渡すと、今日の点が実績と
 * 一致するよう較正される。
 */

import { addDays, format, startOfDay } from 'date-fns'
import { HEATING_MONTHLY_FACTOR } from './tempCalc'

const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/

type LocationInfo =
  | { kind: 'heating'; rate: number }   // 暖房（月別補正係数の対象）
  | { kind: 'fixed';   rate: number }   // 冷房・温調室（固定レート）
  | { kind: 'outdoor' }                 // 常温（weatherAvg を使う）
  | { kind: 'stopped' }                 // 冷蔵庫（率≦0、完成日なし）

function parseLocation(loc: string, fridgeTemp: number): LocationInfo {
  const m = loc.match(TEMP_LOCATION_RE)
  if (m) {
    const rate = Math.max(Number(m[1]) - 10, 0)
    return loc.startsWith('暖房') ? { kind: 'heating', rate } : { kind: 'fixed', rate }
  }
  if (loc === '冷蔵庫') {
    const rate = Math.max(fridgeTemp - 10, 0)
    return rate <= 0 ? { kind: 'stopped' } : { kind: 'fixed', rate }
  }
  return { kind: 'outdoor' }
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
 *   - 6〜9月: weatherAvg を使用（常温・外気温）
 *   - futureFixedRate=undefined（常温）: 6〜9月は weatherAvg、10〜5月は暖房室
 *     （dailyRoomAccum・月別補正あり）。実際に10月から暖房室へ移す運用のため
 *   - futureFixedRate=数値（暖房/冷房）: 過去は屋内(dailyRoomAccum)/屋外(weatherAvg)モデル
 *   - Q10補正は常温（外気）の日のみ。暖房室の日は月別補正係数と二重になるため掛けない
 *
 * 今日以降に "もしも" 場所を適用する場合は futureFixedRate を指定。
 *   - undefined   → 常温として扱う（6〜9月は weatherAvg、10〜5月は暖房室）
 *   - 数値（≥0） → 暖房/冷房/冷蔵庫の固定有効積算温度（℃/日）
 */
export function simulateLotForModal(
  brewDate:       Date,
  targetTempSum:  number,
  weatherAvg:     Record<string, number>,
  dailyRoomAccum: number,      // = heatingDefaultTemp - 10
  q10Value:       number,
  heatingBaseTemp: number,
  futureFixedRate?: number,    // 今日以降の固定レート（undefined = 常温ロジック継続）
  futureIsHeating?: boolean,   // futureFixedRateが暖房のときtrue（月別補正係数の対象）
  actualAccumToday?: number,   // 今日時点の実績積算温度（℃・日）。渡すと今日で実績に合わせて較正する
): ModalSimDay[] {
  const today = startOfDay(new Date())
  // brewedAt はUTC midnight（= JST 9:00）で渡ってくることがあり、そのままだと
  // 「今日」との一致判定・過去/未来の境界が半日ずれる。必ず日付の頭に丸める
  let curr         = startOfDay(new Date(brewDate.getTime()))
  let totalSimple  = 0
  let totalMaturity = 0
  let calibrated   = false
  const result: ModalSimDay[] = []

  for (let i = 0; i < 730; i++) {
    const isAfterToday = curr.getTime() > today.getTime()
    const month        = curr.getMonth() + 1
    const heatFactor    = HEATING_MONTHLY_FACTOR[month] ?? 1

    // 有効積算温度の決定
    let eff: number
    if (isAfterToday && futureFixedRate !== undefined) {
      // 今日以降・固定レート（暖房/冷房/冷蔵庫）。暖房のみ月別補正係数を適用
      eff = futureIsHeating ? futureFixedRate * heatFactor : futureFixedRate
    } else {
      // 6〜9月は外気（weatherAvg）、10〜5月は暖房室（dailyRoomAccum・月別補正あり）。
      // 常温のロットも10月に入ったら暖房室へ移して熟成させる運用のためこの扱いにする
      // （2026-09-02。以前は常温だけ全期間weatherAvgで、冬に線が寝たまま完成予定が
      //  実際より遅く出ていた）。仕込み計画のAI提案（simulateFermentationDays の
      //  outdoorToIndoorRate）と同じ考え方で、画面ごとの完成予定日のズレも無くなる
      eff = isOutdoor(month)
        ? (weatherAvg[format(curr, 'MM-dd')] ?? 0)
        : dailyRoomAccum * heatFactor
    }

    // 単純積算（Q10補正なし）
    totalSimple = Math.round((totalSimple + eff) * 10) / 10

    // Q10補正は常温（外気）の日だけに掛ける。暖房室の日は HEATING_MONTHLY_FACTOR が
    // 実績から較正済みの係数なので、その上にQ10を重ねると二重に効いてしまう
    // （仕込み計画の simulateFermentationDays・ロット詳細の LotSimChart と同じ扱い。
    //  以前は全期間に掛けており、同じ仕込み日でも画面によって完成予定が4日ズレていた）
    const isOutdoorDay = futureFixedRate === undefined
      ? isOutdoor(month)
      : (!isAfterToday && isOutdoor(month))
    const corrected = (isOutdoorDay && eff > 0 && q10Value !== 1)
      ? eff * Math.pow(q10Value, (eff + 10 - heatingBaseTemp) / 10)
      : eff
    totalMaturity = Math.round((totalMaturity + corrected) * 10) / 10

    result.push({
      date:        format(curr, 'yyyy-MM-dd'),
      maturityPct: Math.round(totalMaturity / targetTempSum * 1000) / 10,
      simplePct:   Math.round(totalSimple   / targetTempSum * 1000) / 10,
    })

    // 今日の時点で実績積算に合わせて較正する（2026-08-28追加）。
    // 過去はモデル（月日平均気温＋屋内想定）なので実際の場所履歴・実際の日別気温で
    // 積んだ値とズレる。今日が実績と一致するよう過去の線を比例で伸縮させ、
    // 今日以降はそこからモデルの日次増分を積む。これでカードの熟成度%と
    // 完成予定日が同じ点を通るようになる（ズレは実測で3〜4日あった）。
    if (!calibrated && actualAccumToday != null && curr.getTime() === today.getTime()) {
      calibrated = true
      if (totalMaturity > 0) {
        const k = actualAccumToday / totalMaturity
        totalMaturity = actualAccumToday
        totalSimple   = Math.round(totalSimple * k * 10) / 10
        for (const r of result) {
          r.maturityPct = Math.round(r.maturityPct * k * 10) / 10
          r.simplePct   = Math.round(r.simplePct   * k * 10) / 10
        }
      }
    }

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
  actualAccumToday?: number,   // 今日時点の実績積算温度。渡すと実績に合わせて較正した完成予定日になる
): Date | null {
  if (targetTempSum <= 0) return null

  const info = parseLocation(currentLocation, fridgeTemp)
  if (info.kind === 'stopped') return null

  const futureFixedRate = (info.kind === 'fixed' || info.kind === 'heating') ? info.rate : undefined
  const futureIsHeating = info.kind === 'heating'

  const simDays = simulateLotForModal(
    brewDate, targetTempSum, weatherAvg, dailyRoomAccum, q10Value, heatingBaseTemp, futureFixedRate, futureIsHeating,
    actualAccumToday,
  )

  const day = simDays.find(d => d.maturityPct >= 100)
  if (!day) return null
  return startOfDay(new Date(day.date + 'T00:00:00'))
}

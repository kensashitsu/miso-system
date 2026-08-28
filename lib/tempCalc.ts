import { addDays, format, startOfDay } from 'date-fns'
import type { LocationHistory } from './generated/prisma'

// 有効積算温度の基準温度
const BASE_TEMP = 10

// 常温Q10補正のデフォルト基準温度（heatingDefaultTempが渡されない場合のフォールバック）
const DEFAULT_HEATING_BASE_TEMP = 25

export type RoomTemps = {
  room1Temp:        number
  room2Temp:        number
  fridgeTemp:       number
  heatingBaseTemp?: number  // Q10の基準温度（= heatingDefaultTemp）。省略時は25℃
  q10Value?:        number  // 常温熟成のQ10補正係数。省略または1.0で補正なし
}
const DEFAULT_ROOM_TEMPS: RoomTemps = { room1Temp: 24, room2Temp: 20, fridgeTemp: 6 }

// WeatherCacheにデータがない日のデフォルト（℃/日、effectiveTemp相当）。
// 下の月日平均も取れないときの最終フォールバック
const DEFAULT_DAILY_TEMP = 14

// WeatherCacheに無い日を「同じ月日の過去平均」で補うためのMap（MM-dd → effectiveTemp平均）。
// 気象取り込みは前日分までしか入らないため当日は必ず欠測になり、以前は固定14℃/日で
// 代用していた（夏は実測19〜20℃/日に対して5〜6℃・日の過小評価）。
// weatherMapごとに一度だけ計算してキャッシュする
const mmddAvgCache = new WeakMap<Map<string, number>, Map<string, number>>()
function getMmddAverages(weatherMap: Map<string, number>): Map<string, number> {
  const cached = mmddAvgCache.get(weatherMap)
  if (cached) return cached
  const totals = new Map<string, { sum: number; count: number }>()
  for (const [dateKey, eff] of weatherMap) {
    const key = dateKey.slice(5)  // MM-dd
    const e = totals.get(key) ?? { sum: 0, count: 0 }
    e.sum += eff; e.count += 1
    totals.set(key, e)
  }
  const avg = new Map<string, number>()
  for (const [key, { sum, count }] of totals) avg.set(key, sum / count)
  mmddAvgCache.set(weatherMap, avg)
  return avg
}

// 暖房・冷房・温調室（後方互換）から温度を抽出するパターン
const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/

// 暖房期（10〜5月）の月別実効レート補正係数。
// 仕込帳原票（data/shikomicho/仕込帳データ.xlsx。使用開始日ではなく「熟成完了日」列。
// [[project_completedat_is_usestart]]参照）の田舎・無添加みそ（目標600℃・日）の実熟成日数から、
// 月ごとに「600÷中央値日数」で逆算した実効レートを、当時の実際の暖房設定（24℃・14℃/日）に
// 対する倍率として算出（scripts/analyze-shikomicho.mjs）。12月が最も遅く（12℃/日・約50日）、
// 3〜5月にかけて暖房中でも実質加速していく（外気の影響と推測）季節変動があったため、
// 「暖房○○℃固定」の単純計算だけでは説明できず導入。冷房・温調室（後方互換）は対象外。
export const HEATING_MONTHLY_FACTOR: Record<number, number> = {
  1: 0.93, 2: 0.97, 3: 1.16, 4: 1.30, 5: 1.59,
  10: 1.07, 11: 0.95, 12: 0.86,
}

// 常温の有効積算温度にQ10補正を適用する
// effectiveTemp = max(avgTempC - 10, 0) を受け取り、Q10補正後の値を返す
// effectiveTemp > 0 のとき avgTempC = effectiveTemp + BASE_TEMP として逆算
export function applyQ10(effectiveTemp: number, q10Value: number, heatingBaseTemp: number): number {
  if (effectiveTemp <= 0 || q10Value === 1) return effectiveTemp
  const avgTempC  = effectiveTemp + BASE_TEMP
  const q10Factor = Math.pow(q10Value, (avgTempC - heatingBaseTemp) / 10)
  return effectiveTemp * q10Factor
}

// 場所名から1日あたりの有効積算温度を計算
function getDailyTemp(
  location: string,
  roomTemps: RoomTemps,
  weatherMap: Map<string, number>,
  dateKey: string,
): number {
  const m = location.match(TEMP_LOCATION_RE)
  if (m) {
    const naive = Math.max(Number(m[1]) - BASE_TEMP, 0)
    if (location.startsWith('暖房')) {
      const month = Number(dateKey.slice(5, 7))
      return naive * (HEATING_MONTHLY_FACTOR[month] ?? 1)
    }
    return naive
  }
  if (location === '冷蔵庫') return Math.max(roomTemps.fridgeTemp - BASE_TEMP, 0)
  // 常温: WeatherCacheから取得してQ10補正を適用。
  // 欠測日は同じ月日の過去平均 → それも無ければデフォルト
  const eff  = weatherMap.get(dateKey)
            ?? getMmddAverages(weatherMap).get(dateKey.slice(5))
            ?? DEFAULT_DAILY_TEMP
  const q10  = roomTemps.q10Value        ?? 1
  const base = roomTemps.heatingBaseTemp ?? DEFAULT_HEATING_BASE_TEMP
  return applyQ10(eff, q10, base)
}

// 指定日時点での場所を取得
function getLocationAtDate(history: LocationHistory[], date: Date): string {
  const d = startOfDay(date)
  const entry = history.find(h => {
    const start = startOfDay(new Date(h.startDate))
    const end = h.endDate ? startOfDay(new Date(h.endDate)) : null
    return start <= d && (end === null || d < end)
  })
  return entry?.location ?? '常温'
}

// 積算の終端日（today と untilDate の早いほう）
function accumulationEndDate(untilDate?: Date | null): Date {
  const today = startOfDay(new Date())
  if (!untilDate) return today
  const until = startOfDay(new Date(untilDate))
  return until < today ? until : today
}

// 積算温度を計算（仕込み日〜今日、または熟成終了日まで）
// untilDate を渡すと、その日で積算を打ち切る（完成ロットの熟成度が完成後も
// 伸び続けて「着色リスク高」になってしまうのを防ぐため。2026-08-28修正）
export function calcAccumulatedTemp(
  brewedAt: Date,
  locationHistory: LocationHistory[],
  weatherMap: Map<string, number>,
  roomTemps: RoomTemps = DEFAULT_ROOM_TEMPS,
  untilDate?: Date | null,
): number {
  const today = accumulationEndDate(untilDate)
  let current = startOfDay(new Date(brewedAt))
  let total = 0

  while (current <= today) {
    const location = getLocationAtDate(locationHistory, current)
    const dateKey  = format(current, 'yyyy-MM-dd')
    total += getDailyTemp(location, roomTemps, weatherMap, dateKey)
    current = addDays(current, 1)
  }

  return total
}

// 現在の場所を取得（endDateがないエントリ）
export function getCurrentLocation(history: LocationHistory[]): string {
  if (history.length === 0) return '不明'
  const active = history.find(h => h.endDate === null)
  return active?.location ?? history[history.length - 1].location
}

// 着色リスク判定
export function calcColoringRisk(
  accumulated: number,
  target: number
): 'normal' | 'warning' | 'danger' {
  const ratio = accumulated / target
  if (ratio >= 1.5) return 'danger'
  if (ratio >= 1.2) return 'warning'
  return 'normal'
}

// 日別積算温度の推移データ（グラフ用）
export function calcDailyAccumulation(
  brewedAt: Date,
  locationHistory: LocationHistory[],
  weatherMap: Map<string, number>,
  roomTemps: RoomTemps = DEFAULT_ROOM_TEMPS
): Array<{ date: string; accumulated: number }> {
  const today = startOfDay(new Date())
  let current = startOfDay(new Date(brewedAt))
  let total = 0
  const result: Array<{ date: string; accumulated: number }> = []

  while (current <= today) {
    const location = getLocationAtDate(locationHistory, current)
    const dateKey  = format(current, 'yyyy-MM-dd')
    total += getDailyTemp(location, roomTemps, weatherMap, dateKey)
    result.push({ date: dateKey, accumulated: Math.round(total * 10) / 10 })
    current = addDays(current, 1)
  }
  return result
}

// 各場所の期間ごとの積算加算量（タイムライン用）
export function calcPeriodAccumulations(
  locationHistory: LocationHistory[],
  weatherMap: Map<string, number>,
  roomTemps: RoomTemps = DEFAULT_ROOM_TEMPS
): Array<{ id: string; location: string; startDateISO: string; endDateISO: string | null; accumulated: number }> {
  const today = startOfDay(new Date())

  return locationHistory.map(period => {
    const start = startOfDay(new Date(period.startDate))
    const end   = period.endDate ? addDays(startOfDay(new Date(period.endDate)), -1) : today
    let accumulated = 0
    let current = new Date(start)
    while (current <= end) {
      const dateKey = format(current, 'yyyy-MM-dd')
      accumulated += getDailyTemp(period.location, roomTemps, weatherMap, dateKey)
      current = addDays(current, 1)
    }
    return {
      id:           period.id,
      location:     period.location,
      startDateISO: period.startDate.toISOString(),
      endDateISO:   period.endDate?.toISOString() ?? null,
      accumulated:  Math.round(accumulated * 10) / 10,
    }
  })
}

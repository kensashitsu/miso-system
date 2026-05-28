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

// WeatherCacheにデータがない日のデフォルト（℃/日、effectiveTemp相当）
const DEFAULT_DAILY_TEMP = 14

// 暖房・冷房・温調室（後方互換）から温度を抽出するパターン
const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)(\d+(?:\.\d+)?)℃$/

// 常温の有効積算温度にQ10補正を適用する
// effectiveTemp = max(avgTempC - 10, 0) を受け取り、Q10補正後の値を返す
// effectiveTemp > 0 のとき avgTempC = effectiveTemp + BASE_TEMP として逆算
function applyQ10(effectiveTemp: number, q10Value: number, heatingBaseTemp: number): number {
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
  if (m) return Math.max(Number(m[1]) - BASE_TEMP, 0)
  if (location === '冷蔵庫') return Math.max(roomTemps.fridgeTemp - BASE_TEMP, 0)
  // 常温: WeatherCacheから取得してQ10補正を適用、なければデフォルトを補正
  const eff  = weatherMap.get(dateKey) ?? DEFAULT_DAILY_TEMP
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

// 積算温度を計算（仕込み日〜今日）
export function calcAccumulatedTemp(
  brewedAt: Date,
  locationHistory: LocationHistory[],
  weatherMap: Map<string, number>,
  roomTemps: RoomTemps = DEFAULT_ROOM_TEMPS
): number {
  const today = startOfDay(new Date())
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

// 完成予定日を計算
export function calcEstimatedCompletion(
  accumulated: number,
  target: number,
  currentLocation: string,
  weatherMap: Map<string, number>,
  roomTemps: RoomTemps = DEFAULT_ROOM_TEMPS
): Date | null {
  if (accumulated >= target) return null

  const remaining = target - accumulated
  let dailyTemp: number

  const m = currentLocation.match(TEMP_LOCATION_RE)
  if (m) {
    dailyTemp = Math.max(Number(m[1]) - BASE_TEMP, 0)
  } else if (currentLocation === '冷蔵庫') {
    dailyTemp = Math.max(roomTemps.fridgeTemp - BASE_TEMP, 0)
  } else {
    // 常温: 直近30日の平均有効気温にQ10補正を適用して使用
    const q10  = roomTemps.q10Value        ?? 1
    const base = roomTemps.heatingBaseTemp ?? DEFAULT_HEATING_BASE_TEMP
    const values = Array.from(weatherMap.values())
    const recent = values.slice(-30)
    dailyTemp = recent.length > 0
      ? recent.map(v => applyQ10(v, q10, base)).reduce((a, b) => a + b, 0) / recent.length
      : applyQ10(DEFAULT_DAILY_TEMP, q10, base)
  }

  if (dailyTemp <= 0) return null
  return addDays(new Date(), Math.ceil(remaining / dailyTemp))
}

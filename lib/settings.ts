import { prisma } from './prisma'

// デフォルト値（後方互換のためエクスポートを残す）
export const KOJI_RATIO      = 1.2
export const KOME_KOJI_RATIO = 1.1
export const SOYBEAN_RATIO   = 2.3

// ==========================================
// 含水量・水分率 + 処理比率の設定
// ==========================================
export type MoistureSettings = {
  hadakaMugi:          number  // 裸麦の含水量（原料）
  mugiKoji:            number  // 麦麹の水分率（実測値・計算に使用）
  kome:                number  // 砕米・無洗米の含水量（原料）
  komeKoji:            number  // 米麹の水分率（実測値・計算に使用）
  soybean:             number  // 大豆の含水量（原料）→ 蒸煮大豆水分率を導出
  mizuame:             number  // 水飴の含水量
  seedMiso:            number  // 種味噌の含水量
  kojiRatio:           number  // 裸麦 → 麦麹（重量比）
  komeKojiRatio:       number  // 砕米・無洗米 → 米麹（重量比）
  soybeanRatio:        number  // 大豆 → 蒸煮大豆（重量比）
  room1Temp:           number  // 計画用参照温度: 暖房（仕込み計画・気象シミュレーター用）℃
  room2Temp:           number  // 計画用参照温度: 冷房（仕込み計画用）℃
  fridgeTemp:          number  // 冷蔵庫の設定温度 ℃（デフォルト6）
  heatingDefaultTemp:  number  // 場所移動時の暖房デフォルト温度 ℃（Q10の基準温度も兼ねる）
  coolingDefaultTemp:  number  // 場所移動時の冷房デフォルト温度 ℃
  q10Value:            number  // 常温熟成のQ10補正係数（デフォルト2.0）
  brewBufferDays:      number  // 仕込み計画バッファ日数（デフォルト14）
  yieldRate:           number  // 歩留まり率（小数: 0.95 = 95%）
}

export const DEFAULT_MOISTURE: MoistureSettings = {
  hadakaMugi:         0.13,
  mugiKoji:           0.31,
  kome:               0.14,
  komeKoji:           0.25,
  soybean:            0.14,
  mizuame:            0.20,
  seedMiso:           0.45,
  kojiRatio:          1.2,
  komeKojiRatio:      1.1,
  soybeanRatio:       2.3,
  room1Temp:          24,
  room2Temp:          20,
  fridgeTemp:         6,
  heatingDefaultTemp: 25,
  coolingDefaultTemp: 20,
  q10Value:           2.0,
  brewBufferDays:     14,
  yieldRate:          0.95,
}

// ==========================================
// 理論値の導出（設定画面での参考表示用）
// ratio を省略するとデフォルト値を使用
// ==========================================
export function calcMugiKojiMoisture(rawMoisture: number, ratio = KOJI_RATIO): number {
  return ((ratio - 1) + rawMoisture) / ratio
}

export function calcKomeKojiMoisture(rawMoisture: number, ratio = KOME_KOJI_RATIO): number {
  return ((ratio - 1) + rawMoisture) / ratio
}

export function calcMushiSoybeanMoisture(rawMoisture: number, ratio = SOYBEAN_RATIO): number {
  return ((ratio - 1) + rawMoisture) / ratio
}

// ==========================================
// DB 読み書き
// ==========================================
const KEYS = Object.keys(DEFAULT_MOISTURE) as (keyof MoistureSettings)[]
const dbKey = (k: keyof MoistureSettings) => `moisture_${k}`

export async function getMoistureSettings(): Promise<MoistureSettings> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: KEYS.map(dbKey) } },
  })
  const map = Object.fromEntries(rows.map(r => [r.key, parseFloat(r.value)]))
  return {
    hadakaMugi:    map[dbKey('hadakaMugi')]    ?? DEFAULT_MOISTURE.hadakaMugi,
    mugiKoji:      map[dbKey('mugiKoji')]      ?? DEFAULT_MOISTURE.mugiKoji,
    kome:          map[dbKey('kome')]          ?? DEFAULT_MOISTURE.kome,
    komeKoji:      map[dbKey('komeKoji')]      ?? DEFAULT_MOISTURE.komeKoji,
    soybean:       map[dbKey('soybean')]       ?? DEFAULT_MOISTURE.soybean,
    mizuame:       map[dbKey('mizuame')]       ?? DEFAULT_MOISTURE.mizuame,
    seedMiso:      map[dbKey('seedMiso')]      ?? DEFAULT_MOISTURE.seedMiso,
    kojiRatio:     map[dbKey('kojiRatio')]     ?? DEFAULT_MOISTURE.kojiRatio,
    komeKojiRatio: map[dbKey('komeKojiRatio')] ?? DEFAULT_MOISTURE.komeKojiRatio,
    soybeanRatio:  map[dbKey('soybeanRatio')]  ?? DEFAULT_MOISTURE.soybeanRatio,
    room1Temp:          map[dbKey('room1Temp')]          ?? DEFAULT_MOISTURE.room1Temp,
    room2Temp:          map[dbKey('room2Temp')]          ?? DEFAULT_MOISTURE.room2Temp,
    fridgeTemp:         map[dbKey('fridgeTemp')]         ?? DEFAULT_MOISTURE.fridgeTemp,
    heatingDefaultTemp: map[dbKey('heatingDefaultTemp')] ?? DEFAULT_MOISTURE.heatingDefaultTemp,
    coolingDefaultTemp: map[dbKey('coolingDefaultTemp')] ?? DEFAULT_MOISTURE.coolingDefaultTemp,
    q10Value:           map[dbKey('q10Value')]           ?? DEFAULT_MOISTURE.q10Value,
    brewBufferDays:     map[dbKey('brewBufferDays')]     ?? DEFAULT_MOISTURE.brewBufferDays,
    yieldRate:          map[dbKey('yieldRate')]          ?? DEFAULT_MOISTURE.yieldRate,
  }
}

export async function saveMoistureSettings(settings: MoistureSettings): Promise<void> {
  await prisma.$transaction(
    KEYS.map(k =>
      prisma.systemSetting.upsert({
        where:  { key: dbKey(k) },
        create: { key: dbKey(k), value: String(settings[k]) },
        update: { value: String(settings[k]) },
      })
    )
  )
}

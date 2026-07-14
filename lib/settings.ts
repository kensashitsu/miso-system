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

// ==========================================
// 桶使用記録のプルダウン選択肢（製品名・操作者名）
// SystemSetting に JSON 文字列配列で保存
// ==========================================
export type BucketUsageOptions = {
  // 品種名 → その品種で使う製品名リスト
  productNamesByType: Record<string, string[]>
  operatorNames:      string[]
}

export const DEFAULT_BUCKET_USAGE_OPTIONS: BucketUsageOptions = {
  productNamesByType: {},
  operatorNames:      [],
}

const BUCKET_PRODUCT_KEY  = 'bucket_productNames'
const BUCKET_OPERATOR_KEY = 'bucket_operatorNames'

function dedupeList(arr: string[]): string[] {
  return Array.from(new Set(arr.map(v => String(v).trim()).filter(v => v.length > 0)))
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return []
  try {
    const arr = JSON.parse(value)
    if (Array.isArray(arr)) return dedupeList(arr.map(String))
  } catch {
    // 不正なJSONは空扱い
  }
  return []
}

function parseProductMap(value: string | undefined): Record<string, string[]> {
  if (!value) return {}
  try {
    const obj = JSON.parse(value)
    // 旧形式（フラットな配列）は品種未分類として無視し、空マップから開始
    if (Array.isArray(obj)) return {}
    if (obj && typeof obj === 'object') {
      const out: Record<string, string[]> = {}
      for (const [type, list] of Object.entries(obj)) {
        if (Array.isArray(list)) out[type] = dedupeList(list.map(String))
      }
      return out
    }
  } catch {
    // 不正なJSONは空扱い
  }
  return {}
}

export async function getBucketUsageOptions(): Promise<BucketUsageOptions> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: [BUCKET_PRODUCT_KEY, BUCKET_OPERATOR_KEY] } },
  })
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    productNamesByType: parseProductMap(map[BUCKET_PRODUCT_KEY]),
    operatorNames:      parseStringList(map[BUCKET_OPERATOR_KEY]),
  }
}

export async function saveBucketUsageOptions(options: BucketUsageOptions): Promise<void> {
  // 重複・空白を除去して保存（品種ごとにdedupe・空リストの品種は落とす）
  const cleanedMap: Record<string, string[]> = {}
  for (const [type, list] of Object.entries(options.productNamesByType)) {
    const cleaned = dedupeList(list)
    if (cleaned.length > 0) cleanedMap[type] = cleaned
  }
  const productJson  = JSON.stringify(cleanedMap)
  const operatorJson = JSON.stringify(dedupeList(options.operatorNames))
  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where:  { key: BUCKET_PRODUCT_KEY },
      create: { key: BUCKET_PRODUCT_KEY, value: productJson },
      update: { value: productJson },
    }),
    prisma.systemSetting.upsert({
      where:  { key: BUCKET_OPERATOR_KEY },
      create: { key: BUCKET_OPERATOR_KEY, value: operatorJson },
      update: { value: operatorJson },
    }),
  ])
}

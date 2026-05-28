/**
 * SQLite → Supabase (PostgreSQL) データ移行スクリプト
 * 使い方: npx tsx scripts/migrate-to-supabase.ts
 */
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import Database from 'better-sqlite3'
import { createClient } from '@supabase/supabase-js'

const DB_PATH = path.resolve(process.cwd(), 'prisma', 'dev.db')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true })
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// SQLiteでbooleanが0/1で保存されるフィールド
const BOOL_FIELDS: Record<string, string[]> = {
  MisoRecipe:      ['isActive'],
  IngredientAlert: ['resolved'],
}

// SQLiteでDateTimeがUnixタイムスタンプ(ms)で保存されるフィールド
const DATETIME_FIELDS: Record<string, string[]> = {
  WeatherCache:    ['date'],
  Lot:             ['brewedAt', 'completedAt', 'createdAt'],
  BrewRecord:      ['soybeanArrivalDate', 'kojiMadeAt'],
  LocationHistory: ['startDate', 'endDate'],
  AgingNote:       ['recordedAt'],
  BrewDiary:       ['recordedAt'],
  SeedMisoUsage:   ['usedAt'],
  PackagingLot:    ['expiryDate', 'alcoholAddedAt', 'filledAt', 'createdAt'],
  Bucket:          ['createdAt'],
  BucketUsage:     ['usedAt', 'createdAt'],
  IngredientAlert: ['createdAt'],
  MisoRecipe:      ['createdAt', 'updatedAt'],
  SystemSetting:   ['updatedAt'],
  ShipmentHistory: ['importedAt'],
  ForecastCache:   ['updatedAt'],
}

function readTable(tableName: string): Record<string, unknown>[] {
  try {
    const rows = db.prepare(`SELECT * FROM "${tableName}"`).all() as Record<string, unknown>[]
    const bools = BOOL_FIELDS[tableName] ?? []
    const datetimes = DATETIME_FIELDS[tableName] ?? []

    return rows.map(row => {
      const out = { ...row }
      // 0/1 → boolean
      for (const f of bools) {
        if (f in out) out[f] = out[f] === 1 || out[f] === true
      }
      // Unix ms → ISO string（nullはそのまま）
      for (const f of datetimes) {
        if (out[f] !== null && out[f] !== undefined) {
          const ms = Number(out[f])
          if (!isNaN(ms)) out[f] = new Date(ms).toISOString()
        }
      }
      return out
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`  ⚠️  ${tableName} 読み取り失敗: ${msg}`)
    return []
  }
}

async function upsertTable(
  tableName: string,
  conflictKey: string,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) {
    console.log(`  ⏭  ${tableName}: データなし`)
    return
  }

  const CHUNK = 200
  let total = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from(tableName)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .upsert(chunk as any, { onConflict: conflictKey })
    if (error) {
      throw new Error(`[${tableName}] upsert失敗: ${error.message}`)
    }
    total += chunk.length
  }
  console.log(`  ✅ ${tableName}: ${total}件`)
}

// FK依存順（依存のないテーブルが先、子テーブルが後）
const TABLES: { name: string; pk: string }[] = [
  { name: 'WeatherCache',    pk: 'date' },
  { name: 'MisoRecipe',      pk: 'id' },
  { name: 'SystemSetting',   pk: 'key' },
  { name: 'ForecastCache',   pk: 'misoType,yearMonth' },
  { name: 'ShipmentHistory', pk: 'id' },
  { name: 'Lot',             pk: 'id' },
  { name: 'BrewRecord',      pk: 'id' },
  { name: 'LocationHistory', pk: 'id' },
  { name: 'AgingNote',       pk: 'id' },
  { name: 'BrewDiary',       pk: 'id' },
  { name: 'PackagingLot',    pk: 'id' },
  { name: 'SeedMisoUsage',   pk: 'id' },
  { name: 'Bucket',          pk: 'id' },
  { name: 'BucketUsage',     pk: 'id' },
  { name: 'IngredientAlert', pk: 'id' },
]

async function main() {
  console.log('=== SQLite → Supabase データ移行 ===')
  console.log(`SQLite: ${DB_PATH}`)
  console.log(`Supabase: ${supabaseUrl}\n`)

  let totalRows = 0
  for (const { name, pk } of TABLES) {
    const rows = readTable(name)
    await upsertTable(name, pk, rows)
    totalRows += rows.length
  }

  db.close()
  console.log(`\n完了！合計 ${totalRows} 件を移行しました。`)
}

main().catch(e => {
  console.error('\n❌ 移行エラー:', e instanceof Error ? e.message : e)
  process.exit(1)
})

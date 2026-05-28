'use server'

import { addDays, format } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getMisoRecipes } from '@/lib/recipes'
import { getMoistureSettings } from '@/lib/settings'

export interface ShikomiRow {
  brewedAt:        string  // YYYY-MM-DD
  useStartAt:      string  // YYYY-MM-DD or empty
  storageDays:     string
  bucketNumbers:   string  // "1・2" or single "13" or empty
  misoType:        string
  mugiKg:          number
  kojiKg:          number
  daizuKg:         number
  shioKg:          number
  mizuameKg:       number
  taneMizuL:       number
  shikomiKg:       number
  daizuOrigin:     string
  airTempC:        string
  productTempC:    string
  kojiCondition:   string
  soybeanHardness: string
  seedMisoKg:      number
  memo:            string
}

export interface ShikomiImportResult {
  success: number
  skipped: number
  errors:  { row: number; message: string }[]
}

// 品種ごとのデフォルト目標積算温度（MisoRecipeにない場合のフォールバック）
function defaultTempSum(misoType: string): number {
  if (misoType.includes('山吹')) return 490
  if (misoType === '白みそ')     return 70
  return 700
}

export async function importShikomiData(rows: ShikomiRow[]): Promise<ShikomiImportResult> {
  const [recipes, { yieldRate }] = await Promise.all([
    getMisoRecipes(),
    getMoistureSettings(),
  ])
  const recipeMap = new Map(recipes.map(r => [r.name, r]))

  let success = 0
  let skipped = 0
  const errors: { row: number; message: string }[] = []

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i]
    const rowNum = i + 2  // ヘッダー行 +1・1始まりの行番号

    try {
      // 日付バリデーション
      const brewDate = new Date(row.brewedAt)
      if (isNaN(brewDate.getTime())) {
        errors.push({ row: rowNum, message: `仕込み日が不正: ${row.brewedAt}` })
        continue
      }
      if (!row.misoType) {
        errors.push({ row: rowNum, message: '品種が空欄です' })
        continue
      }
      if (!row.shikomiKg || row.shikomiKg <= 0) {
        errors.push({ row: rowNum, message: `仕立量が不正: ${row.shikomiKg}` })
        continue
      }

      // 重複チェック（仕込み日・品種・桶番号の組み合わせ）
      const existing = await prisma.lot.findFirst({
        where: {
          brewedAt:      brewDate,
          misoType:      row.misoType,
          bucketNumbers: row.bucketNumbers || null,
        },
      })
      if (existing) { skipped++; continue }

      // ロット番号採番（YYYYMM-XXX）
      const ym    = format(brewDate, 'yyyyMM')
      const count = await prisma.lot.count({
        where: { lotNumber: { startsWith: `${ym}-` } },
      })
      const lotNumber = `${ym}-${String(count + 1).padStart(3, '0')}`

      // 目標積算温度
      const recipe      = recipeMap.get(row.misoType)
      const targetTempSum = recipe?.targetTempSum ?? defaultTempSum(row.misoType)

      // ステータス・完成日
      // 優先順: useStartAt → storageDays（仕込み日 + 熟成日数）→ null
      const useStartAt     = row.useStartAt ? new Date(row.useStartAt) : null
      const storageDaysNum = parseInt(row.storageDays)
      const storageDaysDate = (!useStartAt && !isNaN(storageDaysNum) && storageDaysNum > 0)
        ? addDays(brewDate, storageDaysNum)
        : null
      const status      = useStartAt ? '出荷済' : '完成'
      const completedAt = useStartAt ?? storageDaysDate

      // ── Lot + BrewRecord + LocationHistory を1トランザクションで作成 ──
      const lot = await prisma.$transaction(async (tx) => {
        return tx.lot.create({
          data: {
            lotNumber,
            misoType:      row.misoType,
            brewedAt:      brewDate,
            totalWeightKg: row.shikomiKg,
            targetTempSum,
            status,
            completedAt,
            bucketNumbers: row.bucketNumbers || null,
            brewRecord: {
              create: {
                mugiOrKomeKg:    row.mugiKg,
                kojiKg:          row.kojiKg,
                soybeanKg:       row.daizuKg,
                saltKg:          row.shioKg,
                mizuameKg:       row.mizuameKg   || 0,
                seedWaterL:      row.taneMizuL   || 0,
                shikomiKg:       row.shikomiKg,
                soybeanOrigin:   row.daizuOrigin || null,
                airTempC:        row.airTempC      ? parseFloat(row.airTempC)      : null,
                productTempC:    row.productTempC  ? parseFloat(row.productTempC)  : null,
                kojiCondition:   row.kojiCondition ? parseInt(row.kojiCondition)   : null,
                soybeanHardness: row.soybeanHardness || null,
                seedMisoKg:      row.seedMisoKg  || 0,
                memo:            row.memo         || null,
              },
            },
            locationHistory: {
              create: {
                location:  '暖房24℃',
                startDate: brewDate,
                endDate:   completedAt,
              },
            },
          },
        })
      })

      // ── 桶の生成（SQLite createMany 制限のためトランザクション外で個別作成）──
      if (row.bucketNumbers) {
        const isShiro = row.misoType === '白みそ'
        if (isShiro) {
          const num = parseInt(row.bucketNumbers)
          if (!isNaN(num)) {
            await prisma.bucket.create({
              data: {
                lotId:           lot.id,
                bucketNumber:    num,
                initialWeightKg: Math.floor(row.shikomiKg * yieldRate),
                status:          '空',
              },
            })
          }
        } else {
          const parts = row.bucketNumbers.split('・').map(s => parseInt(s.trim()))
          if (parts.length === 2 && parts.every(n => !isNaN(n))) {
            const half = Math.floor(row.shikomiKg * yieldRate / 2)
            await prisma.bucket.create({
              data: { lotId: lot.id, bucketNumber: parts[0], initialWeightKg: half, status: '空' },
            })
            await prisma.bucket.create({
              data: { lotId: lot.id, bucketNumber: parts[1], initialWeightKg: half, status: '空' },
            })
          } else if (parts.length === 1 && !isNaN(parts[0])) {
            // 単一桶（品種によって1桶のケース）
            await prisma.bucket.create({
              data: {
                lotId:           lot.id,
                bucketNumber:    parts[0],
                initialWeightKg: Math.floor(row.shikomiKg * yieldRate),
                status:          '空',
              },
            })
          }
        }
      }

      success++
    } catch (e) {
      errors.push({ row: rowNum, message: String(e) })
    }
  }

  if (success > 0) {
    revalidatePath('/')
    revalidatePath('/lots')
  }

  return { success, skipped, errors }
}

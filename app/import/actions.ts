'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'

export interface ImportRow {
  yearMonth: string  // "YYYY-MM"
  weightKg:  number
}

export interface ImportResult {
  success: number
  error?:  string
}

export interface BrandedImportRow {
  yearMonth: string
  misoType:  string
  weightKg:  number
}

export interface BrandedImportResult {
  successByBrand: Record<string, number>
  totalSuccess:   number
  error?:         string
}

export async function importBrandedShipmentHistory(
  rows: BrandedImportRow[],
): Promise<BrandedImportResult> {
  if (rows.length === 0) return { successByBrand: {}, totalSuccess: 0 }
  try {
    await prisma.$transaction(
      rows.map(row =>
        prisma.shipmentHistory.upsert({
          where:  { yearMonth_misoType: { yearMonth: row.yearMonth, misoType: row.misoType } },
          update: { weightKg: row.weightKg, importedAt: new Date() },
          create: { yearMonth: row.yearMonth, misoType: row.misoType, weightKg: row.weightKg },
        }),
      ),
    )
    const successByBrand: Record<string, number> = {}
    for (const row of rows) {
      successByBrand[row.misoType] = (successByBrand[row.misoType] ?? 0) + 1
    }
    revalidatePath('/import')
    revalidatePath('/planning')
    return { successByBrand, totalSuccess: rows.length }
  } catch (e) {
    console.error('品種別インポートエラー:', e)
    return { successByBrand: {}, totalSuccess: 0, error: '保存中にエラーが発生しました。' }
  }
}

export async function importShipmentHistory(rows: ImportRow[]): Promise<ImportResult> {
  if (rows.length === 0) return { success: 0 }
  try {
    await prisma.$transaction(
      rows.map(row =>
        prisma.shipmentHistory.upsert({
          where: {
            yearMonth_misoType: { yearMonth: row.yearMonth, misoType: '全品種合計' },
          },
          update: { weightKg: row.weightKg, importedAt: new Date() },
          create: { yearMonth: row.yearMonth, misoType: '全品種合計', weightKg: row.weightKg },
        }),
      ),
    )
    revalidatePath('/import')
    revalidatePath('/planning')
    return { success: rows.length }
  } catch (e) {
    console.error('出荷実績インポートエラー:', e)
    return { success: 0, error: '保存中にエラーが発生しました。' }
  }
}

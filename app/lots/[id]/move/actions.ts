'use server'

import { format } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { adjustStock } from '@/lib/externalApi'

const STATIC_LOCATIONS = ['常温', '冷蔵庫'] as const
const TEMP_LOCATION_RE = /^(?:暖房|冷房|温調室)\d+(?:\.\d+)?℃$/

function isValidLocation(loc: string): boolean {
  return (STATIC_LOCATIONS as readonly string[]).includes(loc) || TEMP_LOCATION_RE.test(loc)
}

export async function moveLot(
  lotId: string,
  newLocation: string,
  moveDateStr: string,
  markAsComplete: boolean = false,
  skipStockUpdate: boolean = false,
): Promise<{ success?: true; error?: string }> {
  if (!isValidLocation(newLocation)) {
    return { error: '不正な場所です。' }
  }

  const moveDate = new Date(moveDateStr)
  if (isNaN(moveDate.getTime())) {
    return { error: '日付が不正です。' }
  }

  // markAsComplete 時は在庫調整に必要な情報を事前に取得
  let lotInfo: {
    misoType: string; lotNumber: string; isPrototype: boolean
    yieldRate: number | null; brewedAt: Date; bucketNumbers: string | null
  } | null = null
  let shikomiKg: number | null = null
  if (markAsComplete) {
    const [lot, brewRecord] = await Promise.all([
      prisma.lot.findUnique({
        where:  { id: lotId },
        select: { misoType: true, lotNumber: true, isPrototype: true, yieldRate: true, brewedAt: true, bucketNumbers: true },
      }),
      prisma.brewRecord.findUnique({ where: { lotId }, select: { shikomiKg: true } }),
    ])
    lotInfo  = lot
    shikomiKg = brewRecord?.shikomiKg ?? null
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 現在アクティブな場所履歴（endDateがnull）のendDateに移動日をセット
      await tx.locationHistory.updateMany({
        where: { lotId, endDate: null },
        data:  { endDate: moveDate },
      })

      // 新しい場所履歴を作成
      await tx.locationHistory.create({
        data: { lotId, location: newLocation, startDate: moveDate, endDate: null },
      })

      // 同時に熟成完了とする場合はステータスを「完成」に変更
      if (markAsComplete) {
        await tx.lot.update({
          where: { id: lotId },
          data:  { status: '完成', completedAt: moveDate },
        })
      }
    })

    // 熟成完了時：外部在庫システムへ通知（熟成中→熟成済 の在庫移動）
    // 試作品・スキップ指定・情報取得失敗時はスキップ
    if (markAsComplete && !skipStockUpdate && lotInfo && !lotInfo.isPrototype && shikomiKg !== null) {
      const settings = await getMoistureSettings()
      const effectiveYieldRate = lotInfo.yieldRate ?? settings.yieldRate
      const yieldKg = Math.floor(shikomiKg * effectiveYieldRate)
      const noteParts: string[] = []
      if (lotInfo.bucketNumbers) noteParts.push(`桶: ${lotInfo.bucketNumbers}`)
      noteParts.push(`仕込み: ${format(lotInfo.brewedAt, 'yyyy/MM/dd')}`)
      noteParts.push(`完成: ${format(moveDate, 'yyyy/MM/dd')}`)
      const agingDays = Math.floor((moveDate.getTime() - lotInfo.brewedAt.getTime()) / (1000 * 60 * 60 * 24))
      noteParts.push(`熟成日数: ${agingDays}日`)
      const completionNotes = noteParts.join(' / ')
      await Promise.all([
        adjustStock({ misoType: lotInfo.misoType, category: 'wip',  deltaKg: -yieldKg, lotNumber: lotInfo.lotNumber, notes: completionNotes }).catch(e => console.error('wip在庫調整エラー:', e)),
        adjustStock({ misoType: lotInfo.misoType, category: 'aged', deltaKg:  yieldKg, lotNumber: lotInfo.lotNumber, notes: completionNotes }).catch(e => console.error('aged在庫調整エラー:', e)),
      ])
    }

    revalidatePath(`/lots/${lotId}`)
    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('場所移動エラー:', e)
    return { error: '保存中にエラーが発生しました。' }
  }
}

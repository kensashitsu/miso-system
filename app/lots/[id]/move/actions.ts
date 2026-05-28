'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'

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
): Promise<{ success?: true; error?: string }> {
  if (!isValidLocation(newLocation)) {
    return { error: '不正な場所です。' }
  }

  const moveDate = new Date(moveDateStr)
  if (isNaN(moveDate.getTime())) {
    return { error: '日付が不正です。' }
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

    revalidatePath(`/lots/${lotId}`)
    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('場所移動エラー:', e)
    return { error: '保存中にエラーが発生しました。' }
  }
}

'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

// ロット登録と同じ桶番号プール（1・2〜29・30、計15ペア）
const BUCKET_PAIRS = Array.from({ length: 15 }, (_, i) => `${i * 2 + 1}・${i * 2 + 2}`)

function nextBucketNumbers(last: string | null, isWhiteMiso: boolean): string {
  if (!last) return isWhiteMiso ? '1' : BUCKET_PAIRS[0]

  const nums = last.split('・').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
  const maxNum = nums.length > 0 ? Math.max(...nums) : 0

  if (isWhiteMiso) {
    // 白みそ: 1桶。最大番号の次（30を超えたら1に戻る）
    return String(maxNum >= 30 ? 1 : maxNum + 1)
  }

  // 非白みそ: 2桶ペア。lastがペア形式なら次のペアへ
  const idx = BUCKET_PAIRS.indexOf(last)
  if (idx !== -1) return BUCKET_PAIRS[(idx + 1) % 15]
  // 直前がペア形式でない場合（白みその単一桶など）
  const next1 = maxNum >= 30 ? 1 : maxNum + 1
  const next2 = next1 >= 30 ? 1 : next1 + 1
  return `${next1}・${next2}`
}

export async function createBrewPlan(data: {
  misoType:                 string
  brewDateISO:              string
  completionDateISO:        string
  fermentationDays:         number
  location:                 string
  materialOrderDeadlineISO: string
}): Promise<{ id: string }> {
  // 桶番号の自動計算: 仮登録プラン（brewDate降順）→ 既存ロット（createdAt降順）の順で最後の桶番号を取得
  const [lastPlan, lastLot] = await Promise.all([
    prisma.brewPlan.findFirst({
      where:   { bucketNumbers: { not: null } },
      orderBy: { brewDate: 'desc' },
      select:  { bucketNumbers: true },
    }),
    prisma.lot.findFirst({
      where:   { bucketNumbers: { not: null } },
      orderBy: { createdAt: 'desc' },
      select:  { bucketNumbers: true },
    }),
  ])
  const lastBuckets   = lastPlan?.bucketNumbers ?? lastLot?.bucketNumbers ?? null
  const isWhiteMiso   = data.misoType === '白みそ'
  const bucketNumbers = nextBucketNumbers(lastBuckets, isWhiteMiso)

  const plan = await prisma.brewPlan.create({
    data: {
      misoType:              data.misoType,
      brewDate:              new Date(data.brewDateISO),
      completionDate:        new Date(data.completionDateISO),
      fermentationDays:      data.fermentationDays,
      location:              data.location,
      materialOrderDeadline: new Date(data.materialOrderDeadlineISO),
      bucketNumbers,
    },
  })
  revalidatePath('/planning')
  return { id: plan.id }
}

export async function deleteBrewPlan(id: string): Promise<void> {
  await prisma.brewPlan.delete({ where: { id } })
  revalidatePath('/planning')
}

export async function markBrewPlanRegistered(id: string, lotId: string): Promise<void> {
  await prisma.brewPlan.update({
    where: { id },
    data: { status: '本登録済', lotId },
  }).catch(() => {})
}

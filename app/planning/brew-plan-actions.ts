'use server'

import { addDays, format } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getMoistureSettings } from '@/lib/settings'
import {
  simulateFermentationDays, getDailyAccum, ORDER_LEAD_DAYS, DEFAULT_ORDER_LEAD_DAYS,
} from '@/lib/brewPlanCalc'

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
  // ペア形式でない場合（白みその単一桶など）
  const next1 = maxNum >= 30 ? 1 : maxNum + 1
  const next2 = next1 >= 30 ? 1 : next1 + 1
  return `${next1}・${next2}`
}

// 仮登録プランを brewDate 昇順に並べ直して桶番号を再採番する
async function resequencePendingPlans(): Promise<void> {
  // 固定済みの最後の桶番号: 本登録済プラン（brewDate降順）→ 既存ロット（createdAt降順）
  const [lastDonePlan, lastLot] = await Promise.all([
    prisma.brewPlan.findFirst({
      where:   { status: '本登録済', bucketNumbers: { not: null } },
      orderBy: { brewDate: 'desc' },
      select:  { bucketNumbers: true },
    }),
    prisma.lot.findFirst({
      where:   { bucketNumbers: { not: null } },
      orderBy: { createdAt: 'desc' },
      select:  { bucketNumbers: true },
    }),
  ])
  const base = lastDonePlan?.bucketNumbers ?? lastLot?.bucketNumbers ?? null

  // 仮登録プランをbrewDate昇順で全取得
  const pending = await prisma.brewPlan.findMany({
    where:   { status: '仮登録' },
    orderBy: { brewDate: 'asc' },
    select:  { id: true, misoType: true },
  })
  if (pending.length === 0) return

  // 順番に採番してDB更新
  let last = base
  for (const plan of pending) {
    const bucketNumbers = nextBucketNumbers(last, plan.misoType === '白みそ')
    await prisma.brewPlan.update({
      where: { id: plan.id },
      data:  { bucketNumbers },
    })
    last = bucketNumbers
  }
}

export async function createBrewPlan(data: {
  misoType:                 string
  brewDateISO:              string
  completionDateISO:        string
  fermentationDays:         number
  location:                 string
  materialOrderDeadlineISO: string
}): Promise<{ id: string }> {
  const plan = await prisma.brewPlan.create({
    data: {
      misoType:              data.misoType,
      brewDate:              new Date(data.brewDateISO),
      completionDate:        new Date(data.completionDateISO),
      fermentationDays:      data.fermentationDays,
      location:              data.location,
      materialOrderDeadline: new Date(data.materialOrderDeadlineISO),
      bucketNumbers:         null,  // resequencePendingPlans で上書き
    },
  })
  await resequencePendingPlans()
  revalidatePath('/', 'layout')
  return { id: plan.id }
}

// 仮登録の仕込み予定日を後から変える。
// 現場の都合で日をずらすことは普通にあるが、これまでは消して登録し直すしかなかった。
// 日付だけ書き換えると完成予定日・熟成日数・原料手配締切が古いままになるので、
// 提案時と同じ計算（常温はその日の季節でQ10シミュレーション／それ以外は固定レート）で
// まとめて引き直す。桶番号も仕込み日順に採番し直す。
export async function updateBrewPlanBrewDate(
  id:          string,
  brewDateISO: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await prisma.brewPlan.findUnique({ where: { id } })
  if (!plan) return { ok: false, error: '仮登録が見つかりません' }
  if (plan.status !== '仮登録') return { ok: false, error: '本登録済みの予定は変更できません' }

  const brewDate = new Date(brewDateISO)
  if (isNaN(brewDate.getTime())) return { ok: false, error: '日付が正しくありません' }

  const [moisture, recipe, weather] = await Promise.all([
    getMoistureSettings(),
    prisma.misoRecipe.findUnique({ where: { name: plan.misoType } }),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])
  if (!recipe) return { ok: false, error: `レシピ（${plan.misoType}）が見つかりません` }

  // MM-dd別の有効積算温度平均（他画面と同じ作り方）
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weather) {
    const key = format(w.date, 'MM-dd')
    const e   = totals.get(key) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    totals.set(key, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of totals) weatherAvg[key] = Math.round((sum / count) * 100) / 100
  const weatherAvgValues = Object.values(weatherAvg)

  let fermentationDays: number
  let completionDate:   Date
  if (plan.location === '常温') {
    // 常温は仕込み日の季節で熟成の速さが変わるため、日ごとに積み上げて完成日を出す。
    // 10〜5月は暖房レートへ切り替える（提案時と同じ扱い）
    const fallback = weatherAvgValues.length > 0
      ? weatherAvgValues.reduce((a, b) => a + b, 0) / weatherAvgValues.length
      : 14
    const r = simulateFermentationDays(
      brewDate, recipe.targetTempSum, weatherAvg, fallback,
      moisture.q10Value, moisture.heatingDefaultTemp,
      Math.max(moisture.heatingDefaultTemp - 10, 0),
    )
    fermentationDays = r.days
    completionDate   = r.completionDate
  } else {
    const dailyAccum = getDailyAccum(
      plan.location, moisture.fridgeTemp, weatherAvgValues,
      moisture.q10Value, moisture.heatingDefaultTemp,
    )
    if (dailyAccum <= 0) return { ok: false, error: `${plan.location}では熟成が進まないため完成予定日を出せません` }
    fermentationDays = Math.ceil(recipe.targetTempSum / dailyAccum)
    completionDate   = addDays(brewDate, fermentationDays)
  }

  const leadDays = ORDER_LEAD_DAYS[plan.misoType] ?? DEFAULT_ORDER_LEAD_DAYS

  await prisma.brewPlan.update({
    where: { id },
    data: {
      brewDate,
      completionDate,
      fermentationDays,
      materialOrderDeadline: addDays(brewDate, -leadDays),
    },
  })
  await resequencePendingPlans()
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function deleteBrewPlan(id: string): Promise<void> {
  await prisma.brewPlan.delete({ where: { id } })
  await resequencePendingPlans()
  revalidatePath('/', 'layout')
}

export async function deleteBrewPlans(ids: string[]): Promise<void> {
  await prisma.brewPlan.deleteMany({ where: { id: { in: ids } } })
  await resequencePendingPlans()
  revalidatePath('/', 'layout')
}

// 原料の手配が済んだかどうかを切り替える。
// これが無いと、ダッシュボードの「原料手配の締切」がロット登録するまで永遠に出続け、
// 壁紙化して読み飛ばされる（2026-08-31ユーザー指摘）
export async function setBrewPlanMaterialOrdered(id: string, ordered: boolean): Promise<void> {
  await prisma.brewPlan.update({
    where: { id },
    data:  { materialOrderedAt: ordered ? new Date() : null },
  })
  revalidatePath('/', 'layout')
}

export async function markBrewPlanRegistered(id: string, lotId: string): Promise<void> {
  await prisma.brewPlan.update({
    where: { id },
    data: { status: '本登録済', lotId },
  }).catch(() => {})
}

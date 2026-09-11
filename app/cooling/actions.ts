'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { parseProductTemp, COOLING_TO_BREW_DAYS, GRAIN_TYPES } from '@/lib/cooling'

const numberOrNull = z.union([z.number(), z.null()]).default(null)

const stepSchema = z.object({
  fan:            numberOrNull,
  belt:           numberOrNull,
  productTempRaw: z.string().nullish(),   // 「37～38」のような幅の書き方をそのまま受ける
  memo:           z.string().nullish(),
})

const schema = z.object({
  runDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付を入力してください'),
  grainType:  z.enum(GRAIN_TYPES),
  airTemp1FC: numberOrNull,
  airTemp2FC: numberOrNull,
  roomTempC:  numberOrNull,
  memo:       z.string().nullish(),
  steps:      z.array(stepSchema),
})

export type CoolingResult = { success?: true; errors?: Record<string, string>; globalError?: string }

/** DBは日付をUTCの0時で持っている（ロットのbrewedAtと揃える） */
function toUtcDate(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * 放冷の2日後に仕込んだロットを探す。
 * 放冷の時点ではロットがまだ登録されていないので、見つからなければ null のまま保存し、
 * あとでロットが登録されたときに紐付け直す（relinkCoolingRuns）。
 */
async function findLotForRun(runDate: Date, grainType: string) {
  const brewDate = new Date(runDate.getTime() + COOLING_TO_BREW_DAYS * 86400000)
  const lots = await prisma.lot.findMany({
    where:  { brewedAt: brewDate },
    select: { id: true, misoType: true },
  })
  if (lots.length === 1) return lots[0].id
  if (lots.length === 0) return null
  // 同じ日に複数仕込んだ日は原料で絞る（砕米＝米を使う品種）
  const RICE_TYPES = ['山吹みそ', '白みそ']
  const narrowed = lots.filter(l =>
    grainType === '砕米' ? RICE_TYPES.includes(l.misoType) : !RICE_TYPES.includes(l.misoType)
  )
  return narrowed.length === 1 ? narrowed[0].id : null
}

export async function saveCoolingRun(input: unknown): Promise<CoolingResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[k] = msgs[0]
    }
    return { errors }
  }
  const { runDate, grainType, airTemp1FC, airTemp2FC, roomTempC, memo, steps } = parsed.data
  const date = toUtcDate(runDate)

  // 何も書かれていない行は捨てる（行を足したまま埋めなかった場合）
  const filled = steps.filter(s =>
    s.fan !== null || s.belt !== null || (s.productTempRaw ?? '').trim() !== '' || (s.memo ?? '').trim() !== ''
  )
  if (filled.length === 0) return { globalError: 'ファン・ベルト・品温のいずれかを入力してください。' }

  try {
    const lotId = await findLotForRun(date, grainType)
    await prisma.$transaction(async tx => {
      const existing = await tx.coolingRun.findUnique({ where: { runDate: date }, select: { id: true } })
      if (existing) await tx.coolingStep.deleteMany({ where: { runId: existing.id } })
      const data = {
        grainType, airTemp1FC, airTemp2FC, roomTempC,
        memo: memo?.trim() || null,
        lotId,
      }
      const saved = await tx.coolingRun.upsert({
        where:  { runDate: date },
        update: data,
        create: { runDate: date, ...data },
        select: { id: true },
      })
      await tx.coolingStep.createMany({
        data: filled.map((s, i) => {
          const temp = parseProductTemp(s.productTempRaw ?? null)
          return {
            runId:          saved.id,
            sortOrder:      i,
            fan:            s.fan,
            belt:           s.belt,
            productTempMin: temp.min,
            productTempMax: temp.max,
            productTempRaw: temp.raw,
            memo:           s.memo?.trim() || null,
          }
        }),
      })
    })
    revalidatePath('/cooling')
    return { success: true }
  } catch (e) {
    console.error('放冷記録の保存エラー:', e)
    return { globalError: 'データベースへの保存中にエラーが発生しました。' }
  }
}

export async function deleteCoolingRun(id: string): Promise<CoolingResult> {
  try {
    await prisma.coolingRun.delete({ where: { id } })
    revalidatePath('/cooling')
    return { success: true }
  } catch (e) {
    console.error('放冷記録の削除エラー:', e)
    return { globalError: '削除中にエラーが発生しました。' }
  }
}

/**
 * ロット未紐付けの放冷記録を、あとから登録されたロットに紐付け直す。
 * 放冷（仕込みの2日前）の時点ではロットがまだ無いため、この後追いが要る。
 */
export async function relinkCoolingRuns(): Promise<{ linked: number }> {
  const runs = await prisma.coolingRun.findMany({ where: { lotId: null }, select: { id: true, runDate: true, grainType: true } })
  let linked = 0
  for (const run of runs) {
    const lotId = await findLotForRun(run.runDate, run.grainType)
    if (!lotId) continue
    await prisma.coolingRun.update({ where: { id: run.id }, data: { lotId } })
    linked++
  }
  if (linked > 0) revalidatePath('/cooling')
  return { linked }
}

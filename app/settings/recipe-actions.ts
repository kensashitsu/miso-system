'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'

const LOCATIONS = ['暖房24℃', '暖房20℃', '冷房20℃', '常温'] as const

const schema = z.object({
  name:            z.string().min(1, '品種名は必須です'),
  grainLabel:      z.string().min(1, '穀物を入力してください'),
  grainKg:         z.number({ error: '数値を入力してください' }).positive('0より大きい値を入力してください'),
  soybeanKg:       z.number({ error: '数値を入力してください' }).min(0),
  saltKg:          z.number({ error: '数値を入力してください' }).min(0),
  mizuameKg:       z.number().min(0).default(0),
  totalWeightKg:   z.number({ error: '数値を入力してください' }).positive('0より大きい値を入力してください'),
  targetTempSum:   z.number({ error: '数値を入力してください' }).positive('0より大きい値を入力してください'),
  defaultLocation: z.enum(LOCATIONS, { error: '場所を選択してください' }),
  soybeanOrigin:   z.string().nullish(),
  sortOrder:       z.number().int().min(0).default(0),
  taneKojiG:       z.number().min(0).default(0),
  safetyStockKg:   z.number().min(0).nullish(),
  winterSafetyStockKg: z.number().min(0).nullish(),
})

export type RecipeResult = {
  success?: true
  errors?: Record<string, string>
  globalError?: string
}

export async function createRecipe(input: unknown): Promise<RecipeResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[k] = msgs[0]
    }
    return { errors }
  }
  try {
    await prisma.misoRecipe.create({ data: { ...parsed.data, soybeanOrigin: parsed.data.soybeanOrigin ?? null, safetyStockKg: parsed.data.safetyStockKg ?? null, winterSafetyStockKg: parsed.data.winterSafetyStockKg ?? null } })
    revalidatePath('/settings')
    revalidatePath('/lots/new')
    return { success: true }
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return { globalError: 'その品種名はすでに登録されています。' }
    console.error('レシピ作成エラー:', e)
    return { globalError: 'データベースへの登録中にエラーが発生しました。' }
  }
}

export async function updateRecipe(id: string, input: unknown): Promise<RecipeResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[k] = msgs[0]
    }
    return { errors }
  }
  try {
    await prisma.misoRecipe.update({
      where: { id },
      data: { ...parsed.data, soybeanOrigin: parsed.data.soybeanOrigin ?? null, safetyStockKg: parsed.data.safetyStockKg ?? null, winterSafetyStockKg: parsed.data.winterSafetyStockKg ?? null },
    })
    revalidatePath('/settings')
    revalidatePath('/lots/new')
    return { success: true }
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return { globalError: 'その品種名はすでに登録されています。' }
    console.error('レシピ更新エラー:', e)
    return { globalError: '更新中にエラーが発生しました。' }
  }
}

export async function deactivateRecipe(id: string): Promise<RecipeResult> {
  try {
    await prisma.misoRecipe.update({ where: { id }, data: { isActive: false } })
    revalidatePath('/settings')
    revalidatePath('/lots/new')
    return { success: true }
  } catch (e) {
    console.error('レシピ削除エラー:', e)
    return { globalError: '削除中にエラーが発生しました。' }
  }
}

'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { saveMoistureSettings, saveBucketUsageOptions } from '@/lib/settings'
import { prisma } from '@/lib/prisma'

const pct     = z.number({ error: '0〜100の数値を入力してください' }).min(0).max(100)
const ratio   = z.number({ error: '0より大きい数値を入力してください' }).positive()
const roomTemp   = z.number({ error: '温度を入力してください' }).int().min(10).max(60)
const fridgeTemp = z.number({ error: '温度を入力してください' }).int().min(1).max(15)

const schema = z.object({
  hadakaMugi:         pct,
  mugiKoji:           pct,
  kome:               pct,
  komeKoji:           pct,
  soybean:            pct,
  mizuame:            pct,
  seedMiso:           pct,
  kojiRatio:          ratio,
  komeKojiRatio:      ratio,
  soybeanRatio:       ratio,
  room1Temp:          roomTemp,
  room2Temp:          roomTemp,
  fridgeTemp:         fridgeTemp,
  heatingDefaultTemp: roomTemp,
  coolingDefaultTemp: roomTemp,
  q10Value:           z.number({ error: 'Q10値を入力してください' }).min(1.0).max(10.0),
  brewBufferDays:     z.number({ error: 'バッファ日数を入力してください' }).int().min(0).max(60),
  yieldRate:          z.number({ error: '歩留まり率を入力してください' }).min(50).max(100),
})

export type SettingsResult = {
  success?: true
  errors?: Record<string, string>
  globalError?: string
}

// ── 場所の一括移動 ───────────────────────────────────────────

export type BulkMoveResult = {
  success?: true
  count?:   number
  error?:   string
}

const HEATING_RE = /^暖房\d+(?:\.\d+)?℃$/
const COOLING_RE = /^冷房\d+(?:\.\d+)?℃$/

export async function bulkMoveLocation(
  sourceType:  '暖房' | '冷房' | '常温',
  newLocation: string,
): Promise<BulkMoveResult> {
  // 移動先バリデーション
  const tempMatch = newLocation.match(/^(暖房|冷房)(\d+)℃$/)
  if (!['常温', '冷蔵庫'].includes(newLocation) && !tempMatch) {
    return { error: '不正な移動先です。' }
  }
  if (tempMatch) {
    const t = parseInt(tempMatch[2], 10)
    if (t < 10 || t > 40) return { error: '温度は10〜40℃で入力してください。' }
  }

  const sourceRe = sourceType === '暖房' ? HEATING_RE
                 : sourceType === '冷房' ? COOLING_RE
                 : null  // 常温は完全一致

  const now = new Date()

  try {
    const lots = await prisma.lot.findMany({
      where: { status: '熟成中' },
      select: {
        id: true,
        locationHistory: {
          where:  { endDate: null },
          select: { location: true },
        },
      },
    })

    const targets = lots.filter(lot =>
      lot.locationHistory.some(h =>
        sourceRe ? sourceRe.test(h.location) : h.location === '常温'
      )
    )

    if (targets.length === 0) return { success: true, count: 0 }

    // SQLite対応: トランザクション内でcreateを個別呼び出し
    await prisma.$transaction(async (tx) => {
      for (const lot of targets) {
        await tx.locationHistory.updateMany({
          where: { lotId: lot.id, endDate: null },
          data:  { endDate: now },
        })
        await tx.locationHistory.create({
          data: { lotId: lot.id, location: newLocation, startDate: now, endDate: null },
        })
      }
    })

    revalidatePath('/')
    revalidatePath('/settings')
    for (const lot of targets) revalidatePath(`/lots/${lot.id}`)

    return { success: true, count: targets.length }
  } catch (e) {
    console.error('一括場所移動エラー:', e)
    return { error: '更新中にエラーが発生しました。' }
  }
}

// ── 桶使用記録のプルダウン選択肢（製品名・操作者名） ──────────

const bucketUsageOptionsSchema = z.object({
  productNamesByType: z.record(z.string(), z.array(z.string())),
  operatorNames:      z.array(z.string()),
})

export async function updateBucketUsageOptions(input: unknown): Promise<SettingsResult> {
  const parsed = bucketUsageOptionsSchema.safeParse(input)
  if (!parsed.success) {
    return { globalError: '入力が不正です。' }
  }
  try {
    await saveBucketUsageOptions(parsed.data)
    revalidatePath('/settings')
    // 各ロット詳細のプルダウンにも反映
    revalidatePath('/lots', 'layout')
    return { success: true }
  } catch (e) {
    console.error('桶使用記録の選択肢保存エラー:', e)
    return { globalError: '選択肢の保存中にエラーが発生しました。' }
  }
}

// ── 含水量・温度設定 ──────────────────────────────────────────

export async function updateMoistureSettings(input: unknown): Promise<SettingsResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [key, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[key] = msgs[0]
    }
    return { errors }
  }

  const d = parsed.data
  try {
    await saveMoistureSettings({
      hadakaMugi:    d.hadakaMugi    / 100,
      mugiKoji:      d.mugiKoji      / 100,
      kome:          d.kome          / 100,
      komeKoji:      d.komeKoji      / 100,
      soybean:       d.soybean       / 100,
      mizuame:       d.mizuame       / 100,
      seedMiso:      d.seedMiso      / 100,
      kojiRatio:     d.kojiRatio,
      komeKojiRatio: d.komeKojiRatio,
      soybeanRatio:  d.soybeanRatio,
      room1Temp:          d.room1Temp,
      room2Temp:          d.room2Temp,
      fridgeTemp:         d.fridgeTemp,
      heatingDefaultTemp: d.heatingDefaultTemp,
      coolingDefaultTemp: d.coolingDefaultTemp,
      q10Value:           d.q10Value,
      brewBufferDays:     d.brewBufferDays,
      yieldRate:          d.yieldRate / 100,  // % → 小数
    })
    revalidatePath('/lots/new')
    return { success: true }
  } catch (e) {
    console.error('設定保存エラー:', e)
    return { globalError: '設定の保存中にエラーが発生しました。' }
  }
}

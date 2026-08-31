'use server'

import { z } from 'zod'
import { startOfDay } from 'date-fns'
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
  // 「この日から」新しい場所として扱う（省略時は今日）。冷房の故障のように
  // 途中から実温度が変わっていた場合、今日で区切ると過去の期間が実態と合わない。
  // 2026-07の冷房故障ではこの分割をスクリプトで手作業していた（2026-08-31にUI化）
  effectiveDateISO?: string,
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

  const today = startOfDay(new Date())
  // 日付だけを受け取り、時刻は0時に丸める（積算は日単位なので時刻を持つと境界がぶれる）
  const effective = effectiveDateISO ? startOfDay(new Date(`${effectiveDateISO}T00:00:00`)) : today
  if (isNaN(effective.getTime())) return { error: '日付が不正です。' }
  if (effective > today) return { error: '未来の日付は指定できません。' }

  try {
    const lots = await prisma.lot.findMany({
      // 完成ロットも対象（完成後も置き場の温度で着色は進むため）。詳細は settings/page.tsx のコメント
      where: { status: { in: ['熟成中', '完成'] } },
      select: {
        id: true,
        locationHistory: {
          where:  { endDate: null },
          select: { id: true, location: true, startDate: true },
        },
      },
    })

    const targets = lots
      .map(lot => ({
        lot,
        current: lot.locationHistory.find(h =>
          sourceRe ? sourceRe.test(h.location) : h.location === '常温'
        ),
      }))
      .filter((t): t is { lot: typeof t.lot; current: NonNullable<typeof t.current> } => t.current != null)

    if (targets.length === 0) return { success: true, count: 0 }

    // SQLite対応: トランザクション内でcreateを個別呼び出し
    await prisma.$transaction(async (tx) => {
      for (const { lot, current } of targets) {
        // 指定日が今の期間の開始日以前なら、その期間まるごとが新しい場所になる。
        // 分割すると長さ0の記録ができてしまうので、場所を書き換えるだけにする
        if (effective > startOfDay(current.startDate)) {
          // 期間の途中 → 指定日で分割し、以降を新しい場所にする
          await tx.locationHistory.update({
            where: { id: current.id },
            data:  { endDate: effective },
          })
          await tx.locationHistory.create({
            data: { lotId: lot.id, location: newLocation, startDate: effective, endDate: null },
          })
        } else {
          await tx.locationHistory.update({
            where: { id: current.id },
            data:  { location: newLocation },
          })
        }
      }
    })

    revalidatePath('/')
    revalidatePath('/settings')
    for (const { lot } of targets) revalidatePath(`/lots/${lot.id}`)

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

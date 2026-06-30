'use server'

import { z } from 'zod'
import { format } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { adjustStock } from '@/lib/externalApi'

// ── 熟成メモ追加 ──────────────────────────────────────────
const noteSchema = z.object({
  recordedAt:  z.string().min(1),
  memo:        z.string().min(1, 'メモを入力してください'),
  airTempC:    z.number().nullish(),
  productTempC: z.number().nullish(),
})

export type NoteResult = {
  success?: true
  id?: string
  recordedAt?: string
  errors?: Record<string, string>
  globalError?: string
}

export async function addAgingNote(lotId: string, input: unknown): Promise<NoteResult> {
  const parsed = noteSchema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[k] = msgs[0]
    }
    return { errors }
  }
  const d = parsed.data
  try {
    const note = await prisma.agingNote.create({
      data: {
        lotId,
        recordedAt:   new Date(d.recordedAt),
        memo:         d.memo,
        airTempC:     d.airTempC ?? null,
        productTempC: d.productTempC ?? null,
      },
    })
    revalidatePath(`/lots/${lotId}`)
    return { success: true, id: note.id, recordedAt: note.recordedAt.toISOString() }
  } catch (e) {
    console.error('メモ追加エラー:', e)
    return { globalError: '保存中にエラーが発生しました。' }
  }
}

// ── ステータス変更 ─────────────────────────────────────────
const ALLOWED_STATUSES = ['完成', '種みそ転用', '品質低下出荷', '出荷済'] as const

export async function changeLotStatus(
  lotId: string,
  newStatus: string,
  completedAtStr?: string,
  skipStockUpdate?: boolean,
): Promise<{ success?: true; error?: string }> {
  if (!(ALLOWED_STATUSES as readonly string[]).includes(newStatus)) {
    return { error: '不正なステータスです。' }
  }
  try {
    const completedAt = completedAtStr ? new Date(completedAtStr) : new Date()
    const lot = await prisma.lot.update({
      where: { id: lotId },
      data: { status: newStatus, completedAt },
      select: { misoType: true, lotNumber: true, isPrototype: true, yieldRate: true, brewedAt: true, bucketNumbers: true },
    })

    // 熟成完了時：外部在庫システムへ通知（熟成中→熟成済 の在庫移動）
    if (newStatus === '完成' && !lot.isPrototype && !skipStockUpdate) {
      const [brewRecord, settings] = await Promise.all([
        prisma.brewRecord.findUnique({ where: { lotId }, select: { shikomiKg: true } }),
        getMoistureSettings(),
      ])
      if (brewRecord) {
        const effectiveYieldRate = lot.yieldRate ?? settings.yieldRate
        const yieldKg = Math.floor(brewRecord.shikomiKg * effectiveYieldRate)
        const noteParts: string[] = []
        if (lot.bucketNumbers) noteParts.push(`桶: ${lot.bucketNumbers}`)
        noteParts.push(`仕込み: ${format(lot.brewedAt, 'yyyy/MM/dd')}`)
        noteParts.push(`完成: ${format(completedAt, 'yyyy/MM/dd')}`)
        const agingDays = Math.floor((completedAt.getTime() - lot.brewedAt.getTime()) / (1000 * 60 * 60 * 24))
        noteParts.push(`熟成日数: ${agingDays}日`)
        const completionNotes = noteParts.join(' / ')
        await Promise.all([
          adjustStock({ misoType: lot.misoType, category: 'wip',  deltaKg: -yieldKg, lotNumber: lot.lotNumber, notes: completionNotes }).catch(e => console.error('wip在庫調整エラー:', e)),
          adjustStock({ misoType: lot.misoType, category: 'aged', deltaKg:  yieldKg, lotNumber: lot.lotNumber, notes: completionNotes }).catch(e => console.error('aged在庫調整エラー:', e)),
        ])
      }
    }

    revalidatePath(`/lots/${lotId}`)
    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('ステータス変更エラー:', e)
    return { error: '変更中にエラーが発生しました。' }
  }
}

// ── 桶残量を更新 ──────────────────────────────────────────
export async function updateBucketRemaining(
  bucketId: string,
  remainingKg: number,
): Promise<{ success?: true; allEmpty?: boolean; error?: string }> {
  try {
    const bucket = await prisma.bucket.findUnique({
      where: { id: bucketId },
      select: { lotId: true, initialWeightKg: true },
    })
    if (!bucket) return { error: '桶が見つかりません。' }

    let newStatus: string
    if (remainingKg <= 0) {
      newStatus = '空'
    } else if (remainingKg < bucket.initialWeightKg) {
      newStatus = '使用中'
    } else {
      newStatus = '待機中'
    }

    await prisma.bucket.update({
      where: { id: bucketId },
      data: { remainingWeightKg: remainingKg, status: newStatus },
    })

    // 全桶が空になったか確認（クライアント側でプロンプト表示に使用）
    let allEmpty = false
    if (newStatus === '空') {
      const allBuckets = await prisma.bucket.findMany({
        where:  { lotId: bucket.lotId },
        select: { status: true },
      })
      allEmpty = allBuckets.length > 0 && allBuckets.every(b => b.status === '空')
    }

    revalidatePath(`/lots/${bucket.lotId}`)
    revalidatePath('/')
    return { success: true, allEmpty }
  } catch (e) {
    console.error('桶残量更新エラー:', e)
    return { error: '更新中にエラーが発生しました。' }
  }
}

// ── 桶を追加（既存ロット対応） ────────────────────────────
export async function addBucketToLot(
  lotId: string,
  bucketNumber: number,
  initialWeightKg: number,
  status: string = '使用中',
): Promise<{ success?: true; error?: string }> {
  try {
    await prisma.bucket.create({
      data: { lotId, bucketNumber, initialWeightKg, status },
    })
    revalidatePath(`/lots/${lotId}`)
    return { success: true }
  } catch (e) {
    console.error('桶追加エラー:', e)
    return { error: '保存中にエラーが発生しました。' }
  }
}

// ── 桶番号を更新 ──────────────────────────────────────────
export async function updateBucketNumbers(
  lotId: string,
  bucketNumbers: string | null,
): Promise<{ success?: true; error?: string }> {
  try {
    await prisma.lot.update({
      where: { id: lotId },
      data: { bucketNumbers: bucketNumbers ?? null },
    })
    revalidatePath(`/lots/${lotId}`)
    return { success: true }
  } catch (e) {
    console.error('桶番号更新エラー:', e)
    return { error: '更新中にエラーが発生しました。' }
  }
}

// ── 桶使用記録を追加 ──────────────────────────────────────
const bucketUsageSchema = z.object({
  usedAt: z.string().min(1, '日付を入力してください'),
  usedKg: z.number({ error: '使用量を入力してください' }).positive('0より大きい値を入力してください'),
  notes:  z.string().nullish(),
})

export type BucketUsageResult = {
  success?: true
  id?: string
  newRemainingWeightKg?: number
  newStatus?: string
  errors?: Record<string, string>
  globalError?: string
}

export async function addBucketUsage(bucketId: string, input: unknown): Promise<BucketUsageResult> {
  const parsed = bucketUsageSchema.safeParse(input)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const [k, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      if (msgs?.[0]) errors[k] = msgs[0]
    }
    return { errors }
  }
  const d = parsed.data
  try {
    const bucket = await prisma.bucket.findUnique({
      where:  { id: bucketId },
      select: { lotId: true, initialWeightKg: true, usages: { select: { usedKg: true } } },
    })
    if (!bucket) return { globalError: '桶が見つかりません。' }

    const usage = await prisma.bucketUsage.create({
      data: { bucketId, usedAt: new Date(d.usedAt), usedKg: d.usedKg, notes: d.notes ?? null },
    })

    // 残量を再計算して更新（initialWeightKg - 全使用量合計）
    const totalUsed  = bucket.usages.reduce((s, u) => s + u.usedKg, 0) + d.usedKg
    const newRemaining = Math.max(bucket.initialWeightKg - totalUsed, 0)
    const newStatus  = newRemaining <= 0 ? '空' : newRemaining < bucket.initialWeightKg ? '使用中' : '待機中'
    await prisma.bucket.update({
      where: { id: bucketId },
      data:  { remainingWeightKg: newRemaining, status: newStatus },
    })

    revalidatePath(`/lots/${bucket.lotId}`)
    return { success: true, id: usage.id, newRemainingWeightKg: newRemaining, newStatus }
  } catch (e) {
    console.error('使用記録追加エラー:', e)
    return { globalError: '保存中にエラーが発生しました。' }
  }
}

// ── 桶使用記録を削除 ──────────────────────────────────────
export async function deleteBucketUsage(usageId: string): Promise<{ success?: true; newRemainingWeightKg?: number; newStatus?: string; error?: string }> {
  try {
    const usage = await prisma.bucketUsage.findUnique({
      where:  { id: usageId },
      select: { usedKg: true, bucket: { select: { id: true, lotId: true, initialWeightKg: true, usages: { select: { usedKg: true } } } } },
    })
    if (!usage) return { error: '記録が見つかりません。' }

    await prisma.bucketUsage.delete({ where: { id: usageId } })

    // 残量を再計算して更新（削除したusageを除いた合計）
    const totalUsed    = usage.bucket.usages.reduce((s, u) => s + u.usedKg, 0) - usage.usedKg
    const newRemaining = Math.max(usage.bucket.initialWeightKg - totalUsed, 0)
    const newStatus    = newRemaining <= 0 ? '空' : newRemaining < usage.bucket.initialWeightKg ? '使用中' : '待機中'
    await prisma.bucket.update({
      where: { id: usage.bucket.id },
      data:  { remainingWeightKg: newRemaining, status: newStatus },
    })

    revalidatePath(`/lots/${usage.bucket.lotId}`)
    return { success: true, newRemainingWeightKg: newRemaining, newStatus }
  } catch (e) {
    console.error('使用記録削除エラー:', e)
    return { error: '削除中にエラーが発生しました。' }
  }
}

// ── ロット削除（関連データをすべて削除） ──────────────────
export async function deleteLot(lotId: string, skipStockUpdate?: boolean): Promise<{ success?: true; error?: string }> {
  try {
    // 削除前に在庫調整用の情報を取得
    const [lot, brewRecord, settings] = await Promise.all([
      prisma.lot.findUnique({
        where:  { id: lotId },
        select: { misoType: true, lotNumber: true, status: true, isPrototype: true, yieldRate: true },
      }),
      prisma.brewRecord.findUnique({ where: { lotId }, select: { shikomiKg: true } }),
      getMoistureSettings(),
    ])

    const buckets = await prisma.bucket.findMany({ where: { lotId }, select: { id: true } })
    const bucketIds = buckets.map(b => b.id)
    await prisma.$transaction([
      prisma.bucketUsage.deleteMany({ where: { bucketId: { in: bucketIds } } }),
      prisma.bucket.deleteMany({ where: { lotId } }),
      prisma.agingNote.deleteMany({ where: { lotId } }),
      prisma.brewDiary.deleteMany({ where: { lotId } }),
      prisma.packagingLot.deleteMany({ where: { lotId } }),
      prisma.seedMisoUsage.deleteMany({ where: { fromLotId: lotId } }),
      prisma.seedMisoUsage.deleteMany({ where: { toLotId: lotId } }),
      prisma.locationHistory.deleteMany({ where: { lotId } }),
      prisma.brewRecord.deleteMany({ where: { lotId } }),
      prisma.lot.delete({ where: { id: lotId } }),
    ])

    // 外部在庫システムから削除分を減算（試作品・スキップ指定・情報取得失敗時はスキップ）
    if (lot && !lot.isPrototype && !skipStockUpdate && brewRecord) {
      const effectiveYieldRate = lot.yieldRate ?? settings.yieldRate
      const yieldKg = Math.floor(brewRecord.shikomiKg * effectiveYieldRate)
      if (lot.status === '完成') {
        // 完成済みなら aged から引く（白みそは aged = 西京みそ バラ）
        await adjustStock({ misoType: lot.misoType, category: 'aged', deltaKg: -yieldKg, lotNumber: lot.lotNumber }).catch(e => console.error('aged在庫削除エラー:', e))
      } else if (lot.misoType !== '白みそ') {
        // 熟成中なら wip から引く（白みそは wip 品目なしのためスキップ）
        await adjustStock({ misoType: lot.misoType, category: 'wip', deltaKg: -yieldKg, lotNumber: lot.lotNumber }).catch(e => console.error('wip在庫削除エラー:', e))
      }
    }

    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('ロット削除エラー:', e)
    return { error: '削除中にエラーが発生しました。' }
  }
}

// ── 完成日を更新 ──────────────────────────────────────────
export async function updateCompletedAt(
  lotId: string,
  completedAtStr: string,
): Promise<{ success?: true; error?: string }> {
  const completedAt = new Date(completedAtStr)
  if (isNaN(completedAt.getTime())) return { error: '日付が不正です。' }
  try {
    const lot = await prisma.lot.findUnique({
      where: { id: lotId },
      select: { completedAt: true },
    })
    const oldCompletedAt = lot?.completedAt ?? null

    await prisma.lot.update({
      where: { id: lotId },
      data:  { completedAt },
    })

    // 旧completedAtと一致するLocationHistoryのendDate・次レコードのstartDateを同期
    if (oldCompletedAt) {
      const locWithOldEnd = await prisma.locationHistory.findFirst({
        where: { lotId, endDate: oldCompletedAt },
      })
      if (locWithOldEnd) {
        await prisma.locationHistory.update({
          where: { id: locWithOldEnd.id },
          data:  { endDate: completedAt },
        })
      }
      const locWithOldStart = await prisma.locationHistory.findFirst({
        where: { lotId, startDate: oldCompletedAt },
      })
      if (locWithOldStart) {
        await prisma.locationHistory.update({
          where: { id: locWithOldStart.id },
          data:  { startDate: completedAt },
        })
      }
    }

    revalidatePath(`/lots/${lotId}`)
    revalidatePath('/')
    revalidatePath('/trace')
    return { success: true }
  } catch (e) {
    console.error('完成日更新エラー:', e)
    return { error: '更新中にエラーが発生しました。' }
  }
}

// ── 場所の設定温度を更新（暖房・冷房のみ） ────────────────────
export async function updateLocationTemp(
  locationHistoryId: string,
  newTemp: number,
): Promise<{ success?: true; error?: string }> {
  if (!Number.isFinite(newTemp) || newTemp < 10 || newTemp > 45) {
    return { error: '温度は10〜45℃の範囲で入力してください。' }
  }
  try {
    const loc = await prisma.locationHistory.findUnique({
      where: { id: locationHistoryId },
      select: { lotId: true, location: true },
    })
    if (!loc) return { error: '場所履歴が見つかりません。' }
    const m = loc.location.match(/^(暖房|冷房)/)
    if (!m) return { error: '暖房・冷房のみ温度変更できます。' }
    const newLocation = `${m[1]}${newTemp}℃`
    await prisma.locationHistory.update({
      where: { id: locationHistoryId },
      data:  { location: newLocation },
    })
    revalidatePath(`/lots/${loc.lotId}`)
    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('場所温度更新エラー:', e)
    return { error: '更新中にエラーが発生しました。' }
  }
}

// ── 仕込み記録を更新 ──────────────────────────────────────
const brewRecordUpdateSchema = z.object({
  mugiOrKomeKg:        z.number(),
  kojiKg:              z.number(),
  soybeanKg:           z.number(),
  saltKg:              z.number(),
  mizuameKg:           z.number(),
  seedWaterL:          z.number(),
  shikomiKg:           z.number(),
  seedMisoKg:          z.number(),
  taneKojiG:           z.number(),
  soybeanOrigin:       z.string().nullish(),
  soybeanOriginDetail: z.string().nullish(),
  soybeanArrivalDate:  z.string().nullish(),
  soybeanSupplier:     z.string().nullish(),
  soybeanLotNo:        z.string().nullish(),
  kojiMadeAt:          z.string().nullish(),
  kojiSupplier:        z.string().nullish(),
  saltBrand:           z.string().nullish(),
  saltLotNo:           z.string().nullish(),
  mizuameBrand:        z.string().nullish(),
  mizuameLotNo:        z.string().nullish(),
  kojiCondition:       z.number().int().nullish(),
  soybeanHardness:     z.string().nullish(),
  airTempC:            z.number().nullish(),
  productTempC:        z.number().nullish(),
  steamingPressure:    z.string().nullish(),
  coolingMin:          z.string().nullish(),
  memo:                z.string().nullish(),
})

export async function updateBrewRecord(
  lotId: string,
  input: unknown,
): Promise<{ success?: true; error?: string }> {
  const parsed = brewRecordUpdateSchema.safeParse(input)
  if (!parsed.success) return { error: '入力内容を確認してください。' }
  const d = parsed.data
  try {
    await prisma.brewRecord.update({
      where: { lotId },
      data: {
        mugiOrKomeKg:        d.mugiOrKomeKg,
        kojiKg:              d.kojiKg,
        soybeanKg:           d.soybeanKg,
        saltKg:              d.saltKg,
        mizuameKg:           d.mizuameKg,
        seedWaterL:          d.seedWaterL,
        shikomiKg:           d.shikomiKg,
        seedMisoKg:          d.seedMisoKg,
        taneKojiG:           d.taneKojiG,
        soybeanOrigin:       d.soybeanOrigin ?? null,
        soybeanOriginDetail: d.soybeanOriginDetail ?? null,
        soybeanArrivalDate:  d.soybeanArrivalDate ? new Date(d.soybeanArrivalDate) : null,
        soybeanSupplier:     d.soybeanSupplier ?? null,
        soybeanLotNo:        d.soybeanLotNo ?? null,
        kojiMadeAt:          d.kojiMadeAt ? new Date(d.kojiMadeAt) : null,
        kojiSupplier:        d.kojiSupplier ?? null,
        saltBrand:           d.saltBrand ?? null,
        saltLotNo:           d.saltLotNo ?? null,
        mizuameBrand:        d.mizuameBrand ?? null,
        mizuameLotNo:        d.mizuameLotNo ?? null,
        kojiCondition:       d.kojiCondition ?? null,
        soybeanHardness:     d.soybeanHardness ?? null,
        airTempC:            d.airTempC ?? null,
        productTempC:        d.productTempC ?? null,
        steamingPressure:    d.steamingPressure ?? null,
        coolingMin:          d.coolingMin ?? null,
        memo:                d.memo ?? null,
      },
    })
    revalidatePath(`/lots/${lotId}`)
    return { success: true }
  } catch (e) {
    console.error('仕込み記録更新エラー:', e)
    return { error: '保存中にエラーが発生しました。' }
  }
}

// ── ステータスを熟成中に戻す ───────────────────────────────
export async function revertLotStatus(lotId: string): Promise<{ success?: true; error?: string }> {
  try {
    await prisma.lot.update({
      where: { id: lotId },
      data: {
        status:      '熟成中',
        completedAt: null,
      },
    })
    revalidatePath(`/lots/${lotId}`)
    revalidatePath('/')
    return { success: true }
  } catch (e) {
    console.error('ステータス戻しエラー:', e)
    return { error: '元に戻す処理中にエラーが発生しました。' }
  }
}

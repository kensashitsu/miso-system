'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { format } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { adjustItemStock } from '@/lib/externalApi'
import { findPackingItem, PACKING_LOCATION } from '@/lib/packingItems'

export interface PackingResult {
  ok:           boolean
  error?:       string
  recordId?:    string
  sendStatus?:  string   // 送信済・未送信・失敗
  sendError?:   string
  /** zaikoが返した原材料の前後値（「田舎みそ（熟成済）2,346 → 2,146 kg」の表示用） */
  materials?:   { name: string; unit: string; before: number | null; after: number | null }[]
}

/**
 * 1件を zaiko へ送る。記録は必ず先にDBへ入っている前提で、その送信結果でレコードを更新する。
 * 通信が失敗しても記録は消さない（「未送信」のまま残して後で再送する）。
 */
async function sendRecord(id: string): Promise<PackingResult> {
  const rec = await prisma.packingRecord.findUnique({ where: { id } })
  if (!rec) return { ok: false, error: '記録が見つかりません' }
  if (rec.sendStatus === '送信済') return { ok: true, recordId: id, sendStatus: '送信済' }

  // 品目コードが分かっていないものは送れない（記録だけ残す）
  if (!rec.itemCode) {
    await prisma.packingRecord.update({
      where: { id },
      data:  { lastError: 'zaikoの品目コードが未設定（lib/packingItems.ts に追記が必要）' },
    })
    return {
      ok: true, recordId: id, sendStatus: '未送信',
      sendError: 'zaikoの品目コードが未設定です（記録は残しています）',
    }
  }

  const res = await adjustItemStock({
    itemCode:    rec.itemCode,
    location:    rec.location,
    delta:       rec.qty,
    applyRecipe: true,   // ★原材料の減算はzaiko側のレシピ連動に任せる（二重計上防止）
    occurredAt:  format(rec.occurredAt, 'yyyy-MM-dd'),
    operator:    rec.operator ?? undefined,
    requestId:   rec.requestId,
    notes:       '小分け入力（熟成管理システム）',
  })

  await prisma.packingRecord.update({
    where: { id },
    data: res.ok
      ? { sendStatus: '送信済', sentAt: new Date(), lastError: null, attempts: { increment: 1 } }
      : { sendStatus: '未送信', lastError: res.error ?? '不明なエラー', attempts: { increment: 1 } },
  })

  return {
    ok:         true,
    recordId:   id,
    sendStatus: res.ok ? '送信済' : '未送信',
    sendError:  res.ok ? undefined : res.error,
    materials:  res.consumedMaterials?.map(m => ({
      name: m.name, unit: m.unit, before: m.stockBefore ?? null, after: m.stockAfter ?? null,
    })),
  }
}

/** 小分けを1件記録する（記録 → zaikoへ送信の順。送信が失敗しても記録は残る） */
export async function recordPacking(input: {
  itemName:   string
  qty:        number
  occurredAt: string   // yyyy-MM-dd
  operator:   string
}): Promise<PackingResult> {
  const item = findPackingItem(input.itemName)
  if (!item) return { ok: false, error: '品目が選ばれていません' }
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    return { ok: false, error: '個数は1以上を入力してください' }
  }
  if (input.qty > 999) return { ok: false, error: '個数が大きすぎます（999まで）' }

  const rec = await prisma.packingRecord.create({
    data: {
      itemCode:   item.code,
      itemName:   item.name,
      unit:       item.unit,
      kgPerUnit:  item.kgPerUnit,
      misoType:   item.misoType,
      qty:        input.qty,
      occurredAt: new Date(`${input.occurredAt}T00:00:00+09:00`),
      operator:   input.operator.trim() || null,
      location:   PACKING_LOCATION,
      requestId:  randomUUID(),
    },
  })

  const result = await sendRecord(rec.id)
  revalidatePath('/packing')
  return result
}

/** 直前の記録を取り消す（元を消さず、逆向きのレコードを1本足して打ち消す） */
export async function cancelPacking(id: string): Promise<PackingResult> {
  const rec = await prisma.packingRecord.findUnique({ where: { id } })
  if (!rec)            return { ok: false, error: '記録が見つかりません' }
  if (rec.canceledAt)  return { ok: false, error: 'この記録はすでに取り消されています' }
  if (rec.qty < 0)     return { ok: false, error: '取消の記録は取り消せません' }

  const reversal = await prisma.packingRecord.create({
    data: {
      itemCode:     rec.itemCode,
      itemName:     rec.itemName,
      unit:         rec.unit,
      kgPerUnit:    rec.kgPerUnit,
      misoType:     rec.misoType,
      qty:          -rec.qty,
      occurredAt:   rec.occurredAt,
      operator:     rec.operator,
      location:     rec.location,
      requestId:    randomUUID(),
      reversalOfId: rec.id,
      // 元がまだzaikoへ行っていなければ、こちらも送る必要がない
      sendStatus:   rec.sendStatus === '送信済' ? '未送信' : '送信不要',
    },
  })
  // 元がまだ送られていなければ、取り消した以上もう送ってはいけない（再送の対象から外す）
  await prisma.packingRecord.update({
    where: { id: rec.id },
    data: rec.sendStatus === '送信済'
      ? { canceledAt: new Date() }
      : { canceledAt: new Date(), sendStatus: '送信不要' },
  })

  const result = reversal.sendStatus === '送信不要'
    ? { ok: true, recordId: reversal.id, sendStatus: '送信不要' }
    : await sendRecord(reversal.id)
  revalidatePath('/packing')
  return result
}

/** 未送信ぶんをまとめて再送する */
export async function resendPending(): Promise<{ sent: number; failed: number }> {
  const pending = await prisma.packingRecord.findMany({
    where:   { sendStatus: '未送信', itemCode: { not: '' } },
    orderBy: { createdAt: 'asc' },
    take:    100,
  })
  let sent = 0, failed = 0
  for (const p of pending) {
    const r = await sendRecord(p.id)
    if (r.sendStatus === '送信済') sent++
    else failed++
  }
  revalidatePath('/packing')
  return { sent, failed }
}

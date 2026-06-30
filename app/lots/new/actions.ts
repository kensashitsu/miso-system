'use server'

import { z } from 'zod'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { format } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { adjustStock } from '@/lib/externalApi'

// 既存品種（非試作品の場合のバリデーション用）
const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const
// 後方互換のため旧形式も含む（暖房XX℃・冷房XX℃はregexで別途検証）
const STATIC_LOCATIONS = ['常温', '冷蔵庫'] as const
const LOCATION_RE = /^(?:暖房|冷房|温調室)\d+(?:\.\d+)?℃$/

// 必須の正の数値フィールド用スキーマ
const positiveNum = (label: string) =>
  z.number({ error: `${label}に数値を入力してください` })
    .positive(`${label}は0より大きい値を入力してください`)

// 0以上の必須数値フィールド用スキーマ
const nonNegNum = (label: string) =>
  z.number({ error: `${label}に数値を入力してください` })
    .min(0, `${label}は0以上の値を入力してください`)

const schema = z.object({
  // ① 基本情報
  isPrototype:      z.boolean().default(false),
  skipStockUpdate:  z.boolean().default(false),
  misoType:        z.string().min(1, '品種名を入力してください'),
  brewedAt:        z.string().min(1, '仕込み日を入力してください'),
  totalWeightKg:   positiveNum('仕込み総量'),
  targetTempSum:   positiveNum('目標積算温度'),
  initialLocation: z.string().refine(
    v => (STATIC_LOCATIONS as readonly string[]).includes(v) || LOCATION_RE.test(v),
    { message: '場所を選択してください' }
  ),
  bucketNumbers:   z.string().nullish(),
  // ② 原料配合（必須）
  mugiOrKomeKg: nonNegNum('麦/米'),
  kojiKg:       nonNegNum('麹'),
  soybeanKg:    nonNegNum('大豆'),
  saltKg:       nonNegNum('塩'),
  shikomiKg:    positiveNum('仕立'),
  // ② 原料配合（任意）
  mizuameKg:    z.number().min(0).default(0),
  seedWaterL:   z.number().min(0).default(0),
  soybeanOrigin: z.string().nullish(),
  seedMisoKg:   z.number().min(0).default(0),
  taneKojiG:    z.number().min(0).default(0),
  // ③ 製造記録（任意）
  kojiCondition:    z.number().int().min(3).max(9).nullish(),
  soybeanHardness:  z.string().nullish(),
  airTempC:         z.number().nullish(),
  productTempC:     z.number().nullish(),
  steamingPressure: z.string().nullish(),
  coolingMin:       z.string().nullish(),
  memo:             z.string().nullish(),
  // ④ 原料ロット（任意）
  soybeanArrivalDate: z.string().nullish(),
  soybeanSupplier:    z.string().nullish(),
  soybeanLotNo:       z.string().nullish(),
  kojiMadeAt:         z.string().nullish(),
  kojiSupplier:       z.string().nullish(),
  saltBrand:          z.string().nullish(),
  saltLotNo:          z.string().nullish(),
  mizuameBrand:       z.string().nullish(),
  mizuameLotNo:       z.string().nullish(),
  brewPlanId:         z.string().nullish(),
})

export type ActionResult = {
  errors?: Record<string, string>
  globalError?: string
}

export async function createLot(input: unknown): Promise<ActionResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    const errors: Record<string, string> = {}
    for (const [key, msgs] of Object.entries(fieldErrors)) {
      if (msgs?.[0]) errors[key] = msgs[0]
    }
    return { errors }
  }

  const d = parsed.data
  const brewDate = new Date(d.brewedAt)

  // 歩留まり率を設定から取得
  const { yieldRate } = await getMoistureSettings()

  let newId = ''
  let newLotNumber = ''
  try {
    // ── Step 1: ロット・仕込み記録・場所履歴をトランザクションで作成 ──
    const lot = await prisma.$transaction(async (tx) => {
      // ロット番号の採番（同月の件数 + 1）
      const ym = format(brewDate, 'yyyyMM')
      const count = await tx.lot.count({
        where: { lotNumber: { startsWith: `${ym}-` } },
      })
      const lotNumber = `${ym}-${String(count + 1).padStart(3, '0')}`

      return tx.lot.create({
        data: {
          lotNumber,
          misoType:    d.misoType,
          isPrototype: d.isPrototype,
          brewedAt:      brewDate,
          totalWeightKg: d.totalWeightKg,
          targetTempSum: d.targetTempSum,
          status:        '熟成中',
          bucketNumbers: d.bucketNumbers ?? null,
          brewRecord: {
            create: {
              mugiOrKomeKg:     d.mugiOrKomeKg,
              kojiKg:           d.kojiKg,
              soybeanKg:        d.soybeanKg,
              saltKg:           d.saltKg,
              mizuameKg:        d.mizuameKg,
              seedWaterL:       d.seedWaterL,
              shikomiKg:        d.shikomiKg,
              soybeanOrigin:    d.soybeanOrigin    ?? null,
              seedMisoKg:       d.seedMisoKg,
              taneKojiG:        d.taneKojiG,
              kojiCondition:    d.kojiCondition    ?? null,
              soybeanHardness:  d.soybeanHardness  ?? null,
              airTempC:         d.airTempC         ?? null,
              productTempC:     d.productTempC     ?? null,
              steamingPressure: d.steamingPressure ?? null,
              coolingMin:       d.coolingMin       ?? null,
              memo:             d.memo             ?? null,
              soybeanArrivalDate: d.soybeanArrivalDate
                ? new Date(d.soybeanArrivalDate) : null,
              soybeanSupplier: d.soybeanSupplier ?? null,
              soybeanLotNo:    d.soybeanLotNo    ?? null,
              kojiMadeAt:      d.kojiMadeAt ? new Date(d.kojiMadeAt) : null,
              kojiSupplier:    d.kojiSupplier    ?? null,
              saltBrand:       d.saltBrand       ?? null,
              saltLotNo:       d.saltLotNo       ?? null,
              mizuameBrand:    d.mizuameBrand    ?? null,
              mizuameLotNo:    d.mizuameLotNo    ?? null,
            },
          },
          locationHistory: {
            create: {
              location:  d.initialLocation,
              startDate: brewDate,
            },
          },
        },
      })
    })
    newId = lot.id
    newLotNumber = lot.lotNumber

    // ── Step 2: 桶レコードを個別に作成（SQLiteのcreateMany制限回避） ──
    if (d.bucketNumbers) {
      const isShiroMiso = d.misoType === '白みそ'
      if (isShiroMiso) {
        // 白みそ：1桶　初期重量 = 仕立量 × 歩留まり率（切り捨て）
        const num = parseInt(d.bucketNumbers)
        if (!isNaN(num)) {
          await prisma.bucket.create({
            data: {
              lotId:           newId,
              bucketNumber:    num,
              initialWeightKg: Math.floor(d.shikomiKg * yieldRate),
              status:          '待機中',  // 使用開始まで待機中
            },
          })
        }
      } else {
        // 白みそ以外：2桶　各初期重量 = 仕立量 × 歩留まり率 ÷ 2（切り捨て）
        // 両桶とも待機中（残量が初期重量より減った時点で自動的に使用中に変わる）
        const parts = d.bucketNumbers.split('・').map(s => parseInt(s.trim()))
        if (parts.length === 2 && parts.every(n => !isNaN(n))) {
          const half = Math.floor(d.shikomiKg * yieldRate / 2)
          await prisma.bucket.create({
            data: { lotId: newId, bucketNumber: parts[0], initialWeightKg: half, status: '待機中' },
          })
          await prisma.bucket.create({
            data: { lotId: newId, bucketNumber: parts[1], initialWeightKg: half, status: '待機中' },
          })
        }
      }
    }
  } catch (e) {
    console.error('ロット登録エラー:', e)
    return { globalError: 'データベースへの登録中にエラーが発生しました。もう一度お試しください。' }
  }

  if (d.brewPlanId) {
    await prisma.brewPlan.update({
      where: { id: d.brewPlanId },
      data:  { status: '本登録済', lotId: newId },
    }).catch(() => {})
    // ルートレイアウトの仮登録ドロワーを再取得させる（更新後の状態を反映）
    revalidatePath('/', 'layout')
  }

  // 外部在庫システムへ熟成中在庫を通知（試作品・白みそ・スキップ指定時は除外）
  // 白みそは在庫システムに熟成中品目がないためスキップ（完成時に直接 aged へ計上）
  if (!d.isPrototype && !d.skipStockUpdate && d.misoType !== '白みそ') {
    const yieldKg = Math.floor(d.shikomiKg * yieldRate)
    const noteParts: string[] = []
    if (d.bucketNumbers) noteParts.push(`桶: ${d.bucketNumbers}`)
    noteParts.push(`仕込み: ${format(brewDate, 'yyyy/MM/dd')}`)
    await adjustStock({
      misoType:  d.misoType,
      category:  'wip',
      deltaKg:   yieldKg,
      lotNumber: newLotNumber,
      notes:     noteParts.join(' / '),
    }).catch(e => console.error('wip在庫登録エラー:', e))
  }

  redirect(`/lots/${newId}`)
}

import type { Metadata } from 'next'
import { differenceInDays, format, startOfDay } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import {
  calcAccumulatedTemp,
  calcColoringRisk,
  getCurrentLocation,
} from '@/lib/tempCalc'
import { getMisoRecipes } from '@/lib/recipes'
import TraceClient, { type TraceLot, type TraceSearchValues } from './TraceClient'

export const metadata: Metadata = {
  title: 'トレース検索 | みそ熟成管理システム',
}

export const dynamic = 'force-dynamic'

export default async function TracePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const sp = await searchParams

  const str = (key: string) => {
    const v = sp[key]
    return typeof v === 'string' ? v.trim() : ''
  }

  const values: TraceSearchValues = {
    lotNumber:     str('lotNumber'),
    misoType:      str('misoType') || 'all',
    brewedFrom:    str('brewedFrom'),
    brewedTo:      str('brewedTo'),
    status:        str('status') || 'all',
    soybeanOrigin: str('soybeanOrigin'),
    soybeanLotNo:  str('soybeanLotNo'),
    kojiSupplier:  str('kojiSupplier'),
    saltLotNo:     str('saltLotNo'),
    bucketNumber:  str('bucketNumber'),
  }

  const hasSearched =
    sp['searched'] === '1' ||
    values.lotNumber     !== '' ||
    values.misoType      !== 'all' ||
    values.brewedFrom    !== '' ||
    values.brewedTo      !== '' ||
    values.status        !== 'all' ||
    values.soybeanOrigin !== '' ||
    values.soybeanLotNo  !== '' ||
    values.kojiSupplier  !== '' ||
    values.saltLotNo     !== '' ||
    values.bucketNumber  !== ''

  let lots: TraceLot[] = []
  let ingredientAlertCount = 0
  let ingredientAlertLabel = ''

  // 品種の選択肢はレシピから（ハードコードすると品種追加時に検索できなくなる）
  const misoTypes = (await getMisoRecipes()).map(r => r.name)

  if (hasSearched) {
    // ── BrewRecord フィルタ ────────────────────────────────
    const brewRecordWhere: Record<string, unknown> = {}
    if (values.soybeanOrigin) brewRecordWhere.soybeanOrigin = { contains: values.soybeanOrigin }
    if (values.soybeanLotNo)  brewRecordWhere.soybeanLotNo  = { contains: values.soybeanLotNo }
    if (values.kojiSupplier)  brewRecordWhere.kojiSupplier  = { contains: values.kojiSupplier }
    if (values.saltLotNo)     brewRecordWhere.saltLotNo     = { contains: values.saltLotNo }

    // ── 仕込み日フィルタ ───────────────────────────────────
    const brewedAtWhere: Record<string, Date> = {}
    if (values.brewedFrom) {
      brewedAtWhere.gte = new Date(values.brewedFrom)
    }
    if (values.brewedTo) {
      const to = new Date(values.brewedTo)
      to.setHours(23, 59, 59, 999)
      brewedAtWhere.lte = to
    }

    // ── 桶番号フィルタ ─────────────────────────────────────
    const bucketNum = parseInt(values.bucketNumber)
    const bucketWhere = !isNaN(bucketNum)
      ? { some: { bucketNumber: bucketNum } }
      : undefined

    const [lotRows, moisture, recipes] = await Promise.all([
      prisma.lot.findMany({
        where: {
          ...(values.lotNumber     ? { lotNumber: { contains: values.lotNumber } } : {}),
          ...(values.misoType !== 'all' ? { misoType: values.misoType } : {}),
          ...(Object.keys(brewedAtWhere).length > 0 ? { brewedAt: brewedAtWhere } : {}),
          ...(values.status !== 'all' ? { status: values.status } : {}),
          ...(Object.keys(brewRecordWhere).length > 0 ? { brewRecord: brewRecordWhere } : {}),
          ...(bucketWhere ? { buckets: bucketWhere } : {}),
        },
        include: {
          locationHistory: { orderBy: { startDate: 'asc' } },
          buckets: {
            select: {
              usages: {
                orderBy: { usedAt: 'desc' },
                take: 1,
                select: { usedAt: true },
              },
            },
          },
          brewRecord: {
            select: {
              soybeanOrigin: true,
              soybeanLotNo:  true,
              kojiSupplier:  true,
              saltLotNo:     true,
            },
          },
        },
        orderBy: { brewedAt: 'desc' },
      }),
      getMoistureSettings(),
      getMisoRecipes(),
    ])

    // MisoRecipeの現在の目標積算温度を品種名でルックアップ
    const recipeTargetMap: Record<string, number> = {}
    for (const r of recipes) recipeTargetMap[r.name] = r.targetTempSum

    if (lotRows.length > 0) {
      const oldestBrewDate = lotRows.reduce(
        (min, l) => (l.brewedAt < min ? l.brewedAt : min),
        lotRows[0].brewedAt,
      )
      const weatherData = await prisma.weatherCache.findMany({
        where:   { date: { gte: oldestBrewDate } },
        orderBy: { date: 'asc' },
      })
      const weatherMap = new Map<string, number>(
        weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
      )
      const roomTemps = {
        room1Temp:       moisture.room1Temp,
        room2Temp:       moisture.room2Temp,
        fridgeTemp:      moisture.fridgeTemp,
        heatingBaseTemp: moisture.heatingDefaultTemp,
        q10Value:        moisture.q10Value,
      }

      const today = startOfDay(new Date())
      lots = lotRows.map(lot => {
        const targetTempSum = recipeTargetMap[lot.misoType] ?? lot.targetTempSum
        // 熟成中: 今日まで / それ以外: completedAt → locationHistory最終endDate → bucketUsage最終usedAt → null
        const lastLocEndDate = lot.locationHistory.at(-1)?.endDate ?? null
        const lastUsageDate  = lot.buckets
          .flatMap(b => b.usages)
          .sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime())[0]?.usedAt ?? null
        const endDate = lot.status === '熟成中'
          ? today
          : lot.completedAt     ? startOfDay(lot.completedAt)
          : lastLocEndDate      ? startOfDay(lastLocEndDate)
          : lastUsageDate       ? startOfDay(lastUsageDate)
          : null
        // 熟成終了日で積算を打ち切る（打ち切らないと完成後も熟成度%が伸び続ける）
        const accumulated   = calcAccumulatedTemp(
          lot.brewedAt, lot.locationHistory, weatherMap, roomTemps,
          lot.status === '熟成中' ? null : endDate,
        )
        return {
          id:              lot.id,
          lotNumber:       lot.lotNumber,
          misoType:        lot.misoType,
          brewedAtISO:     lot.brewedAt.toISOString(),
          status:          lot.status,
          elapsedDays:     endDate !== null ? differenceInDays(endDate, startOfDay(lot.brewedAt)) : null,
          accumulatedTemp: Math.round(accumulated),
          targetTempSum,
          coloringRisk:    calcColoringRisk(accumulated, targetTempSum),
          currentLocation: getCurrentLocation(lot.locationHistory),
          bucketNumbers:   lot.bucketNumbers ?? null,
          soybeanOrigin:   lot.brewRecord?.soybeanOrigin ?? null,
        }
      })
    }

    // ── 原料アラート ───────────────────────────────────────
    if (values.soybeanLotNo && lots.length > 0) {
      ingredientAlertCount = lots.length
      ingredientAlertLabel = `大豆ロット番号「${values.soybeanLotNo}」`
    } else if (values.kojiSupplier && lots.length > 0) {
      ingredientAlertCount = lots.length
      ingredientAlertLabel = `麹仕入れ先「${values.kojiSupplier}」`
    }
  }

  return (
    <TraceClient
      misoTypes={misoTypes}
      lots={lots}
      hasSearched={hasSearched}
      ingredientAlertCount={ingredientAlertCount}
      ingredientAlertLabel={ingredientAlertLabel}
      defaultValues={values}
    />
  )
}

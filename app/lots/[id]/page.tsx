import { notFound } from 'next/navigation'
import { differenceInDays, format, startOfDay } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings, getBucketUsageOptions } from '@/lib/settings'
import {
  calcAccumulatedTemp,
  calcColoringRisk,
  calcPeriodAccumulations,
  getCurrentLocation,
} from '@/lib/tempCalc'
import { calcCompletionFromBrew } from '@/lib/brewSimulation'
import LotDetail, { type LotDetailProps } from './LotDetail'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function LotDetailPage({ params }: Props) {
  const { id } = await params

  const [lot, moisture, allWeatherData, usageOptions] = await Promise.all([
    prisma.lot.findUnique({
      where: { id },
      include: {
        locationHistory: { orderBy: { startDate: 'asc' } },
        agingNotes:      { orderBy: { recordedAt: 'desc' } },
        brewRecord:      true,
        buckets: {
          orderBy: { bucketNumber: 'asc' },
          include: { usages: { orderBy: { usedAt: 'desc' } } },
        },
      },
    }),
    getMoistureSettings(),
    // 全期間の気象データ取得（MM-dd 月日平均のために全年分必要）
    prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
    getBucketUsageOptions(),
  ])
  if (!lot) notFound()

  // レシピの現在の目標積算温度を優先（変更後に即反映するため）
  const recipe      = await prisma.misoRecipe.findUnique({ where: { name: lot.misoType } })
  const targetTempSum = recipe?.targetTempSum ?? lot.targetTempSum

  const roomTemps = { room1Temp: moisture.room1Temp, room2Temp: moisture.room2Temp, fridgeTemp: moisture.fridgeTemp, heatingBaseTemp: moisture.heatingDefaultTemp, q10Value: moisture.q10Value }

  // 日付→有効積算温度 Map（積算計算用）
  const weatherMap = new Map<string, number>(
    allWeatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
  )

  // MM-dd 月日平均（シミュレーショングラフ用）
  const wmTotals = new Map<string, { sum: number; count: number }>()
  for (const w of allWeatherData) {
    const key = format(w.date, 'MM-dd')
    const e   = wmTotals.get(key) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    wmTotals.set(key, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of wmTotals) {
    weatherAvg[key] = Math.round((sum / count) * 100) / 100
  }

  const today = startOfDay(new Date())
  // 熟成中は今日まで、それ以外は完成日（completedAt）で積算を打ち切る（ダッシュボードと同じ扱い）
  const accumUntil = lot.status === '熟成中' ? null : lot.completedAt
  const accumulatedTemp = calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps, accumUntil)
  const currentLocation = getCurrentLocation(lot.locationHistory)
  const coloringRisk = calcColoringRisk(accumulatedTemp, targetTempSum)
  // 今日時点の実績積算を渡して較正（熟成度%と完成予定日が同じ点を通るようにする）
  const estimatedCompletion =
    lot.status === '熟成中'
      ? calcCompletionFromBrew(
          lot.brewedAt, targetTempSum, currentLocation,
          weatherAvg, moisture.heatingDefaultTemp - 10, moisture.q10Value, moisture.heatingDefaultTemp, moisture.fridgeTemp,
          accumulatedTemp,
        )
      : null
  const elapsedDays = differenceInDays(today, startOfDay(lot.brewedAt))
  // 完成済みは completedAt までの日数、熟成中は今日までの日数
  const agingDays = lot.completedAt
    ? differenceInDays(startOfDay(lot.completedAt), startOfDay(lot.brewedAt))
    : elapsedDays
  const locationPeriods = calcPeriodAccumulations(lot.locationHistory, weatherMap, roomTemps)

  // 麹歩合・塩分・水分の計算
  let brewStats: { kojiRatio: number; saltPercent: number; moisturePercent: number } | null = null
  if (lot.brewRecord) {
    const br = lot.brewRecord
    const isRiceKoji = lot.misoType === '山吹みそ' || lot.misoType === '白みそ'
    const kojiMoisture   = isRiceKoji ? moisture.komeKoji : moisture.mugiKoji
    const steamedSoyKg   = br.soybeanKg * moisture.soybeanRatio
    const steamedSoyMoisture = ((moisture.soybeanRatio - 1) + moisture.soybean) / moisture.soybeanRatio
    const totalMoistureKg =
      br.kojiKg      * kojiMoisture +
      steamedSoyKg   * steamedSoyMoisture +
      br.seedWaterL  * 1.0 +
      br.mizuameKg   * moisture.mizuame +
      br.seedMisoKg  * moisture.seedMiso
    brewStats = {
      kojiRatio:       Math.round((br.mugiOrKomeKg / br.soybeanKg) * 10 * 10) / 10,
      saltPercent:     Math.round((br.saltKg / br.shikomiKg) * 100 * 10) / 10,
      moisturePercent: Math.round((totalMoistureKg / br.shikomiKg) * 100 * 10) / 10,
    }
  }

  const props: LotDetailProps = {
    productNameOptions:     usageOptions.productNamesByType[lot.misoType] ?? [],
    operatorOptions:        usageOptions.operatorNames,
    id:                     lot.id,
    lotNumber:              lot.lotNumber,
    misoType:               lot.misoType,
    isPrototype:            lot.isPrototype,
    yieldRate:              moisture.yieldRate,
    status:                 lot.status,
    brewedAtISO:            lot.brewedAt.toISOString(),
    elapsedDays,
    agingDays,
    totalWeightKg:          lot.totalWeightKg,
    targetTempSum,
    q10Value:               moisture.q10Value,
    completedAtISO:         lot.completedAt?.toISOString() ?? null,
    bucketNumbers:          lot.bucketNumbers ?? null,
    accumulatedTemp,
    currentLocation,
    coloringRisk,
    estimatedCompletionISO: estimatedCompletion?.toISOString() ?? null,
    weatherAvg,
    heatingBaseTemp:        moisture.heatingDefaultTemp,
    fridgeTemp:             moisture.fridgeTemp,
    locationPeriods,
    agingNotes: lot.agingNotes.map(n => ({
      id:           n.id,
      recordedAt:   n.recordedAt.toISOString(),
      memo:         n.memo,
      airTempC:     n.airTempC,
      productTempC: n.productTempC,
    })),
    buckets: lot.buckets.map(b => ({
      id:                b.id,
      bucketNumber:      b.bucketNumber,
      initialWeightKg:   b.initialWeightKg,
      remainingWeightKg: b.remainingWeightKg,
      status:            b.status,
      usages: b.usages.map(u => ({
        id:          u.id,
        usedAt:      u.usedAt.toISOString(),
        usedKg:      u.usedKg,
        productName: u.productName ?? null,
        operator:    u.operator ?? null,
        notes:       u.notes ?? null,
      })),
    })),
    brewStats,
    brewRecord: lot.brewRecord
      ? {
          mugiOrKomeKg:        lot.brewRecord.mugiOrKomeKg,
          kojiKg:              lot.brewRecord.kojiKg,
          soybeanKg:           lot.brewRecord.soybeanKg,
          saltKg:              lot.brewRecord.saltKg,
          mizuameKg:           lot.brewRecord.mizuameKg,
          seedWaterL:          lot.brewRecord.seedWaterL,
          shikomiKg:           lot.brewRecord.shikomiKg,
          seedMisoKg:          lot.brewRecord.seedMisoKg,
          taneKojiG:           lot.brewRecord.taneKojiG,
          soybeanOrigin:       lot.brewRecord.soybeanOrigin,
          soybeanOriginDetail: lot.brewRecord.soybeanOriginDetail,
          soybeanArrivalDate:  lot.brewRecord.soybeanArrivalDate?.toISOString() ?? null,
          soybeanSupplier:     lot.brewRecord.soybeanSupplier,
          soybeanLotNo:        lot.brewRecord.soybeanLotNo,
          kojiMadeAt:          lot.brewRecord.kojiMadeAt?.toISOString() ?? null,
          kojiSupplier:        lot.brewRecord.kojiSupplier,
          saltBrand:           lot.brewRecord.saltBrand,
          saltLotNo:           lot.brewRecord.saltLotNo,
          mizuameBrand:        lot.brewRecord.mizuameBrand,
          mizuameLotNo:        lot.brewRecord.mizuameLotNo,
          kojiCondition:       lot.brewRecord.kojiCondition,
          soybeanHardness:     lot.brewRecord.soybeanHardness,
          airTempC:            lot.brewRecord.airTempC,
          productTempC:        lot.brewRecord.productTempC,
          steamingPressure:    lot.brewRecord.steamingPressure,
          coolingMin:          lot.brewRecord.coolingMin,
          memo:                lot.brewRecord.memo,
        }
      : null,
  }

  return <LotDetail {...props} />
}

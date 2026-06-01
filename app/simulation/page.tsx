import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import { applyQ10 } from '@/lib/tempCalc'
import BrewSimulator from './BrewSimulator'

export const metadata: Metadata = {
  title: '試作シミュレーター | みそ熟成管理システム',
}

export const dynamic = 'force-dynamic'

export default async function SimulationPage() {
  const [moisture, recipe, brewRecords, allWeatherData] = await Promise.all([
    getMoistureSettings(),
    prisma.misoRecipe.findFirst({ where: { name: '無添加麦みそ' } }),
    // 無添加麦みその実績仕込みデータ（直近20件）
    prisma.lot.findMany({
      where: {
        misoType:    '無添加麦みそ',
        brewRecord:  { isNot: null },
      },
      select: {
        brewRecord: {
          select: {
            kojiKg:     true,
            soybeanKg:  true,
            seedWaterL: true,
            shikomiKg:  true,
            seedMisoKg: true,
          },
        },
      },
      orderBy: { brewedAt: 'desc' },
      take: 20,
    }),
    // 月別平均気温計算用（date・effectiveTemp のみ取得）
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  const baseGrainKg   = recipe?.grainKg       ?? 650
  const baseSoybeanKg = recipe?.soybeanKg     ?? 270
  const baseSaltKg    = recipe?.saltKg        ?? 171
  const baseTotalKg   = recipe?.totalWeightKg ?? 1572

  const baseKojiHo  = Math.round((baseGrainKg / baseSoybeanKg) * 10 * 10) / 10
  const baseSaltPct = Math.round((baseSaltKg  / baseTotalKg)   * 1000) / 10

  // 蒸煮大豆水分率 = (soybeanRatio - 1 + 大豆含水率) / soybeanRatio
  const steamedSoyMoisture =
    (moisture.soybeanRatio - 1 + moisture.soybean) / moisture.soybeanRatio

  // 月別（1〜12月）の平均有効積算温度・平均気温を計算
  const monthlyBuckets: Record<number, number[]> = {}
  for (const w of allWeatherData) {
    const m = w.date.getUTCMonth() + 1  // 1〜12
    if (!monthlyBuckets[m]) monthlyBuckets[m] = []
    monthlyBuckets[m].push(w.effectiveTemp)
  }

  const weatherMonthlyDailyAvg: Record<number, number> = {}  // Q10補正済み有効積算（℃/日）
  const weatherMonthlyTempC:    Record<number, number> = {}   // 月平均気温（℃）

  // データがない月のフォールバック用年間平均
  const allTemps = allWeatherData.map(w => w.effectiveTemp)
  const globalRawAvg = allTemps.length > 0
    ? allTemps.reduce((s, t) => s + t, 0) / allTemps.length
    : 4

  for (let m = 1; m <= 12; m++) {
    const temps  = monthlyBuckets[m] ?? []
    const rawAvg = temps.length > 0
      ? temps.reduce((s, t) => s + t, 0) / temps.length
      : globalRawAvg
    weatherMonthlyDailyAvg[m] = applyQ10(rawAvg, moisture.q10Value, moisture.heatingDefaultTemp)
    weatherMonthlyTempC[m]    = rawAvg + 10  // effectiveTemp + 10 ≈ 月平均気温
  }

  // 実際の仕込みデータから目標水分率を計算
  const validRecords = brewRecords
    .map(l => l.brewRecord)
    .filter((br): br is NonNullable<typeof br> =>
      br != null && br.shikomiKg > 0 && br.kojiKg > 0
    )

  let targetMoisture: number
  let targetMoistureSampleCount: number

  if (validRecords.length > 0) {
    const moistures = validRecords.map(br =>
      (br.kojiKg     * moisture.mugiKoji +
       br.soybeanKg  * moisture.soybeanRatio * steamedSoyMoisture +
       br.seedWaterL +
       br.seedMisoKg * moisture.seedMiso
      ) / br.shikomiKg
    )
    targetMoisture = moistures.reduce((a, b) => a + b, 0) / moistures.length
    targetMoistureSampleCount = validRecords.length
  } else {
    targetMoisture =
      (baseGrainKg * moisture.kojiRatio * moisture.mugiKoji +
       baseSoybeanKg * moisture.soybeanRatio * steamedSoyMoisture) /
      baseTotalKg
    targetMoistureSampleCount = 0
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">試作シミュレーター</h1>
        <p className="text-sm text-muted-foreground mt-1">
          裸麦・大豆・塩・水の配合を変えたときの熟成挙動を理論モデルで推計します（精度目安±30〜50%）
        </p>
      </div>
      <BrewSimulator
        baseKojiHo={baseKojiHo}
        baseSaltPct={baseSaltPct}
        hadakaMugiMoisture={moisture.hadakaMugi}
        mugiKojiMoisture={moisture.mugiKoji}
        soybeanRawMoisture={moisture.soybean}
        steamedSoyMoisture={steamedSoyMoisture}
        kojiRatio={moisture.kojiRatio}
        soybeanRatio={moisture.soybeanRatio}
        targetMoisture={targetMoisture}
        targetMoistureSampleCount={targetMoistureSampleCount}
        room1Temp={moisture.room1Temp}
        room2Temp={moisture.room2Temp}
        weatherMonthlyDailyAvg={weatherMonthlyDailyAvg}
        weatherMonthlyTempC={weatherMonthlyTempC}
      />
    </div>
  )
}

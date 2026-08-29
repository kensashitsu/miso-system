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
  const [moisture, recipes, allBrewRecords, allWeatherData] = await Promise.all([
    getMoistureSettings(),
    prisma.misoRecipe.findMany({
      where: { name: { in: ['無添加麦みそ', '山吹みそ', '白みそ'] } },
    }),
    prisma.lot.findMany({
      where: {
        misoType:   { in: ['無添加麦みそ', '山吹みそ', '白みそ'] },
        brewRecord: { isNot: null },
      },
      select: {
        misoType: true,
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
      take: 60,
    }),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  const recipeMap     = Object.fromEntries(recipes.map(r => [r.name, r]))
  const recipeMusemai = recipeMap['無添加麦みそ']
  const recipeSuimai  = recipeMap['山吹みそ']
  const recipeShirome = recipeMap['白みそ']

  // 蒸煮大豆水分率（共通）
  const steamedSoyMoisture = (moisture.soybeanRatio - 1 + moisture.soybean) / moisture.soybeanRatio

  // ── 裸麦（無添加麦みそ）基準値 ──
  const baseGrainKg_m   = recipeMusemai?.grainKg       ?? 650
  const baseSoybeanKg_m = recipeMusemai?.soybeanKg     ?? 270
  const baseSaltKg_m    = recipeMusemai?.saltKg        ?? 171
  const baseTotalKg_m   = recipeMusemai?.totalWeightKg ?? 1572
  const baseKojiHo      = Math.round((baseGrainKg_m / baseSoybeanKg_m) * 10 * 10) / 10
  const baseSaltPct     = Math.round((baseSaltKg_m  / baseTotalKg_m)   * 1000) / 10

  // ── 砕米（山吹みそ）基準値 ──
  const baseGrainKg_s   = recipeSuimai?.grainKg       ?? 450
  const baseSoybeanKg_s = recipeSuimai?.soybeanKg     ?? 260
  const baseSaltKg_s    = recipeSuimai?.saltKg        ?? 135
  const baseTotalKg_s   = recipeSuimai?.totalWeightKg ?? 1300
  const baseKojiHoSuimai  = Math.round((baseGrainKg_s / baseSoybeanKg_s) * 10 * 10) / 10
  const baseSaltPctSuimai = Math.round((baseSaltKg_s  / baseTotalKg_s)   * 1000) / 10

  // ── 無洗米（白みそ）基準値 ──
  const baseGrainKg_w   = recipeShirome?.grainKg       ?? 70
  const baseSoybeanKg_w = recipeShirome?.soybeanKg     ?? 20
  const baseSaltKg_w    = recipeShirome?.saltKg        ?? 5
  const baseTotalKg_w   = recipeShirome?.totalWeightKg ?? 150
  const baseKojiHoShirome  = Math.round((baseGrainKg_w / baseSoybeanKg_w) * 10 * 10) / 10
  const baseSaltPctShirome = Math.round((baseSaltKg_w  / baseTotalKg_w)   * 1000) / 10

  // 月別平均気温・有効積算温度
  const monthlyBuckets: Record<number, number[]> = {}
  for (const w of allWeatherData) {
    const m = w.date.getUTCMonth() + 1
    if (!monthlyBuckets[m]) monthlyBuckets[m] = []
    monthlyBuckets[m].push(w.effectiveTemp)
  }
  const weatherMonthlyDailyAvg: Record<number, number> = {}
  const weatherMonthlyTempC:    Record<number, number> = {}
  const allTemps     = allWeatherData.map(w => w.effectiveTemp)
  const globalRawAvg = allTemps.length > 0
    ? allTemps.reduce((s, t) => s + t, 0) / allTemps.length
    : 4
  for (let m = 1; m <= 12; m++) {
    const temps  = monthlyBuckets[m] ?? []
    const rawAvg = temps.length > 0
      ? temps.reduce((s, t) => s + t, 0) / temps.length
      : globalRawAvg
    weatherMonthlyDailyAvg[m] = applyQ10(rawAvg, moisture.q10Value, moisture.heatingDefaultTemp)
    weatherMonthlyTempC[m]    = rawAvg + 10
  }

  // 品種別BrewRecordから目標水分率を計算
  type BrewRecRow = { kojiKg: number; soybeanKg: number; seedWaterL: number; shikomiKg: number; seedMisoKg: number }
  const recordsByType: Record<string, BrewRecRow[]> = {}
  for (const lot of allBrewRecords) {
    if (!lot.brewRecord) continue
    if (!recordsByType[lot.misoType]) recordsByType[lot.misoType] = []
    recordsByType[lot.misoType].push(lot.brewRecord)
  }

  function computeTargetMoisture(records: BrewRecRow[], kojiMoisture: number): { value: number; count: number } {
    const valid = records.filter(r => r.shikomiKg > 0 && r.kojiKg > 0)
    if (valid.length === 0) return { value: -1, count: 0 }
    const vals = valid.map(r =>
      (r.kojiKg     * kojiMoisture +
       r.soybeanKg  * moisture.soybeanRatio * steamedSoyMoisture +
       r.seedWaterL +
       r.seedMisoKg * moisture.seedMiso) / r.shikomiKg
    )
    return { value: vals.reduce((a, b) => a + b, 0) / vals.length, count: valid.length }
  }

  const mResult = computeTargetMoisture(recordsByType['無添加麦みそ'] ?? [], moisture.mugiKoji)
  const sResult = computeTargetMoisture(recordsByType['山吹みそ']    ?? [], moisture.komeKoji)
  const wResult = computeTargetMoisture(recordsByType['白みそ']      ?? [], moisture.komeKoji)

  const targetMoisture = mResult.value >= 0 ? mResult.value
    : (baseGrainKg_m * moisture.kojiRatio     * moisture.mugiKoji + baseSoybeanKg_m * moisture.soybeanRatio * steamedSoyMoisture) / baseTotalKg_m
  const targetMoistureSampleCount = mResult.count

  const targetMoistureSuimai = sResult.value >= 0 ? sResult.value
    : (baseGrainKg_s * moisture.komeKojiRatio * moisture.komeKoji + baseSoybeanKg_s * moisture.soybeanRatio * steamedSoyMoisture) / baseTotalKg_s

  const targetMoistureShirome = wResult.value >= 0 ? wResult.value
    : (baseGrainKg_w * moisture.komeKojiRatio * moisture.komeKoji + baseSoybeanKg_w * moisture.soybeanRatio * steamedSoyMoisture) / baseTotalKg_w

  return (
    <div className="max-w-[1280px] mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">試作シミュレーター</h1>
        <p className="text-sm text-muted-foreground mt-1">
          穀物（裸麦・砕米・無洗米・普通米）・大豆・塩・水の配合を変えたときの熟成挙動を理論モデルで推計します（精度目安±30〜50%）
        </p>
      </div>
      <BrewSimulator
        baseKojiHo={baseKojiHo}
        baseSaltPct={baseSaltPct}
        hadakaMugiMoisture={moisture.hadakaMugi}
        mugiKojiMoisture={moisture.mugiKoji}
        komeMoisture={moisture.kome}
        komeKojiMoisture={moisture.komeKoji}
        soybeanRawMoisture={moisture.soybean}
        steamedSoyMoisture={steamedSoyMoisture}
        kojiRatio={moisture.kojiRatio}
        komeKojiRatio={moisture.komeKojiRatio}
        soybeanRatio={moisture.soybeanRatio}
        targetMoisture={targetMoisture}
        targetMoistureSampleCount={targetMoistureSampleCount}
        targetMoistureSuimai={targetMoistureSuimai}
        targetMoistureShirome={targetMoistureShirome}
        room1Temp={moisture.room1Temp}
        room2Temp={moisture.room2Temp}
        weatherMonthlyDailyAvg={weatherMonthlyDailyAvg}
        weatherMonthlyTempC={weatherMonthlyTempC}
        baseKojiHoSuimai={baseKojiHoSuimai}
        baseSaltPctSuimai={baseSaltPctSuimai}
        baseKojiHoShirome={baseKojiHoShirome}
        baseSaltPctShirome={baseSaltPctShirome}
      />
    </div>
  )
}

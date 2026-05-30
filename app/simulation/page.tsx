import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import BrewSimulator from './BrewSimulator'

export const metadata: Metadata = {
  title: '試作シミュレーター | みそ熟成管理システム',
}

export const dynamic = 'force-dynamic'

export default async function SimulationPage() {
  const [moisture, recipe, brewRecords] = await Promise.all([
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

  // 実際の仕込みデータから目標水分率を計算
  // 水分(%) = (麹×麹水分率 + 蒸煮大豆×蒸煮大豆水分率 + 種水 + 種味噌×種味噌水分率) / 仕立量
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
    // 実績なし → レシピから計算（種水なし）
    targetMoisture =
      (baseGrainKg * moisture.kojiRatio * moisture.mugiKoji +
       baseSoybeanKg * moisture.soybeanRatio * steamedSoyMoisture) /
      baseTotalKg
    targetMoistureSampleCount = 0
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">試作シミュレーター</h1>
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
      />
    </div>
  )
}

import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import BrewSimulator from './BrewSimulator'

export const metadata: Metadata = {
  title: '試作シミュレーター | みそ熟成管理システム',
}

export const dynamic = 'force-dynamic'

export default async function SimulationPage() {
  const [moisture, recipe] = await Promise.all([
    getMoistureSettings(),
    prisma.misoRecipe.findFirst({ where: { name: '無添加麦みそ' } }),
  ])

  const baseGrainKg   = recipe?.grainKg      ?? 650
  const baseSoybeanKg = recipe?.soybeanKg    ?? 270
  const baseSaltKg    = recipe?.saltKg       ?? 171
  const baseTotalKg   = recipe?.totalWeightKg ?? 1572

  const baseKojiHo  = Math.round((baseGrainKg / baseSoybeanKg) * 10 * 10) / 10
  const baseSaltPct = Math.round((baseSaltKg / baseTotalKg) * 1000) / 10

  // 蒸煮大豆水分率 = (soybeanRatio - 1 + 大豆含水率) / soybeanRatio
  const steamedSoyMoisture =
    (moisture.soybeanRatio - 1 + moisture.soybean) / moisture.soybeanRatio

  // 無添加麦みそを基準とした目標水分率（種水なしの計算値）
  const targetMoisture =
    (baseGrainKg * moisture.kojiRatio * moisture.mugiKoji +
     baseSoybeanKg * moisture.soybeanRatio * steamedSoyMoisture) /
    baseTotalKg

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
        mugiKojiMoisture={moisture.mugiKoji}
        steamedSoyMoisture={steamedSoyMoisture}
        kojiRatio={moisture.kojiRatio}
        soybeanRatio={moisture.soybeanRatio}
        targetMoisture={targetMoisture}
      />
    </div>
  )
}

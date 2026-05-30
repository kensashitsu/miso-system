import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import BrewSimulator from './BrewSimulator'

export const metadata: Metadata = {
  title: '試作シミュレーター | みそ熟成管理システム',
}

export const dynamic = 'force-dynamic'

export default async function SimulationPage() {
  const recipe = await prisma.misoRecipe.findFirst({
    where: { name: '無添加麦みそ' },
  })

  const baseKojiHo = recipe
    ? Math.round((recipe.grainKg / recipe.soybeanKg) * 10 * 10) / 10
    : 24.1
  const baseSaltPct = recipe
    ? Math.round((recipe.saltKg / recipe.totalWeightKg) * 1000) / 10
    : 10.9

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">試作シミュレーター</h1>
        <p className="text-sm text-muted-foreground mt-1">
          裸麦・大豆・塩・水の配合を変えたときの熟成挙動を理論モデルで推計します（精度目安±30〜50%）
        </p>
      </div>
      <BrewSimulator baseKojiHo={baseKojiHo} baseSaltPct={baseSaltPct} />
    </div>
  )
}

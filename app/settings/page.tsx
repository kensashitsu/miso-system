import type { Metadata } from 'next'
import { getMoistureSettings, getBucketUsageOptions } from '@/lib/settings'
import { getMisoRecipes } from '@/lib/recipes'
import { prisma } from '@/lib/prisma'
import { getWeatherStatus } from './weather-actions'
import MoistureSettingsForm from './MoistureSettingsForm'
import RecipeSettings from './RecipeSettings'
import WeatherImportCard from './WeatherImportCard'
import ApiStatusCard from './ApiStatusCard'
import BulkTempUpdateCard, { type ActiveLot } from './BulkTempUpdateCard'
import InventorySnapshotCard from './InventorySnapshotCard'
import BucketUsageOptionsCard from './BucketUsageOptionsCard'
import SettingsTabs from './SettingsTabs'

export const metadata: Metadata = {
  title: '設定 | みそ熟成管理システム',
}

const HEATING_RE = /^暖房\d+(?:\.\d+)?℃$/
const COOLING_RE = /^冷房\d+(?:\.\d+)?℃$/

export default async function SettingsPage() {
  const [moisture, recipes, weatherStatus, fermentingLots, snapshots, usageOptions] = await Promise.all([
    getMoistureSettings(),
    getMisoRecipes(),
    getWeatherStatus(),
    // 完成ロットも対象にする。完成後も置き場の温度で熟成（着色）は進むため、
    // 実際に部屋にある物は同じように場所を直せる必要がある。
    // 熟成中だけだと、冷房にいるのが完成ロットばかりのとき「対象ロットなし」に
    // なって温度を直せなかった（2026-08-31ユーザー指摘）
    prisma.lot.findMany({
      where: { status: { in: ['熟成中', '完成'] } },
      select: {
        id:        true,
        lotNumber: true,
        misoType:  true,
        status:    true,
        locationHistory: {
          where:  { endDate: null },
          select: { location: true },
        },
      },
      orderBy: { lotNumber: 'asc' },
    }),
    prisma.monthlyInventorySnapshot.findMany({
      orderBy: [{ yearMonth: 'desc' }, { misoType: 'asc' }],
      take: 96, // 最大24ヶ月×4品種
    }),
    getBucketUsageOptions(),
  ])

  const heatingLots: ActiveLot[] = []
  const coolingLots: ActiveLot[] = []
  const normalLots:  ActiveLot[] = []

  for (const lot of fermentingLots) {
    const location = lot.locationHistory[0]?.location ?? ''
    const entry = { id: lot.id, lotNumber: lot.lotNumber, misoType: lot.misoType, location, status: lot.status }
    if (HEATING_RE.test(location))  heatingLots.push(entry)
    else if (COOLING_RE.test(location)) coolingLots.push(entry)
    else if (location === '常温')   normalLots.push(entry)
  }

  return (
    <div className="max-w-[1280px] mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <h1 className="hidden sm:block text-2xl font-bold text-gray-900 tracking-tight mb-4">設定</h1>
      <SettingsTabs
        recipe={<RecipeSettings recipes={recipes} moisture={moisture} />}
        aging={<MoistureSettingsForm moisture={moisture} />}
        place={
          <>
            <BulkTempUpdateCard
              heatingLots={heatingLots}
              coolingLots={coolingLots}
              normalLots={normalLots}
              heatingDefaultTemp={moisture.heatingDefaultTemp}
              coolingDefaultTemp={moisture.coolingDefaultTemp}
            />
            <BucketUsageOptionsCard
              misoTypes={recipes.map(r => r.name)}
              initialProductNamesByType={usageOptions.productNamesByType}
              initialOperatorNames={usageOptions.operatorNames}
            />
          </>
        }
        data={
          <>
            <WeatherImportCard initialStatus={weatherStatus} />
            <InventorySnapshotCard snapshots={snapshots} />
          </>
        }
        api={<ApiStatusCard />}
      />
    </div>
  )
}

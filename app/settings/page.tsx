import type { Metadata } from 'next'
import { getMoistureSettings } from '@/lib/settings'
import { getMisoRecipes } from '@/lib/recipes'
import { prisma } from '@/lib/prisma'
import { getWeatherStatus } from './weather-actions'
import MoistureSettingsForm from './MoistureSettingsForm'
import RecipeSettings from './RecipeSettings'
import WeatherImportCard from './WeatherImportCard'
import ApiStatusCard from './ApiStatusCard'
import BulkTempUpdateCard, { type ActiveLot } from './BulkTempUpdateCard'

export const metadata: Metadata = {
  title: '設定 | 味噌熟成管理システム',
}

const HEATING_RE = /^暖房\d+(?:\.\d+)?℃$/
const COOLING_RE = /^冷房\d+(?:\.\d+)?℃$/

export default async function SettingsPage() {
  const [moisture, recipes, weatherStatus, fermentingLots] = await Promise.all([
    getMoistureSettings(),
    getMisoRecipes(),
    getWeatherStatus(),
    prisma.lot.findMany({
      where: { status: '熟成中' },
      select: {
        id:        true,
        lotNumber: true,
        misoType:  true,
        locationHistory: {
          where:  { endDate: null },
          select: { location: true },
        },
      },
      orderBy: { lotNumber: 'asc' },
    }),
  ])

  const heatingLots: ActiveLot[] = []
  const coolingLots: ActiveLot[] = []
  const normalLots:  ActiveLot[] = []

  for (const lot of fermentingLots) {
    const location = lot.locationHistory[0]?.location ?? ''
    const entry = { id: lot.id, lotNumber: lot.lotNumber, misoType: lot.misoType, location }
    if (HEATING_RE.test(location))  heatingLots.push(entry)
    else if (COOLING_RE.test(location)) coolingLots.push(entry)
    else if (location === '常温')   normalLots.push(entry)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">設定</h1>
      <ApiStatusCard />
      <RecipeSettings recipes={recipes} moisture={moisture} />
      <MoistureSettingsForm moisture={moisture} />
      <BulkTempUpdateCard
        heatingLots={heatingLots}
        coolingLots={coolingLots}
        normalLots={normalLots}
        heatingDefaultTemp={moisture.heatingDefaultTemp}
        coolingDefaultTemp={moisture.coolingDefaultTemp}
      />
      <WeatherImportCard initialStatus={weatherStatus} />
    </div>
  )
}

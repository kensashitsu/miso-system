'use server'

import { format } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { fetchMonthlyWeather } from '@/lib/weatherFetch'

export type WeatherStatus = {
  count:    number
  earliest: string | null
  latest:   string | null
}

export async function getWeatherStatus(): Promise<WeatherStatus> {
  const [count, earliest, latest] = await Promise.all([
    prisma.weatherCache.count(),
    prisma.weatherCache.findFirst({ orderBy: { date: 'asc' },  select: { date: true } }),
    prisma.weatherCache.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
  ])
  return {
    count,
    earliest: earliest?.date.toISOString() ?? null,
    latest:   latest?.date.toISOString()   ?? null,
  }
}

export type ImportResult = {
  success:  boolean
  imported: number
  errors:   string[]
}

export async function importWeatherRange(yearFrom: number, yearTo: number): Promise<ImportResult> {
  const now = new Date()
  const currentYear  = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  if (yearFrom < 2010 || yearTo > currentYear || yearFrom > yearTo) {
    return { success: false, imported: 0, errors: ['取得範囲は2010年〜今年の範囲で指定してください'] }
  }

  let imported = 0
  const errors: string[] = []

  for (let year = yearFrom; year <= yearTo; year++) {
    // 当月はまだデータが揃っていないため除外
    const maxMonth = year === currentYear ? currentMonth - 1 : 12

    for (let month = 1; month <= maxMonth; month++) {
      try {
        const days = await fetchMonthlyWeather(year, month)
        if (days.length === 0) {
          errors.push(`${year}年${month}月: データなし`)
          continue
        }

        await prisma.$transaction(
          days.map(d =>
            prisma.weatherCache.upsert({
              where:  { date: d.date },
              create: { date: d.date, avgTempC: d.avgTempC, effectiveTemp: d.effectiveTemp },
              update: { avgTempC: d.avgTempC, effectiveTemp: d.effectiveTemp },
            })
          )
        )
        imported += days.length

        // 気象庁サーバーへの負荷軽減
        await new Promise(r => setTimeout(r, 700))
      } catch (e) {
        errors.push(`${year}年${month}月: ${e instanceof Error ? e.message : '取得失敗'}`)
      }
    }
  }

  revalidatePath('/lots/new')
  return { success: errors.length === 0, imported, errors }
}

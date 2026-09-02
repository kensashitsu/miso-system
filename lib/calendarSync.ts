// カレンダー同期：システムの予定をGoogleカレンダーへ反映する。
//
// 1件ずつ手でカレンダーに入れるのが煩わしいため自動化した（2026-09-02）。
//   「仕込予定日」カレンダー ← 仮登録の仕込み予定日
//   「熟成完了日」カレンダー ← 仮登録の完成予定日＋熟成中ロットの完成予定日
// 予定IDは仮登録ID・ロットIDから作る固定値なので、日付が動けば同じ予定が更新され、
// 仮登録やロットが消えれば対応する予定も消える。
// 手で作った予定には触らない（このシステムが作った予定だけを拡張プロパティで見分ける）。
import { createHash } from 'crypto'
import { format } from 'date-fns'
import { prisma } from './prisma'
import { getMoistureSettings } from './settings'
import { calcAccumulatedTemp, getCurrentLocation } from './tempCalc'
import { calcCompletionFromBrew } from './brewSimulation'
import { AGING_CALENDAR_ID, BREW_CALENDAR_ID, brewEventTitle, completionEventTitle } from './googleCalendarLink'
import { syncCalendar, type CalendarEvent } from './googleCalendar'

// GoogleカレンダーのイベントIDは base32hex（0-9a-v）しか使えず、cuid はそのままでは通らない。
// SHA-1のhex（0-9a-f）に変換して使う
const eventId = (key: string) => createHash('sha1').update(key).digest('hex')

export type SyncResult = {
  brew:  { created: number; updated: number; deleted: number }
  aging: { created: number; updated: number; deleted: number }
}

export async function syncPlansToCalendar(): Promise<SyncResult> {
  const [moisture, plans, lots, recipes, weather] = await Promise.all([
    getMoistureSettings(),
    prisma.brewPlan.findMany({ where: { status: '仮登録', lotId: null }, orderBy: { brewDate: 'asc' } }),
    prisma.lot.findMany({
      where: { status: '熟成中' },
      include: { locationHistory: { orderBy: { startDate: 'asc' } } },
    }),
    prisma.misoRecipe.findMany(),
    prisma.weatherCache.findMany({ select: { date: true, effectiveTemp: true } }),
  ])

  // 日別・月日平均の有効積算温度（ダッシュボードと同じ作り方）
  const weatherMap = new Map<string, number>(weather.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp]))
  const totals = new Map<string, { sum: number; count: number }>()
  for (const w of weather) {
    const k = format(w.date, 'MM-dd')
    const e = totals.get(k) ?? { sum: 0, count: 0 }
    e.sum += w.effectiveTemp; e.count += 1
    totals.set(k, e)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [k, { sum, count }] of totals) weatherAvg[k] = Math.round((sum / count) * 100) / 100
  const roomTemps = {
    room1Temp: moisture.room1Temp, room2Temp: moisture.room2Temp, fridgeTemp: moisture.fridgeTemp,
    heatingBaseTemp: moisture.heatingDefaultTemp, q10Value: moisture.q10Value,
  }
  const targetOf = (misoType: string, fallback: number) =>
    recipes.find(r => r.name === misoType)?.targetTempSum ?? fallback

  // ── 仕込予定日カレンダー ──────────────────────────────
  const brewEvents: CalendarEvent[] = plans.map(p => ({
    id:      eventId(`brew:${p.id}`),
    date:    p.brewDate,
    summary: brewEventTitle(p.misoType, p.bucketNumbers),
    description: [
      `仕込み予定日：${format(p.brewDate, 'yyyy/MM/dd')}`,
      `完成予定日：${format(p.completionDate, 'yyyy/MM/dd')}（熟成${p.fermentationDays}日）`,
      '※みそ熟成管理システムが自動で作成・更新しています',
    ].join(String.fromCharCode(10)),
  }))

  // ── 熟成完了日カレンダー ──────────────────────────────
  const agingEvents: CalendarEvent[] = plans.map(p => ({
    id:      eventId(`completion:${p.id}`),
    date:    p.completionDate,
    summary: completionEventTitle(p.misoType, p.bucketNumbers, p.brewDate, p.completionDate),
    description: [
      `完成予定日：${format(p.completionDate, 'yyyy/MM/dd')}（仮登録）`,
      `仕込み予定日：${format(p.brewDate, 'yyyy/MM/dd')}（熟成${p.fermentationDays}日）`,
      '※みそ熟成管理システムが自動で作成・更新しています',
    ].join(String.fromCharCode(10)),
  }))

  // 熟成中ロットは実績積算で較正した完成予定日を使う（ダッシュボードの表示と同じ）
  for (const lot of lots) {
    const target   = targetOf(lot.misoType, lot.targetTempSum)
    const location = lot.locationHistory.length > 0 ? getCurrentLocation(lot.locationHistory) : '常温'
    const accum    = calcAccumulatedTemp(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps)
    const completion = calcCompletionFromBrew(
      lot.brewedAt, target, location, weatherAvg,
      moisture.heatingDefaultTemp - 10, moisture.q10Value, moisture.heatingDefaultTemp, moisture.fridgeTemp,
      accum,
    )
    if (!completion) continue
    agingEvents.push({
      id:      eventId(`lot:${lot.id}`),
      date:    completion,
      summary: completionEventTitle(lot.misoType, lot.bucketNumbers, lot.brewedAt, completion),
      description: [
        `完成予定日：${format(completion, 'yyyy/MM/dd')}（ロット ${lot.lotNumber}）`,
        `仕込み日：${format(lot.brewedAt, 'yyyy/MM/dd')}／目標積算温度：${target} ℃・日`,
        '※みそ熟成管理システムが自動で作成・更新しています（天候で数日前後します）',
      ].join(String.fromCharCode(10)),
    })
  }

  const brew  = await syncCalendar(BREW_CALENDAR_ID,  'brew',  brewEvents)
  const aging = await syncCalendar(AGING_CALENDAR_ID, 'aging', agingEvents)
  return { brew, aging }
}

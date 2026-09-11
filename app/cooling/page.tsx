import type { Metadata } from 'next'
import { format } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { COOLING_TO_BREW_DAYS } from '@/lib/cooling'
import CoolingBoard, { type RunView } from './CoolingBoard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '放冷',
}

export default async function CoolingPage() {
  const [runs, plans] = await Promise.all([
    prisma.coolingRun.findMany({
      orderBy: { runDate: 'desc' },
      include: {
        steps: { orderBy: { sortOrder: 'asc' } },
        lot:   { select: { id: true, lotNumber: true, misoType: true } },
      },
    }),
    // ロットになる前の仮登録。放冷した日にはまだロットが無いので、
    // 「2日後に何を仕込む予定か」はこちらから出す
    prisma.brewPlan.findMany({
      where:  { status: '仮登録' },
      select: { brewDate: true, misoType: true, bucketNumbers: true },
    }),
  ])

  const planByDate = new Map<string, string>()
  for (const plan of plans) {
    const key = format(plan.brewDate, 'yyyy-MM-dd')
    const label = plan.bucketNumbers ? `${plan.misoType} ${plan.bucketNumbers}` : plan.misoType
    planByDate.set(key, planByDate.has(key) ? `${planByDate.get(key)}・${label}` : label)
  }

  const views: RunView[] = runs.map(run => {
    const brewKey = format(new Date(run.runDate.getTime() + COOLING_TO_BREW_DAYS * 86400000), 'yyyy-MM-dd')
    return {
      id:           run.id,
      runDateISO:   format(run.runDate, 'yyyy-MM-dd'),
      grainType:    run.grainType,
      airTemp1FC:   run.airTemp1FC,
      airTemp2FC:   run.airTemp2FC,
      roomTempC:    run.roomTempC,
      memo:         run.memo,
      lot:          run.lot,
      plannedLabel: run.lot ? null : (planByDate.get(brewKey) ?? null),
      steps:        run.steps.map(s => ({
        id:             s.id,
        fan:            s.fan,
        belt:           s.belt,
        productTempMin: s.productTempMin,
        productTempMax: s.productTempMax,
        productTempRaw: s.productTempRaw,
        memo:           s.memo,
      })),
    }
  })

  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">放冷記録</h1>
        <p className="text-sm text-muted-foreground mt-1">
          蒸した麦・砕米を放冷機で冷やしたときの設定と品温。仕込みはこの2日後で、ロットとは自動で紐付きます。
        </p>
      </div>
      <CoolingBoard runs={views} />
    </main>
  )
}

import type { Metadata } from 'next'
import { subDays } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { PACKING_ITEMS, PACKING_LOCATION } from '@/lib/packingItems'
import PackingInput from './PackingInput'

export const metadata: Metadata = { title: '小分け入力' }

export default async function PackingPage() {
  const [recent, usage, pendingCount] = await Promise.all([
    // 直近の記録（取消ボタンを出すぶん）
    prisma.packingRecord.findMany({
      where:   { qty: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take:    8,
    }),
    // 品目ボタンの並び順に使う直近90日の実績
    prisma.packingRecord.groupBy({
      by:    ['itemName'],
      where: { createdAt: { gte: subDays(new Date(), 90) }, qty: { gt: 0 } },
      _sum:  { qty: true },
    }),
    prisma.packingRecord.count({ where: { sendStatus: '未送信' } }),
  ])

  // よく使う品目ほど前に出す（使わない品目は自然に沈む）
  const usedQty = new Map(usage.map(u => [u.itemName, u._sum.qty ?? 0]))
  const items = [...PACKING_ITEMS].sort(
    (a, b) => (usedQty.get(b.name) ?? 0) - (usedQty.get(a.name) ?? 0)
  )

  return (
    <PackingInput
      items={items}
      location={PACKING_LOCATION}
      pendingCount={pendingCount}
      recent={recent.map(r => ({
        id:         r.id,
        itemName:   r.itemName,
        qty:        r.qty,
        unit:       r.unit,
        kgPerUnit:  r.kgPerUnit,
        operator:   r.operator,
        sendStatus: r.sendStatus,
        canceled:   r.canceledAt != null,
        createdAt:  r.createdAt.toISOString(),
      }))}
    />
  )
}

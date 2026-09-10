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
    // ※ 量ではなく「入力した回数」で数える（バラはkg・桶は丁で桁が違うため、
    //   量で並べるとバラだけが常に先頭に来てしまう）
    prisma.packingRecord.groupBy({
      by:    ['itemName'],
      where: { createdAt: { gte: subDays(new Date(), 90) }, qty: { gt: 0 } },
      _count: { _all: true },
    }),
    prisma.packingRecord.count({ where: { sendStatus: '未送信' } }),
  ])

  // よく使う品目ほど前に出す（使わない品目は自然に沈む）
  const usedCount = new Map(usage.map(u => [u.itemName, u._count._all]))
  const items = [...PACKING_ITEMS].sort(
    (a, b) => (usedCount.get(b.name) ?? 0) - (usedCount.get(a.name) ?? 0)
  )

  // タブの並びはマスタの登録順で固定する（実績順で並べ替えるのは各タブの中の品目だけ。
  // タブまで動くと「いつもの位置」が変わって押し間違えるため）
  const types = [...new Set(PACKING_ITEMS.map(i => i.misoType))]

  return (
    <PackingInput
      items={items}
      types={types}
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

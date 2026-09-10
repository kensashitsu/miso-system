import type { Metadata } from 'next'
import { subDays } from 'date-fns'
import { prisma } from '@/lib/prisma'
import { PACKING_ITEMS, PACKING_LOCATION } from '@/lib/packingItems'
import { fetchItemStocks } from '@/lib/externalApi'
import PackingInput from './PackingInput'

export const metadata: Metadata = { title: '小分け入力' }

export default async function PackingPage() {
  const [recent, usage, pendingCount, itemStocks] = await Promise.all([
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
    // 在庫数はzaikoにしか無い（本システムは持っていない）。API未設定・取得失敗のときは
    // null が返り、画面は在庫欄を出さない
    fetchItemStocks(),
  ])

  // よく使う品目ほど前に出す（使わない品目は自然に沈む）
  const usedCount = new Map(usage.map(u => [u.itemName, u._count._all]))
  const items = [...PACKING_ITEMS].sort(
    (a, b) => (usedCount.get(b.name) ?? 0) - (usedCount.get(a.name) ?? 0)
  )

  // タブの並びはマスタの登録順で固定する（実績順で並べ替えるのは各タブの中の品目だけ。
  // タブまで動くと「いつもの位置」が変わって押し間違えるため）
  const types = [...new Set(PACKING_ITEMS.map(i => i.misoType))]

  // 品目コード優先・無ければ品名で突き合わせる（コードが埋まるまでの保険）
  const stockByItem: Record<string, number> = {}
  for (const item of PACKING_ITEMS) {
    const hit = itemStocks?.find(s =>
      (item.code !== '' && s.itemCode === item.code) || s.itemName === item.name
    )
    if (hit) stockByItem[item.name] = hit.stock
  }

  return (
    <PackingInput
      items={items}
      types={types}
      stockByItem={stockByItem}
      stockAvailable={itemStocks != null}
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

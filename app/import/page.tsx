import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import ShipmentImport, { type ExistingRow, type ImportSummaryRow } from './ShipmentImport'
import ShikomiImport, { type ShikomiSummaryRow } from './ShikomiImport'

export const metadata: Metadata = {
  title: 'データインポート | 味噌熟成管理システム',
}

export const dynamic = 'force-dynamic'

// 準備中タブのプレースホルダー
function ComingSoonTab({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
      {label}のインポート機能は準備中です
    </div>
  )
}

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab = 'shipment' } = await searchParams

  const [existingData, importSummaryRaw]: [ExistingRow[], { misoType: string; _count: { id: number }; _min: { yearMonth: string | null }; _max: { yearMonth: string | null } }[]] =
    tab === 'shipment'
      ? await Promise.all([
          prisma.shipmentHistory.findMany({
            where:   { misoType: '全品種合計' },
            orderBy: { yearMonth: 'desc' },
            select:  { yearMonth: true, weightKg: true, importedAt: true },
          }).then(rows => rows.map(r => ({
            yearMonth:  r.yearMonth,
            weightKg:   r.weightKg,
            importedAt: r.importedAt.toISOString(),
          }))),
          prisma.shipmentHistory.groupBy({
            by: ['misoType'],
            _count: { id: true },
            _min:   { yearMonth: true },
            _max:   { yearMonth: true },
          }),
        ])
      : [[], []]

  const SUMMARY_TYPES = ['全品種合計', '無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const
  const importSummary = SUMMARY_TYPES.map(misoType => {
    const row = importSummaryRaw.find(r => r.misoType === misoType)
    return {
      misoType,
      count:       row?._count.id         ?? 0,
      minYearMonth: row?._min.yearMonth   ?? null,
      maxYearMonth: row?._max.yearMonth   ?? null,
    }
  })

  const SHIKOMI_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const
  const shikomiSummary: ShikomiSummaryRow[] = tab === 'brewing'
    ? await prisma.lot.groupBy({
        by: ['misoType'],
        _count: { id: true },
        _min:   { brewedAt: true },
        _max:   { brewedAt: true },
      }).then(rows =>
        SHIKOMI_TYPES.map(misoType => {
          const row = rows.find(r => r.misoType === misoType)
          return {
            misoType,
            count:      row?._count.id       ?? 0,
            minBrewedAt: row?._min.brewedAt  ? row._min.brewedAt.toISOString() : null,
            maxBrewedAt: row?._max.brewedAt  ? row._max.brewedAt.toISOString() : null,
          }
        })
      )
    : []

  const tabs = [
    { key: 'shipment', label: '出荷実績' },
    { key: 'brewing',  label: '仕込帳' },
    { key: 'packaging',label: '袋詰め記録' },
  ]

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">データインポート</h1>

      {/* タブ */}
      <div className="flex gap-1 border-b border-gray-100">
        {tabs.map(t => (
          <a
            key={t.key}
            href={`/import?tab=${t.key}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-400 hover:text-gray-700'
            }`}
          >
            {t.label}
            {t.key === 'packaging' && (
              <span className="ml-1.5 text-xs text-muted-foreground/60">準備中</span>
            )}
          </a>
        ))}
      </div>

      {/* タブコンテンツ */}
      {tab === 'shipment' && <ShipmentImport existingData={existingData} importSummary={importSummary} />}
      {tab === 'brewing'  && <ShikomiImport shikomiSummary={shikomiSummary} />}
      {tab === 'packaging'&& <ComingSoonTab label="袋詰め記録" />}
    </div>
  )
}

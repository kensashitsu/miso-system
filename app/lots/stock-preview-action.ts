'use server'

import { fetchAgedStock, fetchWipStock } from '@/lib/externalApi'

export interface StockChangeItem {
  label:     string
  currentKg: number | null  // null = API未設定 or 取得失敗
  deltaKg:   number         // 正=追加、負=減算
}

export async function getStockPreview(
  misoType:  string,
  action:    'register' | 'complete' | 'delete-wip' | 'delete-aged',
  yieldKg:   number,
): Promise<StockChangeItem[]> {
  const [wipStocks, agedStocks] = await Promise.all([
    fetchWipStock(),
    fetchAgedStock(),
  ])

  const wipKg   = wipStocks?.find(s => s.misoType === misoType)?.stockKg ?? null
  const agedKg  = agedStocks?.find(s => s.misoType === misoType)?.stockKg ?? null
  const agedLbl = misoType === '白みそ' ? '西京みそ　ﾊﾞﾗ（熟成済）' : `${misoType}（熟成済）`
  const wipLbl  = `${misoType}（熟成中）`

  switch (action) {
    case 'register':
      // 白みそは熟成中品目なし
      if (misoType === '白みそ') return []
      return [{ label: wipLbl, currentKg: wipKg, deltaKg: yieldKg }]

    case 'complete': {
      const items: StockChangeItem[] = []
      if (misoType !== '白みそ') {
        items.push({ label: wipLbl, currentKg: wipKg, deltaKg: -yieldKg })
      }
      items.push({ label: agedLbl, currentKg: agedKg, deltaKg: yieldKg })
      return items
    }

    case 'delete-wip':
      if (misoType === '白みそ') return []
      return [{ label: wipLbl, currentKg: wipKg, deltaKg: -yieldKg }]

    case 'delete-aged':
      return [{ label: agedLbl, currentKg: agedKg, deltaKg: -yieldKg }]

    default:
      return []
  }
}

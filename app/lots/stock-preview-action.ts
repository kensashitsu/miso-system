'use server'

import { fetchAgedStock, fetchWipStock, previewStockAdjust } from '@/lib/externalApi'

export interface StockChangeItem {
  label:        string
  currentKg:    number | null  // null = API未設定 or 取得失敗
  deltaKg:      number         // 正=追加、負=減算
  unit?:        string         // 表示単位（省略時 kg。原材料は 袋・リットル など）
  isMaterial?:  boolean        // true=レシピ連動で増減する原材料行
  recipeLinked?: boolean       // true=zaiko側でレシピ展開され原材料在庫も連動調整される
}

// レシピ連動で増減する原材料行を取得（プレビューAPI未設定時は空配列）
async function fetchMaterialItems(misoType: string, deltaKg: number): Promise<StockChangeItem[]> {
  const preview = await previewStockAdjust({ misoType, category: 'wip', deltaKg, applyRecipe: true })
  if (!preview) return []
  return preview.consumedMaterials.map(m => ({
    label:      m.name,
    currentKg:  m.stockBefore ?? null,
    // 在庫変動は前後値の差から算出する（quantityはAPIが復元方向でも正で返すため符号の根拠にしない）
    deltaKg:
      m.stockBefore != null && m.stockAfter != null
        ? m.stockAfter - m.stockBefore
        : deltaKg >= 0 ? -Math.abs(m.quantity) : Math.abs(m.quantity),
    unit:       m.unit,
    isMaterial: true,
  }))
}

export async function getStockPreview(
  misoType:  string,
  action:    'register' | 'complete' | 'revert' | 'delete-wip' | 'delete-aged',
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
    case 'register': {
      // 白みそは熟成中品目なし
      if (misoType === '白みそ') return []
      const materials = await fetchMaterialItems(misoType, yieldKg)
      return [
        { label: wipLbl, currentKg: wipKg, deltaKg: yieldKg, recipeLinked: true },
        ...materials,
      ]
    }

    case 'complete': {
      const items: StockChangeItem[] = []
      if (misoType !== '白みそ') {
        items.push({ label: wipLbl, currentKg: wipKg, deltaKg: -yieldKg })
      }
      items.push({ label: agedLbl, currentKg: agedKg, deltaKg: yieldKg })
      return items
    }

    case 'revert': {
      const items: StockChangeItem[] = [
        { label: agedLbl, currentKg: agedKg, deltaKg: -yieldKg },
      ]
      if (misoType !== '白みそ') {
        items.push({ label: wipLbl, currentKg: wipKg, deltaKg: yieldKg })
      }
      return items
    }

    case 'delete-wip': {
      if (misoType === '白みそ') return []
      const materials = await fetchMaterialItems(misoType, -yieldKg)
      return [
        { label: wipLbl, currentKg: wipKg, deltaKg: -yieldKg, recipeLinked: true },
        ...materials,
      ]
    }

    case 'delete-aged':
      return [{ label: agedLbl, currentKg: agedKg, deltaKg: -yieldKg }]

    default:
      return []
  }
}

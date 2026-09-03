// 原材料在庫（zaiko）の取得。
//
// 原材料の在庫はこのシステムでは持っていない。zaiko 側にあり、ロット登録時の
// 在庫調整API（applyRecipe: true）でレシピ展開されて自動的に減る。
// 数量を知るための専用APIは無いが、在庫調整のプレビューAPI（読み取り専用・在庫は
// 一切変更しない）が consumedMaterials に「現在庫（stockBefore）」と
// 「1回の仕込みで使う量（quantity）」を返すので、それをそのまま在庫表示に使う。
//
// 1回の仕込みで送る量は品種ごとの固定値（lib/stockQty.ts）なので、
// quantity ＝ 1回の仕込みで使う量になり、在庫 ÷ quantity で「あと何回分」が出せる。
import { previewStockAdjust } from './externalApi'
import { FIXED_STOCK_SEND_KG } from './stockQty'

export interface MaterialStock {
  name:  string
  unit:  string                      // 袋・缶・リットル・kg
  stock: number                      // 現在庫
  // 1回の仕込みで使う量（品種別）。この原材料を使わない品種はキーごと無い
  usagePerBrew: Record<string, number>
}

export async function getMaterialStock(): Promise<MaterialStock[] | null> {
  // 固定送信量が決まっている品種＝仕込みで原材料を消費する品種。
  // 白みそは熟成中品目が無く在庫調整の対象外なので、そもそも含まれない
  const misoTypes = Object.keys(FIXED_STOCK_SEND_KG)

  const previews = await Promise.all(
    misoTypes.map(async misoType => ({
      misoType,
      preview: await previewStockAdjust({
        misoType,
        category:    'wip',
        deltaKg:     FIXED_STOCK_SEND_KG[misoType],
        applyRecipe: true,
      }),
    })),
  )
  if (previews.every(p => p.preview == null)) return null

  // 原材料名で束ねる。在庫はどの品種から見ても同じ値なので最初に取れたものを使う
  const byName = new Map<string, MaterialStock>()
  for (const { misoType, preview } of previews) {
    for (const m of preview?.consumedMaterials ?? []) {
      if (m.stockBefore == null) continue
      const cur = byName.get(m.name) ?? { name: m.name, unit: m.unit, stock: m.stockBefore, usagePerBrew: {} }
      cur.usagePerBrew[misoType] = m.quantity
      byName.set(m.name, cur)
    }
  }
  return [...byName.values()]
}

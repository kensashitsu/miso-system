'use client'

import type { StockChangeItem } from '@/app/lots/stock-preview-action'

export default function StockPreviewPanel({
  state,
}: {
  state: StockChangeItem[] | null | 'loading'
}) {
  if (state === 'loading' || state === null) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-2.5 text-sm text-muted-foreground">
        {state === 'loading' ? '在庫情報を取得中...' : ''}
      </div>
    )
  }
  if (state.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">在庫システムへの反映なし</p>
    )
  }
  const hasRecipeLinked = state.some(item => item.recipeLinked)
  const isConsume = state.some(item => item.recipeLinked && item.deltaKg >= 0)
  return (
    <div className="rounded-md border overflow-hidden text-sm">
      <table className="w-full">
        <thead className="bg-muted/40">
          <tr>
            <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">品目</th>
            <th className="text-right px-3 py-1.5 text-xs font-medium text-muted-foreground">現在</th>
            <th className="text-right px-3 py-1.5 text-xs font-medium text-muted-foreground">変動</th>
            <th className="text-right px-3 py-1.5 text-xs font-medium text-muted-foreground">変動後</th>
          </tr>
        </thead>
        <tbody>
          {state.map((item, i) => {
            const after  = item.currentKg !== null ? item.currentKg + item.deltaKg : null
            const isAdd  = item.deltaKg >= 0
            return (
              <tr key={i} className="border-t">
                <td className="px-3 py-2">{item.label}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {item.currentKg !== null ? `${item.currentKg.toLocaleString()} kg` : '—'}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${isAdd ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {isAdd ? '+' : ''}{item.deltaKg.toLocaleString()} kg
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">
                  {after !== null ? `${after.toLocaleString()} kg` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {hasRecipeLinked && (
        <p className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          ※在庫システムのレシピ連動により、原材料在庫（裸麦・大豆・塩・種麹など）も自動で
          {isConsume ? '消費（減算）' : '復元（加算）'}されます
        </p>
      )}
    </div>
  )
}

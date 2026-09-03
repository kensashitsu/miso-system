import { Boxes } from 'lucide-react'
import type { MaterialStock } from '@/lib/materialStock'

// 現場は原材料を袋（缶・リットル）で数えているので、kg換算はせず単位のまま出す。
// 数字だけ並べても頭で割り算することになるため、「あと何回分の仕込みができるか」まで出す。
// 使用量は1回の仕込みで固定なので、在庫 ÷ 1回の使用量 で回数が出せる。
//
// 回数の基準になる品種は原材料ごとに変わる（麦みそは裸麦、山吹みそは砕米…）。
// basisOrder＝これから仕込む予定の品種の順で、その原材料を使う最初の品種を基準にする。
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10
  return (r === 0 ? 0 : r).toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

export default function MaterialStock({
  materials,
  basisOrder,
  primaryType,
}: {
  materials:   MaterialStock[]
  basisOrder:  string[]        // 回数の基準にする品種（優先順）
  primaryType: string | null   // 次に仕込む品種。これ以外が基準の行には品種名を添える
}) {
  if (materials.length === 0) return null

  const rows = materials
    .map(m => {
      const basis = basisOrder.find(t => (m.usagePerBrew[t] ?? 0) > 0)
        ?? Object.keys(m.usagePerBrew).find(t => m.usagePerBrew[t] > 0)
        ?? null
      const usage = basis ? m.usagePerBrew[basis] : null
      return { ...m, basis, times: usage ? Math.floor(m.stock / usage) : null }
    })
    .sort((a, b) => {
      if (a.times == null) return 1
      if (b.times == null) return -1
      return a.times - b.times
    })

  return (
    <section className="rounded-xl border bg-white p-3 sm:p-4">
      <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-gray-900">
        <span className="flex items-center gap-1.5">
          <Boxes className="h-4 w-4 text-gray-400" />
          原材料の在庫
        </span>
        <span className="text-[11px] font-normal text-muted-foreground">
          あと何回仕込めるか
        </span>
      </h2>

      <ul className="divide-y divide-gray-100 text-xs sm:text-sm">
        {rows.map(m => {
          const tone =
            m.times == null ? 'text-gray-400'
            : m.times <= 0  ? 'text-rose-700 font-semibold'
            : m.times === 1 ? 'text-amber-700 font-semibold'
            : 'text-gray-600'
          return (
            <li key={m.name} className="flex items-baseline gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-gray-700">{m.name}</span>
              <span className="shrink-0 tabular-nums font-medium text-gray-900">
                {fmt(m.stock)} {m.unit}
              </span>
              <span className={`w-24 shrink-0 text-right tabular-nums ${tone}`}>
                {m.times == null ? '' : m.times <= 0 ? '足りない' : `あと ${m.times} 回`}
                {m.basis && m.basis !== primaryType && (
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                    {m.basis}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      <p className="mt-2 text-[11px] text-muted-foreground">
        在庫システム（zaiko）の数量。ロットを登録すると自動で引かれます
      </p>
    </section>
  )
}

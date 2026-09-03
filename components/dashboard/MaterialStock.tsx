import { Boxes, Truck } from 'lucide-react'
import type { MaterialStock } from '@/lib/materialStock'
import { materialKey, type IncomingOrder } from '@/lib/purchaseOrders'

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

// 入荷予定の書き方。週指定（アバウト）のときは factory-planner 側で
// その週の月曜〜日曜が入っているので「9/14〜18」の形にする
function arrivalText(o: IncomingOrder): string | null {
  if (!o.expectedDate) return null
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  const when = o.expectedDateTo ? `${md(o.expectedDate)}〜${md(o.expectedDateTo)}` : md(o.expectedDate)
  return `${when} に ${o.quantity.toLocaleString()} ${o.unit} 入荷予定`
}

export default function MaterialStock({
  materials,
  basisOrder,
  primaryType,
  incoming,
}: {
  materials:   MaterialStock[]
  basisOrder:  string[]        // 回数の基準にする品種（優先順）
  primaryType: string | null   // 次に仕込む品種。これ以外が基準の行には品種名を添える
  incoming:    IncomingOrder[] // factory-planner の発注中リスト（入荷予定）
}) {
  if (materials.length === 0) return null

  // 発注中は同じ原材料に複数あり得るので、名前ごとにまとめて入荷日の早い順にする
  const incomingByName = new Map<string, IncomingOrder[]>()
  for (const o of incoming) {
    const k = materialKey(o.productName)
    incomingByName.set(k, [...(incomingByName.get(k) ?? []), o])
  }
  for (const list of incomingByName.values()) {
    list.sort((a, b) => (a.expectedDate ?? '').localeCompare(b.expectedDate ?? ''))
  }

  const rows = materials
    .map(m => {
      const basis = basisOrder.find(t => (m.usagePerBrew[t] ?? 0) > 0)
        ?? Object.keys(m.usagePerBrew).find(t => m.usagePerBrew[t] > 0)
        ?? null
      const usage = basis ? m.usagePerBrew[basis] : null
      return {
        ...m, basis,
        times:    usage ? Math.floor(m.stock / usage) : null,
        arrivals: incomingByName.get(materialKey(m.name)) ?? [],
      }
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
            <li key={m.name} className="py-1.5">
              <div className="flex items-baseline gap-2">
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
              </div>
              {/* 在庫が0でも発注済なら「いつ何袋入るか」が分かれば慌てずに済む */}
              {m.arrivals.map((o, i) => {
                const text = arrivalText(o)
                if (!text) return null
                return (
                  <p key={i} className="mt-0.5 flex items-center gap-1 text-[11px] text-sky-700">
                    <Truck className="h-3 w-3 shrink-0" />
                    {text}
                    {o.supplierName && <span className="text-muted-foreground">（{o.supplierName}）</span>}
                  </p>
                )
              })}
            </li>
          )
        })}
      </ul>

      <p className="mt-2 text-[11px] text-muted-foreground">
        在庫システム（zaiko）の数量。ロットを登録すると自動で引かれます。
        入荷予定は生産管理（factory-planner）の発注リストから
      </p>
    </section>
  )
}

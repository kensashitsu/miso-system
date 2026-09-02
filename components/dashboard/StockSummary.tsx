'use client'

import { useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

// 表示順は MisoRecipe.sortOrder（page.tsx から渡す）。ハードコードしない
type StockSummaryProps = {
  misoTypes:          string[]
  agedStockMap:       Record<string, { agedKg: number; packagedKg: number | null }>
  fermentingKgByType: Record<string, number>
  hasApiData:         boolean
  hasApiError:        boolean
  // 完成ロットの桶残量（本システム側の熟成済在庫）。在庫APIの値と突き合わせるため併記する
  systemAgedKgByType?: Record<string, number>
  safetyStockMap?:    Record<string, number>  // 品種ごとの安全在庫ライン（熟成済バラ＋小分け製品の合算、kg）
}

function KgCell({ value, warn }: { value: number | null; warn?: boolean }) {
  if (value == null) return <span className="text-gray-300">—</span>
  return (
    <>
      <span className={`font-semibold ${warn ? 'text-orange-600' : 'text-gray-900'}`}>{value.toLocaleString()}</span>
      <span className={`font-normal text-xs ml-0.5 ${warn ? 'text-orange-400' : 'text-gray-400'}`}>kg</span>
      {warn && <span className="ml-1 text-orange-500" title="熟成済＋小分けの合算が安全在庫ラインを下回っています">⚠</span>}
    </>
  )
}

// 熟成済在庫セルの下段：本システム（完成ロットの桶残量）と在庫APIとの差分。
// 差分は「本システム − API」。棚卸しのズレに気づけるように符号付きで出す
function SystemAgedNote({ apiKg, systemKg }: { apiKg: number | null; systemKg: number | null }) {
  if (systemKg == null) return null
  const diff = apiKg != null ? Math.round(systemKg - apiKg) : null
  return (
    <div
      className="text-[10px] leading-tight text-gray-400 font-normal mt-0.5"
      title={`本システムの完成ロット桶残量 ${systemKg.toLocaleString()}kg${diff != null ? `（在庫APIとの差 ${diff > 0 ? '+' : ''}${diff.toLocaleString()}kg）` : ''}`}
    >
      本{systemKg.toLocaleString()}
      {diff != null && (
        <span className={diff === 0 ? 'ml-1 text-gray-400' : `ml-1 ${Math.abs(diff) >= 100 ? 'text-orange-500' : 'text-gray-400'}`}>
          {diff === 0 ? '(一致)' : `(${diff > 0 ? '+' : ''}${diff.toLocaleString()})`}
        </span>
      )}
    </div>
  )
}

export default function StockSummary({ misoTypes, agedStockMap, fermentingKgByType, hasApiData, hasApiError, safetyStockMap, systemAgedKgByType }: StockSummaryProps) {
  // レシピに無い品種でも在庫APIや熟成中ロットに出てきたら行を作る（取りこぼし防止）
  const types = [
    ...misoTypes,
    ...Object.keys(agedStockMap).filter(t => !misoTypes.includes(t)),
    ...Object.keys(fermentingKgByType).filter(t => !misoTypes.includes(t) && !(t in agedStockMap)),
  ]
  const [isOpen, setIsOpen] = useState(true)

  const rows = types.map(type => {
    const stock      = agedStockMap[type] ?? null
    const aged       = stock?.agedKg ?? null
    const packaged   = stock?.packagedKg ?? null
    const fermenting = Math.round(fermentingKgByType[type] ?? 0)
    return { aged, packaged, fermenting }
  })
  const hasAnyAged     = rows.some(r => r.aged != null)
  const hasAnyPackaged = rows.some(r => r.packaged != null)
  const sumFermenting  = rows.reduce((s, r) => s + r.fermenting, 0)
  const sumAged        = hasAnyAged     ? rows.reduce((s, r) => s + (r.aged     ?? 0), 0) : null
  const hasAnySystemAged = types.some(t => systemAgedKgByType?.[t] != null)
  const sumSystemAged    = hasAnySystemAged
    ? types.reduce((s, t) => s + Math.round(systemAgedKgByType?.[t] ?? 0), 0)
    : null
  const sumPackaged    = hasAnyPackaged ? rows.reduce((s, r) => s + (r.packaged ?? 0), 0) : null
  const sumTotal       = sumAged != null ? sumAged + (sumPackaged ?? 0) + sumFermenting : null

  return (
    <section>
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="w-full flex items-start justify-between mb-3 group gap-2"
      >
        <div className="text-left">
          <h2 className="text-base font-semibold text-gray-700">品種別在庫サマリー</h2>
          {/* 折りたたみ時：合計をインラインで表示 */}
          {!isOpen && (
            <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
              {sumFermenting > 0 && (
                <span>熟成中 <span className="font-semibold text-gray-800">{sumFermenting.toLocaleString()}</span>kg</span>
              )}
              {sumAged != null && (
                <span>熟成済 <span className="font-semibold text-gray-800">{sumAged.toLocaleString()}</span>kg</span>
              )}
              {sumTotal != null && (
                <span>合計 <span className="font-semibold text-gray-800">{sumTotal.toLocaleString()}</span>kg</span>
              )}
            </p>
          )}
        </div>
        <span className="flex items-center gap-1 text-xs text-gray-400 group-hover:text-gray-600 transition-colors shrink-0 mt-0.5">
          {isOpen ? <><ChevronUp className="h-4 w-4" />閉じる</> : <><ChevronDown className="h-4 w-4" />開く</>}
        </span>
      </button>

      {/* テーブルは展開時のみ表示 */}
      {isOpen && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
          {/* APIバッジ */}
          <div className="flex items-center gap-2 px-4 pt-3 pb-2">
            {hasApiData ? (
              <span className="inline-flex items-center rounded-full border border-emerald-200/60 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                在庫API連携中
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-dashed border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-400">
                {hasApiError ? 'データ取得エラー' : '在庫API未設定'}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2.5 pr-2 px-4 text-gray-400 font-medium text-xs tracking-wider uppercase">品種</th>
                  <th className="text-right py-2.5 px-2 text-gray-400 font-medium text-xs tracking-wider uppercase">熟成中</th>
                  <th className="text-right py-2.5 px-2 text-gray-400 font-medium text-xs tracking-wider uppercase hidden sm:table-cell">熟成済在庫</th>
                  <th className="text-right py-2.5 px-2 text-gray-400 font-medium text-xs tracking-wider uppercase hidden sm:table-cell">小分け在庫</th>
                  <th className="text-right py-2.5 pl-2 pr-4 text-gray-400 font-medium text-xs tracking-wider uppercase">合計</th>
                </tr>
              </thead>
              <tbody>
                {types.map(type => {
                  const stock      = agedStockMap[type] ?? null
                  const aged       = stock?.agedKg ?? null
                  const packaged   = stock?.packagedKg ?? null
                  const fermenting = Math.round(fermentingKgByType[type] ?? 0)
                  // 完成ロットが1件も無い品種でも、APIに在庫がある間は 0 として出す
                  // （「登録されていない」こと自体が差分として見たいもの）
                  const systemAged = (aged != null || systemAgedKgByType?.[type] != null)
                    ? Math.round(systemAgedKgByType?.[type] ?? 0)
                    : null
                  const total      = aged != null ? aged + (packaged ?? 0) + fermenting : null
                  const safetyLine = safetyStockMap?.[type]
                  // 判定は「熟成済バラ＋小分け製品」の合算（熟成中ロットは含めない）
                  const shippableKg = aged != null ? aged + (packaged ?? 0) : null
                  const belowSafety = safetyLine != null && shippableKg != null && shippableKg < safetyLine
                  return (
                    <tr key={type} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                      <td className="py-2.5 pr-2 px-4 text-sm font-medium text-gray-700 whitespace-nowrap">{type}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        <KgCell value={fermenting > 0 ? fermenting : null} />
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums hidden sm:table-cell">
                        <KgCell value={aged} />
                        <SystemAgedNote apiKg={aged} systemKg={systemAged} />
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums hidden sm:table-cell"><KgCell value={packaged} warn={belowSafety} /></td>
                      <td className="py-2.5 pl-2 pr-4 text-right tabular-nums"><KgCell value={total} /></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-100 bg-gray-50/60">
                  <td className="py-2.5 pr-2 px-4 text-sm font-semibold text-gray-700">合計</td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-sm">
                    <KgCell value={sumFermenting > 0 ? sumFermenting : null} />
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-sm hidden sm:table-cell">
                    <KgCell value={sumAged} />
                    <SystemAgedNote apiKg={sumAged} systemKg={sumSystemAged} />
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-sm hidden sm:table-cell"><KgCell value={sumPackaged} /></td>
                  <td className="py-2.5 pl-2 pr-4 text-right tabular-nums text-sm"><KgCell value={sumTotal} /></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 「本」の意味は列名からは分からないので凡例を出す（列幅を広げずに済ませる） */}
          {sumSystemAged != null && (
            <p className="px-4 pb-3 pt-2 text-[10px] leading-relaxed text-gray-400">
              熟成済在庫の下段「本」＝本システムの完成ロット桶残量。カッコ内は在庫APIとの差（本システム − API）
            </p>
          )}
        </div>
      )}
    </section>
  )
}

'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Settings, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react'

const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const

type Props = {
  currentBufferDays: number
  shipmentMap:       Record<string, Record<string, number>>
  snapshotCount:     number   // 蓄積済みの月末在庫スナップショット数
}

// 変動係数（CV）を計算
function calcCV(values: number[]): number | null {
  if (values.length < 6) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return null
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

// CVからバッファ日数を提案
function suggestBuffer(cv: number): number {
  if (cv < 0.10) return 7
  if (cv < 0.15) return 10
  if (cv < 0.20) return 14
  if (cv < 0.25) return 18
  return 21
}

// CVの評価ラベル
function cvLabel(cv: number): { text: string; color: string } {
  if (cv < 0.10) return { text: '安定',   color: 'text-emerald-600' }
  if (cv < 0.20) return { text: '普通',   color: 'text-amber-600' }
  return                { text: '変動大', color: 'text-rose-600' }
}

export default function BufferDaySuggestion({ currentBufferDays, shipmentMap, snapshotCount }: Props) {
  const [isOpen, setIsOpen] = useState(false)

  // 品種ごとの分析
  const analysis = MISO_TYPES.map(type => {
    const data   = shipmentMap[type] ?? {}
    const values = Object.values(data).filter(v => v > 0)
    const cv     = calcCV(values)
    const suggested = cv != null ? suggestBuffer(cv) : null
    const diff      = suggested != null ? suggested - currentBufferDays : null
    return { type, months: values.length, cv, suggested, diff }
  })

  // 全品種の中央値で代表バッファを計算
  const suggestedValues = analysis.map(a => a.suggested).filter((v): v is number => v != null)
  const representativeSuggested = suggestedValues.length > 0
    ? Math.round(suggestedValues.reduce((a, b) => a + b, 0) / suggestedValues.length)
    : null

  const hasEnoughData  = analysis.some(a => a.months >= 6)
  const overallDiff    = representativeSuggested != null ? representativeSuggested - currentBufferDays : null

  return (
    <section className="no-print">
      <button
        type="button"
        onClick={() => setIsOpen(p => !p)}
        className="w-full flex items-center justify-between mb-3 group"
      >
        <div className="text-left">
          <h2 className="text-base font-semibold text-gray-700">③ バッファ日数の分析</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            需要変動から最適なバッファ日数を提案（現在：{currentBufferDays}日）
          </p>
        </div>
        <span className="flex items-center gap-1 text-xs text-gray-400 group-hover:text-gray-600 transition-colors">
          {isOpen
            ? <><ChevronUp   className="h-4 w-4" />閉じる</>
            : <><ChevronDown className="h-4 w-4" />開く</>}
        </span>
      </button>

      {isOpen && (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">

          {/* サマリーバナー */}
          {hasEnoughData && overallDiff != null && (
            <div className={`px-5 py-3 flex items-center gap-3 text-sm ${
              overallDiff === 0
                ? 'bg-emerald-50 border-b border-emerald-100'
                : 'bg-amber-50 border-b border-amber-100'
            }`}>
              {overallDiff === 0
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                : <AlertCircle  className="h-4 w-4 text-amber-600 shrink-0" />
              }
              <span className={overallDiff === 0 ? 'text-emerald-700' : 'text-amber-700'}>
                {overallDiff === 0
                  ? `現在の${currentBufferDays}日は需要変動に対して適切です`
                  : `需要変動の分析から、バッファは${representativeSuggested}日（現在${currentBufferDays}日）が適切と推計されます`
                }
              </span>
              <a
                href="/settings"
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
              >
                <Settings className="h-3.5 w-3.5" />
                設定で変更
              </a>
            </div>
          )}

          {/* 品種別テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="text-left px-5 py-2.5 text-xs text-gray-400 font-medium">品種</th>
                  <th className="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">データ数</th>
                  <th className="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">需要変動（CV）</th>
                  <th className="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">変動評価</th>
                  <th className="text-right px-5 py-2.5 text-xs text-gray-400 font-medium">推奨バッファ</th>
                </tr>
              </thead>
              <tbody>
                {analysis.map(a => {
                  const label = a.cv != null ? cvLabel(a.cv) : null
                  return (
                    <tr key={a.type} className="border-b border-gray-50 hover:bg-gray-50/40 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-700">{a.type}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {a.months}ヶ月
                        {a.months < 6 && <span className="text-xs text-gray-300 ml-1">（不足）</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {a.cv != null ? `±${Math.round(a.cv * 100)}%` : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {label
                          ? <span className={`text-xs font-medium ${label.color}`}>{label.text}</span>
                          : <span className="text-gray-300 text-xs">データ不足</span>
                        }
                      </td>
                      <td className="px-5 py-3 text-right">
                        {a.suggested != null ? (
                          <span className={`font-semibold ${a.diff !== 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {a.suggested}日
                            {a.diff !== 0 && a.diff != null && (
                              <span className="text-xs font-normal ml-1">
                                ({a.diff > 0 ? '+' : ''}{a.diff})
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 補足説明 */}
          <div className="px-5 py-3 bg-gray-50/40 border-t border-gray-100 space-y-1.5">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
              <span>
                <span className="font-medium text-gray-600">CV（変動係数）</span>とは月ごとの出荷量のばらつきを表す指標です。
                値が大きいほど需要が不規則で、多めのバッファが必要になります。
              </span>
            </div>
            <p className="text-xs text-muted-foreground pl-5">
              月末在庫スナップショット蓄積数：<span className="font-medium text-gray-600">{snapshotCount}ヶ月分</span>
              {snapshotCount < 12
                ? '（12ヶ月以上蓄積されると在庫水準も加味した精度の高い提案が可能になります）'
                : '（在庫水準データあり・より精度の高い提案が可能です）'
              }
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

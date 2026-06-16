'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { computeBacktest } from '@/lib/backtest'

const MISO_TYPES = ['無添加麦みそ', '田舎みそ', '山吹みそ', '白みそ'] as const

// 評価対象とする直近の月数（バックテスト窓）
const WINDOW = 24

interface Props {
  shipmentMap:          Record<string, Record<string, number>>
  sarimaxPastForecast?: Record<string, Record<string, number>>
}

function biasLabel(biasPct: number | null): { text: string; cls: string } {
  if (biasPct == null) return { text: '—', cls: 'text-muted-foreground' }
  const v = Math.round(biasPct)
  if (Math.abs(v) < 3)  return { text: 'ほぼ偏りなし', cls: 'text-emerald-600' }
  if (v < 0)            return { text: `予測 ${v}%（少なめ・欠品側）`, cls: 'text-rose-600 font-medium' }
  return { text: `予測 +${v}%（多め・過剰側）`, cls: 'text-blue-600' }
}

function mapeCls(mapePct: number | null): string {
  if (mapePct == null) return 'text-muted-foreground'
  if (mapePct <= 15) return 'text-emerald-600'
  if (mapePct <= 30) return 'text-amber-600'
  return 'text-gray-500'
}

export default function ForecastBacktest({ shipmentMap, sarimaxPastForecast }: Props) {
  const [open, setOpen] = useState(false)
  // 品種ごとに3方式のバックテスト結果を算出（表示と自動方式選択で共有のロジック）
  const perType = computeBacktest([...MISO_TYPES], shipmentMap, sarimaxPastForecast, { window: WINDOW })
  const anyData = perType.some(t => t.hasAny)

  return (
    <Card className="no-print">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-base font-semibold">④ 予測精度・傾向（バックテスト）</h2>
            <span className="text-xs text-muted-foreground">
              過去の予測と実績を突き合わせた結果（直近{WINDOW}ヶ月）
            </span>
          </div>
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          {!anyData ? (
            <p className="text-sm text-muted-foreground">
              突き合わせ可能なデータがありません（出荷実績またはSARIMAX過去予測が不足）。
            </p>
          ) : (
            <>
              {perType.map(({ type, stats, bestKey, hasAny }) => (
                <div key={type} className="space-y-1.5">
                  <span
                    className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                    style={getMisoTypeBadgeStyle(type)}
                  >
                    {type}
                  </span>
                  {!hasAny ? (
                    <p className="text-xs text-muted-foreground pl-1">データ不足</p>
                  ) : (
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40 border-b text-muted-foreground">
                            <th className="text-left  px-2 py-1.5 font-medium">予測方式</th>
                            <th className="text-center px-2 py-1.5 font-medium w-16">評価月数</th>
                            <th className="text-left  px-2 py-1.5 font-medium">偏り傾向</th>
                            <th className="text-right px-2 py-1.5 font-medium w-24">平均誤差</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.map(s => {
                            const bl     = biasLabel(s.biasPct)
                            const isBest = s.key === bestKey
                            return (
                              <tr key={s.key} className={`border-b last:border-0 ${isBest ? 'bg-emerald-50/50' : ''}`}>
                                <td className="px-2 py-1.5">
                                  {isBest && <span className="text-emerald-600 mr-1">✓</span>}
                                  <span className={isBest ? 'font-semibold' : ''}>{s.label}</span>
                                  {isBest && <span className="ml-1 text-[10px] text-emerald-700">最も的中</span>}
                                </td>
                                <td className="text-center px-2 py-1.5 tabular-nums text-muted-foreground">
                                  {s.n > 0 ? `${s.n}ヶ月` : '—'}
                                </td>
                                <td className={`px-2 py-1.5 ${bl.cls}`}>{bl.text}</td>
                                <td className={`text-right px-2 py-1.5 tabular-nums ${mapeCls(s.mapePct)}`}>
                                  {s.mapePct != null ? `±${Math.round(s.mapePct)}%` : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                <span className="font-medium">偏り傾向</span>＝(予測−実績)÷実績の平均。
                <span className="text-rose-600">マイナス（少なめ）は欠品リスク側</span>・
                <span className="text-blue-600">プラス（多め）は過剰在庫側</span>。
                偏りが続く品種は、保守モード（90%）への切替や在庫の手動調整で補正できます。
                <span className="font-medium">平均誤差（MAPE）</span>が最小の方式が「最も的中」。
                評価は同月より前の実績のみで予測（先読み防止）。
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

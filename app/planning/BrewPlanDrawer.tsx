'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Trash2, ArrowRight, ChevronUp, ChevronDown, CalendarPlus, LineChart, RefreshCw } from 'lucide-react'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import {
  brewEventTitle, buildBrewPlanCalendarUrl, buildGoogleCalendarUrl, completionEventTitle,
} from '@/lib/googleCalendarLink'
import { buildIcs, downloadIcs } from '@/lib/ics'
import { syncCalendarNow } from '@/app/planning/calendar-sync-action'
import { deleteBrewPlan, deleteBrewPlans, setBrewPlanMaterialOrdered } from '@/app/planning/brew-plan-actions'
import { getPlanSimConfig } from '@/app/planning/plan-sim-action'
import LotSimulationModal, { type LotSimConfig } from '@/components/dashboard/LotSimulationModal'

export interface BrewPlanItem {
  id:                    string
  misoType:              string
  brewDate:              Date
  completionDate:        Date
  fermentationDays:      number
  location:              string
  bucketNumbers:         string | null
  materialOrderDeadline: Date
  materialOrderedAt:     Date | null
  status:                string
  lotId:                 string | null
}

export default function BrewPlanDrawer({ plans }: { plans: BrewPlanItem[] }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 原料手配チェックの楽観的更新。サーバーアクション＋再検証を待つとチェックが
  // 一拍遅れて反応しないように見えるため、押した瞬間の見た目をここで持つ
  const [pendingOrdered, setPendingOrdered] = useState<Record<string, boolean>>({})
  // 固定ドロワーの実高さ（畳んでいるとき＝バーのみ／開いているとき＝バー＋一覧）。
  // 同じ高さの余白を流し込み側に確保して、ページ末尾がドロワーに隠れないようにする
  const drawerRef = useRef<HTMLDivElement>(null)
  const [drawerHeight, setDrawerHeight] = useState(48)
  // 熟成シミュレーション。設定と気象データの集計は重いので、
  // ボタンを押したときに一度だけ取りに行って以後は使い回す
  const [simPlan, setSimPlan] = useState<BrewPlanItem | null>(null)
  const [simData, setSimData] = useState<{ simConfig: LotSimConfig; targetByType: Record<string, number> } | null>(null)
  const [simLoading, setSimLoading] = useState(false)

  // カレンダーへの一括登録用ICS。1件ずつカレンダー画面で保存するのが煩わしいため、
  // まとめて1ファイルに出して「設定 → インポート」で読み込んでもらう。
  // UIDを仮登録IDから作っているので、日付を直して入れ直しても重複せず上書きされる。
  // カレンダーを仕込み用・完成用に分けているのでファイルも2つに分ける
  const icsTargets = () => (selectedIds.size > 0 ? pending.filter(p => selectedIds.has(p.id)) : pending)

  const exportBrewIcs = () => {
    const targets = icsTargets()
    if (targets.length === 0) return
    const ics = buildIcs(targets.map(p => ({
      uid:     `brew-${p.id}@miso-system`,
      date:    p.brewDate,
      summary: brewEventTitle(p.misoType, p.bucketNumbers),
      description: `仕込み予定日：${format(p.brewDate, 'yyyy/MM/dd')}\n`
        + `完成予定日：${format(p.completionDate, 'yyyy/MM/dd')}（熟成${p.fermentationDays}日）`,
    })), '仕込予定日')
    downloadIcs(`仕込予定日_${format(new Date(), 'yyyyMMdd')}.ics`, ics)
  }

  const exportCompletionIcs = () => {
    const targets = icsTargets()
    if (targets.length === 0) return
    const ics = buildIcs(targets.map(p => ({
      uid:     `completion-${p.id}@miso-system`,
      date:    p.completionDate,
      summary: completionEventTitle(p.misoType, p.bucketNumbers, p.brewDate, p.completionDate),
      description: `完成予定日：${format(p.completionDate, 'yyyy/MM/dd')}\n`
        + `仕込み予定日：${format(p.brewDate, 'yyyy/MM/dd')}（熟成${p.fermentationDays}日）`,
    })), '熟成完了日')
    downloadIcs(`熟成完了日_${format(new Date(), 'yyyyMMdd')}.ics`, ics)
  }

  // Googleカレンダーへの自動同期（毎日GitHub Actionsでも走るが、仮登録した直後に
  // 反映を確かめたいことがあるのでボタンからも叩けるようにしている）
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await syncCalendarNow()
      setSyncMsg(r.ok ? `同期しました（${r.message}）` : r.message)
    } finally {
      setSyncing(false)
    }
  }

  const openSim = async (plan: BrewPlanItem) => {
    setSimPlan(plan)
    if (simData) return
    setSimLoading(true)
    try {
      setSimData(await getPlanSimConfig())
    } finally {
      setSimLoading(false)
    }
  }

  // 本登録済（ロット化済み）は自動でリストから外れるため、ここに来るのは仮登録のみのはず
  const pending = plans.filter(p => p.status === '仮登録')

  // サーバー側の値が楽観的な値に追いついたら、楽観的な値を捨てる
  useEffect(() => {
    setPendingOrdered(prev => {
      const next = { ...prev }
      let changed = false
      for (const p of plans) {
        if (p.id in next && next[p.id] === (p.materialOrderedAt != null)) {
          delete next[p.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [plans])

  // 開閉・件数でドロワーの高さが変わるので、そのつど測り直して余白に反映する
  useEffect(() => {
    const el = drawerRef.current
    if (!el) return
    const update = () => setDrawerHeight(el.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [isOpen, pending.length])

  if (pending.length === 0) return null

  const allSelected = pending.length > 0 && pending.every(p => selectedIds.has(p.id))

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(pending.map(p => p.id)))
  }

  function toggleOne(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearManualPin(plan: BrewPlanItem) {
    // この仮登録と同じ日付で仕込み提案側に手動固定(調整済)ピンが残っていた場合、
    // 仮登録が消えた瞬間にその古いピンが復活して推奨日が固まってしまうため、
    // 削除と同時に消しておく（仕込み提案画面はlocalStorageで手動ピンを管理・
    // 回ごとに1回目=品種名のみ、2回目以降=品種名#インデックスのキー）。
    const brewDateStr = format(plan.brewDate, 'yyyy-MM-dd')
    for (let idx = 0; idx < 5; idx++) {
      const key = `planning_manualDate_${idx === 0 ? plan.misoType : `${plan.misoType}#${idx}`}`
      if (localStorage.getItem(key) === brewDateStr) {
        localStorage.removeItem(key)
      }
    }
  }

  function handleBulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`選択した${selectedIds.size}件を削除しますか？`)) return
    const targets = pending.filter(p => selectedIds.has(p.id))
    targets.forEach(clearManualPin)
    const ids = targets.map(p => p.id)
    startTransition(async () => {
      await deleteBrewPlans(ids)
      setSelectedIds(new Set())
    })
  }

  return (
    <>
    {/* 固定ドロワーは position:fixed で流し込みから外れるため、そのままだと
        ページ最下部のコンテンツに重なる。同じ高さの余白を流し込み側に確保する。
        高さは固定値ではなく実測（開くと一覧の分だけ伸びるため。以前は畳んだ
        バーの高さ h-12 決め打ちで、開くと画面下部が隠れていた・2026-08-30修正） */}
    <div style={{ height: drawerHeight }} className="no-print" aria-hidden />
    {simPlan && simData && (
      <LotSimulationModal
        isOpen
        onClose={() => setSimPlan(null)}
        lotNumber={`仮登録 ${format(simPlan.brewDate, 'M/d')}仕込み予定`}
        misoType={simPlan.misoType}
        brewedAtISO={simPlan.brewDate.toISOString()}
        elapsedDays={0}
        accumulatedTemp={0}
        targetTempSum={simData.targetByType[simPlan.misoType] ?? 600}
        currentLocation={simPlan.location}
        simConfig={simData.simConfig}
        isPlan
      />
    )}
    <div ref={drawerRef} className="fixed bottom-0 left-0 right-0 z-30 no-print">
      <div className="max-w-[1400px] mx-auto px-4">
      {/* 展開時のパネル */}
      {isOpen && (
        <div className="bg-white border-t border-x border-gray-200 rounded-t-xl shadow-lg overflow-hidden max-h-[55vh] flex flex-col">
            {pending.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    カレンダーに一括登録{selectedIds.size > 0 ? `（選択した${selectedIds.size}件）` : `（${pending.length}件すべて）`}
                  </span>
                  <button
                    type="button"
                    onClick={exportBrewIcs}
                    className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors whitespace-nowrap"
                    title="仕込み予定日のICSファイルを書き出す（Googleカレンダーの設定→インポートで読み込む）"
                  >
                    <CalendarPlus className="h-3 w-3" />
                    仕込予定日.ics
                  </button>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => void handleSync()}
                    className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-primary/30 text-primary hover:bg-primary/5 transition-colors whitespace-nowrap disabled:opacity-40"
                    title="Googleカレンダーへ今すぐ同期する（毎朝6時にも自動で同期されます）"
                  >
                    <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? '同期中...' : 'カレンダーに同期'}
                  </button>
                  <button
                    type="button"
                    onClick={exportCompletionIcs}
                    className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50 transition-colors whitespace-nowrap"
                    title="完成予定日のICSファイルを書き出す（Googleカレンダーの設定→インポートで読み込む）"
                  >
                    <CalendarPlus className="h-3 w-3" />
                    熟成完了日.ics
                  </button>
                </div>
                {syncMsg && <span className="text-[11px] text-muted-foreground">{syncMsg}</span>}
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={handleBulkDelete}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    選択した{selectedIds.size}件を削除
                  </button>
                )}
              </div>
            )}
          <div className="overflow-y-auto overflow-x-auto flex-1 min-h-0">
            <table className="w-full min-w-[500px] text-xs">
              <thead className="sticky top-0 bg-muted/40 border-b">
                <tr className="text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="すべて選択"
                      className="h-3.5 w-3.5 align-middle"
                    />
                  </th>
                  <th className="text-left px-3 py-2 font-medium">品種</th>
                  <th className="text-left px-3 py-2 font-medium">仕込み予定日</th>
                  <th className="text-left px-3 py-2 font-medium">完成予定日</th>
                  <th className="text-left px-3 py-2 font-medium whitespace-nowrap">原料手配</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">桶番号</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">場所</th>
                  <th className="text-left px-3 py-2 font-medium">状態</th>
                  <th className="text-right px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(plan => {
                  const ordered = pendingOrdered[plan.id] ?? (plan.materialOrderedAt != null)
                  return (
                    <tr key={plan.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(plan.id)}
                          onChange={() => toggleOne(plan.id)}
                          aria-label={`${plan.misoType}を選択`}
                          className="h-3.5 w-3.5 align-middle"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
                          style={getMisoTypeBadgeStyle(plan.misoType)}
                        >
                          {plan.misoType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums font-medium">
                        <span className="inline-flex items-center gap-1">
                          {(() => {
                            const dow = ['日','月','火','水','木','金','土'][plan.brewDate.getDay()]
                            return `${format(plan.brewDate, 'M/d')}（${dow}）`
                          })()}
                          {/* 完成予定日と同じく、仕込み予定日も1件ずつカレンダーに入れられるようにする */}
                          <a
                            href={buildBrewPlanCalendarUrl({
                              misoType:       plan.misoType,
                              bucketNumbers:  plan.bucketNumbers,
                              brewDate:       plan.brewDate,
                              completionDate: plan.completionDate,
                            })}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                            aria-label="仕込み予定日をGoogleカレンダーに追加"
                            title="仕込み予定日をGoogleカレンダーに追加"
                          >
                            <CalendarPlus className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {format(plan.completionDate, 'M/d')}
                          <span className="text-[10px]">({plan.fermentationDays}日)</span>
                          <a
                            href={buildGoogleCalendarUrl({
                              misoType:      plan.misoType,
                              bucketNumbers: plan.bucketNumbers,
                              brewDate:      plan.brewDate,
                              targetDate:    plan.completionDate,
                              isActual:      false,
                            })}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
                            aria-label="Googleカレンダーに追加"
                            title="Googleカレンダーに追加"
                          >
                            <CalendarPlus className="h-3.5 w-3.5" />
                          </a>
                        </span>
                      </td>
                      {/* 原料手配のチェック。済にするとダッシュボードの督促から外れる */}
                      <td className="px-3 py-2.5">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={ordered}
                            onChange={e => {
                              const next = e.target.checked
                              setPendingOrdered(prev => ({ ...prev, [plan.id]: next }))
                              startTransition(async () => {
                                try {
                                  await setBrewPlanMaterialOrdered(plan.id, next)
                                  // ここで楽観的な値を捨ててはいけない。アクションの完了と
                                  // 再検証されたpropsの到着にはズレがあり、捨てると一瞬
                                  // 元の状態に戻って見える（実測で150〜400msちらついた）。
                                  // 破棄は下の useEffect（propsが追いついたら）で行う
                                } catch {
                                  // 失敗したら押す前の状態に戻す
                                  setPendingOrdered(prev => {
                                    const rest = { ...prev }
                                    delete rest[plan.id]
                                    return rest
                                  })
                                }
                              })
                            }}
                            className="h-3.5 w-3.5 align-middle"
                          />
                          {ordered ? (
                            <span className="text-emerald-600">
                              手配済
                              {plan.materialOrderedAt && (
                                <span className="text-[10px] text-muted-foreground"> {format(plan.materialOrderedAt, 'M/d')}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              未手配 <span className="text-[10px]">締切 {format(plan.materialOrderDeadline, 'M/d')}</span>
                            </span>
                          )}
                        </label>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums hidden sm:table-cell">
                        {plan.bucketNumbers ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        {plan.location}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-amber-600 font-medium">仮登録</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/lots/new?brewPlanId=${plan.id}`}
                            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors whitespace-nowrap"
                          >
                            ロット登録へ
                            <ArrowRight className="h-3 w-3" />
                          </Link>
                          {/* 仕込む前に「この日に仕込むといつ完成するか／置き場を変えるとどうなるか」を試せるように。
                              アイコンだけだと気づかれなかったので文字を付ける（2026-09-02ユーザー指摘） */}
                          <button
                            type="button"
                            disabled={simLoading}
                            onClick={() => void openSim(plan)}
                            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-primary/30 text-primary hover:bg-primary/5 transition-colors whitespace-nowrap disabled:opacity-40"
                            title="この予定で仕込んだ場合の熟成をシミュレーションする"
                          >
                            <LineChart className="h-3 w-3" />
                            {simLoading && simPlan?.id === plan.id ? '読込中...' : '熟成シミュレーション'}
                          </button>
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => {
                              if (!confirm('この仮登録を削除しますか？')) return
                              clearManualPin(plan)
                              startTransition(() => deleteBrewPlan(plan.id))
                            }}
                            className="p-1 rounded text-muted-foreground/60 hover:text-rose-500 hover:bg-rose-50 transition-colors disabled:opacity-40"
                            title="削除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 常時表示バー */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className="w-full bg-white border-t border-x border-gray-200 px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 text-sm font-medium">
          <span className="inline-flex items-center gap-1.5 text-amber-700">
            <span className="inline-flex items-center justify-center bg-amber-100 text-amber-700 rounded-full w-5 h-5 text-[11px] font-bold">{pending.length}</span>
            仮登録
          </span>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {isOpen ? (
            <><ChevronDown className="h-4 w-4" />閉じる</>
          ) : (
            <><ChevronUp className="h-4 w-4" />一覧を見る</>
          )}
        </span>
      </button>
      </div>
    </div>
    </>
  )
}

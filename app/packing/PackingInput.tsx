'use client'

import { useState, useRef, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { isBulkItem, type PackingItem } from '@/lib/packingItems'
import { recordPacking, cancelPacking, resendPending, type PackingResult } from './actions'

interface RecentRow {
  id:         string
  itemName:   string
  qty:        number
  unit:       string
  kgPerUnit:  number
  operator:   string | null
  sendStatus: string
  canceled:   boolean
  createdAt:  string
}

interface Props {
  items:          PackingItem[]
  types:          string[]
  stockByItem:    Record<string, number>
  stockAvailable: boolean
  agedByType:     Record<string, number>
  location:     string
  pendingCount: number
  recent:       RecentRow[]
}

// 品種ごとの色（既存のバッジ配色に合わせる）
const TYPE_STYLE: Record<string, { bg: string; fg: string; bd: string }> = {
  '無添加麦みそ': { bg: '#E1F5EE', fg: '#0F6E56', bd: '#5DCAA5' },
  '田舎みそ':     { bg: '#FAEEDA', fg: '#854F0B', bd: '#EF9F27' },
  '山吹みそ':     { bg: '#EEEDFE', fg: '#3C3489', bd: '#AFA9EC' },
  '白みそ':       { bg: '#E6F1FB', fg: '#185FA5', bd: '#85B7EB' },
  '合せみそ':     { bg: '#F1F3F5', fg: '#495057', bd: '#CED4DA' },
}
const FALLBACK_STYLE = { bg: '#F3F4F6', fg: '#374151', bd: '#D1D5DB' }

export default function PackingInput({
  items, types, stockByItem, stockAvailable, agedByType, location, pendingCount, recent,
}: Props) {
  const [activeType, setActiveType] = useState(types[0] ?? '')
  const [selected, setSelected] = useState<PackingItem | null>(null)
  const [qty,      setQty]      = useState('')
  const [operator, setOperator] = useState('')
  const [workDate, setWorkDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [result,   setResult]   = useState<PackingResult | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const qtyRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  // 担当者と開いていた品種タブは端末に覚えさせる（毎回選ばせない）
  useEffect(() => {
    setOperator(localStorage.getItem('packing_operator') ?? '')
    const saved = localStorage.getItem('packing_type')
    if (saved && types.includes(saved)) setActiveType(saved)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function changeType(t: string) {
    setActiveType(t)
    localStorage.setItem('packing_type', t)
    setSelected(null)
    setQty('')
    setError(null)
  }

  function changeOperator(v: string) {
    setOperator(v)
    localStorage.setItem('packing_operator', v)
  }

  // 品目を選んだら個数欄へフォーカスを飛ばす（クリック→数字→Enter で完結させる）
  function pick(item: PackingItem) {
    setSelected(item)
    setQty('')
    setError(null)
    setResult(null)
    requestAnimationFrame(() => qtyRef.current?.focus())
  }

  function submit() {
    if (!selected) { setError('品目を選んでください'); return }
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) {
      setError(isBulkItem(selected) ? '重さ（kg）を入力してください' : '個数を入力してください')
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await recordPacking({
        itemName:   selected.name,
        qty:        n,
        occurredAt: workDate,
        operator,
      })
      if (!res.ok) { setError(res.error ?? '記録できませんでした'); return }
      setResult(res)
      setQty('')
      setSelected(null)
      router.refresh()
    })
  }

  function cancel(id: string) {
    startTransition(async () => {
      const res = await cancelPacking(id)
      if (!res.ok) { setError(res.error ?? '取り消せませんでした'); return }
      setResult(null)
      router.refresh()
    })
  }

  function resend() {
    startTransition(async () => {
      const r = await resendPending()
      setError(r.failed > 0 ? `${r.sent}件を送信しました（${r.failed}件は送れませんでした）` : null)
      router.refresh()
    })
  }

  // 桶・袋は「3丁（60kg）」と重さを添える。バラは打った数がkgそのものなので添えない
  const totalKg =
    selected && !isBulkItem(selected) && Number(qty) > 0
      ? selected.kgPerUnit * Number(qty)
      : null

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">

      {/* 見出し＋作業日・担当者 */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">小分け入力</h1>
          <p className="text-sm text-gray-500 mt-1">
            登録先：{location}（固定）／原材料は在庫システム側で自動的に引かれます
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">作業日</span>
            <input
              type="date"
              value={workDate}
              onChange={e => setWorkDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-base"
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500 mb-1">担当者</span>
            <input
              type="text"
              value={operator}
              onChange={e => changeOperator(e.target.value)}
              placeholder="名前"
              className="border border-gray-300 rounded-lg px-3 py-2 text-base w-32"
            />
          </label>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <span className="text-sm text-amber-900">
            在庫システムへ送れていない記録が <b>{pendingCount}件</b> あります（記録は残っています）
          </span>
          <button
            type="button"
            onClick={resend}
            disabled={isPending}
            className="text-sm font-medium px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
          >
            まとめて再送
          </button>
        </div>
      )}

      {/* ① 品目を選ぶ（品種はタブで切り替える） */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">① 作ったものを選ぶ</h2>

        <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-4">
          {types.map(t => {
            const st = TYPE_STYLE[t] ?? FALLBACK_STYLE
            const on = t === activeType
            return (
              <button
                key={t}
                type="button"
                onClick={() => changeType(t)}
                className="px-5 py-2.5 text-base font-semibold rounded-t-lg border-b-[3px] -mb-px transition-colors"
                style={{
                  color:             on ? st.fg : '#9CA3AF',
                  borderBottomColor: on ? st.fg : 'transparent',
                  background:        on ? st.bg : 'transparent',
                }}
              >
                {t}
              </button>
            )
          })}
        </div>

        {agedByType[activeType] != null && (
          <p className="text-sm text-gray-600 mb-3">
            {activeType}の熟成済（バラ）在庫{' '}
            <b className="text-base text-gray-900">
              {Math.round(agedByType[activeType]).toLocaleString()}
            </b> kg
            <span className="text-xs text-gray-400 ml-2">
              小分けするとここから減ります
            </span>
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {items.filter(i => i.misoType === activeType).map(item => {
            const st     = TYPE_STYLE[item.misoType] ?? FALLBACK_STYLE
            const active = selected?.name === item.name
            return (
              <button
                key={item.name}
                type="button"
                onClick={() => pick(item)}
                className="min-w-[120px] px-4 py-4 rounded-xl border-2 text-left transition-all hover:-translate-y-0.5"
                style={{
                  background:  active ? st.fg : st.bg,
                  borderColor: active ? st.fg : st.bd,
                  color:       active ? '#fff' : st.fg,
                }}
              >
                <span className="block text-lg font-bold leading-tight">{item.short}</span>
                <span className="block text-xs opacity-80 mt-0.5">
                  {isBulkItem(item) ? 'kgで入力' : `${item.kgPerUnit}kg／${item.unit}`}
                </span>
                {stockAvailable && (
                  <span
                    className="block text-xs mt-2 pt-1.5 border-t"
                    style={{ borderColor: active ? 'rgba(255,255,255,.35)' : st.bd }}
                  >
                    在庫 <b className="text-sm">
                      {stockByItem[item.name] != null
                        ? stockByItem[item.name].toLocaleString()
                        : '—'}
                    </b> {item.unit}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </section>

      {/* ② 個数を打つ */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          ② {selected && isBulkItem(selected) ? '重さ（kg）' : '個数'}を入力して Enter
        </h2>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4">
          <span className="text-base font-medium text-gray-900 min-w-[220px]">
            {selected ? selected.name : <span className="text-gray-400">品目を選んでください</span>}
            {selected && stockAvailable && stockByItem[selected.name] != null && (
              <span className="block text-xs text-gray-500 mt-0.5">
                いまの在庫 {stockByItem[selected.name].toLocaleString()}{selected.unit}
                {Number(qty) > 0 && (
                  <> → <b className="text-gray-900">
                    {(stockByItem[selected.name] + Number(qty)).toLocaleString()}{selected.unit}
                  </b></>
                )}
              </span>
            )}
          </span>
          {!(selected && isBulkItem(selected)) && (
            <button
              type="button"
              onClick={() => setQty(String(Math.max(0, (Number(qty) || 0) - 1)))}
              disabled={!selected}
              className="w-11 h-11 rounded-lg border border-gray-300 text-xl font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >−</button>
          )}
          <input
            ref={qtyRef}
            type="number"
            inputMode="decimal"
            min={0}
            step={selected && isBulkItem(selected) ? 'any' : 1}
            value={qty}
            disabled={!selected}
            onChange={e => setQty(e.target.value)}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            className="w-28 text-center text-3xl font-bold border-2 border-gray-300 rounded-lg py-2 focus:border-gray-900 focus:outline-none disabled:bg-gray-50"
          />
          {!(selected && isBulkItem(selected)) && (
            <button
              type="button"
              onClick={() => setQty(String((Number(qty) || 0) + 1))}
              disabled={!selected}
              className="w-11 h-11 rounded-lg border border-gray-300 text-xl font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >＋</button>
          )}
          <span className="text-base text-gray-500 w-28">
            {selected?.unit ?? ''}{totalKg != null && `（${totalKg}kg）`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={isPending || !selected || !qty}
            className="ml-auto px-8 py-3 rounded-lg bg-gray-900 text-white text-base font-semibold hover:bg-gray-700 disabled:opacity-40"
          >
            {isPending ? '記録中…' : '記録する'}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      </section>

      {/* 記録した直後の結果 */}
      {result?.ok && (
        <div className="mb-6 rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-4">
          <p className="text-base font-semibold text-emerald-900">記録しました</p>
          {result.sendStatus === '送信済' ? (
            <p className="text-sm text-emerald-800 mt-1">在庫システムへ反映しました</p>
          ) : (
            <p className="text-sm text-amber-800 mt-1">
              在庫システムへはまだ送れていません（記録は残っています）
              {result.sendError && (
                <span className="block text-xs text-amber-700 mt-0.5">{result.sendError}</span>
              )}
            </p>
          )}
          {result.materials && result.materials.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {result.materials.map(m => (
                <li key={m.name} className="text-sm text-emerald-900">
                  {m.name}　{m.before?.toLocaleString() ?? '—'} → <b>{m.after?.toLocaleString() ?? '—'}</b> {m.unit}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 直近の記録（取り消しはここから。一覧を開かせない） */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">直近の記録</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-gray-400">まだ記録がありません</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {recent.map(r => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-xs text-gray-400 w-12 shrink-0">
                  {format(new Date(r.createdAt), 'HH:mm')}
                </span>
                <span className={`flex-1 text-sm ${r.canceled ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                  {r.itemName}　<b>{r.qty}</b>{r.unit}
                  {r.unit !== 'KG' && (
                    <span className="text-gray-400">（{r.qty * r.kgPerUnit}kg）</span>
                  )}
                  {r.operator && <span className="text-xs text-gray-400 ml-2">{r.operator}</span>}
                </span>
                {r.canceled ? (
                  <span className="text-xs text-gray-400">取消済</span>
                ) : (
                  <>
                    {r.sendStatus !== '送信済' && (
                      <span className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5">未送信</span>
                    )}
                    <button
                      type="button"
                      onClick={() => cancel(r.id)}
                      disabled={isPending}
                      className="text-xs text-gray-500 hover:text-rose-600 border border-gray-200 rounded px-3 py-1.5 disabled:opacity-40"
                    >
                      取消
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  )
}

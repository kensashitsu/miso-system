'use client'

import { useState, useEffect, type ReactNode } from 'react'

// 設定は無関係な項目が1本のスクロール（PC幅で約4,900px）に並んでいて目的の
// 設定にたどり着けなかったため、意味のまとまりでタブに分けた（2026-08-30）。
// 中身はサーバーコンポーネントのまま props で受け取る（描画自体は常に行われる）。
type TabKey = 'recipe' | 'aging' | 'place' | 'data' | 'api'

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'recipe', label: '品種・レシピ',   hint: '配合・目標積算温度・安全在庫ライン' },
  { key: 'aging',  label: '熟成の条件',     hint: '含水量・温度・Q10・バッファ・歩留まり' },
  { key: 'place',  label: '場所・桶',       hint: '場所の一括変更・桶使用記録の選択肢' },
  { key: 'data',   label: 'データ取込',     hint: '気象データ・月末在庫スナップショット' },
  { key: 'api',    label: '外部連携',       hint: '在庫API・出荷実績APIの接続状態' },
]

const STORAGE_KEY = 'settings_activeTab'

export default function SettingsTabs(props: Record<TabKey, ReactNode>) {
  const [active, setActive] = useState<TabKey>('recipe')

  // 直前に開いていたタブを復元する（設定は同じ項目を続けて触ることが多い）
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as TabKey | null
    if (saved && TABS.some(t => t.key === saved)) setActive(saved)
  }, [])

  function select(key: TabKey) {
    setActive(key)
    try { localStorage.setItem(STORAGE_KEY, key) } catch { /* プライベートモード等では保存しない */ }
  }

  const current = TABS.find(t => t.key === active)!

  return (
    <div>
      <div className="flex items-end gap-1 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => select(t.key)}
            className={`rounded-t-lg px-4 py-2 text-sm transition-colors ${
              t.key === active
                ? 'border border-b-white border-gray-200 bg-white -mb-px font-semibold text-gray-900'
                : 'text-muted-foreground hover:bg-gray-50 hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 mb-4 text-xs text-muted-foreground">{current.hint}</p>

      {/* 表示していないタブは DOM から外す（フォームの状態は各カードが持つため入り直しで初期化される） */}
      <div className="space-y-6 sm:space-y-8">{props[active]}</div>
    </div>
  )
}

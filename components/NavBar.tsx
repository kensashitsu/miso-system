'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_LINKS = [
  { href: '/',         label: 'ダッシュボード' },
  { href: '/lots/new', label: 'ロット登録' },
  { href: '/planning', label: '仕込み計画' },
  { href: '/trace',    label: 'トレース' },
  { href: '/import',   label: 'インポート' },
  { href: '/settings', label: '設定' },
]

export default function NavBar() {
  const pathname = usePathname()

  return (
    <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 sticky top-0 z-50 h-14">
      <div className="max-w-5xl mx-auto px-4 h-full flex items-center gap-8">
        {/* ロゴ */}
        <span className="font-bold text-gray-900 tracking-tight text-lg shrink-0 select-none">
          味噌熟成管理
        </span>

        {/* ナビゲーション */}
        <nav className="flex items-stretch h-full overflow-x-auto">
          {NAV_LINKS.map(({ href, label }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={[
                  'relative flex items-center px-3 text-sm font-medium whitespace-nowrap transition-colors duration-200',
                  active
                    ? 'text-gray-900 font-semibold'
                    : 'text-gray-500 hover:text-gray-900',
                ].join(' ')}
              >
                {label}
                {active && (
                  <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-gray-900 rounded-full" />
                )}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}

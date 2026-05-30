'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

const NAV_LINKS = [
  { href: '/',            label: 'ダッシュボード' },
  { href: '/lots/new',    label: 'ロット登録' },
  { href: '/planning',    label: '仕込み計画' },
  { href: '/simulation',  label: '試作' },
  { href: '/trace',       label: 'トレース' },
  { href: '/import',      label: 'インポート' },
  { href: '/settings',    label: '設定' },
]

function NavLinks({ pathname }: { pathname: string }) {
  return (
    <>
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
    </>
  )
}

export default function NavBar({ username }: { username: string | null }) {
  const pathname = usePathname()
  const router   = useRouter()

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 sticky top-0 z-50">

      {/* モバイル: 2行レイアウト */}
      <div className="sm:hidden">
        <div className="h-10 px-4 flex items-center justify-between">
          <span className="font-bold text-gray-900 text-base select-none">みそ熟成管理</span>
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors px-2 py-1 rounded"
          >
            ログアウト
          </button>
        </div>
        <nav className="flex items-stretch h-9 overflow-x-auto border-t border-gray-100 px-1">
          <NavLinks pathname={pathname} />
        </nav>
      </div>

      {/* デスクトップ: 1行レイアウト */}
      <div className="hidden sm:flex items-center gap-8 h-14 max-w-5xl mx-auto px-4">
        <span className="font-bold text-gray-900 tracking-tight text-lg shrink-0 select-none">
          みそ熟成管理
        </span>
        <nav className="flex items-stretch h-full overflow-x-auto flex-1">
          <NavLinks pathname={pathname} />
        </nav>
        <div className="shrink-0 flex items-center gap-2">
          {username && (
            <span className="text-xs text-gray-500">
              ログイン中：{username}
            </span>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors px-2 py-1 rounded"
          >
            ログアウト
          </button>
        </div>
      </div>

    </header>
  )
}

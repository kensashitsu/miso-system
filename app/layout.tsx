import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { emailToUsername } from '@/lib/username-map'
import { prisma } from '@/lib/prisma'
import BrewPlanDrawer from '@/app/planning/BrewPlanDrawer'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

// タブに何のページか出す（2026-09-08 ユーザー要望。複数タブで並べると見分けがつかなかった）。
// 各ページは短い名前だけを持ち、末尾はここで付ける（タブは幅が狭く先頭しか見えないため）。
export const metadata: Metadata = {
  title: {
    default:  'みそ熟成管理システム',
    template: '%s｜みそ熟成',
  },
  description: '仕込みロット熟成進捗・仕込み計画管理',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient()
  const [{ data: { user } }, brewPlans] = await Promise.all([
    supabase.auth.getUser(),
    prisma.brewPlan.findMany({ where: { status: '仮登録' }, orderBy: { brewDate: 'asc' } }),
  ])
  const username = user?.email ? emailToUsername(user.email) : null

  return (
    <html lang="ja" className={geist.variable}>
      <body className="min-h-screen flex flex-col bg-background text-foreground antialiased">
        <NavBar username={username} />
        <main className="flex-1">{children}</main>
        <BrewPlanDrawer plans={brewPlans} />
      </body>
    </html>
  )
}

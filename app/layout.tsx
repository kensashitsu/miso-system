import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { emailToUsername } from '@/lib/username-map'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: 'みそ熟成管理システム',
  description: '仕込みロット熟成進捗・仕込み計画管理',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const username = user?.email ? emailToUsername(user.email) : null

  return (
    <html lang="ja" className={geist.variable}>
      <body className="min-h-screen flex flex-col bg-background text-foreground antialiased">
        <NavBar username={username} />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  )
}

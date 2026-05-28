import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: '味噌熟成管理システム',
  description: '仕込みロット熟成進捗・仕込み計画管理',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={geist.variable}>
      <body className="min-h-screen flex flex-col bg-background text-foreground antialiased">
        <NavBar />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  )
}

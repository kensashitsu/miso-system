'use server'

import { testApiConnection, type ApiTestResult } from '@/lib/externalApi'

export interface ApiStatusResult {
  stock: ApiTestResult
  sales: ApiTestResult
  testedAt: string  // ISO文字列
}

export async function testApiConnections(): Promise<ApiStatusResult> {
  const stockUrl = process.env.STOCK_API_URL ?? ''
  const salesUrl = process.env.SALES_API_URL ?? ''

  const [stock, sales] = await Promise.all([
    stockUrl ? testApiConnection(stockUrl) : Promise.resolve({ ok: false, latency: 0, error: 'STOCK_API_URL 未設定' }),
    salesUrl ? testApiConnection(salesUrl) : Promise.resolve({ ok: false, latency: 0, error: 'SALES_API_URL 未設定' }),
  ])

  return { stock, sales, testedAt: new Date().toISOString() }
}

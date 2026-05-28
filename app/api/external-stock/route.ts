import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.STOCK_API_URL
  const key = process.env.EXTERNAL_API_KEY

  if (!url || !key) {
    return NextResponse.json({ error: '環境変数が未設定です' }, { status: 500 })
  }

  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ error: `API エラー: HTTP ${res.status}` }, { status: res.status })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: `接続エラー: ${String(e)}` }, { status: 503 })
  }
}

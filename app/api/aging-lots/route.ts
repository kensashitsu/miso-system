// 熟成中ロットの完成予定日（2026-10-01・調味料工場の生産管理 factory-planner 向け）。
//
// factory-planner は製造依頼を出す前に原料（熟成済みのみそ）が足りるかを zaiko で確かめている。
// 今は足りなくても、近く完成するロットで補えるなら入庫希望日を後ろにずらして送れるよう、
// ここで「種類・量・完成予定日」を返す。完成予定日はダッシュボード・熟成完了日カレンダーと同じ計算
// （lib/agingLots.ts）。
//
// 認証：X-API-Key ヘッダーが環境変数 AGING_LOTS_API_KEY と一致すること。
// ログイン必須の対象外（middleware.ts の matcher で除外）。読むだけで何も書き換えない。

import { NextRequest, NextResponse } from 'next/server'
import { format } from 'date-fns'
import { listAgingLotPredictions } from '@/lib/agingLots'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const key = process.env.AGING_LOTS_API_KEY
  if (!key) return NextResponse.json({ error: 'AGING_LOTS_API_KEY が未設定です' }, { status: 500 })
  if (req.headers.get('x-api-key') !== key) return NextResponse.json({ error: '認証エラー' }, { status: 401 })

  const misoType = req.nextUrl.searchParams.get('misoType')
  const lots = (await listAgingLotPredictions())
    .filter(l => !misoType || l.misoType === misoType)
    .map(l => ({
      lotNumber:          l.lotNumber,
      misoType:           l.misoType,
      totalWeightKg:      l.totalWeightKg,
      bucketNumbers:      l.bucketNumbers,
      brewedAt:           format(l.brewedAt, 'yyyy-MM-dd'),
      expectedCompletion: format(l.completion, 'yyyy-MM-dd'),
    }))
  return NextResponse.json({ lots })
}

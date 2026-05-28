// 外部システム（seizou.mitsuura.jp）との連携
// 環境変数はすべてサーバーサイドのみ（NEXT_PUBLIC_ なし）

// 既存システム開発者への依頼：
// /api/stock/aged のレスポンスに packagedStockKg を追加してください。
// 各品種の小分け製品在庫のkg換算合計を返してください。
// マッピングは以下を参照：
//
// 【無添加麦みそ】
//   光うらの麦みそ（粒）1kg / 光うらの麦みそ（粒）500g / 光うらの麦みそ（すり）1kg
//   一番掘り出し 1kg / 無添加 麦みそ 10K桶入 / 無添加 麦みそ バラ / 芳麦味噌 500g
//
// 【田舎みそ】
//   田舎みそ（ｽﾘ）バラ / 田舎みそ（粒）バラ / 田舎みそ（ｽﾘ）1kg
//   田舎みそ（ｽﾘ）1kg（重枝醤油）/ 田舎みそ（ｽﾘ）2K桶入 / 田舎みそ（ｽﾘ）2K桶入（重枝醤油）
//   田舎みそ（ｽﾘ）4K桶入 / 田舎みそ（ｽﾘ）4K桶入（重枝醤油）/ 田舎みそ（ｽﾘ）8K桶入
//   田舎みそ（ｽﾘ）10K桶入 / 田舎みそ（ｽﾘ）10K桶入（重枝醤油）
//   田舎みそ（ｽﾘ）20K桶入 / 田舎みそ（ｽﾘ）20K桶入（重枝醤油）/ 田舎みそ（粒）2kg袋入
//
// 【山吹みそ】
//   山吹みそ バラ / 山吹みそ 4K桶入 / 山吹みそ 8K桶入 / 山吹みそ 20K桶入
//
// 【白みそ】
//   白みそは「西京みそ バラ」として熟成済在庫（stockKg）に含まれているため packagedStockKg は不要
//
// また、レスポンスのフィールド名を stockKg → agedStockKg に改名予定であれば
// 移行期は両フィールドを返してください（後方互換のため）。

export interface AgedStockItem {
  misoType:        string
  stockKg:         number   // 熟成済在庫（将来的に agedStockKg に改名予定）
  packagedStockKg?: number  // 小分け製品在庫合計（API追加対応後に有効化）
}

export interface MonthlySalesItem {
  yearMonth: string  // "YYYY-MM"
  misoType:  string
  weightKg:  number
}

export interface ApiTestResult {
  ok:      boolean
  latency: number   // ms
  error?:  string
}

function headers(): HeadersInit {
  return {
    'X-API-Key':    process.env.EXTERNAL_API_KEY ?? '',
    'Content-Type': 'application/json',
  }
}

// ── 熟成済在庫の取得 ─────────────────────────────────────
export async function fetchAgedStock(): Promise<AgedStockItem[] | null> {
  const url = process.env.STOCK_API_URL
  if (!url || !process.env.EXTERNAL_API_KEY) return null

  try {
    const res = await fetch(url, {
      headers: headers(),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    const items: unknown = Array.isArray(json) ? json : json?.data ?? null
    if (!Array.isArray(items)) return null
    return items
      .filter((i): boolean => {
        if (typeof i !== 'object' || i === null) return false
        const obj = i as Record<string, unknown>
        return (
          typeof obj.misoType === 'string' &&
          (typeof obj.stockKg === 'number' || typeof obj.agedStockKg === 'number')
        )
      })
      .map((i): AgedStockItem => {
        const obj = i as Record<string, unknown>
        return {
          misoType:        obj.misoType as string,
          // stockKg（旧）・agedStockKg（新）どちらにも対応
          stockKg:         (typeof obj.stockKg === 'number' ? obj.stockKg : obj.agedStockKg) as number,
          packagedStockKg: typeof obj.packagedStockKg === 'number' ? obj.packagedStockKg : undefined,
        }
      })
  } catch {
    return null
  }
}

// ── 月別出荷実績の取得 ───────────────────────────────────
export async function fetchMonthlySales(): Promise<MonthlySalesItem[] | null> {
  const url = process.env.SALES_API_URL
  if (!url || !process.env.EXTERNAL_API_KEY) return null

  try {
    const res = await fetch(url, {
      headers: headers(),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    const items: unknown = Array.isArray(json) ? json : json?.data ?? null
    if (!Array.isArray(items)) return null
    return items.filter(
      (i): i is MonthlySalesItem =>
        typeof i === 'object' && i !== null &&
        typeof (i as MonthlySalesItem).yearMonth === 'string' &&
        typeof (i as MonthlySalesItem).misoType === 'string' &&
        typeof (i as MonthlySalesItem).weightKg === 'number'
    )
  } catch {
    return null
  }
}

// ── 接続テスト ────────────────────────────────────────────
export async function testApiConnection(url: string): Promise<ApiTestResult> {
  if (!process.env.EXTERNAL_API_KEY) {
    return { ok: false, latency: 0, error: 'EXTERNAL_API_KEY が未設定です' }
  }
  const start = Date.now()
  try {
    const res = await fetch(url, {
      headers: headers(),
      cache: 'no-store',
    })
    const latency = Date.now() - start
    if (!res.ok) return { ok: false, latency, error: `HTTP ${res.status}` }
    return { ok: true, latency }
  } catch (e) {
    return { ok: false, latency: Date.now() - start, error: String(e) }
  }
}

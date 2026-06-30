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

// ── 熟成中（半製品）在庫の取得 ──────────────────────────────────
// 外部システム開発者への依頼：
// STOCK_WIP_API_URL に熟成中（半製品）在庫を返すエンドポイントを追加してください。
// レスポンス形式は STOCK_API_URL（熟成済在庫）と同じ形式で返してください：
//   [ { "misoType": "無添加麦みそ", "stockKg": 3200 }, ... ]
// ※ 白みそは熟成中品目がないため対象外
export async function fetchWipStock(): Promise<AgedStockItem[] | null> {
  const url = process.env.STOCK_WIP_API_URL
  if (!url || !process.env.EXTERNAL_API_KEY) return null

  try {
    const res = await fetch(url, { headers: headers(), cache: 'no-store' })
    if (!res.ok) return null
    const json = await res.json()
    const items: unknown = Array.isArray(json) ? json : json?.data ?? null
    if (!Array.isArray(items)) return null
    return items
      .filter((i): boolean => {
        if (typeof i !== 'object' || i === null) return false
        const obj = i as Record<string, unknown>
        return typeof obj.misoType === 'string' && typeof obj.stockKg === 'number'
      })
      .map((i): AgedStockItem => {
        const obj = i as Record<string, unknown>
        return { misoType: obj.misoType as string, stockKg: obj.stockKg as number }
      })
  } catch {
    return null
  }
}

// ── 在庫調整（書き込み）──────────────────────────────────────
// zaiko.mitsuura.jp 開発者への依頼：
// 以下の POST エンドポイントを追加し、環境変数 STOCK_ADJUST_API_URL にURLを設定してください。
//
// POST ${STOCK_ADJUST_API_URL}
// 認証: X-API-Key ヘッダー（既存の EXTERNAL_API_KEY を共用）
// リクエストボディ（JSON）:
//   {
//     "misoType":  "無添加麦みそ" | "田舎みそ" | "山吹みそ" | "白みそ",
//     "category":  "wip" | "aged",  // wip=熟成中（半製品）、aged=熟成済
//     "deltaKg":   number,           // 正=追加、負=減算
//     "lotNumber": "202506-001"      // 参照用ロット番号
//   }
// レスポンス: HTTP 200 で成功とみなす
//
// 品種別マッピング（外部システム側で対応してください）：
//   白みそ + category:"aged" → 「西京みそ　ﾊﾞﾗ」に反映
//   白みそは熟成中品目がないため category:"wip" の呼び出しは行いません
//
// 呼び出しタイミング：
//   ロット登録時   → category:"wip",  deltaKg:+(予想歩留まり重量kg) ※白みそを除く
//   熟成完了時     → category:"wip",  deltaKg:-(同上)               ※白みそを除く
//                   category:"aged", deltaKg:+(同上)               ※白みそは 西京みそ ﾊﾞﾗ へ
//
// notes フィールド（任意）: 在庫変更履歴の備考列に追記する文字列。
//   ロット登録時: "桶: 5・6 / 仕込み: 2026/06/30"
//   熟成完了時:   "桶: 5・6 / 仕込み: 2026/06/30 / 完成: 2026/07/15 / 熟成日数: 44日"
//   ← 既存の "味噌仕込み管理連携: ..." 文字列の末尾に " / " で連結してください

export interface StockAdjustPayload {
  misoType:   string
  category:   'wip' | 'aged'
  deltaKg:    number
  lotNumber?: string
  notes?:     string  // 在庫変更履歴の備考列に追記
}

export async function adjustStock(payload: StockAdjustPayload): Promise<boolean> {
  const url = process.env.STOCK_ADJUST_API_URL
  if (!url || !process.env.EXTERNAL_API_KEY) return false

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: headers(),
      body:    JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`在庫調整API エラー: HTTP ${res.status}`, payload)
    }
    return res.ok
  } catch (e) {
    console.error('在庫調整API 通信エラー:', e, payload)
    return false
  }
}

// ── 備考更新 ──────────────────────────────────────────────
// zaiko.mitsuura.jp 開発者への依頼：
// 以下の PATCH エンドポイントを追加してください（認証は既存の X-API-Key を共用）。
//
// PATCH ${STOCK_NOTES_API_URL}
// Body: { "misoType": "無添加麦みそ", "notes": "...", "lotNumber": "202506-001" }
//
// 呼び出しタイミング：
//   ロット登録時 → notes: "【202506-001】桶: 5・6 / 仕込み: 2025/06/01"
//   熟成完了時   → notes: "【202506-001】桶: 5・6 / 仕込み: 2025/06/01 / 完成: 2025/07/15 / 熟成日数: 44日"

export interface StockNotesPayload {
  misoType:  string
  notes:     string
  lotNumber: string
}

export async function updateStockNotes(payload: StockNotesPayload): Promise<boolean> {
  const url = process.env.STOCK_NOTES_API_URL
  if (!url || !process.env.EXTERNAL_API_KEY) return false

  try {
    const res = await fetch(url, {
      method:  'PATCH',
      headers: headers(),
      body:    JSON.stringify(payload),
    })
    if (!res.ok) console.error(`備考更新API エラー: HTTP ${res.status}`, payload)
    return res.ok
  } catch (e) {
    console.error('備考更新API 通信エラー:', e, payload)
    return false
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

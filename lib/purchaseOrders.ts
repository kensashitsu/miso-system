// 発注中の原材料（入荷予定）を factory-planner から取得する。
//
// 原材料の発注は factory-planner の発注リスト（/materials）で管理されていて、
// 入荷予定日もそこにある。factory-planner は別のSupabaseプロジェクトなのでDBを
// 直接は見られない。向こうに読み取り専用API（GET /api/purchase-orders）を用意して
// 発注中のものだけを受け取る。
export interface IncomingOrder {
  productName:     string
  quantity:        number
  unit:            string
  supplierName:    string | null
  expectedDate:    string | null   // "YYYY-MM-DD"。週指定のときはその週の月曜日
  expectedDateTo:  string | null   // 週指定のときだけ入る（その週の日曜日）
}

// 取れなかったときは理由を返す。黙って消えると「発注していないのか、連携が
// 壊れているのか」が画面から判断できず、原因を追えなくなるため（2026-09-03）
export interface IncomingOrderResult {
  orders: IncomingOrder[]
  error:  string | null
}

export async function fetchIncomingOrders(): Promise<IncomingOrderResult> {
  const url = process.env.PURCHASE_ORDER_API_URL?.trim()
  const key = process.env.PURCHASE_ORDER_API_KEY?.trim()
  if (!url || !key) {
    const missing = [!url && 'PURCHASE_ORDER_API_URL', !key && 'PURCHASE_ORDER_API_KEY'].filter(Boolean)
    return { orders: [], error: `${missing.join(' と ')} が未設定です` }
  }

  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': key },
      cache:   'no-store',
    })
    if (!res.ok) {
      return {
        orders: [],
        error: res.status === 401
          ? '発注リストの認証に失敗しました（APIキーが両システムで一致していません）'
          : `発注リストの取得に失敗しました（HTTP ${res.status}）`,
      }
    }
    const json = await res.json()
    const orders: unknown = json?.orders
    if (!Array.isArray(orders)) return { orders: [], error: '発注リストの形式が想定と違います' }
    const parsed = orders
      .filter((o): boolean => {
        if (typeof o !== 'object' || o === null) return false
        const obj = o as Record<string, unknown>
        return typeof obj.productName === 'string' && typeof obj.quantity === 'number'
      })
      .map((o): IncomingOrder => {
        const obj = o as Record<string, unknown>
        return {
          productName:    obj.productName as string,
          quantity:       obj.quantity as number,
          unit:           typeof obj.unit === 'string' ? obj.unit : '',
          supplierName:   typeof obj.supplierName   === 'string' ? obj.supplierName   : null,
          expectedDate:   typeof obj.expectedDate   === 'string' ? obj.expectedDate   : null,
          expectedDateTo: typeof obj.expectedDateTo === 'string' ? obj.expectedDateTo : null,
        }
      })
    return { orders: parsed, error: null }
  } catch (e) {
    return { orders: [], error: `発注リストに接続できません（${e instanceof Error ? e.message : String(e)}）` }
  }
}

// 原材料名の突き合わせ用のキー。zaiko（在庫調整APIが返す name）と
// factory-planner（発注リストの productName）はどちらも zaiko の品目名なので
// 文字列は一致するが、末尾スペースや全角空白の揺れだけは吸収する。
// ※ zaiko の在庫調整APIが品目コードを返すようになれば、コード同士で突き合わせたい。
export function materialKey(name: string): string {
  return name.replace(/[\s　]/g, '')
}

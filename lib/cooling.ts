// 放冷記録（CoolingRun / CoolingStep）まわりの共通処理

/** 放冷の翌々日に仕込む（実績151回中150回がこの形・2026-09-11確認） */
export const COOLING_TO_BREW_DAYS = 2

export const GRAIN_TYPES = ['麦', '砕米'] as const
export type GrainType = (typeof GRAIN_TYPES)[number]

/**
 * 放冷した原料から仕込む品種。同じ日に複数仕込んだ日にどのロットの放冷かを決めるのに使う。
 * 砕米は全て山吹みそ（2026-09-11 ユーザー確認・実績9回すべて山吹）。白みそは無洗米で
 * 放冷機を通さないため、麦・砕米のどちらにも含めない。
 */
export const MISO_TYPES_BY_GRAIN: Record<string, string[]> = {
  '麦':   ['無添加麦みそ', '田舎みそ'],
  '砕米': ['山吹みそ'],
}

export function matchesGrainType(grainType: string, misoType: string) {
  const types = MISO_TYPES_BY_GRAIN[grainType]
  return types ? types.includes(misoType) : true
}

/**
 * 品温の書き方をそのまま受けて下限・上限に分ける。
 * エクセルでは「37～38」「42~43」「38.5」「30℃以下」「(40?)」のように
 * 幅や但し書きで書かれていたため、数値2つに直しつつ原文も残す。
 */
export function parseProductTemp(raw: unknown): {
  min: number | null
  max: number | null
  raw: string | null
} {
  if (raw === null || raw === undefined || raw === '') return { min: null, max: null, raw: null }
  if (typeof raw === 'number') return { min: raw, max: raw, raw: String(raw) }

  const text = String(raw).trim()
  if (!text) return { min: null, max: null, raw: null }

  // 全角数字・全角記号を半角に寄せてから数値を拾う
  const normalized = text.replace(/[０-９．～〜]/g, c =>
    c === '．' ? '.' : c === '～' || c === '〜' ? '~' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  )
  const nums = (normalized.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)

  if (nums.length === 0) return { min: null, max: null, raw: text }
  if (nums.length === 1) {
    const n = nums[0]
    if (/以下/.test(text)) return { min: null, max: n, raw: text }   // 「30℃以下」
    if (/以上/.test(text)) return { min: n, max: null, raw: text }
    return { min: n, max: n, raw: text }
  }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { min, max, raw: text }
}

/** 品温を画面に出すときの表記。原文があればそれを優先する（現場の書き方を消さない） */
export function formatProductTemp(step: {
  productTempMin: number | null
  productTempMax: number | null
  productTempRaw: string | null
}): string {
  if (step.productTempRaw) return step.productTempRaw
  const { productTempMin: min, productTempMax: max } = step
  if (min === null && max === null) return ''
  if (min === null) return `${max}℃以下`
  if (max === null) return `${min}℃以上`
  return min === max ? `${min}` : `${min}～${max}`
}

/** 並べ替え・近さの比較に使う代表値（幅で書かれていたら中央値） */
export function representativeTemp(step: {
  productTempMin: number | null
  productTempMax: number | null
}): number | null {
  const { productTempMin: min, productTempMax: max } = step
  if (min !== null && max !== null) return (min + max) / 2
  return min ?? max ?? null
}

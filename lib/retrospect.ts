// 振り返り：過去の実データだけで在庫推移を再現し、
// 「いつ・何回仕込んでおけばよかったか」を出す。
//
// 予測は一切使わない。使うのは
//   起点在庫 … 月末在庫スナップショット（熟成済＋小分け）
//   消費     … 出荷実績（月次）の日割り
//   補充     … 実際に完成したロット（歩留まり量）
// だけ。予測が当たったかではなく、**現実に対して仕込みが足りていたか**を見る。
//
// ⚠ 熟成日数に Lot.completedAt − brewedAt を使わないこと。出荷済ロットの completedAt は
//   熟成完了日ではなく使用開始日で、実データでは95日などになる。日数はモデル
//   （simulateFermentationDays）で出す。
import { addDays, differenceInDays, format } from 'date-fns'

export interface RetrospectPoint { d: string; kg: number; safety: number }

export interface ShortfallRun {
  from:        string
  to:          string
  deepestKg:   number   // その期間で最も深く割った量
  deepestDate: string
}

export interface ShouldHaveBrewed {
  d:            string  // 仕込んでおくべきだった日（水・木に丸めた手前側）
  forRunFrom:   string  // どの不足に間に合わせるためか
  fermentDays:  number
  hadBrewNear:  boolean // その前後に実際の仕込みがあったか（＝日はよいが量が足りなかった）
}

export interface RetrospectResult {
  misoType:         string
  startKg:          number
  points:           RetrospectPoint[]
  brewDates:        string[]      // 期間内に実際に仕込んだ日
  runs:             ShortfallRun[]
  peakDeficitKg:    number
  missingBatches:   number        // 最も深い不足を1回の歩留まり量で割った回数
  batchKg:          number
  shouldHaveBrewed: ShouldHaveBrewed[]
}

export interface RetrospectParams {
  misoType:      string
  startKg:       number
  startDate:     Date
  endDate:       Date
  dailyRateOf:   (date: Date) => number            // 出荷実績の日割り
  supplyByDate:  Map<string, number>               // 完成日 → 歩留まり量
  // 月末在庫スナップショットで毎月つなぎ直すための実測値（'yyyy-MM-dd' → その日の朝の在庫）。
  // 補充にロットの completedAt を使うが、出荷済ロットではこれが使用開始日なので、
  // すでに起点在庫に入っている分を二重に足してしまう（実データで1回分ぶん多く出た）。
  // 毎月頭で実測に戻せば、ずれが月をまたいで積み上がらない
  anchors:       Map<string, number>
  safetyLineAt:  (date: Date) => number
  brewDates:     Date[]                            // 期間内の実際の仕込み日
  batchKg:       number                            // 1回の歩留まり量
  fermentDaysAt: (brewDate: Date) => number        // その日に仕込んだ場合の熟成日数
}

export function computeRetrospect(p: RetrospectParams): RetrospectResult {
  const d = (x: Date) => format(x, 'yyyy-MM-dd')
  const points: RetrospectPoint[] = []
  const runs: ShortfallRun[] = []

  let stock = p.startKg
  let cur = p.startDate
  let runFrom: string | null = null
  let deepest = 0
  let deepestDate = ''
  let peakDeficit = 0
  const closeRun = (to: string) => {
    runs.push({ from: runFrom!, to, deepestKg: deepest, deepestDate })
    runFrom = null; deepest = 0; deepestDate = ''
  }

  for (let i = 0; i <= differenceInDays(p.endDate, p.startDate); i++) {
    const k = d(cur)
    const anchor = p.anchors.get(k)
    if (anchor != null) stock = anchor      // 実測に戻す
    stock += p.supplyByDate.get(k) ?? 0
    stock -= p.dailyRateOf(cur)
    const line = p.safetyLineAt(cur)
    points.push({ d: k, kg: Math.round(stock), safety: Math.round(line) })
    if (stock < line) {
      if (!runFrom) runFrom = k
      const gap = line - stock
      if (gap > deepest) { deepest = gap; deepestDate = k }
      if (gap > peakDeficit) peakDeficit = gap
    } else if (runFrom) {
      closeRun(k)
    }
    cur = addDays(cur, 1)
  }
  if (runFrom) closeRun(d(p.endDate))

  // 仕込んでおくべきだった日＝不足の入口 − その仕込み日の季節の熟成日数。
  // 熟成日数は仕込み時期で変わるので、概算で遡ってから引き直す（1回の反復で収束する）
  const shouldHaveBrewed: ShouldHaveBrewed[] = runs.map(r => {
    const entry = new Date(r.from + 'T00:00:00')
    let back = addDays(entry, -p.fermentDaysAt(addDays(entry, -41)))
    back = addDays(entry, -p.fermentDaysAt(back))
    // 仕込みは水・木のみ。間に合わせるため手前側へ丸める
    let snapped = back
    for (let k = 0; k < 7; k++) {
      if (snapped.getDay() === 3 || snapped.getDay() === 4) break
      snapped = addDays(snapped, -1)
    }
    return {
      d:           d(snapped),
      forRunFrom:  r.from,
      fermentDays: p.fermentDaysAt(snapped),
      hadBrewNear: p.brewDates.some(b => Math.abs(differenceInDays(b, snapped)) <= 3),
    }
  })

  return {
    misoType:       p.misoType,
    startKg:        p.startKg,
    points,
    brewDates:      p.brewDates.map(d),
    runs,
    peakDeficitKg:  Math.round(peakDeficit),
    missingBatches: p.batchKg > 0 ? Math.ceil(peakDeficit / p.batchKg) : 0,
    batchKg:        Math.round(p.batchKg),
    shouldHaveBrewed,
  }
}

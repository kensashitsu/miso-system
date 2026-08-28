// AI仕込み提案の純粋な計算ロジック。
// UI（app/planning/BrewSuggestions.tsx）から切り出してテスト可能にしている。
// 実データでの検証は scripts/debug-brew-plan.mts で行う。
import { addDays, differenceInDays, format } from 'date-fns'
import { HEATING_MONTHLY_FACTOR } from './tempCalc'

export interface BatchPlan {
  n:                     number
  brewDate:              Date
  completionDate:        Date
  fermentationDays:      number  // Q10補正ありの熟成日数（常温）/ 固定値（暖房・冷房）
  stockOutDate:          Date
  materialOrderDeadline: Date
  daysUntilOrder:        number
  startStockKg:          number  // この回の計画開始時点の有効在庫
  rawFermentationDays?:      number  // Q10補正なしの熟成日数（常温かつq10≠1のときのみ）
  rawCompletionDate?:        Date    // Q10補正なしの完成日
  rawBrewDate?:              Date    // Q10補正なしの推奨仕込み日
  rawMaterialOrderDeadline?: Date    // Q10補正なしの手配締切
  isFixed?:                  boolean // 仮登録済み（確定）の行。提案ではなく既定の予定
  bucketNumbers?:            string | null  // 確定行のみ。仮登録時に採番された桶番号（例: 11・12）
  // この仕込み日を最終的に決めた条件（画面の「計算の根拠」で理由を出すため）。
  // 在庫切れからの逆算値は、最短仕込み日・前の回との間隔・仕込める曜日・仮登録済みの日などで
  // その後ずらされることが多く、「在庫切れ − 熟成 − バッファ」の式では結果を説明できない。
  // 最後にこの日を動かした条件を記録する。
  decidedBy?: 'stockout' | 'peak' | 'earliest' | 'order' | 'spacing' | 'blocked' | 'manual'
  // 出荷ピーク期（完成が10〜12月）の2回仕込み。1行で「連続2回（水→木）」を表す。
  // 行と回インデックスの1対1対応を保つため、2行に分けず1行に相方の日付を持たせている。
  pairBrewDate?:              Date
  pairCompletionDate?:        Date
  pairFermentationDays?:      number
  pairMaterialOrderDeadline?: Date
}

// 常温：仕込み日から気象データを日ごとに積み上げて完成日を推計（Q10補正あり）
// lib/tempCalc.ts の applyQ10 と同ロジック（effectiveTemp > 0 のとき avgTempC = eff + 10 で逆算）
export function simulateFermentationDays(
  brewDate:         Date,
  targetTempSum:    number,
  weatherAvg:       Record<string, number>,
  fallbackDaily:    number,
  q10Value:         number,
  heatingBaseTemp:  number,
  indoorDailyRate?: number,  // 10〜5月の暖房レート（常温→暖房の季節切り替え用）
): { days: number; completionDate: Date } {
  if (!brewDate || isNaN(brewDate.getTime())) return { days: 0, completionDate: new Date() }
  let accumulated = 0
  let current = new Date(brewDate)
  for (let i = 0; i < 730; i++) {
    const month = current.getMonth() + 1
    const isOutdoorMonth = month >= 6 && month <= 9
    let daily: number
    if (indoorDailyRate !== undefined && !isOutdoorMonth) {
      // 10〜5月: 暖房レートに実データ較正済みの月別補正係数を適用（Q10補正は対象外）
      daily = indoorDailyRate * (HEATING_MONTHLY_FACTOR[month] ?? 1)
    } else {
      const key = format(current, 'MM-dd')
      const eff = weatherAvg[key] ?? fallbackDaily
      if (eff > 0 && q10Value !== 1) {
        const avgTempC = eff + 10
        daily = eff * Math.pow(q10Value, (avgTempC - heatingBaseTemp) / 10)
      } else {
        daily = eff
      }
    }
    accumulated += daily
    current = addDays(current, 1)
    if (accumulated >= targetTempSum) {
      return { days: i + 1, completionDate: new Date(current) }
    }
  }
  return { days: 730, completionDate: addDays(brewDate, 730) }
}

// 品種別の原料手配リードタイム（仕込み日の何日前までに手配が必要か）
export const ORDER_LEAD_DAYS: Record<string, number> = {
  '白みそ': 7,
}
export const DEFAULT_ORDER_LEAD_DAYS = 21

// 指定日以降で最も近い水曜（3）または木曜（4）を返す
// 各曜日からの加算日数: [日,月,火,水,木,金,土] = [3,2,1,0,0,5,4]
export const SNAP_DAYS_OFFSET = [3, 2, 1, 0, 0, 5, 4]

export function snapToBrewDay(date: Date): Date {
  return addDays(date, SNAP_DAYS_OFFSET[date.getDay()])
}

// 翌週の月曜日を返す（当週は原料手配等の都合で提案対象外にするための起点）
export function nextWeekMonday(date: Date): Date {
  const isoDow = (date.getDay() + 6) % 7  // 月=0, 火=1, ... 日=6
  return addDays(date, 7 - isoDow)
}

// 指定日を含む週の月曜日を 'yyyy-MM-dd' で返す（仕込めない週の管理キー）
export function weekStartOf(date: Date): string {
  const isoDow = (date.getDay() + 6) % 7   // 月=0, 火=1, ... 日=6
  return format(addDays(date, -isoDow), 'yyyy-MM-dd')
}

// 仕込めない週（月曜日の配列）を、その週の全日付の集合に展開する。
// calcBatches の blockedBrewDates に渡して、その週を避けた提案にする
export function expandBlockedWeeks(weekStarts: string[]): Set<string> {
  const out = new Set<string>()
  for (const w of weekStarts) {
    const mon = new Date(w + 'T00:00:00')
    if (isNaN(mon.getTime())) continue
    for (let i = 0; i < 7; i++) out.add(format(addDays(mon, i), 'yyyy-MM-dd'))
  }
  return out
}

// 月別変動レートを使って在庫が尽きる日をシミュレーション（熟成中ロットの補充スケジュール考慮）
export function findStockOutDate(
  stock:          number,
  startDate:      Date,
  getDailyRateFn: (date: Date) => number,
  supplyEvents?:  { date: Date; kg: number }[],
  getSafetyDelta?: (date: Date) => number,   // 季節で安全在庫ラインが変わる分の補正
): Date {
  if (stock <= 0 && (!supplyEvents || supplyEvents.length === 0)) return new Date(startDate)
  let remaining = stock
  let d = new Date(startDate)
  for (let i = 0; i < 3650; i++) {
    // 完成予定日に熟成中ロットの歩留まりを補充
    if (supplyEvents) {
      const dStr = format(d, 'yyyy-MM-dd')
      for (const ev of supplyEvents) {
        if (format(ev.date, 'yyyy-MM-dd') === dStr) remaining += ev.kg
      }
    }
    remaining -= getDailyRateFn(d)
    if (remaining - (getSafetyDelta?.(d) ?? 0) <= 0) return addDays(d, 1)
    d = addDays(d, 1)
  }
  return addDays(startDate, 3650)
}

// この回の仕込みで「防げる」在庫切れ日を返す。
// notBefore（最短で仕込んだ場合の完成日）より前の在庫切れは今から仕込んでも間に合わないので
// そこでは止まらず、notBefore 以降にいったん在庫がプラスへ回復してから次に尽きる日を返す
// （＝確定済みの仕込みが手当てする谷を、もう一度狙い直さないため）。
// 最後まで回復しない場合は本当に手が足りていないので、最初の在庫切れ日をそのまま返す
// （＝従来どおり最短日での仕込み提案になる）。
// ※不足分（マイナス残）は0で底打ちさせないこと。底打ちすると割り込んだ分がなかったことになり、
//   以降の在庫を実際より多く見積もって次の仕込みが遅れる（2026-08-28に12月の安全在庫割れで発覚）。
export function findStockOutDateAfter(
  stock:          number,
  startDate:      Date,
  getDailyRateFn: (date: Date) => number,
  notBefore:      Date,
  supplyEvents?:  { date: Date; kg: number }[],
  getSafetyDelta?: (date: Date) => number,   // 季節で安全在庫ラインが変わる分の補正
  getSafetyLine?:  (date: Date) => number,   // その日の安全在庫ライン（谷の深さ判定に使う）
): { date: Date; criticalDate: Date } {
  const notBeforeStr = format(notBefore, 'yyyy-MM-dd')
  let remaining = stock
  let d = new Date(startDate)
  let firstStockOut: Date | null = null
  let recoveredAfterNotBefore = false
  // 谷の入口の候補。SHORTFALL_TOLERANCE_DAYS 以内に在庫が回復した谷は
  // 既存の仕込みで埋まるものとして見送り、続けて次の谷を探す
  let candidate: Date | null = null
  let candidateIdx = -1
  let candidateDeep = false   // その谷で在庫が MIN_COVER_DAYS 分を下回ったか
  let criticalDate: Date | null = null   // 実際に薄くなった日
  for (let i = 0; i < 3650; i++) {
    const dStr = format(d, 'yyyy-MM-dd')
    if (supplyEvents) {
      for (const ev of supplyEvents) {
        if (format(ev.date, 'yyyy-MM-dd') === dStr) remaining += ev.kg
      }
    }
    remaining -= getDailyRateFn(d)
    if (remaining - (getSafetyDelta?.(d) ?? 0) > 0) {
      if (dStr >= notBeforeStr) recoveredAfterNotBefore = true
      candidate = null; candidateDeep = false; criticalDate = null   // 回復した＝手当て済みの谷なので見送る
    } else {
      if (firstStockOut === null) firstStockOut = addDays(d, 1)
      if (dStr >= notBeforeStr && recoveredAfterNotBefore) {
        if (candidate === null) { candidate = addDays(d, 1); candidateIdx = i }
        // 谷の深さ：実在庫（＝ライン控除前）が MIN_COVER_DAYS 分を下回った日を返す。
        // ラインを割り始めた日ではなく「本当に薄くなる日」を狙わないと、
        // まだ30日分以上あるのに1ヶ月早い仕込みを提案してしまう
        // （2026-08-28：11/17に35日分あるのに10/1仕込みを提案しユーザー指摘）。
        // ラインが未設定（0）の品種は remaining がそのまま実在庫になる
        const line      = getSafetyLine?.(d) ?? 0
        const actualKg  = remaining + line
        const rate      = Math.max(getDailyRateFn(d), 1e-9)
        if (actualKg < MIN_COVER_DAYS * rate && !candidateDeep) {
          candidateDeep = true
          criticalDate  = addDays(d, 1)
        }
        if (candidateDeep && i - candidateIdx >= SHORTFALL_TOLERANCE_DAYS) {
          // date         = 谷の入口（ここを狙って逆算する）
          // criticalDate = 実際に薄くなる日（団子防止のずらしはここを越えてはいけない）
          return { date: candidate, criticalDate: criticalDate ?? addDays(d, 1) }
        }
      }
    }
    d = addDays(d, 1)
  }
  const fallback = candidate ?? firstStockOut ?? addDays(startDate, 3650)
  return { date: fallback, criticalDate: criticalDate ?? fallback }
}

// 期間内 [startDate, endDate) に受け取る補充量合計（熟成中ロット・仮登録の完成分）
// ※必ず日付単位（yyyy-MM-dd）で比較する。補充イベントの日付は0時ちょうど、
//   startDate/endDate は today 由来で時刻を持つため、Dateのまま比較すると
//   「endDateと同じ日の補充」が期間内と判定される。その補充は次の回の
//   findStockOutDate（refDate=endDateから開始）でも加算されるため二重計上になる。
export function computeSupplyReceived(
  startDate:     Date,
  endDate:       Date,
  supplyEvents?: { date: Date; kg: number }[],
): number {
  if (!supplyEvents) return 0
  const startStr = format(startDate, 'yyyy-MM-dd')
  const endStr   = format(endDate,   'yyyy-MM-dd')
  return supplyEvents
    .filter(ev => {
      const evStr = format(ev.date, 'yyyy-MM-dd')
      return evStr >= startStr && evStr < endStr
    })
    .reduce((sum, ev) => sum + ev.kg, 0)
}

// startDate〜endDate間の月別変動レートによる消費量合計
export function computeConsumed(
  startDate:      Date,
  endDate:        Date,
  getDailyRateFn: (date: Date) => number,
): number {
  let total = 0
  let d = new Date(startDate)
  while (d < endDate) {
    total += getDailyRateFn(d)
    d = addDays(d, 1)
  }
  return total
}

// 1バッチの歩留まり(kg)を消費しきるまでの日数（月別変動レートで積分）
// = このバッチが「何日分の需要を賄えるか」。連続バッチの完成日がこの間隔より
// 密集すると仕込み日が1〜数日差で団子になるため、最小完成間隔の基準として使う。
export function computeCoverageDays(
  batchKg:        number,
  startDate:      Date,
  getDailyRateFn: (date: Date) => number,
): number {
  if (batchKg <= 0) return 0
  let remaining = batchKg
  let d = new Date(startDate)
  for (let i = 0; i < 730; i++) {
    remaining -= getDailyRateFn(d)
    if (remaining <= 0) return i + 1
    d = addDays(d, 1)
  }
  return 730
}

// 出荷ピーク（11〜12月）に在庫を厚くするため、完成日がこの月に入る回は2本立て（連続2回仕込み）にする。
// 冬は熟成が45日前後に伸びる一方、1本が賄えるのは20〜25日分しかなく1本ずつでは追いつかないため。
export const PEAK_COMPLETION_MONTHS = [10, 11, 12]

// ピーク期に完成する回に上乗せするバッファ日数。冬は需要増＋熟成長期化で
// 通常のバッファ（14日）だと完成待ちの間に安全在庫ラインを割り込みやすいため厚くする
export const PEAK_EXTRA_BUFFER_DAYS = 14

// 2本立ては必ず連日（水→木）にする。仮登録済み・仕込めない週・工程制約を避けた結果
// 翌日に置けない場合は2本立てにしない（その分は次の回として別途提案される）
export const MAX_PAIR_GAP_DAYS = 1

// 既存の仕込みで埋まる短い谷は新規提案の対象にしない（この日数以内に在庫が回復するなら見送る）。
// 安全在庫ライン自体が緩衝なので、数日の割り込みのために1回分（ピーク期は2本＝約3,200kg）を
// 追加提案するのは過剰。仕込みの完成日も熟成のブレで数日動くため、そもそも狙い撃ちできない。
export const SHORTFALL_TOLERANCE_DAYS = 7

// 安全在庫ラインを割っても、在庫がこの日数分を保っていれば新規提案の対象にしない。
// 安全在庫ライン自体が緩衝なので「ラインを割った＝即補充が必要」ではなく、
// 現場は「まだ◯日分ある」で判断している。深さを見ずに期間だけで判定すると、
// 実務では問題にならない浅い谷にも1回分の仕込みを提案してしまう。
export const MIN_COVER_DAYS = 10

// 冬季（この月）は外気が低く、完成後に常温へ出せば着色が実質進まないため、
// 出荷ピークに備えて安全在庫ラインを厚くできる
// （防府アメダス実測：11月195日・12〜2月は実質進まない／夏は13〜20日でリスク高）。
// ※1〜2月を含めないのは、年明けに注文がパタッと減るため（実績：12月3,322kg→1月1,969kgで
//   年間最低。1月に厚いラインを敷くと過剰で、届かない警告が鳴り続けるだけになる）
export const WINTER_MONTHS = [11, 12]

// 夏季（この月）は完成後13〜20日で着色リスク高に達するため、安全在庫ラインを厚くすると
// 在庫の底が上がって滞留が延び、かえって不利になる。薄め（0＝底を作らない）で運用する。
export const SUMMER_MONTHS = [5, 6, 7, 8]

// その日に適用される安全在庫ライン(kg)を返す関数を作る（冬季・夏季・それ以外の3段階）
export function makeSafetyLineFn(
  baseSafetyKg:   number,
  winterSafetyKg: number | null | undefined,
  summerSafetyKg: number | null | undefined,
): (date: Date) => number {
  return (date: Date) => {
    const m = date.getMonth() + 1
    if (winterSafetyKg != null && WINTER_MONTHS.includes(m)) return winterSafetyKg
    if (summerSafetyKg != null && SUMMER_MONTHS.includes(m)) return summerSafetyKg
    return baseSafetyKg
  }
}

// 「その日の安全在庫ライン − 通年ライン」を返す関数を作る。
// 在庫連鎖は通年ライン(safetyStockKg)を引いた「実質使える在庫」で追跡しているため、
// 季節でラインが変わる分をこの差分で補正する（差分ぶんだけ早く／遅く在庫切れ扱いになる）。
// ※基準は必ず通年ライン。基準日のライン（季節で変わりうる）にすると引き算がズレる
export function makeSafetyDeltaFn(
  baseSafetyKg:   number,
  winterSafetyKg: number | null | undefined,
  summerSafetyKg: number | null | undefined,
): ((date: Date) => number) | undefined {
  const hasWinter = winterSafetyKg != null && winterSafetyKg !== baseSafetyKg
  const hasSummer = summerSafetyKg != null && summerSafetyKg !== baseSafetyKg
  if (!hasWinter && !hasSummer) return undefined
  const lineAt = makeSafetyLineFn(baseSafetyKg, winterSafetyKg, summerSafetyKg)
  return (date: Date) => lineAt(date) - baseSafetyKg
}

// 完成間隔を詰められる下限（水木仕込みなら同じ週に2回（水→木で1日差）まで可能なため、
// 物理的な下限は1日。2026-08-26にユーザー指摘で「週1本」想定から緩和）
export const MIN_COMPLETION_GAP_DAYS = 1

// 次バッチの完成日下限を計算する。
// 基本は「前バッチ完成日＋カバー日数」（団子防止）だが、完成時点の在庫の底が
// バッファ日数分を下回る見込みのときは、不足日数分だけ間隔を詰めることを許し、
// 数バッチかけてバッファを回復できるようにする。
// ※従来はカバー日数固定の下限だったため間隔が常に消費とトントン以上となり、
//   一度食い込んだバッファ（例: 秋冬の需要増×熟成長期化）を回復する手段がなく
//   在庫ゼロ張り付きの提案が連鎖する「ラチェット」になっていた。
export function calcMinNextCompletion(
  completionDate: Date,
  stockAtRef:     number,   // refDate時点の在庫（前バッチの歩留まり加算済み）
  refDate:        Date,     // 前バッチの完成日（初回は今日）
  batchYieldKg:   number,
  bufferDays:     number,
  getDailyRateFn: (date: Date) => number,
  supplyEvents?:  { date: Date; kg: number }[],
  getSafetyDelta?: (date: Date) => number,   // 季節で安全在庫ラインが変わる分の補正
): Date {
  const coverage = computeCoverageDays(batchYieldKg, completionDate, getDailyRateFn)
  // このバッチ完成時点の在庫の底（歩留まり加算前）
  const floorKg = Math.max(
    0,
    stockAtRef
      - computeConsumed(refDate, completionDate, getDailyRateFn)
      + computeSupplyReceived(refDate, completionDate, supplyEvents)
      - (getSafetyDelta?.(completionDate) ?? 0),
  )
  const rate        = Math.max(getDailyRateFn(completionDate), 1e-9)
  const deficitDays = Math.max(0, bufferDays - floorKg / rate)
  const minGap      = Math.min(MIN_COMPLETION_GAP_DAYS, coverage)
  const gapDays     = Math.max(minGap, Math.ceil(coverage - deficitDays))
  return addDays(completionDate, gapDays)
}

// 予測方式・データから「日付→1日消費量(kg)」関数を生成

// そこで得た遅い熟成日数（45日前後）のまま1回だけ補正すると、夏仕込みなのに仕込み日が
// 2〜3週間も前倒しになる。実際の仕込み日の季節に合った熟成日数へ収束するまで繰り返す。
export function refineBrewDateToStockOut(
  stockOut:      Date,
  initialEst:    number,
  buffer:        number,
  getCompletion: (d: Date) => { days: number; completionDate: Date },
  snapBrewDate?: (d: Date) => Date,
): Date {
  const snap = (d: Date) => (snapBrewDate ? snapBrewDate(d) : d)
  let brew = snap(addDays(stockOut, -(initialEst + buffer)))
  const seen = new Set<string>()
  for (let k = 0; k < 6; k++) {
    const r    = getCompletion(brew)
    const next = snap(addDays(stockOut, -(r.days + buffer)))
    if (format(next, 'yyyy-MM-dd') === format(brew, 'yyyy-MM-dd')) return next  // 収束
    // スナップ起因で隣接日を行き来する2サイクルは、遅い方（完成が在庫切れに近い＝過剰仕込みが少ない安全側）を採用
    if (seen.has(format(next, 'yyyy-MM-dd'))) return next > brew ? next : brew
    seen.add(format(brew, 'yyyy-MM-dd'))
    brew = next
  }
  return brew
}

export function calcBatches(
  effectiveStock:      number,
  getDailyRateFn:      (date: Date) => number,  // 月別消費量関数
  fermentationDays:    number,    // Q10補正ありの初期推定値
  batchYieldKg:        number,
  count:               number,
  today:               Date,
  orderLeadDays:       number,
  bufferDays:          number,
  getCompletion?:      (brewDate: Date) => { days: number; completionDate: Date },
  snapBrewDate?:       (date: Date) => Date,
  getCompletionRaw?:   (brewDate: Date) => { days: number; completionDate: Date },
  fermentationDaysRaw?: number,   // Q10補正なしの初期推定値（常温のみ）
  manualBrewDateByIndex?: Record<number, Date>,  // 回ごと（0始まり）の仕込み日手動指定（スナップ無効）
  supplyEvents?:       { date: Date; kg: number }[],  // 熟成中ロットの補充スケジュール
  isDoubleBatch?:      (completionDate: Date) => boolean,  // その完成日は2回仕込み（連続2回）にするか
  blockedBrewDates?:   Set<string>,  // 'yyyy-MM-dd'。既に仮登録済みなど、提案を置いてはいけない日
  getSafetyDelta?:     (date: Date) => number,  // 季節で安全在庫ラインが変わる分の補正
  getSafetyLine?:      (date: Date) => number,  // その日の安全在庫ライン（谷の深さ判定用）
  isAllowedBrewDay?:   (date: Date) => boolean,  // 指定時、真を返す日にしか提案しない（工程上の制約）
  fixedCompletionDates?: Date[],  // 確定済み（仮登録）の完成日。団子防止の間隔基準に含める
): BatchPlan[] {
  const batches: BatchPlan[] = []
  // 当週はもう原料手配等の都合で仕込めないため、仕込み日として提案できるのは最短で翌週から
  const minBrewDate   = snapBrewDate ? snapBrewDate(nextWeekMonday(today)) : nextWeekMonday(today)
  // 仮登録済みの日には新規提案を置かない。置いてしまうと表示では重複として除外される一方、
  // 在庫連鎖には歩留まりが加算されたままになり、実在しない在庫を見込んで
  // 以降の仕込みが遅れる（2026-08-28に1月以降の安全在庫割れの原因として実データで確認）
  // 提案に使える日かどうか。isAllowedBrewDay 指定時はそれが真を返す日だけが使える
  // （例: 山吹みそは無添加・田舎の翌日＝木曜にしか仕込めない）
  const isUsableBrewDay = (dt: Date): boolean => {
    if (blockedBrewDates?.has(format(dt, 'yyyy-MM-dd'))) return false
    if (isAllowedBrewDay && !isAllowedBrewDay(dt)) return false
    return true
  }
  const nextAllowedBrewDay = (dt: Date): Date => {
    let x = dt
    for (let g = 0; g < 120 && !isUsableBrewDay(x); g++) {
      x = snapBrewDate ? snapBrewDate(addDays(x, 1)) : addDays(x, 1)
    }
    return x
  }
  let stock           = effectiveStock
  let refDate         = today
  // Q10補正あり・なしそれぞれの推定値を独立して追跡する
  let currentEstimate    = fermentationDays
  let rawCurrentEstimate = fermentationDaysRaw ?? fermentationDays
  // バッチ間の昇順を保証するための下限日（前バッチの翌日以降）
  let minNextBrewDate:    Date = minBrewDate
  let minNextRawBrewDate: Date = minBrewDate
  // 連続バッチの完成日が密集しないための下限（前バッチの完成日＋カバー期間）。
  // これにより「1バッチを消費しきる前に次が完成」する団子状の仕込み提案を防ぐ。
  let minNextCompletion:    Date = today
  let minNextRawCompletion: Date = today
  // Q10補正なしチェーン専用の在庫追跡（Q10補正ありとは独立して連鎖する）
  let rawRefDate = today
  let rawStock   = effectiveStock

  for (let i = 0; i < count; i++) {
    const startStockKg = stock
    const safeBuffer   = Number.isFinite(bufferDays) ? bufferDays : 0
    // この回が狙うべき在庫切れ日。今から最短で仕込んでも完成が間に合わない在庫切れは
    // 対象にしない（間に合わない分を狙うと、確定済みの仕込みで既に手当てされているのに
    // 最短日で不要な仕込みを提案してしまうため）
    const earliestCompletion = (getCompletion
      ? getCompletion(minBrewDate).completionDate
      : addDays(minBrewDate, fermentationDays))
    const shortfall    = findStockOutDateAfter(stock, refDate, getDailyRateFn, earliestCompletion, supplyEvents, getSafetyDelta, getSafetyLine)
    const stockOutDate = shortfall.date          // 逆算の基準（谷の入口）
    const criticalDate = shortfall.criticalDate  // ずらしの上限（実際に薄くなる日）
    // Q10補正なし専用の在庫切れ予測日（独立チェーン）
    const rawStockOutDate = getCompletionRaw
      ? findStockOutDateAfter(rawStock, rawRefDate, getDailyRateFn, getCompletionRaw(minBrewDate).completionDate, supplyEvents, getSafetyDelta, getSafetyLine).date
      : stockOutDate

    // 完成日を計算するヘルパー（常温はQ10シミュレーション、それ以外は固定熟成日数）
    const computeCompletion = (bd: Date): { completionDate: Date; days: number } =>
      getCompletion ? getCompletion(bd) : { completionDate: addDays(bd, fermentationDays), days: fermentationDays }

    // ── Q10補正あり（メイン） ──────────────────────────────
    let brewDate: Date
    // 仕込み日を動かした条件を順に上書きしていく（最後に動かしたものが決め手）
    let decidedBy: BatchPlan['decidedBy'] = 'stockout'
    if (manualBrewDateByIndex?.[i]) {
      decidedBy = 'manual'
      brewDate = manualBrewDateByIndex[i]
      // 手動指定日が当日以前の場合も翌日以降に修正（elseブランチと統一）
      if (brewDate < minBrewDate) {
        brewDate = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
      }
    } else {
      // 常温は仕込み日の季節に合った実熟成日数へ不動点反復で収束させる（単発補正だと前倒し過ぎる）。
      // それ以外は固定熟成日数で逆算するだけ。
      const solveBrewDate = (buf: number): Date => {
        if (getCompletion) return refineBrewDateToStockOut(stockOutDate, currentEstimate, buf, getCompletion, snapBrewDate)
        const preSnapDate = addDays(stockOutDate, -(currentEstimate + buf))
        return snapBrewDate ? snapBrewDate(preSnapDate) : preSnapDate
      }
      brewDate = solveBrewDate(safeBuffer)
      // 出荷ピーク期に完成する回はバッファを厚くして前倒しする。
      // 冬は需要が増える上に熟成も長引くため、通常のバッファ（14日）だと完成待ちの間に
      // 安全在庫ラインを割り込みやすい
      if (isDoubleBatch?.(computeCompletion(brewDate).completionDate)) {
        brewDate = solveBrewDate(safeBuffer + PEAK_EXTRA_BUFFER_DAYS)
        decidedBy = 'peak'
      }
      // 計算結果が当日以前になった場合は翌日以降に修正（当日はもう仕込めないため）
      if (brewDate < minBrewDate) {
        brewDate = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
        decidedBy = 'earliest'
      }
    }
    // 前バッチ以前にならないよう修正（昇順を保証し、sort後のn=1・n=2が同日になるのを防ぐ）
    if (brewDate < minNextBrewDate) {
      brewDate = snapBrewDate ? snapBrewDate(minNextBrewDate) : minNextBrewDate
      decidedBy = 'order'
    }
    // 仮登録済みの日と重ならないようずらす（手動固定はユーザーの意思なのでそのまま）
    if (!manualBrewDateByIndex?.[i]) {
      const beforeBlocked = brewDate
      brewDate = nextAllowedBrewDay(brewDate)
      if (brewDate.getTime() !== beforeBlocked.getTime()) decidedBy = 'blocked'
    }

    let { completionDate, days: actualFermentDays } = computeCompletion(brewDate)
    // 完成日が「前バッチの完成日＋カバー期間」より早い場合は仕込み日を後ろへずらす。
    // 1バッチの歩留まりを消費しきる前に次が完成すると、仕込み日が1〜数日差で密集する
    // （前バッチの翌日へ丸める昇順クランプだけでは団子状の提案になってしまう）。
    // ※確定済み（仮登録）の完成日も間隔の基準に含める。含めないと「確定の翌日に仕込む」
    //   ような提案が出る（2026-08-28：9/30確定の翌日10/1が提案されユーザー指摘）。
    for (const fc of fixedCompletionDates ?? []) {
      if (fc > completionDate) continue          // この回より後の確定分は基準にしない
      const bound = addDays(fc, computeCoverageDays(batchYieldKg, fc, getDailyRateFn))
      if (bound > minNextCompletion) minNextCompletion = bound
    }
    // ただし手動固定されている回は、現場の都合（水木連続仕込みなど）を優先しそのまま採用する。
    if (completionDate < minNextCompletion && !manualBrewDateByIndex?.[i]) {
      // 元の日から1回ずつ後ろへ動かし、「criticalDate（実際に在庫が薄くなる日）に間に合う範囲で
      // 最も遅い日」を採用する。間隔（minNextCompletion）に届いた時点で打ち切る。
      // ※以前は「ずらした結果が criticalDate を超えたらずらし自体を取り消す」実装だったため、
      //   1日超えただけで元の（早すぎる）日に戻り、確定分の翌日に仕込む提案が出ていた。
      let bestBrew = brewDate, bestComp = completionDate, bestDays = actualFermentDays
      let cur = brewDate
      for (let guard = 0; guard < 120; guard++) {
        const next = nextAllowedBrewDay(snapBrewDate ? snapBrewDate(addDays(cur, 1)) : addDays(cur, 1))
        const rr   = computeCompletion(next)
        if (rr.completionDate > criticalDate) break   // これ以上は在庫が薄くなる日に間に合わない
        bestBrew = next; bestComp = rr.completionDate; bestDays = rr.days
        cur = next
        if (rr.completionDate >= minNextCompletion) break   // 目標の間隔に達した
      }
      if (bestBrew.getTime() !== brewDate.getTime()) decidedBy = 'spacing'
      brewDate          = bestBrew
      completionDate    = bestComp
      actualFermentDays = bestDays
    }
    // ── 出荷ピーク期の2回仕込み ──────────────────────────────
    // 完成が対象期間に入る回は、翌仕込み可能日（水→木）にもう1本仕込んで2本立てにする。
    // 冬は熟成が45日前後に伸びる一方、1本(≒1,600kg)が賄えるのは20〜25日分しかないため、
    // 1本ずつでは出荷ピークの11〜12月に在庫が積み上がらないため。
    let pairBrewDate:              Date | undefined
    let pairCompletionDate:        Date | undefined
    let pairFermentationDays:      number | undefined
    let pairMaterialOrderDeadline: Date | undefined
    if (isDoubleBatch?.(completionDate)) {
      // 相方も仮登録済み・仕込めない週を避ける（避けないと確定分と同じ仕込みを二重に数えてしまう）
      const pb = nextAllowedBrewDay(snapBrewDate ? snapBrewDate(addDays(brewDate, 1)) : addDays(brewDate, 1))
      // 2本立ては必ず連日。翌日に置けない場合（相方が仮登録済み・仕込めない週・
      // 木曜始まりで翌日が金曜など）は2本立てにせず、その分は次の回として別途提案させる
      if (differenceInDays(pb, brewDate) <= MAX_PAIR_GAP_DAYS) {
        const pr = computeCompletion(pb)
        pairBrewDate              = pb
        pairCompletionDate        = pr.completionDate
        pairFermentationDays      = pr.days
        pairMaterialOrderDeadline = addDays(pb, -orderLeadDays)
      }
    }
    // 2本立ての場合は遅い方の完成日・2本分の歩留まりを基準に次回以降を連鎖させる
    const chainCompletion = pairCompletionDate && pairCompletionDate > completionDate
      ? pairCompletionDate : completionDate
    const chainYieldKg    = pairBrewDate ? batchYieldKg * 2 : batchYieldKg

    currentEstimate   = actualFermentDays
    minNextBrewDate   = addDays(pairBrewDate ?? brewDate, 1)
    // バッファ不足時は間隔を詰められる下限（stock/refDateはこの時点ではまだ前バッチ基準）
    minNextCompletion = calcMinNextCompletion(chainCompletion, stock, refDate, chainYieldKg, safeBuffer, getDailyRateFn, supplyEvents, getSafetyDelta)

    const materialOrderDeadline = addDays(brewDate, -orderLeadDays)
    const daysUntilOrder        = differenceInDays(materialOrderDeadline, today)

    // ── Q10補正なし（サブ・常温かつq10≠1のときのみ） ────────
    let rawBrewDate: Date | undefined
    let rawFermentationDays: number | undefined
    let rawCompletionDate: Date | undefined
    let rawMaterialOrderDeadline: Date | undefined
    if (getCompletionRaw) {
      let rawProv: Date
      if (manualBrewDateByIndex?.[i]) {
        rawProv = manualBrewDateByIndex[i]
        // 手動指定日が当日以前の場合も翌日以降に修正（elseブランチと統一）
        if (rawProv < minBrewDate) {
          rawProv = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
        }
      } else {
        // Q10補正ありと同様に、不動点反復で仕込み日の季節に合った熟成日数へ収束させる
        rawProv = refineBrewDateToStockOut(rawStockOutDate, rawCurrentEstimate, safeBuffer, getCompletionRaw, snapBrewDate)
        if (rawProv < minBrewDate) {
          rawProv = snapBrewDate ? snapBrewDate(minBrewDate) : minBrewDate
        }
      }
      // rawBrewDateも昇順を保証
      if (rawProv < minNextRawBrewDate) {
        rawProv = snapBrewDate ? snapBrewDate(minNextRawBrewDate) : minNextRawBrewDate
      }
      rawBrewDate = rawProv
      let rr = getCompletionRaw(rawBrewDate)
      // Q10補正ありと同様に、カバー期間で完成日の密集（仕込み日の団子化）を防ぐ（手動固定回は除く）
      if (rr.completionDate < minNextRawCompletion && !manualBrewDateByIndex?.[i]) {
        const deficit = differenceInDays(minNextRawCompletion, rr.completionDate)
        rawBrewDate = snapBrewDate ? snapBrewDate(addDays(rawBrewDate, deficit)) : addDays(rawBrewDate, deficit)
        rr          = getCompletionRaw(rawBrewDate)
        let guard   = 0
        while (rr.completionDate < minNextRawCompletion && guard < 60) {
          rawBrewDate = snapBrewDate ? snapBrewDate(addDays(rawBrewDate, 1)) : addDays(rawBrewDate, 1)
          rr          = getCompletionRaw(rawBrewDate)
          guard++
        }
      }
      minNextRawBrewDate       = addDays(rawBrewDate, 1)
      rawFermentationDays      = rr.days
      rawCompletionDate        = rr.completionDate
      rawCurrentEstimate       = rawFermentationDays   // 次回の推定に実績値を使う
      minNextRawCompletion     = calcMinNextCompletion(rawCompletionDate, rawStock, rawRefDate, batchYieldKg, safeBuffer, getDailyRateFn, supplyEvents, getSafetyDelta)
      rawMaterialOrderDeadline = addDays(rawBrewDate, -orderLeadDays)
    }

    batches.push({
      n: i + 1, brewDate, completionDate, fermentationDays: actualFermentDays,
      stockOutDate, materialOrderDeadline, daysUntilOrder, startStockKg,
      rawFermentationDays, rawCompletionDate, rawBrewDate, rawMaterialOrderDeadline,
      pairBrewDate, pairCompletionDate, pairFermentationDays, pairMaterialOrderDeadline,
      decidedBy,
    })

    // 在庫引き継ぎはQ10補正ありの完成日を基準にする（月別変動レートで積分 + 熟成中ロット補充分を加算）
    // 2本立ての回は遅い方の完成日まで進め、2本分の歩留まりを加算する
    const consumed       = computeConsumed(refDate, chainCompletion, getDailyRateFn)
    const supplyReceived = computeSupplyReceived(refDate, chainCompletion, supplyEvents)
    refDate = chainCompletion
    stock   = Math.max(0, stock - consumed + supplyReceived) + chainYieldKg
    // Q10補正なしチェーンも独立して在庫を前進させる（2本立ての歩留まりは同じく2本分）
    if (rawCompletionDate) {
      const rawConsumed       = computeConsumed(rawRefDate, rawCompletionDate, getDailyRateFn)
      const rawSupplyReceived = computeSupplyReceived(rawRefDate, rawCompletionDate, supplyEvents)
      rawRefDate = rawCompletionDate
      rawStock   = Math.max(0, rawStock - rawConsumed + rawSupplyReceived) + chainYieldKg
    }
  }

  // 仕込み日昇順で並び替えて回数を振り直す（理論上は既に単調増加だが念のため）
  return batches
    .sort((a, b) => a.brewDate.getTime() - b.brewDate.getTime())
    .map((b, i) => ({ ...b, n: i + 1 }))
}

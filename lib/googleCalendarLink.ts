import { differenceInDays, format } from 'date-fns'

// カレンダー（Google Calendar）のID。完成予定日と仕込み予定日でカレンダーを分けている
const AGING_CALENDAR_ID = '1734b91d3702c0f7c7d08184672490495ec6ab8c74ffac171de070f577610d88@group.calendar.google.com'  // 「熟成完了日」
const BREW_CALENDAR_ID  = '9933b20e587eccf0c47ee15c5eb2598d4700e3b7c0375692e1ee446f037ddd97@group.calendar.google.com'  // 「仕込予定日」

export const MISO_ABBR: Record<string, string> = {
  '無添加麦みそ': '無添加',
  '田舎みそ':     '田舎',
  '山吹みそ':     '山吹',
  '白みそ':       '白',
}

// 数字を丸数字（①〜㊿）に変換。範囲外はそのまま返す
export function toCircledNumber(n: number): string {
  if (n >= 1  && n <= 20) return String.fromCodePoint(0x2460 + n - 1)       // ①〜⑳
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21)      // ㉑〜㉟
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36)      // ㊱〜㊿
  return String(n)
}

// "9・10" のような桶番号文字列を丸数字に変換（"⑨⑩"）
export function circledBucketNumbers(bucketNumbers: string | null): string {
  return (bucketNumbers ?? '')
    .split('・')
    .map(n => {
      const num = parseInt(n, 10)
      return Number.isNaN(num) ? n : toCircledNumber(num)
    })
    .join('')
}

// 予定名。カレンダーのリンクでもICSの一括書き出しでも同じ書式を使う
// 完成予定日：「無添加⑨⑩（9/16仕込 熟成41日）」
export function completionEventTitle(
  misoType: string, bucketNumbers: string | null, brewDate: Date, targetDate: Date,
): string {
  const abbr = MISO_ABBR[misoType] ?? misoType.replace('みそ', '')
  return `${abbr}${circledBucketNumbers(bucketNumbers)}`
    + `（${format(brewDate, 'M/d')}仕込 熟成${differenceInDays(targetDate, brewDate)}日）`
}

// 仕込み予定日：「田舎⑤⑥仕込」
export function brewEventTitle(misoType: string, bucketNumbers: string | null): string {
  const abbr = MISO_ABBR[misoType] ?? misoType.replace('みそ', '')
  return `${abbr}${circledBucketNumbers(bucketNumbers)}仕込`
}

// Googleカレンダーへの予定追加リンクを作る（終日イベント。end は翌日を指定する仕様）
export function buildGoogleCalendarUrl(opts: {
  misoType:      string
  bucketNumbers: string | null
  brewDate:      Date
  targetDate:    Date        // 完成日 or 完成予定日
  detailsExtra?: string      // 詳細欄に追加する行（例: 目標積算温度）
  isActual?:     boolean     // true=実際の完成日、false/未指定=完成予定日
}): string {
  const { misoType, bucketNumbers, brewDate, targetDate, detailsExtra, isActual } = opts
  const endDate = new Date(targetDate)
  endDate.setDate(endDate.getDate() + 1)
  const toYmd = (d: Date) => format(d, 'yyyyMMdd')
  const label = isActual ? '完成日' : '完成予定日'
  const details = `${label}：${format(targetDate, 'yyyy/MM/dd')}` + (detailsExtra ? `\n${detailsExtra}` : '')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: completionEventTitle(misoType, bucketNumbers, brewDate, targetDate),
    dates: `${toYmd(targetDate)}/${toYmd(endDate)}`,
    details,
    src: AGING_CALENDAR_ID,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

// 仕込み予定日をGoogleカレンダーに入れるリンクを作る（終日イベント）。
// 完成予定日のリンク（buildGoogleCalendarUrl）と対になるもので、
// 仮登録リストから「その日に何を仕込むか」を先に押さえるために使う
export function buildBrewPlanCalendarUrl(opts: {
  misoType:        string
  bucketNumbers:   string | null
  brewDate:        Date
  completionDate?: Date | null   // 分かっていれば詳細欄に完成予定日を添える
}): string {
  const { misoType, bucketNumbers, brewDate, completionDate } = opts
  const endDate = new Date(brewDate)
  endDate.setDate(endDate.getDate() + 1)
  const toYmd = (d: Date) => format(d, 'yyyyMMdd')
  const details = `仕込み予定日：${format(brewDate, 'yyyy/MM/dd')}`
    + (completionDate
        ? `
完成予定日：${format(completionDate, 'yyyy/MM/dd')}（熟成${differenceInDays(completionDate, brewDate)}日）`
        : '')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    // 予定名の規則は「田舎⑤⑥仕込」（品種略称＋桶番号の丸数字＋仕込）
    text: brewEventTitle(misoType, bucketNumbers),
    dates: `${toYmd(brewDate)}/${toYmd(endDate)}`,
    details,
    src: BREW_CALENDAR_ID,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

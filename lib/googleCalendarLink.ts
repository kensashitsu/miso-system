import { differenceInDays, format } from 'date-fns'

// 「熟成完了日」カレンダー（Google Calendar）のID
const AGING_CALENDAR_ID = '1734b91d3702c0f7c7d08184672490495ec6ab8c74ffac171de070f577610d88@group.calendar.google.com'

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
  const agingDays = differenceInDays(targetDate, brewDate)
  const label = isActual ? '完成日' : '完成予定日'
  const details = `${label}：${format(targetDate, 'yyyy/MM/dd')}` + (detailsExtra ? `\n${detailsExtra}` : '')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${MISO_ABBR[misoType] ?? misoType.replace('みそ', '')}${circledBucketNumbers(bucketNumbers)}（${format(brewDate, 'M/d')}仕込 熟成${agingDays}日）`,
    dates: `${toYmd(targetDate)}/${toYmd(endDate)}`,
    details,
    src: AGING_CALENDAR_ID,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

// Googleカレンダーへ一括で取り込むための ICS（iCalendar）を組み立てる。
//
// 予定を1件ずつカレンダーの追加画面で保存するのが煩わしいため、仮登録リストから
// まとめて1ファイルを出し、Googleカレンダーの「設定 → インポート」で読み込む。
// UID を仮登録のIDから作っているので、日付を直して入れ直すと重複せず上書きされる。

export type IcsEvent = {
  uid:          string   // 予定の一意キー（再インポート時の上書きに使う）
  date:         Date     // 終日予定の日付
  summary:      string
  description?: string
}

// ICSの特殊文字をエスケープ（バックスラッシュ・カンマ・セミコロン・改行）
function esc(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

// 1行75オクテットで折り返す（日本語があるのでバイト数で数える。
// 継続行は行頭に空白を1つ置く決まり）
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: string[] = []
  let chunk = ''
  let len = 0
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length
    // 継続行は先頭の空白1バイト分を差し引く
    const limit = out.length === 0 ? 75 : 74
    if (len + size > limit) {
      out.push(chunk)
      chunk = ''
      len = 0
    }
    chunk += ch
    len += size
  }
  if (chunk) out.push(chunk)
  return out.map((c, i) => (i === 0 ? c : ` ${c}`)).join('\r\n')
}

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

const stampUtc = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  + `T${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`

export function buildIcs(events: IcsEvent[], calendarName: string): string {
  const now = stampUtc(new Date())
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//miso-system//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${esc(calendarName)}`),
  ]
  for (const ev of events) {
    const end = new Date(ev.date)
    end.setDate(end.getDate() + 1)   // 終日予定のDTENDは翌日を指す
    lines.push(
      'BEGIN:VEVENT',
      fold(`UID:${ev.uid}`),
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${ymd(ev.date)}`,
      `DTEND;VALUE=DATE:${ymd(end)}`,
      fold(`SUMMARY:${esc(ev.summary)}`),
      ...(ev.description ? [fold(`DESCRIPTION:${esc(ev.description)}`)] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

// 組み立てたICSをその場でダウンロードさせる（ブラウザのみ）
export function downloadIcs(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

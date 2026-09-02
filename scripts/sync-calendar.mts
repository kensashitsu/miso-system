// 仕込み予定・完成予定をGoogleカレンダーへ同期する（GitHub Actionsから毎日実行）。
//
// 実行: npx tsx scripts/sync-calendar.mts
// 必要な環境変数: DATABASE_URL / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY
import * as syncNs from '../lib/calendarSync'

const merge = (ns: unknown): Record<string, any> => {
  const n = ns as Record<string, any>
  return { ...n, ...(typeof n.default === 'object' ? n.default : {}) }
}
const { syncPlansToCalendar } = merge(syncNs)

const r = await syncPlansToCalendar()
console.log('仕込予定日:', r.brew)
console.log('熟成完了日:', r.aging)

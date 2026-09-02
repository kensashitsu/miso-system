'use server'

import { hasCalendarCredentials } from '@/lib/googleCalendar'
import { syncPlansToCalendar } from '@/lib/calendarSync'

// 仮登録リストの「カレンダーに同期」ボタンから呼ぶ。
// 毎日のGitHub Actionsでも同じ処理を走らせているが、仮登録した直後に
// 反映を確認したい場面があるため手動でも叩けるようにしている
export async function syncCalendarNow(): Promise<{ ok: boolean; message: string }> {
  if (!hasCalendarCredentials()) {
    return { ok: false, message: 'Googleカレンダー連携が未設定です（サービスアカウントの環境変数がありません）' }
  }
  try {
    const r = await syncPlansToCalendar()
    const line = (label: string, x: { created: number; updated: number; deleted: number }) =>
      `${label} 追加${x.created}・更新${x.updated}・削除${x.deleted}`
    return { ok: true, message: `${line('仕込予定日', r.brew)} / ${line('熟成完了日', r.aging)}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '同期に失敗しました' }
  }
}

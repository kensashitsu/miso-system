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
    // 差分だけだと「全部0」で何も起きなかったように見えるので、同期後の件数を主役にする
    const line = (label: string, x: { total: number; created: number; updated: number; deleted: number }) => {
      const diff = [
        x.created ? `追加${x.created}` : '',
        x.updated ? `更新${x.updated}` : '',
        x.deleted ? `削除${x.deleted}` : '',
      ].filter(Boolean).join('・')
      return `${label} ${x.total}件${diff ? `（${diff}）` : ''}`
    }
    const noChange = r.brew.created + r.brew.updated + r.brew.deleted
      + r.aging.created + r.aging.updated + r.aging.deleted === 0
    return {
      ok: true,
      message: `${line('仕込予定日', r.brew)} ／ ${line('熟成完了日', r.aging)}`
        + (noChange ? '（変更なし・すでに最新でした）' : ''),
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '同期に失敗しました' }
  }
}

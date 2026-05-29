'use server'

import { revalidatePath } from 'next/cache'

// GitHub Actions workflow_dispatch でSARIMAX予測を起動する
// 実行はGitHub Actions側（Ubuntu + Python）で行い、結果はSupabaseに直接書き込まれる

type ForecastResult =
  | { ok: true;  message: string; updatedAt: string }
  | { ok: false; message: string }

const REPO          = 'kensashitsu/miso-system'
const WORKFLOW_FILE = 'forecast.yml'

export async function runSarimaxForecast(): Promise<ForecastResult> {
  const token = process.env.GH_PAT
  if (!token) {
    return { ok: false, message: 'GH_PAT が未設定です（Vercel環境変数に追加してください）' }
  }

  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main' }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, message: `GitHub API エラー (${res.status}): ${text.slice(0, 200)}` }
  }

  // 204 No Content が成功レスポンス
  // 予測完了まで数分かかるため、ページキャッシュは少し遅延して無効化
  setTimeout(() => revalidatePath('/planning'), 5 * 60 * 1000)

  const updatedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  return {
    ok:      true,
    message: 'GitHub Actions でSARIMAX予測ジョブを開始しました。完了まで数分かかります。GitHubのActionsタブで進捗を確認できます。',
    updatedAt,
  }
}

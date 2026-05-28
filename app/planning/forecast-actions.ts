'use server'

import { execFile } from 'child_process'
import path from 'path'
import { revalidatePath } from 'next/cache'

// Server Action: SARIMAX予測スクリプトを実行してForecastCacheを更新する

type ForecastResult =
  | { ok: true;  message: string; updatedAt: string }
  | { ok: false; message: string }

export async function runSarimaxForecast(): Promise<ForecastResult> {
  // 環境変数からPythonパスを取得（なければシステムのpythonを使用）
  const pythonPath  = process.env.PYTHON_PATH ?? 'python'
  const scriptPath  = path.join(process.cwd(), 'scripts', 'forecast_sarimax.py')
  const timeoutMs   = 3 * 60 * 1000 // 3分

  return new Promise(resolve => {
    execFile(
      pythonPath,
      [scriptPath],
      { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
      (error, stdout, stderr) => {
        // stderrはログとして記録（エラーではなく進捗出力）
        if (stderr) {
          console.log('[forecast_sarimax stderr]', stderr)
        }

        if (error) {
          const msg = error.killed
            ? '予測処理がタイムアウトしました（3分）'
            : `予測スクリプトエラー: ${error.message}`
          console.error('[forecast_sarimax error]', error)
          resolve({ ok: false, message: msg })
          return
        }

        // stdoutからJSONを取得
        const rawOutput = stdout.trim()
        if (!rawOutput) {
          resolve({ ok: false, message: 'スクリプトから出力がありませんでした' })
          return
        }

        try {
          const parsed = JSON.parse(rawOutput) as {
            ok:    boolean
            types?: string[]
            mape?:  Record<string, number | null>
            error?: string
          }

          if (!parsed.ok) {
            resolve({ ok: false, message: parsed.error ?? '予測処理に失敗しました' })
            return
          }

          const types     = (parsed.types ?? []).join('、')
          const mapeLines = Object.entries(parsed.mape ?? {})
            .map(([type, val]) => `${type}: ${val != null ? `${val.toFixed(1)}%` : '—'}`)
            .join(' / ')

          const message = `更新完了（${types}）MAPE: ${mapeLines}`
          const updatedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })

          // 仕込み計画ページのキャッシュを無効化
          revalidatePath('/planning')

          resolve({ ok: true, message, updatedAt })
        } catch {
          resolve({ ok: false, message: `JSON解析エラー: ${rawOutput.slice(0, 200)}` })
        }
      },
    )
  })
}

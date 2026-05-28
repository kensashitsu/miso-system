/**
 * アカウント名 → Supabase登録メールアドレスの対応表（サーバーサイドのみ）
 * ユーザーを追加・変更する場合はここを編集してください。
 * アカウント名は小文字で統一（ログイン時に自動で小文字変換）。
 */
export const USERNAME_EMAIL_MAP: Record<string, string> = {
  admin: 'support@mitsuura.jp',
}

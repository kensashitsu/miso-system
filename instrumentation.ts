// サーバーの実行タイムゾーンを JST に固定する。
//
// Vercel のランタイムは既定で UTC のため、そのままだと日本時間の 0:00〜9:00 の間は
// サーバーが「前日」を今日として扱ってしまい、ダッシュボードの経過日数・完成間近（7日以内）
// 判定・積算温度の終端日・安全在庫ラインの季節判定が1日ずれる。
// また、日付をブラウザ側（JST）で計算しているロットカードと表示が食い違う。
// Node は process.env.TZ への代入で以後の Date を切り替えるため、ここで固定する。
// 別のタイムゾーンで動かしたい場合のみ環境変数 APP_TZ で上書きする。
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  process.env.TZ = process.env.APP_TZ || 'Asia/Tokyo'
}

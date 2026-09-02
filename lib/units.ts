// 種水の単位換算（ℓ ⇄ 斗）。
// 現場は一斗缶（18ℓ）で数えるため 1斗 = 18ℓ とする（尺貫法の正確な1斗=18.039ℓではない）。
// ロット登録フォームとロット詳細の編集フォームで同じ換算を使う。
export const LITERS_PER_TO = 18

// ℓ → 斗（表示用・小数2桁まで）。空や数値でないものは空文字
export function litersToToText(liters: string): string {
  const l = Number(liters)
  if (!liters || Number.isNaN(l) || l === 0) return ''
  return String(Math.round((l / LITERS_PER_TO) * 100) / 100)
}

// 斗 → ℓ（保存用・小数1桁まで）。空や数値でないものは空文字
export function toToLitersText(to: string): string {
  const t = Number(to)
  if (!to || Number.isNaN(t)) return ''
  return String(Math.round(t * LITERS_PER_TO * 10) / 10)
}

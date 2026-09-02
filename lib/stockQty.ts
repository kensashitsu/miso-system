// 在庫システム（zaiko）へ送るみその量（kg）。
//
// 歩留まりから計算した実量（例: 1,682kg）をそのまま送ると、zaiko側でレシピ展開される
// 原材料のマイナスが毎回半端な数（-27.34袋 / -9.46袋 …）になってしまうため、
// 品種ごとに決めた固定量を送る（2026-09-02 ユーザー指示）。
//
// ここに無い品種（白みそなど）は従来どおり計算した実量を送る。
// 本システム内部の在庫（桶残量・熟成中の集計）は実量のままで、これはzaikoへ送る量だけの話。
export const FIXED_STOCK_SEND_KG: Record<string, number> = {
  '田舎みそ':     1600,
  '無添加麦みそ': 1600,
  '山吹みそ':     1300,
}

export function stockSendKg(misoType: string, calculatedKg: number): number {
  return FIXED_STOCK_SEND_KG[misoType] ?? calculatedKg
}

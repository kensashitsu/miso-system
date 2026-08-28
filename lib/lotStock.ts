// 熟成中ロットの在庫量（kg）の数え方を1箇所にまとめる。
//
// 以前はダッシュボード・仕込み計画・ロットカード・月末スナップショット（Python）の
// 4箇所でルールが少しずつ違っていた（桶レコードが無いロットを0kgとするか仕立量とするか、
// 「待機中」の桶に残量と初期重量のどちらを使うか、「空」の桶を除外するかどうか）。

export type BucketLike = {
  status:            string
  remainingWeightKg: number | null
  initialWeightKg:   number
}

// 桶1つの現在残量。「空」は0、残量が未入力（待機中など）なら初期重量とみなす
export function bucketRemainingKg(status: string, remainingKg: number | null, initialKg: number): number {
  if (status === '空') return 0
  return remainingKg ?? initialKg
}

// ロット1件の熟成中在庫。桶レコードが無いロットは仕立量×歩留まりで概算する
// （桶の初期重量と同じ作り方。ロット固有の歩留まりがあればそれを優先）
export function fermentingKgOfLot(
  lot: { buckets: BucketLike[]; totalWeightKg: number; yieldRate?: number | null },
  defaultYieldRate: number,
): number {
  if (lot.buckets.length > 0) {
    return lot.buckets.reduce(
      (sum, b) => sum + bucketRemainingKg(b.status, b.remainingWeightKg, b.initialWeightKg),
      0,
    )
  }
  return Math.floor(lot.totalWeightKg * (lot.yieldRate ?? defaultYieldRate))
}

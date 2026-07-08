# 【改修依頼】在庫調整プレビューAPIの追加（適用なしの試算）

- 依頼元: みそ熟成・仕込み計画管理システム（miso-system）
- 依頼先: zaiko.mitsuura.jp 開発者
- 依頼日: 2026-07-09
- 前提: レシピ連動対応（applyRecipe）は対応済み・動作確認済み。ありがとうございました

---

## 背景

熟成管理システムのロット登録・削除の確認画面に、半製品だけでなく
**原材料の使用前後の数量**（zaikoの在庫登録モーダルに出る「0 −26 → −26 袋」のような表示）
を出したいと考えています。

そのためには「実行した場合に原材料がどう動くか」を**在庫を変更せずに**取得する
手段が必要なため、プレビュー用のエンドポイントを1つ追加してください。

## 依頼内容

在庫調整APIのプレビュー版 POST エンドポイントを追加してください。
URLは任意で構いません（こちらの環境変数 `STOCK_ADJUST_PREVIEW_API_URL` に設定します）。
例: `POST https://seizou.mitsuura.jp/api/stock/adjust/preview`

- **認証・リクエストボディ**: 既存の在庫調整API（`/api/stock/adjust`）と完全に同一
- **動作**: 在庫を一切変更せず、実行した場合の結果だけを計算して返す（読み取り専用）
- **レスポンス**: 既存の在庫調整APIと同じ形式。ただし `consumedMaterials` の各要素に
  原材料在庫の前後値 **`stockBefore` / `stockAfter`**（単位は `unit` と同じ）を追加してください

### レスポンス例

```json
{
  "ok": true,
  "misoType": "無添加麦みそ",
  "category": "wip",
  "itemName": "【半製品】無添加麦みそ（熟成中）",
  "stockBefore": 1639,
  "stockAfter": 1739,
  "appliedDeltaKg": 100,
  "recipeApplied": true,
  "consumedMaterials": [
    {
      "name": "山口県産裸麦25kg",
      "quantity": 1.63,
      "unit": "袋",
      "stockBefore": 10,
      "stockAfter": 8.37
    }
  ]
}
```

## 呼び出しタイミング

熟成管理システムのロット登録・削除の確認画面を開いたときに呼び出します。
`applyRecipe: true` 固定・`deltaKg` は登録時が正、削除時が負です。
実際の在庫変更は従来どおり本体API（`/api/stock/adjust`）で行います。

## 補足

- こちら側の実装は完了済みです。エンドポイントのURLをいただければ
  環境変数に設定するだけで表示が有効になります（未設定の間は従来表示のまま）
- 可能であれば、本体APIの `consumedMaterials` にも同じ `stockBefore` / `stockAfter` を
  追加していただけると将来のログ表示に使えますが、必須ではありません

## 問い合わせ先

不明点は support@mitsuura.jp まで。

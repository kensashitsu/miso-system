// 業務用小分けみその品目マスタ（2026-09-10）
//
// zaiko 側に品目一覧APIができるまでの暫定。できたらこのファイルは差し替える
// （依頼書: docs/zaiko-api-packaging.md の「③ 品目一覧API」）。
//
// code は zaiko の在庫登録モーダル見出しの括弧内の番号
// （例:「田舎みそ（ｽﾘ）20K桶入 (800895)」→ 800895）。
// ★ code が空の品目は zaiko へ送れない（記録は残り「未送信」で溜まる）。
//   zaiko で品目を開いて番号を控え、ここに追記すること。
export interface PackingItem {
  code:      string   // zaiko 品目コード（空 = 未調査）
  name:      string   // zaiko の品名（表示にも使う）
  short:     string   // 入力画面のボタンに出す短い名前
  unit:      string   // 在庫単位（丁・個）
  kgPerUnit: number   // 1単位あたりのkg
  misoType:  string   // 本システムの品種名
}

export const PACKING_ITEMS: PackingItem[] = [
  // 田舎みそ（ｽﾘ）
  { code: '',       name: '田舎みそ（ｽﾘ）1kg',     short: 'ｽﾘ 1kg',  unit: '個', kgPerUnit: 1,  misoType: '田舎みそ' },
  { code: '',       name: '田舎みそ（ｽﾘ）2K桶入',  short: 'ｽﾘ 2K桶', unit: '丁', kgPerUnit: 2,  misoType: '田舎みそ' },
  { code: '',       name: '田舎みそ（ｽﾘ）4K桶入',  short: 'ｽﾘ 4K桶', unit: '丁', kgPerUnit: 4,  misoType: '田舎みそ' },
  { code: '',       name: '田舎みそ（ｽﾘ）8K桶入',  short: 'ｽﾘ 8K桶', unit: '丁', kgPerUnit: 8,  misoType: '田舎みそ' },
  { code: '',       name: '田舎みそ（ｽﾘ）10K桶入', short: 'ｽﾘ 10K桶',unit: '丁', kgPerUnit: 10, misoType: '田舎みそ' },
  { code: '800895', name: '田舎みそ（ｽﾘ）20K桶入', short: 'ｽﾘ 20K桶',unit: '丁', kgPerUnit: 20, misoType: '田舎みそ' },
  // 田舎みそ（粒）
  { code: '',       name: '田舎みそ（粒）2kg袋入',  short: '粒 2kg袋', unit: '個', kgPerUnit: 2,  misoType: '田舎みそ' },
  { code: '',       name: '田舎みそ（粒）20K桶入',  short: '粒 20K桶', unit: '丁', kgPerUnit: 20, misoType: '田舎みそ' },
  // 山吹みそ
  { code: '',       name: '山吹みそ　4K桶入',      short: '4K桶',    unit: '丁', kgPerUnit: 4,  misoType: '山吹みそ' },
  { code: '',       name: '山吹みそ　8K桶入',      short: '8K桶',    unit: '丁', kgPerUnit: 8,  misoType: '山吹みそ' },
  { code: '',       name: '山吹みそ　10K桶入',     short: '10K桶',   unit: '丁', kgPerUnit: 10, misoType: '山吹みそ' },
  { code: '',       name: '山吹みそ　20K桶入',     short: '20K桶',   unit: '丁', kgPerUnit: 20, misoType: '山吹みそ' },
  // 無添加麦みそ
  { code: '',       name: '無添加　麦みそ　10K桶入', short: '10K桶',  unit: '丁', kgPerUnit: 10, misoType: '無添加麦みそ' },
]

export function findPackingItem(name: string): PackingItem | undefined {
  return PACKING_ITEMS.find(i => i.name === name)
}

// 小分けの登録先は常に「調味料工場倉庫」（2026-09-10 ユーザー確認）。
// 他ロケーションへの登録は従来どおり zaiko の画面で行う。
export const PACKING_LOCATION = '調味料工場倉庫'

// 仕込帳データ.xlsx の「熟成日数」列など、数式が入っているセルの参照行が
// 自分の行からズレていないか（コピペ・行挿入によるずれ）を全シートでチェックする。
// sheet_to_json は計算済みの値しか見えないため、ここでは生のセル(.f プロパティ)を直接読む。
// 実行: node scripts/validate-shikomicho-formulas.mjs
import XLSX from 'xlsx'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const filePath = path.join(__dirname, '..', 'data', 'shikomicho', '仕込帳データ.xlsx')
const wb = XLSX.readFile(filePath, { cellFormula: true })

function colToNum(col) {
  let n = 0
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

let totalFlagged = 0

for (const name of wb.SheetNames) {
  if (name === 'Sheet1') continue
  const ws = wb.Sheets[name]
  const ref = ws['!ref']
  if (!ref) continue
  const range = XLSX.utils.decode_range(ref)

  const flagged = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const rowNum = r + 1 // Excel上の行番号（1始まり）
    if (rowNum === 1) continue // ヘッダー行はスキップ
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      if (!cell || !cell.f) continue
      const formula = cell.f
      // SUM(A1:A10)のような範囲集計式は複数行を跨ぐのが正常なので対象外
      if (formula.includes(':')) continue
      // 数式内に出てくるセル参照（例: C22, $B$21）を全部抜き出し、1つでも自分の行と違う行を参照していれば疑わしいとする
      // （この帳簿は基本的に「その行の他列」だけを参照する行内完結の数式のため）
      const refs = [...formula.matchAll(/\$?([A-Z]{1,2})\$?(\d+)/g)]
      if (refs.length === 0) continue
      const mismatchedRefs = refs.filter(([, , refRowStr]) => Number(refRowStr) !== rowNum)
      if (mismatchedRefs.length > 0) {
        flagged.push({ addr, formula, rowNum, refs: refs.map(m => m[0]), mismatched: mismatchedRefs.map(m => m[0]) })
      }
    }
  }
  if (flagged.length > 0) {
    console.log(`\n=== ${name} : ${flagged.length}件の疑わしい数式 ===`)
    for (const f of flagged) {
      console.log(`  ${f.addr} (行${f.rowNum})\t=${f.formula}\t参照: ${f.refs.join(', ')}\tズレ: ${f.mismatched.join(', ')}`)
    }
    totalFlagged += flagged.length
  }
}

console.log(`\n合計: ${totalFlagged}件の疑わしい数式`)

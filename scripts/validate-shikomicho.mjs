// 仕込帳データ.xlsx の「熟成日数」列(D)が「熟成完了日(C) - 仕込日(B)」と一致しているか全行検証する。
// 実行: node scripts/validate-shikomicho.mjs
import XLSX from 'xlsx'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const filePath = path.join(__dirname, '..', 'data', 'shikomicho', '仕込帳データ.xlsx')
const wb = XLSX.readFile(filePath)

function excelDateToJs(serial) {
  if (typeof serial !== 'number') return null
  return new Date(Math.round((serial - 25569) * 86400 * 1000))
}
function diffDays(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}

let totalMismatch = 0
let totalChecked = 0

for (const name of wb.SheetNames) {
  if (name === 'Sheet1') continue
  const ws = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
  if (rows.length < 2) continue
  const header = rows[0].map(h => (typeof h === 'string' ? h.replace(/\s|\r|\n/g, '') : h))
  const idxBrew = header.indexOf('仕込日')
  const idxDone = header.indexOf('熟成完了日')
  const idxDays = header.indexOf('熟成日数')
  if (idxBrew === -1 || idxDone === -1 || idxDays === -1) continue

  const mismatches = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r[idxBrew] == null || r[idxDone] == null || r[idxDays] == null) continue
    const brewDate = excelDateToJs(r[idxBrew])
    const doneDate = excelDateToJs(r[idxDone])
    const storedDays = r[idxDays]
    if (!brewDate || !doneDate || typeof storedDays !== 'number') continue
    const actualDays = diffDays(doneDate, brewDate)
    totalChecked++
    if (actualDays !== storedDays) {
      totalMismatch++
      mismatches.push({
        excelRow: i + 1, // シート上の行番号（ヘッダーが1行目）
        brewDate: brewDate.toISOString().slice(0, 10),
        doneDate: doneDate.toISOString().slice(0, 10),
        storedDays,
        actualDays,
        diff: storedDays - actualDays,
      })
    }
  }
  if (mismatches.length > 0) {
    console.log(`\n=== ${name} : ${mismatches.length}件の不一致 ===`)
    for (const m of mismatches) {
      console.log(`  行${m.excelRow}\t仕込${m.brewDate}\t完了${m.doneDate}\t記載${m.storedDays}日\t実際${m.actualDays}日\t差${m.diff > 0 ? '+' : ''}${m.diff}`)
    }
  }
}

console.log(`\n検証行数: ${totalChecked}件中 ${totalMismatch}件が不一致`)

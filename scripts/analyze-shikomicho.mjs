// 仕込帳データ.xlsx から実際の熟成日数（使用開始日ではなく「熟成完了日」列ベース）を集計する分析スクリプト。
// 暖房期の月別補正係数の再較正に使う。実行: node scripts/analyze-shikomicho.mjs
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

const results = []
for (const name of wb.SheetNames) {
  if (name === 'Sheet1') continue
  const ws = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
  if (rows.length < 2) continue
  const header = rows[0].map(h => (typeof h === 'string' ? h.replace(/\s|\r|\n/g, '') : h))
  const idxBrew = header.indexOf('仕込日')
  const idxDone = header.indexOf('熟成完了日')
  const idxDays = header.indexOf('熟成日数')
  const idxType = header.indexOf('品種')
  if (idxBrew === -1 || idxDone === -1 || idxDays === -1) continue
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r[idxBrew] == null || r[idxDone] == null) continue
    const brewDate = excelDateToJs(r[idxBrew])
    const days = r[idxDays]
    if (!brewDate || typeof days !== 'number') continue
    results.push({ brewDate, days, misoType: r[idxType] })
  }
}

const target = results.filter(r => r.misoType === '田舎' || r.misoType === '無添加')

const byMonth = {}
for (const r of target) {
  const m = r.brewDate.getMonth() + 1
  ;(byMonth[m] ??= []).push(r.days)
}

console.log('月別 熟成日数（田舎・無添加、全期間）:')
const TARGET_TEMP_SUM = 600
for (let m = 1; m <= 12; m++) {
  const arr = (byMonth[m] ?? []).sort((a, b) => a - b)
  if (arr.length === 0) { console.log(`${m}月: データなし`); continue }
  const mid  = arr[Math.floor(arr.length / 2)]
  const avg  = arr.reduce((a, b) => a + b, 0) / arr.length
  const rate = TARGET_TEMP_SUM / mid
  console.log(`${m}月: 件数${arr.length}\t平均${avg.toFixed(1)}日\t中央値${mid}日\t範囲${arr[0]}-${arr[arr.length-1]}\t逆算レート${rate.toFixed(2)}℃/日`)
}

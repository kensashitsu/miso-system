/**
 * 放冷機パラメータ.xlsx を CoolingRun / CoolingStep に取り込む
 *
 *   npx tsx scripts/import-cooling.mts "C:\Users\user\Desktop\放冷機パラメータ.xlsx" [--dry]
 *
 * エクセルの形：1行目がヘッダー、以降は「日付が入った行」が作業日の先頭で、
 * 日付が空の行は同じ日の2回目・3回目の設定（＝CoolingStep）。
 * 最終2行のように日付がA列（砕米の列）にシリアル値で入ってしまったものも拾う。
 */
import XLSXns from 'xlsx'

const XLSX = ((XLSXns as any).default ?? XLSXns) as typeof XLSXns
import { PrismaClient } from '../lib/generated/prisma'
import * as coolingNs from '../lib/cooling'

// このプロジェクトのスクリプトは lib/* を名前空間importで読む（名前付きexportがそのまま出ない）
const cooling = { ...(coolingNs as Record<string, any>), ...((coolingNs as any).default ?? {}) }
const parseProductTemp = cooling.parseProductTemp as typeof coolingNs.parseProductTemp
const COOLING_TO_BREW_DAYS = cooling.COOLING_TO_BREW_DAYS as number

const prisma = new PrismaClient()

const filePath = process.argv[2]
const dryRun   = process.argv.includes('--dry')
if (!filePath) {
  console.error('使い方: npx tsx scripts/import-cooling.mts <放冷機パラメータ.xlsx> [--dry]')
  process.exit(1)
}

/** UTCの0時に揃えた日付（DBのbrewedAtと同じ持ち方） */
function utcDate(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m, d))
}

/** Excelのシリアル値（1900年基準）を日付に */
function fromSerial(serial: number) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000
  const d = new Date(ms)
  return utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const m = String(v).replace(/[０-９．]/g, c => c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  const n = Number(m)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

type StepInput = {
  sortOrder: number
  fan: number | null
  belt: number | null
  productTempMin: number | null
  productTempMax: number | null
  productTempRaw: string | null
  memo: string | null
}
type RunInput = {
  runDate: Date
  grainType: string
  airTemp1FC: number | null
  airTemp2FC: number | null
  roomTempC: number | null
  memo: string | null
  steps: StepInput[]
}

const wb = XLSX.readFile(filePath, { cellDates: true })
const sheet = wb.Sheets[wb.SheetNames[0]]
const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: null })

const runs: RunInput[] = []
let current: RunInput | null = null

for (const row of rows.slice(1)) {
  const [colGrain, colDate, col1F, col2F, colRoom, colFan, colBelt, colTemp, colMemo] = row

  // 日付：B列が本来の位置。入力ミスでA列にシリアル値が入っているものも拾う
  let runDate: Date | null = null
  let grainMark = str(colGrain)
  if (colDate instanceof Date) {
    runDate = utcDate(colDate.getFullYear(), colDate.getMonth(), colDate.getDate())
  } else if (colGrain instanceof Date) {
    // 最終2行のように日付をA列（砕米の列）へ打ってしまったもの
    runDate = utcDate(colGrain.getFullYear(), colGrain.getMonth(), colGrain.getDate())
    grainMark = null
  } else if (typeof colGrain === 'number' && colGrain > 40000) {
    runDate = fromSerial(colGrain)
    grainMark = null
  }

  if (runDate) {
    current = {
      runDate,
      grainType:  grainMark ? '砕米' : '麦',   // 砕米の回だけA列に回数が入っている
      airTemp1FC: num(col1F),
      airTemp2FC: num(col2F),
      roomTempC:  num(colRoom),
      memo:       null,
      steps:      [],
    }
    runs.push(current)
  }
  if (!current) continue

  // 継続行に気温だけ書かれている回がある（作業日側が空のときだけ採用する）
  if (!runDate) {
    if (current.airTemp1FC === null) current.airTemp1FC = num(col1F)
    if (current.airTemp2FC === null) current.airTemp2FC = num(col2F)
    if (current.roomTempC  === null) current.roomTempC  = num(colRoom)
    if (grainMark && !/^\d+$/.test(grainMark)) { /* 砕米マーク以外は無視 */ }
    else if (grainMark) current.grainType = '砕米'
  }

  const fanRaw  = str(colFan)
  const fan     = num(colFan)
  const belt    = num(colBelt)
  const temp    = parseProductTemp(colTemp)
  let   memo    = str(colMemo)

  // 「10～15～20」のように幅で書かれたファン設定は数値にできないので備考へ逃がす
  if (fan === null && fanRaw) memo = memo ? `ファン${fanRaw}／${memo}` : `ファン${fanRaw}`

  if (fan === null && belt === null && temp.raw === null && !memo) continue

  current.steps.push({
    sortOrder: current.steps.length,
    fan, belt,
    productTempMin: temp.min,
    productTempMax: temp.max,
    productTempRaw: temp.raw,
    memo,
  })
}

// 仕込みロットとの紐付け（放冷日の2日後に仕込まれたロット）
const lots = await prisma.lot.findMany({ select: { id: true, lotNumber: true, misoType: true, brewedAt: true } })
const lotsByDate = new Map<string, typeof lots>()
for (const lot of lots) {
  const key = lot.brewedAt.toISOString().slice(0, 10)
  lotsByDate.set(key, [...(lotsByDate.get(key) ?? []), lot])
}
const RICE_TYPES = ['山吹みそ', '白みそ']

function findLot(run: RunInput) {
  const key = new Date(run.runDate.getTime() + COOLING_TO_BREW_DAYS * 86400000).toISOString().slice(0, 10)
  const candidates = lotsByDate.get(key) ?? []
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  // 同じ日に複数仕込んだ日は原料で絞る（砕米＝米を使う品種）
  const byGrain = candidates.filter(l =>
    run.grainType === '砕米' ? RICE_TYPES.includes(l.misoType) : !RICE_TYPES.includes(l.misoType)
  )
  return (byGrain.length === 1 ? byGrain[0] : null)
}

let linked = 0
const unlinked: string[] = []
const ambiguous: string[] = []

for (const run of runs) {
  const lot = findLot(run)
  const dateStr = run.runDate.toISOString().slice(0, 10)
  if (lot) linked++
  else {
    const key = new Date(run.runDate.getTime() + COOLING_TO_BREW_DAYS * 86400000).toISOString().slice(0, 10)
    if ((lotsByDate.get(key) ?? []).length > 1) ambiguous.push(`${dateStr}(${run.grainType})`)
    else unlinked.push(`${dateStr}(${run.grainType})`)
  }
  if (dryRun) continue

  await prisma.$transaction(async tx => {
    const existing = await tx.coolingRun.findUnique({ where: { runDate: run.runDate }, select: { id: true } })
    if (existing) await tx.coolingStep.deleteMany({ where: { runId: existing.id } })
    const saved = await tx.coolingRun.upsert({
      where:  { runDate: run.runDate },
      update: { grainType: run.grainType, airTemp1FC: run.airTemp1FC, airTemp2FC: run.airTemp2FC, roomTempC: run.roomTempC, memo: run.memo, lotId: lot?.id ?? null },
      create: { runDate: run.runDate, grainType: run.grainType, airTemp1FC: run.airTemp1FC, airTemp2FC: run.airTemp2FC, roomTempC: run.roomTempC, memo: run.memo, lotId: lot?.id ?? null },
      select: { id: true },
    })
    if (run.steps.length > 0) {
      await tx.coolingStep.createMany({ data: run.steps.map(s => ({ ...s, runId: saved.id })) })
    }
  })
}

console.log(`${dryRun ? '【試算】' : '取り込み完了：'}放冷 ${runs.length}件 / 設定行 ${runs.reduce((a, r) => a + r.steps.length, 0)}件`)
console.log(`期間: ${runs[0]?.runDate.toISOString().slice(0, 10)} 〜 ${runs.at(-1)?.runDate.toISOString().slice(0, 10)}`)
console.log(`ロット紐付け: ${linked}件`)
if (ambiguous.length) console.log(`同日に複数ロットで絞れず未紐付け: ${ambiguous.join(', ')}`)
if (unlinked.length)  console.log(`2日後にロットが無く未紐付け(${unlinked.length}件): ${unlinked.join(', ')}`)

await prisma.$disconnect()

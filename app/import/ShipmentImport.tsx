'use client'

import { useState, useTransition, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Upload, FileSpreadsheet } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  importShipmentHistory,
  importBrandedShipmentHistory,
  type ImportRow,
  type BrandedImportRow,
  type BrandedImportResult,
} from './actions'

// ── 元号変換 ────────────────────────────────────────────────
const ERA_OFFSETS: Record<string, number> = {
  M: 1867, T: 1911, S: 1925, H: 1988, R: 2018,
}

function toYM(year: number, month: number): string | null {
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

function parseYearMonth(label: unknown): string | null {
  if (typeof label !== 'string') return null
  const s = label.trim()

  // パターン③：西暦4桁　例）2019.01月 / 2020.1月 / 2025.12月
  const m3 = s.match(/^(\d{4})[.\-](\d{1,2})月?$/)
  if (m3) return toYM(parseInt(m3[1]), parseInt(m3[2]))

  // パターン①：元号+年+月　例）H27.3月 / H29.12月 / R6.4月
  const m1 = s.match(/^([MmTtSsHhRr])(\d+)[.\-](\d{1,2})月?$/i)
  if (m1) {
    const offset = ERA_OFFSETS[m1[1].toUpperCase()]
    if (!offset) return null
    return toYM(parseInt(m1[2]) + offset, parseInt(m1[3]))
  }

  // パターン②：元号+.+年+月　例）H.30.2月 / H.30.12月
  const m2 = s.match(/^([MmTtSsHhRr])[.\-](\d+)[.\-](\d{1,2})月?$/i)
  if (m2) {
    const offset = ERA_OFFSETS[m2[1].toUpperCase()]
    if (!offset) return null
    return toYM(parseInt(m2[2]) + offset, parseInt(m2[3]))
  }

  return null
}

// ── 既存データ型 ─────────────────────────────────────────────
export interface ExistingRow {
  yearMonth:  string
  weightKg:   number
  importedAt: string
}

export interface ImportSummaryRow {
  misoType:     string
  count:        number
  minYearMonth: string | null
  maxYearMonth: string | null
}

// ── 品種別シート名マッピング ─────────────────────────────────
const BRAND_SHEETS: Record<string, string> = {
  '無添加麦みそ': '＠無添加麦みそ（総量）',
  '田舎みそ':     '＠田舎みそ （総量）',
  '山吹みそ':     '山吹みそ',
  '白みそ':       '白みそ',
}

// 品種ごとの重量列インデックス（0始まり）
// 田舎みそ・山吹みそは列C（index=2）が合せ込みkg合計
const BRAND_KG_COLUMN: Record<string, number> = {
  '無添加麦みそ': 1,  // 列B
  '田舎みそ':     2,  // 列C（合せ・ビタミン＋）
  '山吹みそ':     2,  // 列C（合せ＋）
  '白みそ':       1,  // 列B
}

// ── コンポーネント ───────────────────────────────────────────
interface ParsedRow extends ImportRow {
  label: string  // 元の表示ラベル（例: H27.3月）
}

interface Props {
  existingData:   ExistingRow[]
  importSummary?: ImportSummaryRow[]
}

export default function ShipmentImport({ existingData, importSummary }: Props) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging,   setIsDragging]   = useState(false)
  const [fileName,     setFileName]     = useState<string | null>(null)
  const [parsedRows,   setParsedRows]   = useState<ParsedRow[] | null>(null)
  const [skipped,      setSkipped]      = useState(0)
  const [parseError,   setParseError]   = useState<string | null>(null)
  const [result,       setResult]       = useState<{ success: number } | null>(null)
  const [importError,  setImportError]  = useState<string | null>(null)
  const [isPending,    startTransition] = useTransition()

  // ── 品種別インポート用 state ─────────────────────────────
  const brandFileInputRef = useRef<HTMLInputElement>(null)
  const [brandIsDragging,  setBrandIsDragging]  = useState(false)
  const [brandFileName,    setBrandFileName]    = useState<string | null>(null)
  const [brandParsedRows,  setBrandParsedRows]  = useState<(BrandedImportRow & { label: string })[] | null>(null)
  const [brandParseError,  setBrandParseError]  = useState<string | null>(null)
  const [brandResult,      setBrandResult]      = useState<BrandedImportResult | null>(null)
  const [brandImportError, setBrandImportError] = useState<string | null>(null)
  const [isBrandPending,   startBrandTransition] = useTransition()

  // ── ファイル解析 ───────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      setParseError('xlsx ファイルを選択してください。')
      return
    }
    setParseError(null)
    setResult(null)
    setImportError(null)
    setFileName(file.name)

    try {
      // Dynamic import で xlsx を遅延ロード
      const XLSX    = await import('xlsx')
      const buffer  = await file.arrayBuffer()
      const wb      = XLSX.read(buffer, { type: 'array' })

      const sheetName = wb.SheetNames.find(n => n.includes('月間集計')) ?? wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      if (!ws) { setParseError('対象シートが見つかりません。'); return }

      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]

      const valid:   ParsedRow[] = []
      let   skippedCount = 0

      for (const row of rows) {
        const label = row[0]
        const kgRaw = row[1]
        const ym    = parseYearMonth(label as string)
        const kg    = typeof kgRaw === 'number' ? kgRaw : parseFloat(String(kgRaw ?? ''))
        if (!ym || isNaN(kg) || kg < 0) { skippedCount++; continue }
        valid.push({ yearMonth: ym, weightKg: kg, label: String(label) })
      }

      setParsedRows(valid)
      setSkipped(skippedCount)
    } catch (e) {
      setParseError('ファイルの読み込みに失敗しました。')
      console.error(e)
    }
  }, [])

  // ── ドラッグ&ドロップ ──────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true)  }
  const onDragLeave = ()                    => setIsDragging(false)
  const onDrop      = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  // ── インポート実行 ──────────────────────────────────────────
  function handleImport() {
    if (!parsedRows || parsedRows.length === 0) return
    setImportError(null)
    startTransition(async () => {
      const res = await importShipmentHistory(parsedRows)
      if (res.error) { setImportError(res.error); return }
      setResult({ success: res.success })
      setParsedRows(null)
      setFileName(null)
      router.refresh()
    })
  }

  // ── 品種別ファイル解析 ────────────────────────────────────
  const handleBrandFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.xlsx?$/i)) {
      setBrandParseError('xlsx ファイルを選択してください。')
      return
    }
    setBrandParseError(null)
    setBrandResult(null)
    setBrandImportError(null)
    setBrandFileName(file.name)

    try {
      const XLSX   = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb     = XLSX.read(buffer, { type: 'array' })

      const rows: (BrandedImportRow & { label: string })[] = []

      for (const [misoType, targetName] of Object.entries(BRAND_SHEETS)) {
        // シート名の完全一致・前後空白無視でマッチ
        const sheetKey = wb.SheetNames.find(
          s => s.trim() === targetName.trim()
        )
        if (!sheetKey) continue

        const ws = wb.Sheets[sheetKey]
        const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]

        const colIdx = BRAND_KG_COLUMN[misoType] ?? 1

        for (const row of sheetRows) {
          const label = row[0]
          const kgRaw = row[colIdx]
          const ym    = parseYearMonth(label as string)
          const kg    = typeof kgRaw === 'number' ? kgRaw : parseFloat(String(kgRaw ?? ''))
          if (!ym || isNaN(kg) || kg < 0) continue
          rows.push({ yearMonth: ym, misoType, weightKg: kg, label: String(label) })
        }
      }

      setBrandParsedRows(rows)
    } catch (e) {
      setBrandParseError('ファイルの読み込みに失敗しました。')
      console.error(e)
    }
  }, [])

  // ── 品種別インポート実行 ──────────────────────────────────
  function handleBrandImport() {
    if (!brandParsedRows || brandParsedRows.length === 0) return
    setBrandImportError(null)
    startBrandTransition(async () => {
      const res = await importBrandedShipmentHistory(brandParsedRows)
      if (res.error) { setBrandImportError(res.error); return }
      setBrandResult(res)
      setBrandParsedRows(null)
      setBrandFileName(null)
      router.refresh()
    })
  }

  // ── 表示 ────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* インポート状況サマリー */}
      {importSummary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">インポート状況</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {importSummary.map(row => (
                <div
                  key={row.misoType}
                  className={`rounded-lg border px-3 py-2.5 ${row.count === 0 ? 'border-dashed opacity-60' : ''}`}
                >
                  <p className="text-xs text-muted-foreground truncate">{row.misoType}</p>
                  {row.count > 0 ? (
                    <>
                      <p className="text-base font-semibold tabular-nums mt-0.5">{row.count}<span className="text-xs font-normal text-muted-foreground ml-0.5">件</span></p>
                      <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                        {row.minYearMonth} 〜 {row.maxYearMonth}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-0.5">未インポート</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* アップロードエリア */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            ファイルをアップロード
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            「集計_みそ.xlsx」の「月間集計」シートを選択してください。<br />
            列A：年月ラベル（例: H27.3月 / R6.4月）　列B：全品種合計出荷量（kg）
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ドロップゾーン */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-10 cursor-pointer transition-colors ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={onFileInput}
            />
            {fileName ? (
              <>
                <FileSpreadsheet className="h-8 w-8 text-primary" />
                <p className="text-sm font-medium">{fileName}</p>
                <p className="text-xs text-muted-foreground">別のファイルを選ぶにはクリック</p>
              </>
            ) : (
              <>
                <Upload className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  ここにドラッグ&ドロップ<br />
                  <span className="text-primary underline underline-offset-2">またはクリックしてファイル選択</span>
                </p>
              </>
            )}
          </div>

          {parseError && (
            <p className="text-sm text-red-600">{parseError}</p>
          )}
        </CardContent>
      </Card>

      {/* プレビュー */}
      {parsedRows !== null && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                プレビュー
              </CardTitle>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>有効 <strong className="text-foreground">{parsedRows.length}</strong> 件</span>
                {skipped > 0 && (
                  <span>スキップ <strong className="text-orange-600">{skipped}</strong> 件</span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium">元ラベル</th>
                    <th className="text-left px-3 py-2 font-medium">年月</th>
                    <th className="text-right px-3 py-2 font-medium">出荷量（kg）</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2 text-muted-foreground">{row.label}</td>
                      <td className="px-3 py-2 tabular-nums">{row.yearMonth}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.weightKg.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsedRows.length > 10 && (
              <p className="text-xs text-muted-foreground text-right">
                先頭10件を表示。全{parsedRows.length}件がインポートされます。
              </p>
            )}

            {importError && <p className="text-sm text-red-600">{importError}</p>}

            <Button
              onClick={handleImport}
              disabled={isPending || parsedRows.length === 0}
              className="w-full sm:w-auto"
            >
              {isPending ? 'インポート中...' : `${parsedRows.length}件をインポート実行`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* インポート結果 */}
      {result && (
        <Card className="border-green-300 bg-green-50">
          <CardContent className="py-4">
            <p className="text-sm font-medium text-green-700">
              インポート完了：{result.success}件を保存しました。
            </p>
          </CardContent>
        </Card>
      )}

      {/* インポート済みデータ一覧 */}
      {existingData.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">インポート済みデータ</CardTitle>
              <span className="text-xs text-muted-foreground">{existingData.length}件</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/80">
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium">年月</th>
                    <th className="text-right px-3 py-2 font-medium">出荷量（kg）</th>
                    <th className="text-right px-3 py-2 font-medium">取込日</th>
                  </tr>
                </thead>
                <tbody>
                  {existingData.map(row => (
                    <tr key={row.yearMonth} className="border-b last:border-0">
                      <td className="px-3 py-2 tabular-nums">{row.yearMonth}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.weightKg.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground text-xs tabular-nums">
                        {format(new Date(row.importedAt), 'yyyy/MM/dd')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 品種別インポート ────────────────────────────────── */}
      <div className="border-t pt-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">品種別インポート</h3>
          <p className="text-xs text-muted-foreground mt-1">
            同じ Excel ファイルから品種別シートを読み込みます。<br />
            対象シート：＠無添加麦みそ（総量）/ ＠田舎みそ （総量）/ 山吹みそ / 白みそ
          </p>
        </div>

        {/* ドロップゾーン（品種別） */}
        <Card>
          <CardContent className="pt-4 space-y-4">
            <div
              onDragOver={e => { e.preventDefault(); setBrandIsDragging(true) }}
              onDragLeave={() => setBrandIsDragging(false)}
              onDrop={e => { e.preventDefault(); setBrandIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleBrandFile(f) }}
              onClick={() => brandFileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-8 cursor-pointer transition-colors ${
                brandIsDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30'
              }`}
            >
              <input
                ref={brandFileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleBrandFile(f) }}
              />
              {brandFileName ? (
                <>
                  <FileSpreadsheet className="h-7 w-7 text-primary" />
                  <p className="text-sm font-medium">{brandFileName}</p>
                  <p className="text-xs text-muted-foreground">別のファイルを選ぶにはクリック</p>
                </>
              ) : (
                <>
                  <Upload className="h-7 w-7 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    集計_みそ.xlsx をドラッグ&ドロップ<br />
                    <span className="text-primary underline underline-offset-2">またはクリックして選択</span>
                  </p>
                </>
              )}
            </div>
            {brandParseError && <p className="text-sm text-red-600">{brandParseError}</p>}
          </CardContent>
        </Card>

        {/* 品種別プレビュー */}
        {brandParsedRows !== null && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">プレビュー（品種別）</CardTitle>
                <span className="text-xs text-muted-foreground">合計 {brandParsedRows.length} 件</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 品種別件数サマリー */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.keys(BRAND_SHEETS).map(brand => {
                  const count = brandParsedRows.filter(r => r.misoType === brand).length
                  return (
                    <div key={brand} className={`rounded-lg border px-3 py-2 text-center ${count === 0 ? 'border-dashed opacity-50' : ''}`}>
                      <p className="text-xs text-muted-foreground">{brand}</p>
                      <p className="text-sm font-semibold tabular-nums">{count}件</p>
                    </div>
                  )
                })}
              </div>

              {/* 先頭10件プレビュー */}
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-muted-foreground">
                      <th className="text-left px-3 py-2 font-medium">品種</th>
                      <th className="text-left px-3 py-2 font-medium">元ラベル</th>
                      <th className="text-left px-3 py-2 font-medium">年月</th>
                      <th className="text-right px-3 py-2 font-medium">出荷量（kg）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brandParsedRows.slice(0, 10).map((row, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-2 text-xs">{row.misoType}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.label}</td>
                        <td className="px-3 py-2 tabular-nums">{row.yearMonth}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.weightKg.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {brandParsedRows.length > 10 && (
                <p className="text-xs text-muted-foreground text-right">
                  先頭10件を表示。全{brandParsedRows.length}件がインポートされます。
                </p>
              )}

              {brandImportError && <p className="text-sm text-red-600">{brandImportError}</p>}

              <Button
                onClick={handleBrandImport}
                disabled={isBrandPending || brandParsedRows.length === 0}
                className="w-full sm:w-auto"
              >
                {isBrandPending ? 'インポート中...' : `${brandParsedRows.length}件をインポート実行`}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* 品種別インポート結果 */}
        {brandResult && (
          <Card className="border-green-300 bg-green-50">
            <CardContent className="py-4 space-y-1">
              <p className="text-sm font-medium text-green-700">
                品種別インポート完了：合計 {brandResult.totalSuccess} 件
              </p>
              <div className="flex flex-wrap gap-3">
                {Object.entries(brandResult.successByBrand).map(([brand, count]) => (
                  <span key={brand} className="text-xs text-green-600">
                    {brand}：{count}件
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

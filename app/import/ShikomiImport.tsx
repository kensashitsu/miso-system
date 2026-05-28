'use client'

import { useState, useTransition, useRef, useCallback } from 'react'
import { format } from 'date-fns'
import { Upload, FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { importShikomiData, type ShikomiRow, type ShikomiImportResult } from './shikomi-actions'

// ── CSV パーサー ──────────────────────────────────────────
function parseCSVLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cell += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      cells.push(cell.trim()); cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

function parseCSV(text: string): { headers: string[]; rows: ShikomiRow[]; skippedBlank: number } {
  const cleaned = text.startsWith('﻿') ? text.slice(1) : text
  const lines   = cleaned.split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [], skippedBlank: 0 }

  const headers = parseCSVLine(lines[0])
  const rows: ShikomiRow[] = []
  let skippedBlank = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCSVLine(lines[i])
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => { obj[h] = values[idx] ?? '' })

    if (!obj.brewedAt || !obj.misoType || !obj.shikomiKg) { skippedBlank++; continue }

    rows.push({
      brewedAt:        obj.brewedAt        ?? '',
      useStartAt:      obj.useStartAt      ?? '',
      storageDays:     obj.storageDays     ?? '',
      bucketNumbers:   obj.bucketNumbers   ?? '',
      misoType:        obj.misoType        ?? '',
      mugiKg:          parseFloat(obj.mugiKg)    || 0,
      kojiKg:          parseFloat(obj.kojiKg)    || 0,
      daizuKg:         parseFloat(obj.daizuKg)   || 0,
      shioKg:          parseFloat(obj.shioKg)    || 0,
      mizuameKg:       parseFloat(obj.mizuameKg) || 0,
      taneMizuL:       parseFloat(obj.taneMizuL) || 0,
      shikomiKg:       parseFloat(obj.shikomiKg) || 0,
      daizuOrigin:     obj.daizuOrigin     ?? '',
      airTempC:        obj.airTempC        ?? '',
      productTempC:    obj.productTempC    ?? '',
      kojiCondition:   obj.kojiCondition   ?? '',
      soybeanHardness: obj.soybeanHardness ?? '',
      seedMisoKg:      parseFloat(obj.seedMisoKg) || 0,
      memo:            obj.memo            ?? '',
    })
  }

  return { headers, rows, skippedBlank }
}

function derivedStatus(row: ShikomiRow): string {
  return row.useStartAt ? '出荷済' : '完成'
}

// ── 型 ──────────────────────────────────────────────────
export interface ShikomiSummaryRow {
  misoType:    string
  count:       number
  minBrewedAt: string | null
  maxBrewedAt: string | null
}

// ── コンポーネント ───────────────────────────────────────
export default function ShikomiImport({ shikomiSummary }: { shikomiSummary?: ShikomiSummaryRow[] }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging,  setIsDragging]  = useState(false)
  const [fileName,    setFileName]    = useState<string | null>(null)
  const [parsedRows,  setParsedRows]  = useState<ShikomiRow[] | null>(null)
  const [skippedBlank, setSkippedBlank] = useState(0)
  const [parseError,  setParseError]  = useState<string | null>(null)
  const [result,      setResult]      = useState<ShikomiImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [isPending,   startTransition] = useTransition()

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.csv$/i)) {
      setParseError('CSV ファイル（.csv）を選択してください。')
      return
    }
    setParseError(null)
    setResult(null)
    setImportError(null)
    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string
        const { rows, skippedBlank } = parseCSV(text)
        setParsedRows(rows)
        setSkippedBlank(skippedBlank)
      } catch {
        setParseError('ファイルの読み込みに失敗しました。')
      }
    }
    reader.readAsText(file, 'UTF-8')
  }, [])

  function handleImport() {
    if (!parsedRows || parsedRows.length === 0) return
    setImportError(null)
    startTransition(async () => {
      const res = await importShikomiData(parsedRows)
      setResult(res)
      setParsedRows(null)
      setFileName(null)
    })
  }

  return (
    <div className="space-y-6">

      {/* インポート状況サマリー */}
      {shikomiSummary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">登録状況</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {shikomiSummary.map(row => (
                <div
                  key={row.misoType}
                  className={`rounded-lg border px-3 py-2.5 ${row.count === 0 ? 'border-dashed opacity-60' : ''}`}
                >
                  <p className="text-xs text-muted-foreground truncate">{row.misoType}</p>
                  {row.count > 0 ? (
                    <>
                      <p className="text-base font-semibold tabular-nums mt-0.5">
                        {row.count}<span className="text-xs font-normal text-muted-foreground ml-0.5">件</span>
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                        {row.minBrewedAt ? format(new Date(row.minBrewedAt), 'yyyy/MM') : '—'}
                        {' 〜 '}
                        {row.maxBrewedAt ? format(new Date(row.maxBrewedAt), 'yyyy/MM') : '—'}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-0.5">未登録</p>
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
          <CardTitle className="text-sm font-semibold">CSVファイルをアップロード</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            shikomi_import_filtered.csv を選択してください。<br />
            ヘッダー行（1行目）が必要です。文字コード：UTF-8
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
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
              accept=".csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            {fileName ? (
              <>
                <FileText className="h-8 w-8 text-primary" />
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
          {parseError && <p className="text-sm text-red-600">{parseError}</p>}
        </CardContent>
      </Card>

      {/* プレビュー */}
      {parsedRows !== null && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">プレビュー</CardTitle>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>有効 <strong className="text-foreground">{parsedRows.length}</strong> 件</span>
                {skippedBlank > 0 && <span>空行スキップ <strong className="text-orange-600">{skippedBlank}</strong> 件</span>}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium whitespace-nowrap">仕込み日</th>
                    <th className="text-left px-3 py-2 font-medium whitespace-nowrap">品種</th>
                    <th className="text-left px-3 py-2 font-medium whitespace-nowrap">桶番号</th>
                    <th className="text-right px-3 py-2 font-medium whitespace-nowrap">仕立(kg)</th>
                    <th className="text-left px-3 py-2 font-medium whitespace-nowrap">大豆産地</th>
                    <th className="text-left px-3 py-2 font-medium whitespace-nowrap">登録ステータス</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2 tabular-nums whitespace-nowrap">{row.brewedAt}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{row.misoType}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {row.bucketNumbers || '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.shikomiKg.toLocaleString()}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {row.daizuOrigin || '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${
                          derivedStatus(row) === '出荷済'
                            ? 'border-gray-300 bg-gray-50 text-gray-600'
                            : 'border-green-400 bg-green-50 text-green-700'
                        }`}>
                          {derivedStatus(row)}
                        </span>
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

      {/* 結果 */}
      {result && (
        <div className="space-y-3">
          <Card className={result.success > 0 ? 'border-green-300 bg-green-50' : 'border-orange-300 bg-orange-50'}>
            <CardContent className="py-4 space-y-1">
              <p className={`text-sm font-medium ${result.success > 0 ? 'text-green-700' : 'text-orange-700'}`}>
                インポート完了
              </p>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-green-700">
                  成功：<strong>{result.success}</strong> 件
                </span>
                {result.skipped > 0 && (
                  <span className="text-muted-foreground">
                    スキップ（重複）：<strong>{result.skipped}</strong> 件
                  </span>
                )}
                {result.errors.length > 0 && (
                  <span className="text-red-600">
                    エラー：<strong>{result.errors.length}</strong> 件
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {result.errors.length > 0 && (
            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="text-sm font-semibold text-red-700">エラー詳細</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-600">
                      行{e.row}：{e.message}
                    </p>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

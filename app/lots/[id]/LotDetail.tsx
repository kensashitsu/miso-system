'use client'

import { useState, useTransition, useMemo, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { ChevronDown, ChevronUp, ArrowLeft, MapPin, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import LotSimChart from './LotSimChart'
import { addAgingNote, changeLotStatus, revertLotStatus, deleteLot, updateBucketNumbers, updateBucketRemaining, addBucketToLot, addBucketUsage, updateBucketUsage, deleteBucketUsage, updateCompletedAt, updateLocationTemp, updateBrewRecord, type NoteResult, type BucketUsageResult } from './actions'
import { getStockPreview, type StockChangeItem } from '@/app/lots/stock-preview-action'
import StockPreviewPanel from '@/components/StockPreviewPanel'
import { getMisoTypeBadgeStyle } from '@/lib/misoTypeColor'
import { litersToToText, toToLitersText } from '@/lib/units'
import { stockSendKg } from '@/lib/stockQty'

const BUCKET_PAIRS = Array.from({ length: 15 }, (_, i) => `${i * 2 + 1}・${i * 2 + 2}`)

// ── 型定義 ────────────────────────────────────────────────
interface LocationPeriod {
  id: string
  location: string
  startDateISO: string
  endDateISO: string | null
  accumulated: number
}

interface AgingNoteItem {
  id: string
  recordedAt: string
  memo: string
  airTempC: number | null
  productTempC: number | null
}

interface BrewRecordData {
  mugiOrKomeKg: number
  kojiKg: number
  soybeanKg: number
  saltKg: number
  mizuameKg: number
  seedWaterL: number
  shikomiKg: number
  seedMisoKg: number
  taneKojiG: number
  soybeanOrigin: string | null
  soybeanOriginDetail: string | null
  soybeanArrivalDate: string | null
  soybeanSupplier: string | null
  soybeanLotNo: string | null
  kojiMadeAt: string | null
  kojiSupplier: string | null
  saltBrand: string | null
  saltLotNo: string | null
  mizuameBrand: string | null
  mizuameLotNo: string | null
  kojiCondition: number | null
  soybeanHardness: string | null
  airTempC: number | null
  productTempC: number | null
  steamingPressure: string | null
  coolingMin: string | null
  memo: string | null
}

interface BucketUsageItem {
  id:          string
  usedAt:      string
  usedKg:      number
  productName: string | null
  operator:    string | null
  notes:       string | null
}

interface BucketItem {
  id:                string
  bucketNumber:      number
  initialWeightKg:   number
  remainingWeightKg: number | null
  status:            string
  usages:            BucketUsageItem[]
}

export interface LotDetailProps {
  productNameOptions: string[]
  operatorOptions:    string[]
  id: string
  lotNumber: string
  misoType: string
  yieldRate: number
  status: string
  brewedAtISO: string
  elapsedDays: number
  agingDays: number
  totalWeightKg: number
  targetTempSum: number
  completedAtISO: string | null
  bucketNumbers: string | null
  accumulatedTemp: number             // 完成までの積算（熟成中は今日まで）
  postCompletionTemp?: number | null  // 完成後に進んだ積算（完成ロットのみ）
  currentLocation: string
  coloringRisk: 'normal' | 'warning' | 'danger'
  estimatedCompletionISO: string | null
  q10Value:        number
  weatherAvg:      Record<string, number>
  heatingBaseTemp: number
  fridgeTemp:      number
  locationPeriods: LocationPeriod[]
  agingNotes: AgingNoteItem[]
  brewStats: { kojiRatio: number; saltPercent: number; moisturePercent: number } | null
  brewRecord: BrewRecordData | null
  buckets:      BucketItem[]
  isPrototype?: boolean
}

// ── ステータスバッジ ────────────────────────────────────────
const STATUS_BADGE: Record<string, string> = {
  '熟成中':       'border-blue-200 bg-blue-50/70 text-blue-700',
  '完成':         'border-emerald-200 bg-emerald-50/70 text-emerald-700',
  '種みそ転用':   'border-purple-200 bg-purple-50/70 text-purple-700',
  '品質低下出荷': 'border-amber-200 bg-amber-50/70 text-amber-700',
  '出荷済':       'border-gray-200 bg-gray-50 text-gray-500',
}

const RISK_LABEL: Record<string, string> = {
  normal:  '通常',
  warning: '要注意',
  danger:  'リスク高',
}

const RISK_CLASS: Record<string, string> = {
  normal:  'border-emerald-200/50 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200/50 bg-amber-50 text-amber-700',
  danger:  'border-rose-200/50 bg-rose-50 text-rose-700',
}

const PROGRESS_COLOR: Record<string, string> = {
  normal:  'bg-emerald-500',
  warning: 'bg-amber-500',
  danger:  'bg-rose-500',
}

// ── ヘルパー ───────────────────────────────────────────────
function normalizeLocation(loc: string): string {
  const m = loc.match(/^温調室(\d+(?:\.\d+)?)℃$/)
  return m ? `暖房${m[1]}℃` : loc
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm py-1.5 border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value ?? '—'}</span>
    </div>
  )
}

// ── 仕込み記録編集用 ──────────────────────────────────────
interface BrewRecordDraft {
  mugiOrKomeKg: string; kojiKg: string; soybeanKg: string; saltKg: string
  mizuameKg: string; seedWaterL: string; shikomiKg: string; seedMisoKg: string
  taneKojiG: string; soybeanOrigin: string; soybeanOriginDetail: string
  soybeanArrivalDate: string; soybeanSupplier: string; soybeanLotNo: string
  kojiMadeAt: string; kojiSupplier: string; saltBrand: string; saltLotNo: string
  mizuameBrand: string; mizuameLotNo: string; kojiCondition: string
  soybeanHardness: string; airTempC: string; productTempC: string
  steamingPressure: string; coolingMin: string; memo: string
}

function toBrewDraft(r: BrewRecordData): BrewRecordDraft {
  return {
    mugiOrKomeKg: String(r.mugiOrKomeKg),
    kojiKg: String(r.kojiKg),
    soybeanKg: String(r.soybeanKg),
    saltKg: String(r.saltKg),
    mizuameKg: String(r.mizuameKg),
    seedWaterL: String(r.seedWaterL),
    shikomiKg: String(r.shikomiKg),
    seedMisoKg: String(r.seedMisoKg),
    taneKojiG: String(r.taneKojiG),
    soybeanOrigin: r.soybeanOrigin ?? '',
    soybeanOriginDetail: r.soybeanOriginDetail ?? '',
    soybeanArrivalDate: r.soybeanArrivalDate ? r.soybeanArrivalDate.slice(0, 10) : '',
    soybeanSupplier: r.soybeanSupplier ?? '',
    soybeanLotNo: r.soybeanLotNo ?? '',
    kojiMadeAt: r.kojiMadeAt ? r.kojiMadeAt.slice(0, 10) : '',
    kojiSupplier: r.kojiSupplier ?? '',
    saltBrand: r.saltBrand ?? '',
    saltLotNo: r.saltLotNo ?? '',
    mizuameBrand: r.mizuameBrand ?? '',
    mizuameLotNo: r.mizuameLotNo ?? '',
    kojiCondition: r.kojiCondition != null ? String(r.kojiCondition) : '',
    soybeanHardness: r.soybeanHardness ?? '',
    airTempC: r.airTempC != null ? String(r.airTempC) : '',
    productTempC: r.productTempC != null ? String(r.productTempC) : '',
    steamingPressure: r.steamingPressure ?? '',
    coolingMin: r.coolingMin ?? '',
    memo: r.memo ?? '',
  }
}

function draftToInput(d: BrewRecordDraft) {
  const n = (s: string) => s !== '' ? parseFloat(s) : 0
  const ni = (s: string) => s !== '' ? parseInt(s, 10) : null
  const ns = (s: string) => s !== '' ? s : null
  return {
    mugiOrKomeKg: n(d.mugiOrKomeKg),
    kojiKg: n(d.kojiKg),
    soybeanKg: n(d.soybeanKg),
    saltKg: n(d.saltKg),
    mizuameKg: n(d.mizuameKg),
    seedWaterL: n(d.seedWaterL),
    shikomiKg: n(d.shikomiKg),
    seedMisoKg: n(d.seedMisoKg),
    taneKojiG: n(d.taneKojiG),
    soybeanOrigin: ns(d.soybeanOrigin),
    soybeanOriginDetail: ns(d.soybeanOriginDetail),
    soybeanArrivalDate: ns(d.soybeanArrivalDate),
    soybeanSupplier: ns(d.soybeanSupplier),
    soybeanLotNo: ns(d.soybeanLotNo),
    kojiMadeAt: ns(d.kojiMadeAt),
    kojiSupplier: ns(d.kojiSupplier),
    saltBrand: ns(d.saltBrand),
    saltLotNo: ns(d.saltLotNo),
    mizuameBrand: ns(d.mizuameBrand),
    mizuameLotNo: ns(d.mizuameLotNo),
    kojiCondition: ni(d.kojiCondition),
    soybeanHardness: ns(d.soybeanHardness),
    airTempC: d.airTempC !== '' ? parseFloat(d.airTempC) : null,
    productTempC: d.productTempC !== '' ? parseFloat(d.productTempC) : null,
    steamingPressure: ns(d.steamingPressure),
    coolingMin: ns(d.coolingMin),
    memo: ns(d.memo),
  }
}

function draftToBrewRecord(d: BrewRecordDraft): BrewRecordData {
  const n = (s: string) => s !== '' ? parseFloat(s) : 0
  return {
    mugiOrKomeKg: n(d.mugiOrKomeKg),
    kojiKg: n(d.kojiKg),
    soybeanKg: n(d.soybeanKg),
    saltKg: n(d.saltKg),
    mizuameKg: n(d.mizuameKg),
    seedWaterL: n(d.seedWaterL),
    shikomiKg: n(d.shikomiKg),
    seedMisoKg: n(d.seedMisoKg),
    taneKojiG: n(d.taneKojiG),
    soybeanOrigin: d.soybeanOrigin || null,
    soybeanOriginDetail: d.soybeanOriginDetail || null,
    soybeanArrivalDate: d.soybeanArrivalDate || null,
    soybeanSupplier: d.soybeanSupplier || null,
    soybeanLotNo: d.soybeanLotNo || null,
    kojiMadeAt: d.kojiMadeAt || null,
    kojiSupplier: d.kojiSupplier || null,
    saltBrand: d.saltBrand || null,
    saltLotNo: d.saltLotNo || null,
    mizuameBrand: d.mizuameBrand || null,
    mizuameLotNo: d.mizuameLotNo || null,
    kojiCondition: d.kojiCondition !== '' ? parseInt(d.kojiCondition, 10) : null,
    soybeanHardness: d.soybeanHardness || null,
    airTempC: d.airTempC !== '' ? parseFloat(d.airTempC) : null,
    productTempC: d.productTempC !== '' ? parseFloat(d.productTempC) : null,
    steamingPressure: d.steamingPressure || null,
    coolingMin: d.coolingMin || null,
    memo: d.memo || null,
  }
}

// ── メインコンポーネント ───────────────────────────────────
export default function LotDetail({
  id,
  lotNumber,
  misoType,
  yieldRate,
  status,
  brewedAtISO,
  elapsedDays,
  agingDays,
  totalWeightKg,
  targetTempSum,
  completedAtISO,
  bucketNumbers,
  accumulatedTemp,
  postCompletionTemp,
  currentLocation,
  coloringRisk,
  estimatedCompletionISO,
  q10Value,
  weatherAvg,
  heatingBaseTemp,
  fridgeTemp,
  locationPeriods,
  agingNotes: initialNotes,
  brewStats,
  brewRecord,
  buckets: initialBuckets,
  isPrototype,
  productNameOptions,
  operatorOptions,
}: LotDetailProps) {
  const router = useRouter()

  const [showBrew, setShowBrew] = useState(false)
  const [notes, setNotes] = useState<AgingNoteItem[]>(initialNotes)
  const [noteForm, setNoteForm] = useState({ recordedAt: format(new Date(), 'yyyy-MM-dd'), memo: '', airTempC: '', productTempC: '' })
  const [noteError, setNoteError] = useState<Record<string, string>>({})
  const [noteGlobalError, setNoteGlobalError] = useState<string | null>(null)
  const [isNoteSubmitting, startNoteTransition] = useTransition()
  const [statusError, setStatusError] = useState<string | null>(null)
  const [isStatusChanging, startStatusTransition] = useTransition()
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null)
  const [completionDate, setCompletionDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [revertError, setRevertError] = useState<string | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [isReverting, startRevertTransition] = useTransition()
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleting, startDeleteTransition] = useTransition()
  // 在庫プレビュー（完成確認・削除確認時）
  const [stockPreview, setStockPreview] = useState<StockChangeItem[] | null | 'loading'>(null)
  const [skipStockUpdate, setSkipStockUpdate] = useState(false)

  useEffect(() => {
    if (isPrototype) return
    // 在庫システムへ送る量は品種ごとの固定量（actions.ts の送信と同じ）
    const yieldKg = stockSendKg(misoType, Math.floor(totalWeightKg * yieldRate))
    if (confirmStatus === '完成') {
      setStockPreview('loading')
      setSkipStockUpdate(false)
      getStockPreview(misoType, 'complete', yieldKg)
        .then(items => setStockPreview(items))
        .catch(() => setStockPreview([]))
    } else if (confirmDelete) {
      setStockPreview('loading')
      setSkipStockUpdate(false)
      const action = status === '完成' ? 'delete-aged' as const : 'delete-wip' as const
      getStockPreview(misoType, action, yieldKg)
        .then(items => setStockPreview(items))
        .catch(() => setStockPreview([]))
    } else if (confirmRevert) {
      setStockPreview('loading')
      setSkipStockUpdate(false)
      getStockPreview(misoType, 'revert', yieldKg)
        .then(items => setStockPreview(items))
        .catch(() => setStockPreview([]))
    } else {
      setStockPreview(null)
      setSkipStockUpdate(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmStatus, confirmDelete, confirmRevert])

  // 桶管理
  const [buckets, setBuckets] = useState<BucketItem[]>(initialBuckets)
  const [bucketDrafts, setBucketDrafts] = useState<Record<string, string>>({})
  // 全桶が空になった時のプロンプト（完成ロットのみ）
  const [showAllEmptyPrompt, setShowAllEmptyPrompt] = useState(
    status === '完成' &&
    initialBuckets.length > 0 &&
    initialBuckets.every(b => b.status === '空')
  )
  const [bucketSavingId, setBucketSavingId] = useState<string | null>(null)
  const [showAddBucket, setShowAddBucket] = useState(false)
  const [addBucketNum, setAddBucketNum] = useState('')
  const [addBucketKg, setAddBucketKg] = useState('')
  const [isAddingBucket, startAddBucketTransition] = useTransition()
  const [currentBucketNumbers, setCurrentBucketNumbers] = useState<string | null>(bucketNumbers)
  const [editingBucket, setEditingBucket] = useState(false)
  const [bucketDraft, setBucketDraft] = useState(bucketNumbers ?? '')
  const [bucketError, setBucketError] = useState<string | null>(null)
  const [isBucketSaving, startBucketTransition] = useTransition()
  // 使用記録
  const [bucketUsages, setBucketUsages] = useState<Record<string, BucketUsageItem[]>>(
    Object.fromEntries(initialBuckets.map(b => [b.id, b.usages]))
  )
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, boolean>>({})
  // 前回選んだ操作者を記憶（初期選択に使う）
  const [lastOperator, setLastOperator] = useState('')
  useEffect(() => {
    try {
      const saved = localStorage.getItem('bucketUsage_lastOperator')
      if (saved) setLastOperator(saved)
    } catch { /* localStorage 不可でも無視 */ }
  }, [])
  const [usageForm, setUsageForm] = useState<Record<string, { usedAt: string; usedKg: string; productName: string; operator: string; notes: string }>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, Record<string, string>>>({})
  const [usageGlobalError, setUsageGlobalError] = useState<Record<string, string | null>>({})
  const [isUsageSubmitting, startUsageTransition] = useTransition()
  const [deletingUsageId, setDeletingUsageId] = useState<string | null>(null)
  const [editingUsageId, setEditingUsageId] = useState<string | null>(null)
  const [usageEditDraft, setUsageEditDraft] = useState<{ usedAt: string; usedKg: string; productName: string; operator: string; notes: string } | null>(null)
  const [usageEditError, setUsageEditError] = useState<string | null>(null)
  const [isUsageEditSubmitting, startUsageEditTransition] = useTransition()
  // 完成日インライン編集
  const [completedAtValue, setCompletedAtValue] = useState<string | null>(completedAtISO)
  const [editingCompletedAt, setEditingCompletedAt] = useState(false)
  const [completedAtDraft, setCompletedAtDraft] = useState('')
  const [isSavingCompletedAt, startCompletedAtTransition] = useTransition()
  const cancelCompletedAtRef = useRef(false)
  // 場所温度インライン編集
  const [editingLocId, setEditingLocId] = useState<string | null>(null)
  const [locTempDraft, setLocTempDraft] = useState('')
  const [locTempError, setLocTempError] = useState<string | null>(null)
  const [isSavingLocTemp, startLocTempTransition] = useTransition()
  const cancelLocTempRef = useRef(false)
  // 仕込み記録編集
  const [localBrewRecord, setLocalBrewRecord] = useState<BrewRecordData | null>(brewRecord)
  const [editingBrew, setEditingBrew] = useState(false)
  const [brewDraft, setBrewDraft] = useState<BrewRecordDraft | null>(null)
  // 種水の「斗」欄。入力中だけ生テキストを持ち、それ以外は ℓ から換算して表示する
  const [seedWaterToDraft, setSeedWaterToDraft] = useState<string | null>(null)
  const [isSavingBrew, startBrewTransition] = useTransition()
  const [brewSaveError, setBrewSaveError] = useState<string | null>(null)

  const rawProgressPct  = targetTempSum > 0 ? (accumulatedTemp / targetTempSum) * 100 : 0
  // 完成後も置き場の温度に応じて熟成は進む（冷蔵庫ならほぼ停止）。分けて表示する
  const postTemp     = postCompletionTemp ?? 0
  const hasPost      = postTemp > 0
  const totalPct     = targetTempSum > 0 ? ((accumulatedTemp + postTemp) / targetTempSum) * 100 : 0

  // バーの目盛り（ダッシュボードのロットカードと同じ扱い・components/dashboard/lot-card.tsx）。
  // 100%＝満杯だと、完成時点で100%を超えているロットは完成後に進んだ分を描けない。
  // 目標を超えているロットだけ物差しを200%まで広げ、100/120/150%に目盛りを立てる
  const RISK_SCALE_MAX = 200
  const useRiskScale   = hasPost || rawProgressPct > 100
  const scaleMax       = useRiskScale ? RISK_SCALE_MAX : 100
  const toWidth        = (pct: number) => Math.max(0, Math.min(100, (pct / scaleMax) * 100))
  const barWidth       = toWidth(rawProgressPct)
  const postBarWidth   = Math.max(0, toWidth(totalPct) - barWidth)
  const isOverScale    = totalPct > scaleMax
  const scaleTicks     = useRiskScale
    ? [
        { pct: 100, label: '完成' },
        { pct: 120, label: '要注意' },
        { pct: 150, label: 'リスク高' },
      ].filter(t => t.pct < scaleMax)
    : []
  const brewedAt = new Date(brewedAtISO)
  const estimatedCompletion = estimatedCompletionISO ? new Date(estimatedCompletionISO) : null

  // ── 熟成メモ追加 ────────────────────────────────────────
  function handleNoteSubmit() {
    setNoteError({})
    setNoteGlobalError(null)
    startNoteTransition(async () => {
      const input = {
        recordedAt:  noteForm.recordedAt,
        memo:        noteForm.memo,
        airTempC:    noteForm.airTempC !== '' ? parseFloat(noteForm.airTempC) : null,
        productTempC: noteForm.productTempC !== '' ? parseFloat(noteForm.productTempC) : null,
      }
      const result: NoteResult = await addAgingNote(id, input)
      if (result.errors) { setNoteError(result.errors); return }
      if (result.globalError) { setNoteGlobalError(result.globalError); return }
      if (result.success && result.id) {
        setNotes(prev => [{
          id: result.id!,
          recordedAt: result.recordedAt!,
          memo: noteForm.memo,
          airTempC: noteForm.airTempC !== '' ? parseFloat(noteForm.airTempC) : null,
          productTempC: noteForm.productTempC !== '' ? parseFloat(noteForm.productTempC) : null,
        }, ...prev])
        setNoteForm({ recordedAt: format(new Date(), 'yyyy-MM-dd'), memo: '', airTempC: '', productTempC: '' })
      }
    })
  }

  // ── ステータス変更 ──────────────────────────────────────
  function handleStatusChange(newStatus: string) {
    setStatusError(null)
    setConfirmStatus(null)
    startStatusTransition(async () => {
      const dateStr = newStatus === '完成' ? completionDate : undefined
      const result = await changeLotStatus(id, newStatus, dateStr, skipStockUpdate)
      if (result.error) { setStatusError(result.error); return }
      router.refresh()
    })
  }

  // ── ロット削除 ─────────────────────────────────────────
  function handleDelete() {
    setDeleteError(null)
    setConfirmDelete(false)
    startDeleteTransition(async () => {
      const result = await deleteLot(id, skipStockUpdate)
      if (result.error) { setDeleteError(result.error); return }
      router.push('/')
    })
  }

  // ── 桶番号保存 ─────────────────────────────────────────
  function handleBucketSave() {
    setBucketError(null)
    startBucketTransition(async () => {
      const result = await updateBucketNumbers(id, bucketDraft || null)
      if (result.error) { setBucketError(result.error); return }
      setCurrentBucketNumbers(bucketDraft || null)
      setEditingBucket(false)
    })
  }

  // ── 桶残量の保存 ───────────────────────────────────────
  async function handleBucketRemainingChange(bucketId: string) {
    const raw = bucketDrafts[bucketId]
    if (raw === undefined) return
    const kg = parseFloat(raw)
    if (isNaN(kg) || kg < 0) return
    setBucketSavingId(bucketId)
    const result = await updateBucketRemaining(bucketId, kg)
    setBucketSavingId(null)
    if (result.success) {
      setBuckets(prev => prev.map(b =>
        b.id === bucketId
          ? { ...b, remainingWeightKg: kg, status: kg <= 0 ? '空' : b.status }
          : b
      ))
      setBucketDrafts(prev => { const next = { ...prev }; delete next[bucketId]; return next })
      if (result.allEmpty && status === '完成') setShowAllEmptyPrompt(true)
    }
  }

  // ── 桶を追加（既存ロット） ────────────────────────────
  function handleAddBucket() {
    const num = parseInt(addBucketNum)
    const kg  = parseFloat(addBucketKg)
    if (isNaN(num) || num < 0 || num > 30 || isNaN(kg) || kg <= 0) return
    startAddBucketTransition(async () => {
      const result = await addBucketToLot(id, num, kg)
      if (result.success) {
        setBuckets(prev => [...prev, { id: `tmp-${Date.now()}`, bucketNumber: num, initialWeightKg: kg, remainingWeightKg: null, status: '使用中', usages: [] }].sort((a, b) => a.bucketNumber - b.bucketNumber))
        setAddBucketNum('')
        setAddBucketKg('')
        setShowAddBucket(false)
        router.refresh()
      }
    })
  }

  // 使用記録フォームの初期値（操作者は前回選択を引き継ぐ）
  function emptyUsageForm() {
    return { usedAt: format(new Date(), 'yyyy-MM-dd'), usedKg: '', productName: '', operator: lastOperator, notes: '' }
  }

  // ── 桶使用記録を追加 ───────────────────────────────────
  function handleUsageSubmit(bucketId: string) {
    const form = usageForm[bucketId] ?? emptyUsageForm()
    setUsageErrors(prev => ({ ...prev, [bucketId]: {} }))
    setUsageGlobalError(prev => ({ ...prev, [bucketId]: null }))
    startUsageTransition(async () => {
      const input = {
        usedAt:      form.usedAt,
        usedKg:      form.usedKg !== '' ? parseFloat(form.usedKg) : undefined,
        productName: form.productName || null,
        operator:    form.operator || null,
        notes:       form.notes || null,
      }
      const result: BucketUsageResult = await addBucketUsage(bucketId, input)
      if (result.errors) { setUsageErrors(prev => ({ ...prev, [bucketId]: result.errors! })); return }
      if (result.globalError) { setUsageGlobalError(prev => ({ ...prev, [bucketId]: result.globalError! })); return }
      if (result.success && result.id) {
        // 選んだ操作者を次回の初期値として記憶
        if (form.operator) {
          setLastOperator(form.operator)
          try { localStorage.setItem('bucketUsage_lastOperator', form.operator) } catch { /* 無視 */ }
        }
        setBucketUsages(prev => ({
          ...prev,
          [bucketId]: [{ id: result.id!, usedAt: new Date(form.usedAt).toISOString(), usedKg: parseFloat(form.usedKg), productName: form.productName || null, operator: form.operator || null, notes: form.notes || null }, ...(prev[bucketId] ?? [])],
        }))
        if (result.newRemainingWeightKg !== undefined) {
          setBuckets(prev => prev.map(b => b.id === bucketId
            ? { ...b, remainingWeightKg: result.newRemainingWeightKg!, status: result.newStatus ?? b.status }
            : b
          ))
        }
        setUsageForm(prev => ({ ...prev, [bucketId]: { ...emptyUsageForm(), operator: form.operator } }))
      }
    })
  }

  // ── 桶使用記録を削除 ───────────────────────────────────
  async function handleUsageDelete(usageId: string, bucketId: string) {
    setDeletingUsageId(usageId)
    const result = await deleteBucketUsage(usageId)
    setDeletingUsageId(null)
    if (result.success) {
      setBucketUsages(prev => ({ ...prev, [bucketId]: (prev[bucketId] ?? []).filter(u => u.id !== usageId) }))
      if (result.newRemainingWeightKg !== undefined) {
        setBuckets(prev => prev.map(b => b.id === bucketId
          ? { ...b, remainingWeightKg: result.newRemainingWeightKg!, status: result.newStatus ?? b.status }
          : b
        ))
      }
    }
  }

  // ── 桶使用記録の編集を開始 ─────────────────────────────
  function handleUsageEditStart(u: BucketUsageItem) {
    setEditingUsageId(u.id)
    setUsageEditDraft({
      usedAt:      format(new Date(u.usedAt), 'yyyy-MM-dd'),
      usedKg:      String(u.usedKg),
      productName: u.productName ?? '',
      operator:    u.operator ?? '',
      notes:       u.notes ?? '',
    })
    setUsageEditError(null)
  }

  function handleUsageEditCancel() {
    setEditingUsageId(null)
    setUsageEditDraft(null)
    setUsageEditError(null)
  }

  // ── 桶使用記録を保存 ───────────────────────────────────
  function handleUsageEditSave(usageId: string, bucketId: string) {
    if (!usageEditDraft) return
    setUsageEditError(null)
    startUsageEditTransition(async () => {
      const input = {
        usedAt:      usageEditDraft.usedAt,
        usedKg:      usageEditDraft.usedKg !== '' ? parseFloat(usageEditDraft.usedKg) : undefined,
        productName: usageEditDraft.productName || null,
        operator:    usageEditDraft.operator || null,
        notes:       usageEditDraft.notes || null,
      }
      const result: BucketUsageResult = await updateBucketUsage(usageId, input)
      if (result.errors) {
        const first = Object.values(result.errors)[0]
        setUsageEditError(first ?? '入力内容を確認してください。')
        return
      }
      if (result.globalError) { setUsageEditError(result.globalError); return }
      if (result.success) {
        setBucketUsages(prev => ({
          ...prev,
          [bucketId]: (prev[bucketId] ?? []).map(u => u.id === usageId
            ? { ...u, usedAt: new Date(usageEditDraft.usedAt).toISOString(), usedKg: parseFloat(usageEditDraft.usedKg), productName: usageEditDraft.productName || null, operator: usageEditDraft.operator || null, notes: usageEditDraft.notes || null }
            : u
          ),
        }))
        if (result.newRemainingWeightKg !== undefined) {
          setBuckets(prev => prev.map(b => b.id === bucketId
            ? { ...b, remainingWeightKg: result.newRemainingWeightKg!, status: result.newStatus ?? b.status }
            : b
          ))
        }
        setEditingUsageId(null)
        setUsageEditDraft(null)
      }
    })
  }

  // ── 完成日を保存 ───────────────────────────────────────
  function handleCompletedAtSave() {
    if (!completedAtDraft) { setEditingCompletedAt(false); return }
    startCompletedAtTransition(async () => {
      const result = await updateCompletedAt(id, completedAtDraft + 'T00:00:00')
      if (result.error) return
      setCompletedAtValue(new Date(completedAtDraft + 'T00:00:00').toISOString())
      setEditingCompletedAt(false)
    })
  }

  // ── 場所温度を保存 ─────────────────────────────────────
  function handleLocTempSave(locationId: string) {
    if (cancelLocTempRef.current) { cancelLocTempRef.current = false; return }
    const parsed = parseFloat(locTempDraft)
    if (isNaN(parsed) || parsed < 10 || parsed > 45) {
      setLocTempError('10〜45の範囲で入力してください')
      return
    }
    setLocTempError(null)
    startLocTempTransition(async () => {
      const result = await updateLocationTemp(locationId, parsed)
      if (result.error) { setLocTempError(result.error); return }
      setEditingLocId(null)
    })
  }

  // ── 仕込み記録編集 ────────────────────────────────────
  function handleBrewEdit() {
    if (!localBrewRecord) return
    setBrewDraft(toBrewDraft(localBrewRecord))
    setBrewSaveError(null)
    setEditingBrew(true)
  }

  function handleBrewCancel() {
    setEditingBrew(false)
    setBrewDraft(null)
    setBrewSaveError(null)
  }

  function handleBrewSave() {
    if (!brewDraft) return
    setBrewSaveError(null)
    startBrewTransition(async () => {
      const result = await updateBrewRecord(id, draftToInput(brewDraft))
      if (result.error) { setBrewSaveError(result.error); return }
      setLocalBrewRecord(draftToBrewRecord(brewDraft))
      setEditingBrew(false)
      setBrewDraft(null)
    })
  }

  // ── 熟成中に戻す ───────────────────────────────────────
  function handleRevert() {
    setRevertError(null)
    setConfirmRevert(false)
    startRevertTransition(async () => {
      const result = await revertLotStatus(id, skipStockUpdate)
      if (result.error) { setRevertError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div className="max-w-[1280px] mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">

      {/* 戻るリンク */}
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        ダッシュボードへ
      </Link>

      {/* ── ヘッダー ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">{lotNumber}</h1>
          {isPrototype && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700 border border-violet-200">
              試作
            </span>
          )}
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
            style={getMisoTypeBadgeStyle(misoType)}
          >
            {misoType}
          </span>
          <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${STATUS_BADGE[status] ?? ''}`}>
            {status}
          </span>
          {status === '熟成中' && (
            <span className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${RISK_CLASS[coloringRisk]}`}>
              {RISK_LABEL[coloringRisk]}
            </span>
          )}
        </div>

        <div className="text-sm text-muted-foreground space-y-0.5">
          <p>仕込み日：{format(brewedAt, 'yyyy年M月d日')}（{elapsedDays}日経過）</p>
          <p>
            仕立量：{totalWeightKg.toLocaleString()} kg　目標積算温度：{targetTempSum} ℃・日
            <span className="ml-3">
              熟成日数：<span className="font-medium">{agingDays}日</span>
              {status === '熟成中' && <span className="text-xs ml-1 text-blue-600">（熟成中）</span>}
            </span>
          </p>
          {brewStats && (
            <p>
              麹歩合：<span className="font-medium">{brewStats.kojiRatio}割</span>
              <span className="mx-2 text-gray-300">|</span>
              塩分：<span className="font-medium">{brewStats.saltPercent}%</span>
              <span className="mx-2 text-gray-300">|</span>
              水分：<span className="font-medium">{brewStats.moisturePercent}%</span>
            </p>
          )}
          {/* 桶番号（インライン編集） */}
          {editingBucket ? (
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              <span>桶番号：</span>
              <select
                value={bucketDraft}
                onChange={e => setBucketDraft(e.target.value)}
                className="rounded border bg-background px-2 py-1 text-sm text-foreground"
              >
                <option value="">指定なし</option>
                {BUCKET_PAIRS.map(p => (
                  <option key={p} value={p}>{p} 号</option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleBucketSave}
                disabled={isBucketSaving}
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {isBucketSaving ? '保存中...' : '保存'}
              </button>
              <button
                type="button"
                onClick={() => { setEditingBucket(false); setBucketDraft(currentBucketNumbers ?? '') }}
                disabled={isBucketSaving}
                className="rounded border px-3 py-1 text-xs disabled:opacity-50"
              >
                キャンセル
              </button>
              {bucketError && <span className="text-red-600 text-xs">{bucketError}</span>}
            </div>
          ) : (
            <p>
              桶番号：{currentBucketNumbers ? `${currentBucketNumbers} 号` : '未登録'}
              <button
                type="button"
                onClick={() => { setBucketDraft(currentBucketNumbers ?? ''); setEditingBucket(true) }}
                className="ml-2 text-xs text-primary underline underline-offset-2"
              >
                編集
              </button>
            </p>
          )}
          {/* 完成日（出荷済・完成・品質低下出荷・種みそ転用は編集可） */}
          {status !== '熟成中' && (
            editingCompletedAt ? (
              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                <span>完成日：</span>
                <input
                  type="date"
                  autoFocus
                  value={completedAtDraft}
                  onChange={e => setCompletedAtDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleCompletedAtSave() }
                    if (e.key === 'Escape') { e.preventDefault(); cancelCompletedAtRef.current = true; setEditingCompletedAt(false) }
                  }}
                  onBlur={() => {
                    if (cancelCompletedAtRef.current) { cancelCompletedAtRef.current = false; return }
                    handleCompletedAtSave()
                  }}
                  disabled={isSavingCompletedAt}
                  className="rounded border bg-background px-2 py-0.5 text-sm text-foreground disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => { cancelCompletedAtRef.current = true; setEditingCompletedAt(false) }}
                  disabled={isSavingCompletedAt}
                  className="text-xs text-muted-foreground underline underline-offset-2 disabled:opacity-50"
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5">
                <span>完成日：</span>
                {completedAtValue
                  ? <span>{format(new Date(completedAtValue), 'yyyy年M月d日')}</span>
                  : <span className="text-gray-400">未設定</span>}
                <button
                  type="button"
                  onClick={() => {
                    setCompletedAtDraft(completedAtValue ? format(new Date(completedAtValue), 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd'))
                    setEditingCompletedAt(true)
                  }}
                  title="完成日を編集"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </p>
            )
          )}
        </div>

        {/* 進捗バー */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{hasPost ? '積算温度（完成まで）' : '積算温度'}</span>
            <span className="font-medium tabular-nums">
              {Math.round(accumulatedTemp)} / {targetTempSum} ℃・日
              <span className="text-muted-foreground ml-2">({Math.round(rawProgressPct)}%)</span>
              {/* バーが2色なので数字も両方出す */}
              {hasPost && (
                <span className={`ml-1 ${coloringRisk === 'danger' ? 'text-rose-600' : 'text-amber-600'}`}>
                  → 累計 {Math.round(totalPct)}%
                </span>
              )}
            </span>
          </div>
          <div className="relative w-full">
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden flex">
              {/* 完成までの分。色は完成時点の熟成度で決める */}
              <div
                className={`h-full ${PROGRESS_COLOR[
                  rawProgressPct >= 150 ? 'danger' : rawProgressPct >= 120 ? 'warning' : 'normal'
                ]}`}
                style={{ width: `${barWidth}%` }}
              />
              {postBarWidth > 0 && (
                <div
                  className={`h-full ${coloringRisk === 'danger' ? 'bg-rose-400' : 'bg-amber-400'}`}
                  style={{ width: `${postBarWidth}%` }}
                  title="完成後に進んだ熟成"
                />
              )}
            </div>
            {/* 目盛り（完成100% / 要注意120% / リスク高150%） */}
            {scaleTicks.map(t => (
              <span
                key={t.pct}
                className="absolute top-0 h-2 w-px bg-white/80"
                style={{ left: `${(t.pct / scaleMax) * 100}%` }}
                title={`${t.label} ${t.pct}%`}
                aria-hidden
              />
            ))}
            {isOverScale && (
              <span className="absolute -top-0.5 -right-1 text-[10px] leading-none text-rose-500" title={`目盛り${scaleMax}%を超過`}>
                ▶
              </span>
            )}
          </div>
          {useRiskScale && (
            <div className="relative h-3 text-[9px] text-gray-400 select-none" aria-hidden>
              {scaleTicks.map(t => (
                <span key={t.pct} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(t.pct / scaleMax) * 100}%` }}>
                  {t.pct}
                </span>
              ))}
              <span className="absolute right-0 whitespace-nowrap">{scaleMax}%</span>
            </div>
          )}
          {hasPost && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                完成後の熟成
                <span className="text-muted-foreground/70 ml-1 text-xs">（{currentLocation}）</span>
              </span>
              <span className="font-medium tabular-nums text-amber-700">
                +{Math.round(postTemp)} ℃・日
                <span className="text-muted-foreground ml-2 font-normal">
                  累計 {Math.round(totalPct)}%（着色リスクはこの値で判定）
                </span>
              </span>
            </div>
          )}
        </div>

        {/* 現在地と完成予定日 */}
        <div className="flex flex-wrap gap-4 text-sm pt-1">
          <div className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{currentLocation}</span>
            {(status === '熟成中' || status === '完成') && (
              <Link
                href={`/lots/${id}/move`}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
              >
                移動記録
              </Link>
            )}
          </div>
          {estimatedCompletion && status === '熟成中' && (
            <div className="text-muted-foreground">
              完成予定：
              <span className="font-medium text-foreground ml-1">
                {format(estimatedCompletion, 'M月d日')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* PC専用。1カラムで縦2,000pxあったので、
          左＝熟成の経過（グラフ・場所履歴・桶・仕込み記録）／右＝記録と操作 に分ける */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 sm:gap-6 items-start">
      <div className="space-y-4 sm:space-y-6 min-w-0">

      {/* ── 熟成シミュレーショングラフ ── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-3">熟成シミュレーション</h2>
        <div className="rounded-xl border border-gray-100 p-3">
          <LotSimChart
            brewedAtISO={brewedAtISO}
            targetTempSum={targetTempSum}
            weatherAvg={weatherAvg}
            heatingBaseTemp={heatingBaseTemp}
            q10Value={q10Value}
            fridgeTemp={fridgeTemp}
            locationPeriods={locationPeriods}
            completedAtISO={completedAtISO}
            /* ヘッダーの「完成予定」と同じ較正をかける（渡さないと数日ズレる） */
            actualAccumToday={status === '熟成中' ? accumulatedTemp : null}
          />
        </div>
      </section>

      {/* ── 場所履歴タイムライン ── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-3">場所履歴</h2>
        <div className="rounded-xl border border-gray-100 divide-y">
          {locationPeriods.map((p) => {
            const isEditable = /^(暖房|冷房)/.test(p.location)
            const isEditing  = editingLocId === p.id
            const locPrefix  = p.location.match(/^(暖房|冷房)/)?.[1] ?? ''
            return (
              <div key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  {isEditing ? (
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-muted-foreground">{locPrefix}</span>
                      <input
                        type="number"
                        min={10}
                        max={45}
                        step={1}
                        value={locTempDraft}
                        onChange={e => setLocTempDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.currentTarget.blur(); handleLocTempSave(p.id) }
                          if (e.key === 'Escape') { cancelLocTempRef.current = true; setEditingLocId(null); setLocTempError(null) }
                        }}
                        onBlur={() => handleLocTempSave(p.id)}
                        disabled={isSavingLocTemp}
                        autoFocus
                        className="w-16 rounded border px-2 py-0.5 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <span className="font-medium text-muted-foreground">℃</span>
                      {locTempError && (
                        <span className="text-xs text-red-600">{locTempError}</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{normalizeLocation(p.location)}</span>
                      {isEditable && (
                        <button
                          type="button"
                          onClick={() => {
                            const m = p.location.match(/(\d+(?:\.\d+)?)℃$/)
                            setLocTempDraft(m ? m[1] : '')
                            setLocTempError(null)
                            setEditingLocId(p.id)
                          }}
                          className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                          title="温度を編集"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {format(new Date(p.startDateISO), 'yyyy/MM/dd')}
                    {' → '}
                    {p.endDateISO ? format(new Date(p.endDateISO), 'yyyy/MM/dd') : '現在'}
                  </p>
                </div>
                <span className="tabular-nums text-muted-foreground">
                  +{p.accumulated.toFixed(1)} ℃
                </span>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── 桶管理 ── */}
      <section className="rounded-xl border border-gray-100 px-4 py-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">桶別残量</h2>
          {!showAddBucket && (
            <button
              type="button"
              onClick={() => {
                // 初期重量のデフォルト値を歩留まり率から自動計算
                const isShiro = misoType === '白みそ'
                const defaultKg = isShiro
                  ? Math.floor(totalWeightKg * yieldRate)
                  : Math.floor(totalWeightKg * yieldRate / 2)
                setAddBucketKg(String(defaultKg))
                setShowAddBucket(true)
              }}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              ＋ 桶を追加
            </button>
          )}
        </div>

        {/* 桶一覧 */}
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">桶が登録されていません</p>
        ) : (
          <>
            <div className={`grid gap-3 ${buckets.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {buckets.map(b => {
                const isEmpty   = b.status === '空'
                const isActive  = b.status === '使用中'
                const isWaiting = b.status === '待機中'
                const current   = b.remainingWeightKg ?? b.initialWeightKg
                const draftVal  = bucketDrafts[b.id] !== undefined ? bucketDrafts[b.id] : String(current)
                const parsedDraft = parseFloat(draftVal)
                const barKg     = isNaN(parsedDraft) ? current : Math.max(0, parsedDraft)
                const barPct    = b.initialWeightKg > 0 ? (barKg / b.initialWeightKg) * 100 : 0
                const barColor  = isEmpty    ? 'bg-gray-200'
                                : isWaiting  ? 'bg-slate-400'
                                : barPct >= 60 ? 'bg-emerald-500'
                                : barPct >= 30 ? 'bg-amber-400'
                                :                'bg-rose-500'
                const usages    = bucketUsages[b.id] ?? []
                const isExpanded = expandedBuckets[b.id] ?? false
                const form      = usageForm[b.id] ?? emptyUsageForm()
                const errs      = usageErrors[b.id] ?? {}
                const gErr      = usageGlobalError[b.id] ?? null
                return (
                  <div key={b.id} className={`text-sm rounded-xl border border-gray-100 ${isEmpty ? 'opacity-50' : ''}`}>
                    <div className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{b.bucketNumber}号桶</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${
                            isActive ? 'bg-blue-50 border-blue-200 text-blue-700' :
                            isEmpty  ? 'bg-gray-50 border-gray-200 text-gray-400' :
                            'bg-gray-50 border-gray-200 text-gray-500'
                          }`}>
                            {b.status}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          初期 {b.initialWeightKg.toLocaleString()} kg
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-muted-foreground shrink-0">残量</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={draftVal}
                          onChange={e => setBucketDrafts(prev => ({ ...prev, [b.id]: e.target.value }))}
                          onBlur={() => handleBucketRemainingChange(b.id)}
                          onKeyDown={e => { if (e.key === 'Enter') handleBucketRemainingChange(b.id) }}
                          disabled={bucketSavingId === b.id}
                          className="w-28 rounded-md border bg-background px-2 py-1 text-sm tabular-nums disabled:opacity-50"
                        />
                        <span className="text-muted-foreground">kg</span>
                        {bucketSavingId === b.id && (
                          <span className="text-xs text-muted-foreground">保存中...</span>
                        )}
                      </div>
                      {/* 残量バーゲージ */}
                      <div className="mb-2 space-y-0.5">
                        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${barColor}`}
                            style={{ width: `${Math.min(100, isEmpty ? 0 : barPct < 1 && barKg > 0 ? 2 : barPct)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                          <span>{Math.round(barKg).toLocaleString()} / {b.initialWeightKg.toLocaleString()} kg</span>
                          <span>{Math.round(barPct)}%</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpandedBuckets(prev => ({ ...prev, [b.id]: !prev[b.id] }))}
                        className="flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                      >
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        使用記録{usages.length > 0 ? `（${usages.length}件）` : ''}
                      </button>
                    </div>

                    {/* 使用記録展開パネル */}
                    {isExpanded && (
                      <div className="border-t bg-muted/30 px-4 py-3 space-y-3">
                        {/* 追加フォーム */}
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">使用記録を追加</p>
                          <div className="flex flex-wrap gap-2 items-end">
                            <div className="space-y-0.5">
                              <label className="text-xs text-muted-foreground">日付</label>
                              <input
                                type="date"
                                value={form.usedAt}
                                onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, usedAt: e.target.value } }))}
                                className="block rounded-md border bg-background px-2 py-1 text-sm"
                              />
                              {errs.usedAt && <p className="text-xs text-red-600">{errs.usedAt}</p>}
                            </div>
                            <div className="space-y-0.5">
                              <label className="text-xs text-muted-foreground">使用量 (kg)</label>
                              <input
                                type="number"
                                min="0.1"
                                step="1"
                                value={form.usedKg}
                                onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, usedKg: e.target.value } }))}
                                placeholder="例: 200"
                                className="w-28 rounded-md border bg-background px-2 py-1 text-sm"
                              />
                              {errs.usedKg && <p className="text-xs text-red-600">{errs.usedKg}</p>}
                            </div>
                            <div className="space-y-0.5 min-w-36">
                              <label className="text-xs text-muted-foreground">製品名</label>
                              {productNameOptions.length > 0 ? (
                                <select
                                  value={form.productName}
                                  onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, productName: e.target.value } }))}
                                  className="block w-36 rounded-md border bg-background px-2 py-1 text-sm"
                                >
                                  <option value="">選択…</option>
                                  {productNameOptions.map(name => (
                                    <option key={name} value={name}>{name}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={form.productName}
                                  onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, productName: e.target.value } }))}
                                  placeholder="製品名（設定で選択肢を登録可）"
                                  className="block w-36 rounded-md border bg-background px-2 py-1 text-sm"
                                />
                              )}
                            </div>
                            <div className="space-y-0.5 min-w-28">
                              <label className="text-xs text-muted-foreground">操作者</label>
                              {operatorOptions.length > 0 ? (
                                <select
                                  value={form.operator}
                                  onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, operator: e.target.value } }))}
                                  className="block w-28 rounded-md border bg-background px-2 py-1 text-sm"
                                >
                                  <option value="">選択…</option>
                                  {operatorOptions.map(name => (
                                    <option key={name} value={name}>{name}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={form.operator}
                                  onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, operator: e.target.value } }))}
                                  placeholder="操作者（設定で登録可）"
                                  className="block w-28 rounded-md border bg-background px-2 py-1 text-sm"
                                />
                              )}
                            </div>
                            <div className="space-y-0.5 flex-1 min-w-32">
                              <label className="text-xs text-muted-foreground">補足メモ（任意）</label>
                              <input
                                type="text"
                                value={form.notes}
                                onChange={e => setUsageForm(prev => ({ ...prev, [b.id]: { ...form, notes: e.target.value } }))}
                                placeholder="出荷先など補足"
                                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleUsageSubmit(b.id)}
                              disabled={isUsageSubmitting || !form.usedKg}
                              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50 shrink-0"
                            >
                              {isUsageSubmitting ? '保存中...' : '記録'}
                            </button>
                          </div>
                          {gErr && <p className="text-xs text-red-600">{gErr}</p>}
                        </div>

                        {/* 使用記録一覧 */}
                        {usages.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-1">使用記録はまだありません</p>
                        ) : (
                          <div className="divide-y rounded-md border bg-background">
                            {usages.map(u => (
                              editingUsageId === u.id && usageEditDraft ? (
                                <div key={u.id} className="px-3 py-2 space-y-2 bg-muted/30">
                                  <div className="flex flex-wrap gap-2 items-end">
                                    <div className="space-y-0.5">
                                      <label className="text-xs text-muted-foreground">日付</label>
                                      <input
                                        type="date"
                                        value={usageEditDraft.usedAt}
                                        onChange={e => setUsageEditDraft(d => d && { ...d, usedAt: e.target.value })}
                                        className="block w-32 rounded-md border bg-background px-2 py-1 text-xs"
                                      />
                                    </div>
                                    <div className="space-y-0.5">
                                      <label className="text-xs text-muted-foreground">使用量 (kg)</label>
                                      <input
                                        type="number" step="0.1"
                                        value={usageEditDraft.usedKg}
                                        onChange={e => setUsageEditDraft(d => d && { ...d, usedKg: e.target.value })}
                                        className="block w-24 rounded-md border bg-background px-2 py-1 text-xs"
                                      />
                                    </div>
                                    <div className="space-y-0.5">
                                      <label className="text-xs text-muted-foreground">製品名</label>
                                      <input
                                        type="text"
                                        value={usageEditDraft.productName}
                                        onChange={e => setUsageEditDraft(d => d && { ...d, productName: e.target.value })}
                                        className="block w-32 rounded-md border bg-background px-2 py-1 text-xs"
                                      />
                                    </div>
                                    <div className="space-y-0.5">
                                      <label className="text-xs text-muted-foreground">操作者</label>
                                      <input
                                        type="text"
                                        value={usageEditDraft.operator}
                                        onChange={e => setUsageEditDraft(d => d && { ...d, operator: e.target.value })}
                                        className="block w-24 rounded-md border bg-background px-2 py-1 text-xs"
                                      />
                                    </div>
                                    <div className="space-y-0.5 flex-1 min-w-32">
                                      <label className="text-xs text-muted-foreground">補足メモ</label>
                                      <input
                                        type="text"
                                        value={usageEditDraft.notes}
                                        onChange={e => setUsageEditDraft(d => d && { ...d, notes: e.target.value })}
                                        className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                                      />
                                    </div>
                                  </div>
                                  {usageEditError && <p className="text-xs text-red-600">{usageEditError}</p>}
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleUsageEditSave(u.id, b.id)}
                                      disabled={isUsageEditSubmitting || !usageEditDraft.usedKg}
                                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                                    >
                                      {isUsageEditSubmitting ? '保存中...' : '保存'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={handleUsageEditCancel}
                                      disabled={isUsageEditSubmitting}
                                      className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
                                    >
                                      キャンセル
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div key={u.id} className="flex items-center justify-between px-3 py-2 text-xs gap-2">
                                  <div className="space-y-0.5">
                                    <div>
                                      <span className="font-medium tabular-nums">{format(new Date(u.usedAt), 'yyyy/MM/dd')}</span>
                                      <span className="ml-2 text-muted-foreground">{u.usedKg.toLocaleString()} kg 使用</span>
                                      {u.productName && <span className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{u.productName}</span>}
                                    </div>
                                    {u.operator && <p className="text-muted-foreground">操作者: {u.operator}</p>}
                                    {u.notes && <p className="text-muted-foreground">{u.notes}</p>}
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => handleUsageEditStart(u)}
                                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60"
                                      aria-label="編集"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleUsageDelete(u.id, b.id)}
                                      disabled={deletingUsageId === u.id}
                                      className="text-muted-foreground hover:text-red-600 disabled:opacity-50 text-xs"
                                    >
                                      {deletingUsageId === u.id ? '削除中' : '削除'}
                                    </button>
                                  </div>
                                </div>
                              )
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-sm text-muted-foreground text-right">
              合計残量：<span className="font-medium text-foreground">
                {Math.round(
                  buckets.filter(b => b.status !== '空')
                    .reduce((sum, b) => sum + (b.remainingWeightKg ?? b.initialWeightKg), 0)
                ).toLocaleString()} kg
              </span>
            </p>
          </>
        )}

        {/* 桶を追加フォーム */}
        {showAddBucket && (
          <div className="rounded-xl bg-gray-50/70 px-4 py-3 space-y-3 border border-gray-100">
            <h3 className="text-sm font-medium">桶を追加</h3>
            <div className="flex gap-3 flex-wrap items-end">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">桶番号（0〜30）</label>
                <input
                  type="number" min="0" max="30"
                  value={addBucketNum}
                  onChange={e => setAddBucketNum(e.target.value)}
                  className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
                  placeholder="例: 13"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">初期重量 (kg)</label>
                <input
                  type="number" min="1"
                  value={addBucketKg}
                  onChange={e => setAddBucketKg(e.target.value)}
                  className="w-28 rounded-md border bg-background px-2 py-1.5 text-sm"
                  placeholder="例: 800"
                />
              </div>
              <button
                type="button"
                onClick={handleAddBucket}
                disabled={isAddingBucket || !addBucketNum || !addBucketKg}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {isAddingBucket ? '保存中...' : '追加'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddBucket(false); setAddBucketNum(''); setAddBucketKg('') }}
                disabled={isAddingBucket}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── 全桶空プロンプト（完成ロットのみ） ── */}
      {showAllEmptyPrompt && status === '完成' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-4 space-y-3">
          <div className="flex items-start gap-2">
            <span className="text-amber-600 text-lg leading-none">⚠</span>
            <div>
              <p className="text-sm font-semibold text-amber-800">このロットの全桶が空になりました</p>
              <p className="text-sm text-amber-700 mt-0.5">出荷済みにしますか？</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowAllEmptyPrompt(false)}
              className="flex-1 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-50 transition-colors"
            >
              後で
            </button>
            <button
              type="button"
              onClick={() => { setShowAllEmptyPrompt(false); handleStatusChange('出荷済') }}
              disabled={isStatusChanging}
              className="flex-1 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {isStatusChanging ? '変更中...' : '出荷済みにする'}
            </button>
          </div>
        </div>
      )}

      {/* ── 仕込み記録（折りたたみ） ── */}
      {localBrewRecord && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setShowBrew(v => !v)}
              className="flex items-center gap-1 text-base font-semibold"
            >
              <span>仕込み記録</span>
              {showBrew ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {showBrew && !editingBrew && (
              <button
                type="button"
                onClick={handleBrewEdit}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/60 transition-colors"
              >
                <Pencil className="h-3 w-3" />
                編集
              </button>
            )}
          </div>
          {showBrew && !editingBrew && (
            <div className="rounded-xl border border-gray-100 px-4 py-2 space-y-4">
              {/* 配合 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">原料配合</h3>
                <Row label="穀物原料" value={`${localBrewRecord.mugiOrKomeKg} kg`} />
                <Row label="麹（処理後）" value={`${localBrewRecord.kojiKg} kg`} />
                <Row label="大豆" value={`${localBrewRecord.soybeanKg} kg`} />
                <Row label="塩" value={`${localBrewRecord.saltKg} kg`} />
                {localBrewRecord.mizuameKg > 0 && <Row label="水飴" value={`${localBrewRecord.mizuameKg} kg`} />}
                {localBrewRecord.seedWaterL > 0 && (
                  <Row label="種水" value={`${localBrewRecord.seedWaterL} ℓ（${litersToToText(String(localBrewRecord.seedWaterL))} 斗）`} />
                )}
                {localBrewRecord.seedMisoKg > 0 && <Row label="種味噌" value={`${localBrewRecord.seedMisoKg} kg`} />}
                <Row label="仕立量" value={`${localBrewRecord.shikomiKg} kg`} />
                {localBrewRecord.taneKojiG > 0 && <Row label="種麹" value={`${localBrewRecord.taneKojiG} g`} />}
              </div>
              {/* 原料情報 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">原料情報</h3>
                {localBrewRecord.soybeanOrigin && <Row label="大豆産地" value={localBrewRecord.soybeanOrigin} />}
                {localBrewRecord.soybeanOriginDetail && <Row label="産地詳細" value={localBrewRecord.soybeanOriginDetail} />}
                {localBrewRecord.soybeanSupplier && <Row label="大豆仕入先" value={localBrewRecord.soybeanSupplier} />}
                {localBrewRecord.soybeanLotNo && <Row label="大豆ロット" value={localBrewRecord.soybeanLotNo} />}
                {localBrewRecord.soybeanArrivalDate && <Row label="大豆入荷日" value={format(new Date(localBrewRecord.soybeanArrivalDate), 'yyyy/MM/dd')} />}
                {localBrewRecord.kojiSupplier && <Row label="麹仕入先" value={localBrewRecord.kojiSupplier} />}
                {localBrewRecord.kojiMadeAt && <Row label="製麹日" value={format(new Date(localBrewRecord.kojiMadeAt), 'yyyy/MM/dd')} />}
                {localBrewRecord.saltBrand && <Row label="塩ブランド" value={localBrewRecord.saltBrand} />}
                {localBrewRecord.saltLotNo && <Row label="塩ロット" value={localBrewRecord.saltLotNo} />}
                {localBrewRecord.mizuameBrand && <Row label="水飴ブランド" value={localBrewRecord.mizuameBrand} />}
                {localBrewRecord.mizuameLotNo && <Row label="水飴ロット" value={localBrewRecord.mizuameLotNo} />}
              </div>
              {/* 製造記録 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">製造記録</h3>
                {localBrewRecord.kojiCondition != null && <Row label="出麹評価" value={`${localBrewRecord.kojiCondition}`} />}
                {localBrewRecord.soybeanHardness && <Row label="大豆硬度" value={localBrewRecord.soybeanHardness} />}
                {localBrewRecord.airTempC != null && <Row label="仕込み時気温" value={`${localBrewRecord.airTempC} ℃`} />}
                {localBrewRecord.productTempC != null && <Row label="仕込み時品温" value={`${localBrewRecord.productTempC} ℃`} />}
                {localBrewRecord.steamingPressure && <Row label="蒸煮条件" value={localBrewRecord.steamingPressure} />}
                {localBrewRecord.coolingMin && <Row label="冷却時間" value={localBrewRecord.coolingMin} />}
                {localBrewRecord.memo && <Row label="メモ" value={localBrewRecord.memo} />}
              </div>
            </div>
          )}
          {showBrew && editingBrew && brewDraft && (
            <div className="rounded-xl border border-blue-100 bg-blue-50/30 px-4 py-4 space-y-5">
              {/* 原料配合 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">原料配合</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                  {([
                    ['穀物原料 (kg)', 'mugiOrKomeKg'],
                    ['麹（処理後）(kg)', 'kojiKg'],
                    ['大豆 (kg)', 'soybeanKg'],
                    ['塩 (kg)', 'saltKg'],
                    ['水飴 (kg)', 'mizuameKg'],
                    ['種水 (ℓ)', 'seedWaterL'],
                    ['種味噌 (kg)', 'seedMisoKg'],
                    ['仕立量 (kg)', 'shikomiKg'],
                    ['種麹 (g)', 'taneKojiG'],
                  ] as [string, keyof BrewRecordDraft][]).map(([label, key]) => (
                    <div key={key} className="space-y-0.5">
                      <label className="text-xs text-muted-foreground">{label}</label>
                      {key === 'seedWaterL' ? (
                        // 種水は現場が斗で数えるため、ℓと斗のどちらでも入れられるようにする
                        // （保存するのは ℓ のみ。ロット登録フォームと同じ換算 lib/units.ts）
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number" step="0.1"
                            value={brewDraft[key]}
                            onChange={e => {
                              setSeedWaterToDraft(null)
                              setBrewDraft(d => d ? { ...d, seedWaterL: e.target.value } : d)
                            }}
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                          />
                          <span className="text-[11px] text-muted-foreground shrink-0">≒</span>
                          <input
                            type="number" step="0.1"
                            aria-label="種水（斗）"
                            value={seedWaterToDraft ?? litersToToText(brewDraft.seedWaterL)}
                            onChange={e => {
                              const v = e.target.value
                              setSeedWaterToDraft(v)
                              setBrewDraft(d => d ? { ...d, seedWaterL: toToLitersText(v) } : d)
                            }}
                            onBlur={() => setSeedWaterToDraft(null)}
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                          />
                          <span className="text-xs text-muted-foreground shrink-0">斗</span>
                        </div>
                      ) : (
                        <input
                          type="number" step="0.1"
                          value={brewDraft[key]}
                          onChange={e => setBrewDraft(d => d ? { ...d, [key]: e.target.value } : d)}
                          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {/* 原料情報 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">原料情報</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                  {([
                    ['大豆産地', 'soybeanOrigin'],
                    ['産地詳細', 'soybeanOriginDetail'],
                    ['大豆仕入先', 'soybeanSupplier'],
                    ['大豆ロット番号', 'soybeanLotNo'],
                    ['麹仕入先', 'kojiSupplier'],
                    ['塩ブランド', 'saltBrand'],
                    ['塩ロット番号', 'saltLotNo'],
                    ['水飴ブランド', 'mizuameBrand'],
                    ['水飴ロット番号', 'mizuameLotNo'],
                  ] as [string, keyof BrewRecordDraft][]).map(([label, key]) => (
                    <div key={key} className="space-y-0.5">
                      <label className="text-xs text-muted-foreground">{label}</label>
                      <input
                        type="text"
                        value={brewDraft[key]}
                        onChange={e => setBrewDraft(d => d ? { ...d, [key]: e.target.value } : d)}
                        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                      />
                    </div>
                  ))}
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">大豆入荷日</label>
                    <input
                      type="date"
                      value={brewDraft.soybeanArrivalDate}
                      onChange={e => setBrewDraft(d => d ? { ...d, soybeanArrivalDate: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">製麹日</label>
                    <input
                      type="date"
                      value={brewDraft.kojiMadeAt}
                      onChange={e => setBrewDraft(d => d ? { ...d, kojiMadeAt: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
              </div>
              {/* 製造記録 */}
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">製造記録</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">出麹評価（3〜9）</label>
                    <input
                      type="number" min="3" max="9" step="1"
                      value={brewDraft.kojiCondition}
                      onChange={e => setBrewDraft(d => d ? { ...d, kojiCondition: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">大豆硬度</label>
                    <input
                      type="text"
                      value={brewDraft.soybeanHardness}
                      onChange={e => setBrewDraft(d => d ? { ...d, soybeanHardness: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">仕込み時気温 (℃)</label>
                    <input
                      type="number" step="0.1"
                      value={brewDraft.airTempC}
                      onChange={e => setBrewDraft(d => d ? { ...d, airTempC: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">仕込み時品温 (℃)</label>
                    <input
                      type="number" step="0.1"
                      value={brewDraft.productTempC}
                      onChange={e => setBrewDraft(d => d ? { ...d, productTempC: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">蒸煮条件</label>
                    <input
                      type="text"
                      value={brewDraft.steamingPressure}
                      onChange={e => setBrewDraft(d => d ? { ...d, steamingPressure: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-xs text-muted-foreground">冷却時間</label>
                    <input
                      type="text"
                      value={brewDraft.coolingMin}
                      onChange={e => setBrewDraft(d => d ? { ...d, coolingMin: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="col-span-2 space-y-0.5">
                    <label className="text-xs text-muted-foreground">メモ</label>
                    <textarea
                      rows={3}
                      value={brewDraft.memo}
                      onChange={e => setBrewDraft(d => d ? { ...d, memo: e.target.value } : d)}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm resize-none"
                    />
                  </div>
                </div>
              </div>
              {brewSaveError && <p className="text-xs text-red-600">{brewSaveError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleBrewSave}
                  disabled={isSavingBrew}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-colors"
                >
                  {isSavingBrew ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={handleBrewCancel}
                  disabled={isSavingBrew}
                  className="rounded-md border px-4 py-2 text-sm disabled:opacity-50 transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      </div>
      {/* 右カラム：記録の追加とステータス操作 */}
      <div className="space-y-4 sm:space-y-6 min-w-0">

      {/* ── 熟成メモ ── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-3">熟成メモ</h2>

        {/* メモ追加フォーム */}
        {status === '熟成中' && (
          <div className="rounded-xl border border-gray-100 px-4 py-4 mb-4 space-y-3">
            <h3 className="text-sm font-medium">メモを追加</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">記録日</label>
                <input
                  type="date"
                  value={noteForm.recordedAt}
                  onChange={e => setNoteForm(f => ({ ...f, recordedAt: e.target.value }))}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                />
                {noteError.recordedAt && <p className="text-xs text-red-600">{noteError.recordedAt}</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">気温(℃)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={noteForm.airTempC}
                    onChange={e => setNoteForm(f => ({ ...f, airTempC: e.target.value }))}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    placeholder="任意"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">品温(℃)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={noteForm.productTempC}
                    onChange={e => setNoteForm(f => ({ ...f, productTempC: e.target.value }))}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    placeholder="任意"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">メモ</label>
              <textarea
                rows={2}
                value={noteForm.memo}
                onChange={e => setNoteForm(f => ({ ...f, memo: e.target.value }))}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm resize-none"
                placeholder="状態・観察記録など"
              />
              {noteError.memo && <p className="text-xs text-red-600">{noteError.memo}</p>}
            </div>
            {noteGlobalError && <p className="text-xs text-red-600">{noteGlobalError}</p>}
            <button
              type="button"
              onClick={handleNoteSubmit}
              disabled={isNoteSubmitting}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {isNoteSubmitting ? '保存中...' : 'メモを保存'}
            </button>
          </div>
        )}

        {/* メモ一覧 */}
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">メモはまだありません</p>
        ) : (
          <div className="space-y-2">
            {notes.map(note => (
              <div key={note.id} className="rounded-xl border border-gray-100 px-4 py-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{format(new Date(note.recordedAt), 'yyyy/MM/dd')}</span>
                  {(note.airTempC != null || note.productTempC != null) && (
                    <span className="text-xs text-muted-foreground">
                      {note.airTempC != null && `気温 ${note.airTempC}℃`}
                      {note.airTempC != null && note.productTempC != null && '　'}
                      {note.productTempC != null && `品温 ${note.productTempC}℃`}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground whitespace-pre-wrap">{note.memo}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── ステータス変更 ── */}
      {status === '熟成中' && (
        <section className="rounded-xl border border-gray-100 px-4 py-4 space-y-3">
          <h2 className="text-base font-semibold text-gray-900">完了処理</h2>
          <p className="text-sm text-muted-foreground">ステータスを変更すると完了日が記録されます。</p>
          {statusError && <p className="text-sm text-red-600">{statusError}</p>}

          {confirmStatus ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">「{confirmStatus}」に変更しますか？</p>
              {confirmStatus === '完成' && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">完成日</label>
                    <input
                      type="date"
                      value={completionDate}
                      onChange={e => setCompletionDate(e.target.value)}
                      className="block w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">在庫システムへの反映</p>
                    <div className={skipStockUpdate ? 'opacity-40 pointer-events-none' : ''}>
                      <StockPreviewPanel state={stockPreview} />
                    </div>
                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none pt-0.5">
                      <input
                        type="checkbox"
                        checked={!skipStockUpdate}
                        onChange={e => setSkipStockUpdate(!e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      在庫システムへ反映する
                    </label>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmStatus(null)}
                  disabled={isStatusChanging}
                  className="flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusChange(confirmStatus)}
                  disabled={isStatusChanging}
                  className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {isStatusChanging ? '変更中...' : '確定'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(['完成', '品質低下出荷', '種みそ転用', '出荷済'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setConfirmStatus(s)}
                  disabled={isStatusChanging}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── 完成ロット：出荷済みにする ── */}
      {status === '完成' && (
        <section className="rounded-xl border border-gray-100 px-4 py-4 space-y-3">
          <h2 className="text-base font-semibold text-gray-900">出荷済みにする</h2>
          <p className="text-sm text-muted-foreground">
            全桶が空になると自動で出荷済みになります。手動で変更する場合はこちら。
          </p>
          {statusError && <p className="text-sm text-red-600">{statusError}</p>}
          {confirmStatus === '出荷済' ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">「出荷済」に変更しますか？</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmStatus(null)}
                  disabled={isStatusChanging}
                  className="flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => handleStatusChange('出荷済')}
                  disabled={isStatusChanging}
                  className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {isStatusChanging ? '変更中...' : '確定'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmStatus('出荷済')}
              disabled={isStatusChanging}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              出荷済みにする
            </button>
          )}
        </section>
      )}

      {/* ── 熟成中に戻す ── */}
      {status !== '熟成中' && (
        <section className="rounded-xl border border-dashed border-gray-200 px-4 py-4 space-y-3">
          <h2 className="text-base font-semibold text-gray-900">ステータスを元に戻す</h2>
          <p className="text-sm text-muted-foreground">
            現在「{status}」です。誤って変更した場合は「熟成中」に戻せます。
          </p>
          {revertError && <p className="text-sm text-red-600">{revertError}</p>}

          {confirmRevert ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">「熟成中」に戻しますか？完了日もクリアされます。</p>
              {!isPrototype && (
                <>
                  <p className="text-sm font-medium text-gray-700">在庫システムへの反映内容を確認してください</p>
                  <StockPreviewPanel state={stockPreview} />
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!skipStockUpdate}
                      onChange={e => setSkipStockUpdate(!e.target.checked)}
                      className="h-4 w-4 rounded border-border accent-foreground"
                    />
                    <span className="text-sm">在庫システムへ反映する</span>
                  </label>
                </>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmRevert(false)}
                  disabled={isReverting}
                  className="flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={handleRevert}
                  disabled={isReverting}
                  className="flex-1 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  {isReverting ? '処理中...' : '熟成中に戻す'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRevert(true)}
              disabled={isReverting}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              熟成中に戻す
            </button>
          )}
        </section>
      )}

      {/* ── ロット削除 ── */}
      <section className="rounded-xl border border-dashed border-rose-200 px-4 py-4 space-y-3">
        <h2 className="text-base font-semibold text-rose-700">ロットを削除</h2>
        <p className="text-sm text-muted-foreground">
          このロットと関連するすべてのデータ（仕込み記録・場所履歴・熟成メモ・桶記録）を完全に削除します。
          この操作は取り消せません。
        </p>
        {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}

        {confirmDelete ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              「{lotNumber}」を削除しますか？この操作は取り消せません。
            </p>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">在庫システムへの反映</p>
              <div className={skipStockUpdate ? 'opacity-40 pointer-events-none' : ''}>
                <StockPreviewPanel state={stockPreview} />
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none pt-0.5">
                <input
                  type="checkbox"
                  checked={!skipStockUpdate}
                  onChange={e => setSkipStockUpdate(!e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                在庫システムへ反映する
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="flex-1 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? '削除中...' : '削除する'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={isDeleting}
            className="rounded-md border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            このロットを削除
          </button>
        )}
      </section>

      </div>
      </div>
    </div>
  )
}

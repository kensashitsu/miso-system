import Link from 'next/link'
import { differenceInDays, format, startOfDay } from 'date-fns'
import { AlertTriangle, Clock, CalendarClock, PackageSearch, CheckCircle2, Truck, FlaskConical } from 'lucide-react'
import { prisma } from '@/lib/prisma'
import { getMoistureSettings } from '@/lib/settings'
import {
  calcAccumulatedTempSplit,
  calcColoringRisk,
  getCurrentLocation,
} from '@/lib/tempCalc'
import { calcCompletionFromBrew } from '@/lib/brewSimulation'
import { fetchAgedStock } from '@/lib/externalApi'
import { getMaterialStock } from '@/lib/materialStock'
import { getMisoRecipes } from '@/lib/recipes'
import { makeSafetyLineFn } from '@/lib/brewPlanCalc'
import { fermentingKgOfLot } from '@/lib/lotStock'
import DashboardLotGroups from '@/components/dashboard/DashboardLotGroups'
import { type LotCardProps, type LotSimConfig } from '@/components/dashboard/lot-card'
import StockSummary from '@/components/dashboard/StockSummary'
import InventoryTrendChart from '@/components/dashboard/InventoryTrendChart'
import MaterialStock from '@/components/dashboard/MaterialStock'

// 常にサーバー側で最新データを取得する
export const dynamic = 'force-dynamic'


export default async function DashboardPage() {
  // weatherData は全期間取得（oldestBrewDate フィルタだと過去年の夏季データが欠落し
  // weatherAvg が空になるため、ロット積算計算・シミュレーター両方が正常に動作しない）
  const [moisture, agedStockData, recipes, weatherData, inventorySnapshots, brewPlans, materialStock] = await Promise.all([
    getMoistureSettings(),
    fetchAgedStock(),
    getMisoRecipes(),
    prisma.weatherCache.findMany({ orderBy: { date: 'asc' } }),
    prisma.monthlyInventorySnapshot.findMany({
      orderBy: [{ yearMonth: 'asc' }, { misoType: 'asc' }],
    }),
    // 仮登録の仕込み予定（本登録済＝ロット化されたものは熟成中ロットとして出るので除く）。
    // ダッシュボードには熟成と在庫しか無く「仕込み」の予定が抜けていたため追加（2026-08-31）
    prisma.brewPlan.findMany({
      where: { status: '仮登録', lotId: null },
      orderBy: { brewDate: 'asc' },
    }),
    // 原材料在庫（zaiko）。専用APIが無いため在庫調整のプレビュー（読み取り専用）から得る
    getMaterialStock(),
  ])

  // レシピの現在の目標積算温度を品種名でルックアップ
  const recipeTargetMap: Record<string, number> = {}
  for (const r of recipes) recipeTargetMap[r.name] = r.targetTempSum
  // 安全在庫ライン（熟成済バラ＋小分け製品の合算、kg）。未設定の品種は含めない
  const safetyStockMap: Record<string, number> = {}
  // 季節でラインが変わる（冬季11〜12月は厚め・夏季5〜8月は薄め）。未設定の季節は通年ライン
  const now = new Date()
  for (const r of recipes) {
    // 通年が未設定でも季節ラインだけ設定されている品種（例: 山吹みそ＝冬季300kg）がある
    if (r.safetyStockKg == null && r.winterSafetyStockKg == null && r.summerSafetyStockKg == null) continue
    const line = makeSafetyLineFn(r.safetyStockKg ?? 0, r.winterSafetyStockKg, r.summerSafetyStockKg)(now)
    if (line > 0) safetyStockMap[r.name] = line
  }
  // 表示する品種はレシピ（有効なもの）から。ハードコードすると品種追加時に
  // サマリー・グラフから無言で抜け落ちる
  const misoTypes = recipes.map(r => r.name)
  const roomTemps = { room1Temp: moisture.room1Temp, room2Temp: moisture.room2Temp, fridgeTemp: moisture.fridgeTemp, heatingBaseTemp: moisture.heatingDefaultTemp, q10Value: moisture.q10Value }

  // API在庫を品種別Mapに変換
  const agedStockMap: Record<string, { agedKg: number; packagedKg: number | null }> = {}
  for (const item of agedStockData ?? []) {
    agedStockMap[item.misoType] = {
      agedKg:    item.stockKg,
      packagedKg: item.packagedStockKg ?? null,
    }
  }

  // 出荷済を除くロットを取得
  const lots = await prisma.lot.findMany({
    where: { status: { notIn: ['出荷済'] } },
    include: {
      locationHistory: { orderBy: { startDate: 'asc' } },
      buckets: { orderBy: { bucketNumber: 'asc' } },
    },
  })

  // 日付文字列 → 有効積算温度のMap
  const weatherMap = new Map<string, number>(
    weatherData.map(w => [format(w.date, 'yyyy-MM-dd'), w.effectiveTemp])
  )

  // MM-dd別の有効積算温度平均（シミュレーター用）
  const wmTotals = new Map<string, { sum: number; count: number }>()
  for (const w of weatherData) {
    const key = format(w.date, 'MM-dd')
    const entry = wmTotals.get(key) ?? { sum: 0, count: 0 }
    entry.sum += w.effectiveTemp
    entry.count += 1
    wmTotals.set(key, entry)
  }
  const weatherAvg: Record<string, number> = {}
  for (const [key, { sum, count }] of wmTotals) {
    weatherAvg[key] = Math.round((sum / count) * 100) / 100
  }

  const simConfig: LotSimConfig = {
    weatherAvg,
    q10Value:           moisture.q10Value,
    heatingBaseTemp:    moisture.heatingDefaultTemp,
    room1Temp:          moisture.room1Temp,
    heatingDefaultTemp: moisture.heatingDefaultTemp,
    coolingDefaultTemp: moisture.coolingDefaultTemp,
    fridgeTemp:         moisture.fridgeTemp,
  }

  const today = startOfDay(new Date())

  // 各ロットの積算温度・リスク・完成予定日を計算
  const lotData: LotCardProps[] = lots.map(lot => {
    const targetTempSum   = recipeTargetMap[lot.misoType] ?? lot.targetTempSum
    // 「完成までの熟成度」と「完成後に進んだ分」を分けて出す。
    // 完成後も置き場の温度に応じて熟成は進むため、着色リスクは累計で判定する
    const accumUntil      = lot.status === '熟成中' ? null : lot.completedAt
    const accum           = calcAccumulatedTempSplit(lot.brewedAt, lot.locationHistory, weatherMap, roomTemps, accumUntil)
    const accumulated     = accum.untilCompletion
    const currentLocation = getCurrentLocation(lot.locationHistory)
    const coloringRisk    = calcColoringRisk(accum.total, targetTempSum)
    // 仕込み日起点シミュレーション（simulateLotForModal準拠）→ ロット詳細モーダルと完成予定日を統一。
    // 今日時点の実績積算（accumulated）を渡して較正するため、カードの熟成度%と同じ点を通る
    const estimatedCompletion =
      lot.status === '熟成中'
        ? calcCompletionFromBrew(
            lot.brewedAt, targetTempSum, currentLocation,
            weatherAvg, moisture.heatingDefaultTemp - 10, moisture.q10Value, moisture.heatingDefaultTemp, moisture.fridgeTemp,
            accumulated,
          )
        : null
    const elapsedDays = differenceInDays(today, startOfDay(lot.brewedAt))
    const locationTransitions = lot.locationHistory.slice(1).map((h, i) => ({
      date: format(h.startDate, 'yyyy-MM-dd'),
      from: lot.locationHistory[i].location,
      to:   h.location,
    }))

    return {
      id: lot.id,
      lotNumber: lot.lotNumber,
      misoType: lot.misoType,
      brewedAtISO: lot.brewedAt.toISOString(),
      elapsedDays,
      accumulatedTemp: accumulated,
      postCompletionTemp: accum.afterCompletion > 0 ? accum.afterCompletion : null,
      targetTempSum,
      currentLocation,
      estimatedCompletionISO: estimatedCompletion?.toISOString() ?? null,
      completedAtISO: lot.completedAt?.toISOString() ?? null,
      coloringRisk,
      status: lot.status,
      isPrototype: lot.isPrototype,
      bucketNumbers: lot.bucketNumbers ?? null,
      buckets: lot.buckets.map(b => ({
        bucketNumber: b.bucketNumber,
        initialKg:    b.initialWeightKg,
        remainingKg:  b.remainingWeightKg,
        status:       b.status,
      })),
      locationTransitions,
    }
  })

  // グループ分け
  const agingLots       = lotData.filter(l => l.status === '熟成中')
  const completedLots   = lotData.filter(l => l.status === '完成')
  const needsActionLots = lotData.filter(l => ['種みそ転用', '品質低下出荷'].includes(l.status))

  // 各グループを完成予定日昇順（null は末尾）→ 仕込み日降順 でソート
  const sortGroup = (arr: typeof lotData) =>
    arr.sort((a, b) => {
      if (a.estimatedCompletionISO && b.estimatedCompletionISO) {
        return new Date(a.estimatedCompletionISO).getTime() - new Date(b.estimatedCompletionISO).getTime()
      }
      if (a.estimatedCompletionISO) return -1
      if (b.estimatedCompletionISO) return 1
      return new Date(b.brewedAtISO).getTime() - new Date(a.brewedAtISO).getTime()
    })

  sortGroup(agingLots)
  sortGroup(completedLots)
  sortGroup(needsActionLots)

  // 熟成中ロットを品種別に集計（桶残量ベース。数え方は lib/lotStock.ts に集約）
  const fermentingKgByType: Record<string, number> = {}
  for (const lot of lots) {
    if (lot.status !== '熟成中') continue
    const kg = fermentingKgOfLot(lot, moisture.yieldRate)
    fermentingKgByType[lot.misoType] = (fermentingKgByType[lot.misoType] ?? 0) + kg
  }

  // 完成ロットの桶残量を品種別に集計（数え方は熟成中と同じ lib/lotStock.ts）。
  // 熟成済在庫は在庫API（zaiko）の値を正としているが、本システム側の残量と
  // ズレていないかをサマリーで突き合わせられるように併記する
  const systemAgedKgByType: Record<string, number> = {}
  for (const lot of lots) {
    if (lot.status !== '完成') continue
    const kg = fermentingKgOfLot(lot, moisture.yieldRate)
    systemAgedKgByType[lot.misoType] = (systemAgedKgByType[lot.misoType] ?? 0) + kg
  }

  // 着色リスク高は熟成中・完成の両方を対象にする（2026-08-30ユーザー判断）。
  // 完成後も置き場の温度に応じて着色は進むため（judgeは累計 total ベース）、
  // 完成ロットこそ「早めに出荷するか冷蔵庫へ移す」判断が要る
  const dangerLots          = agingLots.filter(l => l.coloringRisk === 'danger')
  // 完成ロットは、桶が全部空＝使い切っていれば対象外（下の activeBuckets で判定）
  const dangerCompletedLotsAll = completedLots.filter(l => l.coloringRisk === 'danger')
  // 表示用の累計%（完成ロットは完成後に進んだ分を足した値で判定している）
  const totalRiskPct = (l: LotCardProps) =>
    Math.round(((l.accumulatedTemp + (l.postCompletionTemp ?? 0)) / l.targetTempSum) * 100)
  // 中身が残っている桶だけを対象にする。空の桶は既に使い切っているので
  // 着色リスクの対象外（2026-08-30ユーザー指摘：25号は空で26号だけが対象）
  const activeBuckets = (l: LotCardProps) =>
    l.buckets.filter(b => b.status !== '空' && (b.remainingKg ?? b.initialKg) > 0)
  const remainingKg = (l: LotCardProps) =>
    activeBuckets(l).reduce((sum, b) => sum + (b.remainingKg ?? b.initialKg), 0)
  // 現場はロット番号より桶番号で覚えているため、「今日やること」に桶番号も出す。
  // 桶レコードがあるロットは残っている桶だけ、無い（古い）ロットは Lot.bucketNumbers をそのまま
  const lotLabel = (l: LotCardProps) => {
    const nums = l.buckets.length > 0
      ? activeBuckets(l).map(b => b.bucketNumber).join('・')
      : (l.bucketNumbers ?? '')
    return `${l.lotNumber}（${l.misoType}${nums ? `・桶${nums}` : ''}）`
  }
  // 着色リスクのアラートはロット番号では現場が分からない（桶と日付で覚えている）。
  // 品種＋桶番号と、仕込み日・仕込みからの経過日数・完成からの経過日数で書く
  const lotLabelNoNumber = (l: LotCardProps) => {
    const nums = l.buckets.length > 0
      ? activeBuckets(l).map(b => b.bucketNumber).join('・')
      : (l.bucketNumbers ?? '')
    return `${l.misoType}${nums ? `（桶${nums}）` : ''}`
  }
  const brewAgeText = (l: LotCardProps) => {
    const brewedAt = startOfDay(new Date(l.brewedAtISO))
    const parts = [`${format(brewedAt, 'M/d')}仕込み（${differenceInDays(today, brewedAt)}日経過）`]
    if (l.completedAtISO) {
      const completedAt = startOfDay(new Date(l.completedAtISO))
      parts.push(`完成${format(completedAt, 'M/d')}（${differenceInDays(today, completedAt)}日経過）`)
    }
    return parts.join('・')
  }

  const nearCompletionLots = agingLots.filter(l => {
    if (!l.estimatedCompletionISO) return false
    const days = differenceInDays(new Date(l.estimatedCompletionISO), today)
    return days >= 0 && days <= 7
  })
  // 安全在庫ラインを下回っている品種。判定は「熟成済バラ＋小分け製品」の合算で行う
  // （熟成中ロットは含めない）。仕込み計画のAI提案も同じ合算で在庫切れを判定しており基準は統一
  const lowSafetyStockTypes = Object.entries(safetyStockMap)
    .map(([type, line]) => {
      const aged = agedStockMap[type]?.agedKg ?? null
      return { type, line, agedKg: aged != null ? aged + (agedStockMap[type]?.packagedKg ?? 0) : null }
    })
    .filter(t => t.agedKg != null && t.agedKg < t.line)

  // 完成予定日を過ぎている熟成中ロット。ロットカードには「（超過）」と出ていたが
  // アラートには載っておらず、開いて最初に目に入らなかった（2026-08-30に追加）
  const overdueLots = agingLots
    .filter(l => l.estimatedCompletionISO && differenceInDays(new Date(l.estimatedCompletionISO), today) < 0)
    .map(l => ({ ...l, overdueDays: -differenceInDays(new Date(l.estimatedCompletionISO!), today) }))
    .sort((a, b) => b.overdueDays - a.overdueDays)

  // 仮登録の仕込み予定から「原料手配の締切」と「今週の仕込み」を拾う。
  // これまでダッシュボードは熟成と在庫しか映しておらず、毎週の仕込み判断が
  // 仕込み計画ページを開かないと分からなかった（手配締切が17日超過していた実例あり）
  const ORDER_ALERT_DAYS = 14   // 手配締切がこの日数以内なら出す
  const BREW_ALERT_DAYS  = 7    // 仕込み予定日がこの日数以内なら出す
  const DOW = ['日', '月', '火', '水', '木', '金', '土']
  const planLabel = (p: { misoType: string; bucketNumbers: string | null }) =>
    `${p.misoType}${p.bucketNumbers ? `（桶${p.bucketNumbers}）` : ''}`
  // 手配済みにチェックが入ったものは督促しない。これが無いと、ロット登録するまで
  // 同じ督促が出続けて壁紙化する（2026-08-31ユーザー指摘）
  const orderDeadlinePlans = brewPlans
    .filter(p => p.materialOrderedAt == null)
    .map(p => ({ p, days: differenceInDays(startOfDay(p.materialOrderDeadline), today) }))
    .filter(x => x.days <= ORDER_ALERT_DAYS)
    .sort((a, b) => a.days - b.days)
  const overdueOrderPlans  = orderDeadlinePlans.filter(x => x.days < 0)
  const upcomingOrderPlans = orderDeadlinePlans.filter(x => x.days >= 0)
  const upcomingBrewPlans = brewPlans
    .map(p => ({ p, days: differenceInDays(startOfDay(p.brewDate), today) }))
    .filter(x => x.days >= 0 && x.days <= BREW_ALERT_DAYS)
    .sort((a, b) => a.days - b.days)

  // 原材料の「あと何回分」の基準にする品種。次に仕込む予定のもの、
  // 予定が無ければ直近に仕込んだ品種を使う（画面の見出しに何基準かを出す）
  const nextPlan   = brewPlans.find(p => startOfDay(p.brewDate) >= today) ?? null
  const latestLot  = lots.filter(l => !l.isPrototype).sort((a, b) => b.brewedAt.getTime() - a.brewedAt.getTime())[0] ?? null
  const materialBaseType  = nextPlan?.misoType ?? latestLot?.misoType ?? null
  // 原材料ごとに基準品種が変わる（麦みそは裸麦、山吹みそは砕米…）ので、
  // これから仕込む予定の品種を順に渡し、その原材料を使う最初の品種で回数を出す
  const materialBasisOrder = [
    ...brewPlans.filter(p => startOfDay(p.brewDate) >= today).map(p => p.misoType),
    ...(latestLot ? [latestLot.misoType] : []),
  ].filter((t, i, arr) => arr.indexOf(t) === i)

  // 「今日やること」に出す項目。緊急度の高い順に並べる
  type Todo = { key: string; tone: 'rose' | 'amber' | 'orange' | 'blue'; icon: 'alert' | 'clock' | 'stock' | 'order' | 'brew'; label: string; body: string; href: string }
  const todos: Todo[] = [
    ...overdueLots.map(l => ({
      key: `over-${l.id}`, tone: 'rose' as const, icon: 'clock' as const,
      label: '完成予定を超過',
      body: `${lotLabel(l)}が完成予定日を ${l.overdueDays} 日過ぎています`,
      href: `/lots/${l.id}`,
    })),
    ...dangerLots.map(l => ({
      key: `color-${l.id}`, tone: 'rose' as const, icon: 'alert' as const,
      label: '着色リスク高',
      body: `${lotLabelNoNumber(l)}が目標の 150% を超えています（累計 ${totalRiskPct(l)}%）。${brewAgeText(l)}`,
      href: `/lots/${l.id}`,
    })),
    // 桶レコードがあるのに残っている桶が無い＝使い切ったロットは出さない
    ...dangerCompletedLotsAll
      .filter(l => l.buckets.length === 0 || activeBuckets(l).length > 0)
      .map(l => ({
        key: `color-done-${l.id}`, tone: 'rose' as const, icon: 'alert' as const,
        label: '着色リスク高（完成済）',
        body: `${lotLabelNoNumber(l)}は完成後も熟成が進み累計 ${totalRiskPct(l)}%。${brewAgeText(l)}。`
          + `${activeBuckets(l).length > 0 ? `残り ${Math.round(remainingKg(l)).toLocaleString()} kg。` : ''}`
          + `${l.currentLocation ? `現在地は${l.currentLocation}。` : ''}早めの出荷か冷蔵庫への移動を検討してください`,
        href: `/lots/${l.id}`,
      })),
    // 手配締切は仮登録の件数だけ出ると赤い行が並んで他が埋もれる（実際に4件並んで
    // 「煩い」と指摘された・2026-08-31）。行き先も対処も同じ（仕込み計画を見る）なので、
    // 超過分・予定分をそれぞれ1行にまとめ、代表として最も急ぐものだけ具体的に書く
    ...(overdueOrderPlans.length > 0 ? [{
      key: 'order-overdue',
      tone: 'rose' as const,
      icon: 'order' as const,
      label: '原料手配が締切超過',
      body: `${planLabel(overdueOrderPlans[0].p)}（${format(overdueOrderPlans[0].p.brewDate, 'M/d')} 仕込み予定）の手配締切 `
        + `${format(overdueOrderPlans[0].p.materialOrderDeadline, 'M/d')} を ${-overdueOrderPlans[0].days} 日超過`
        + (overdueOrderPlans.length > 1 ? `。ほか ${overdueOrderPlans.length - 1} 件` : '')
        + '。手配済みなら仮登録リストでチェックすると消えます',
      href: '/planning',
    }] : []),
    ...lowSafetyStockTypes.map(t => ({
      key: `safety-${t.type}`, tone: 'orange' as const, icon: 'stock' as const,
      label: '安全在庫ライン割れ',
      body: `${t.type} が ${Math.round(t.agedKg!).toLocaleString()} kg（ライン ${t.line.toLocaleString()} kg）を下回っています`,
      href: '/planning',
    })),
    ...(upcomingOrderPlans.length > 0 ? [{
      key: 'order-soon',
      tone: 'amber' as const,
      icon: 'order' as const,
      label: '原料手配の締切',
      body: `${planLabel(upcomingOrderPlans[0].p)}（${format(upcomingOrderPlans[0].p.brewDate, 'M/d')} 仕込み予定）の手配締切は `
        + `${format(upcomingOrderPlans[0].p.materialOrderDeadline, 'M/d')}（あと ${upcomingOrderPlans[0].days} 日）`
        + (upcomingOrderPlans.length > 1 ? `。ほか ${upcomingOrderPlans.length - 1} 件` : ''),
      href: '/planning',
    }] : []),
    // 仕込み予定は日付ごとにやることが変わる（その日に何を仕込むか）ので1行ずつ出す
    ...upcomingBrewPlans.map(({ p, days }) => ({
      key: `brew-${p.id}`,
      tone: 'blue' as const,
      icon: 'brew' as const,
      label: days === 0 ? '今日の仕込み' : '今週の仕込み',
      body: `${format(p.brewDate, 'M/d')}（${DOW[p.brewDate.getDay()]}）に ${planLabel(p)} を仕込む予定です`
        + (days === 0 ? '' : `（あと ${days} 日）`)
        + `。熟成 ${p.fermentationDays} 日で、完成予定は ${format(p.completionDate, 'M/d')}`,
      href: '/planning',
    })),
    ...nearCompletionLots.map(l => ({
      key: `near-${l.id}`, tone: 'amber' as const, icon: 'clock' as const,
      label: '完成間近',
      body: `${lotLabel(l)}はあと ${differenceInDays(new Date(l.estimatedCompletionISO!), today)} 日で完成予定です`,
      href: `/lots/${l.id}`,
    })),
  ]
  const toneCls = {
    rose:   'border-rose-200 bg-rose-50/60 text-rose-800',
    amber:  'border-amber-200 bg-amber-50/60 text-amber-800',
    orange: 'border-orange-200 bg-orange-50/60 text-orange-800',
    blue:   'border-sky-200 bg-sky-50/60 text-sky-800',
  } as const

  // 件数が増えるほど一覧は効かなくなるので、緊急度で2つに割る。
  // 「今すぐ」＝手遅れ／リスクが顕在化しているもの、「今週」＝予定として知っておくもの
  const urgentTodos = todos.filter(t => t.tone === 'rose' || t.tone === 'orange')
  const weekTodos   = todos.filter(t => t.tone === 'amber' || t.tone === 'blue')
  const todoIcon = (icon: Todo['icon']) =>
    icon === 'alert' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
    : icon === 'stock' ? <PackageSearch className="mt-0.5 h-4 w-4 shrink-0" />
    : icon === 'order' ? <Truck className="mt-0.5 h-4 w-4 shrink-0" />
    : icon === 'brew'  ? <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
    : <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
  const todoList = (items: Todo[]) => (
    <ul className="space-y-1.5">
      {items.map(t => (
        <li key={t.key}>
          <Link
            href={t.href}
            draggable={false}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs sm:text-sm transition-colors hover:brightness-95 ${toneCls[t.tone]}`}
          >
            {todoIcon(t.icon)}
            <span>
              <span className="font-semibold">{t.label}：</span>
              {t.body}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-16 space-y-4 sm:space-y-6">
      <h1 className="hidden sm:block text-2xl font-bold text-gray-900 tracking-tight">ダッシュボード</h1>

      {/* 上段：左＝今日やること（最初に目に入る位置）／右＝品種別在庫サマリー */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_760px] gap-4 items-start">
        <div className="space-y-4">
        <section className="rounded-xl border bg-white p-3 sm:p-4">
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-gray-900">
            今日やること
            {todos.length > 0 && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">{todos.length} 件</span>
            )}
          </h2>
          {todos.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              対応が必要なロットはありません。
            </p>
          ) : (
            <div className="space-y-3">
              {urgentTodos.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-rose-700">今すぐ（{urgentTodos.length}件）</p>
                  {todoList(urgentTodos)}
                </div>
              )}
              {weekTodos.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">今週（{weekTodos.length}件）</p>
                  {todoList(weekTodos)}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 原材料の在庫（zaiko）。仕込みに使う袋数と「あと何回分」を出す */}
        {materialStock && materialStock.length > 0 && (
          <MaterialStock
            materials={materialStock}
            basisOrder={materialBasisOrder}
            primaryType={materialBaseType}
          />
        )}
        </div>

        {/* 品種別在庫サマリー */}
        <StockSummary
          misoTypes={misoTypes}
          agedStockMap={agedStockMap}
          fermentingKgByType={fermentingKgByType}
          systemAgedKgByType={systemAgedKgByType}
          hasApiData={agedStockData != null}
          hasApiError={agedStockData == null && !!process.env.STOCK_API_URL}
          safetyStockMap={safetyStockMap}
        />
      </div>

      {/* 在庫推移グラフ */}
      <InventoryTrendChart snapshots={inventorySnapshots} misoTypes={misoTypes} />

      {/* ロット一覧（グループ別） */}
      <DashboardLotGroups
        misoTypes={misoTypes}
        agingLots={agingLots}
        completedLots={completedLots}
        needsActionLots={needsActionLots}
        simConfig={simConfig}
      />
    </div>
  )
}

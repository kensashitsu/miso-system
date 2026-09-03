// 品種ごとに独立して出した提案を、現場の組み合わせルールに沿って週の枠へ割り当て直す。
//
// なぜ必要か：`calcBatches` は品種ごとに在庫切れから逆算しているため、田舎と無添加が
// 同じ週を欲しがったときに片方が押し出されることを表現できない。また山吹は単独で
// 仕込めない（前日に別品種が要る）という2品種同時の制約も、独立計算では出せない。
//
// 現場ルール（2026-09-04 ユーザー確認）
//   絶対：
//     ① 仕込みは水・木のみ
//     ② 山吹は木曜のみ。かつ同じ週の水曜に田舎か無添加があること（単独では仕込めない）
//     ③ 田舎と無添加をセットで組むときは 水＝田舎 ／ 木＝無添加
//     ④ 単発のときは水・木どちらでもよい（品種を問わない）
//   なるべく：
//     ⑤ 水木のセットが基本。単発はコスト（夏は在庫条件から自然に増える）
//     ⑥ セット間隔は2〜3週
//
// 実際の決め方は「品種ごとの理想日を出す → 週の枠に収まるよう直す」なので、
// ここでも提案をゼロから作り直さず、理想日を起点に押し出す形で解く。
import { addDays, differenceInDays, format, startOfDay } from 'date-fns'

export const YAMABUKI = '山吹みそ'
export const INAKA    = '田舎みそ'
export const MUTENKA  = '無添加麦みそ'

export type BrewSlot = '水' | '木'

// 割り当て前の候補（品種ごとの提案1回分）
export interface CombineCandidate {
  misoType:              string
  location:              string
  brewDate:              Date    // 品種ごとの提案が出した理想の仕込み日
  completionDate:        Date
  fermentationDays:      number
  materialOrderDeadline: Date
  stockOutDate:          Date    // この回が間に合わせたい在庫切れ（ライン割れ）日
  orderLeadDays:         number
  isFixed:               boolean // 仮登録済み（動かさない）
  bucketNumbers?:        string | null
}

export type PlacedReason = 'fixed' | 'ideal' | 'contention' | 'pair-order' | 'yamabuki-wait'

export interface PlacedBrew {
  misoType:              string
  location:              string
  slot:                  BrewSlot
  brewDate:              Date
  idealBrewDate:         Date
  movedDays:             number  // 理想日から何日後ろへ動いたか（0＝理想どおり）
  completionDate:        Date
  fermentationDays:      number
  materialOrderDeadline: Date
  stockOutDate:          Date
  fits:                  boolean // 完成が在庫切れに間に合うか
  marginDays:            number  // 間に合う余裕（マイナスは遅れ）
  reason:                PlacedReason
  isFixed:               boolean
  bucketNumbers?:        string | null
}

export interface CombinedWeek {
  weekMonday: Date
  wed:        PlacedBrew | null
  thu:        PlacedBrew | null
}

// その週の水曜。週は月曜始まりで数える
export function mondayOf(d: Date): Date {
  const x = startOfDay(d)
  const dow = x.getDay()            // 0=日
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(x, diff)
}
const wedOf = (monday: Date) => addDays(monday, 2)
const thuOf = (monday: Date) => addDays(monday, 3)

// 山吹の相方になれる品種（山吹自身は相方になれない）
const canCarryYamabuki = (misoType: string) => misoType === INAKA || misoType === MUTENKA

interface WeekSlots { wed: PlacedBrew | null; thu: PlacedBrew | null }

export interface CombineOptions {
  // 仕込めない週（月曜日の yyyy-MM-dd）。その週には置かない
  blockedWeeks?: Set<string>
  // 動かした先の仕込み日で完成日を引き直す（常温は季節で熟成日数が変わるため）。
  // 省略した品種は熟成日数を据え置いて日付だけずらす
  getCompletion?: Record<string, (brewDate: Date) => { days: number; completionDate: Date }>
  // 何週先まで探すか（押し出しが延々と続くのを防ぐ）
  maxWeeksAhead?: number
}

export function combineBrewPlans(
  candidates: CombineCandidate[],
  options: CombineOptions = {},
): CombinedWeek[] {
  const { blockedWeeks, getCompletion, maxWeeksAhead = 104 } = options
  const weeks = new Map<string, WeekSlots>()
  const keyOf = (monday: Date) => format(monday, 'yyyy-MM-dd')
  const slotsOf = (monday: Date): WeekSlots => {
    const k = keyOf(monday)
    const cur = weeks.get(k) ?? { wed: null, thu: null }
    weeks.set(k, cur)
    return cur
  }

  // 仮登録済み（確定）を先に置く。新規提案はその空きを埋める形になる
  const fixed = candidates.filter(c => c.isFixed).sort((a, b) => +a.brewDate - +b.brewDate)
  const fresh = candidates.filter(c => !c.isFixed).sort((a, b) => +a.brewDate - +b.brewDate)

  for (const c of fixed) {
    const monday = mondayOf(c.brewDate)
    const s = slotsOf(monday)
    // 確定行は実際の日付をそのまま尊重する（木曜以外の曜日でも水枠に入れて表示を壊さない）
    const slot: BrewSlot = c.brewDate.getDay() === 4 ? '木' : '水'
    const placed = place(c, monday, slot, 'fixed', getCompletion)
    if (slot === '木' && !s.thu) s.thu = placed
    else if (!s.wed) s.wed = placed
    else if (!s.thu) s.thu = placed
  }

  for (const c of fresh) {
    let monday = mondayOf(c.brewDate)
    for (let i = 0; i < maxWeeksAhead; i++, monday = addDays(monday, 7)) {
      if (blockedWeeks?.has(keyOf(monday))) continue
      const s = slotsOf(monday)
      const decided = decideSlot(c, s)
      if (!decided) continue
      const reason: PlacedReason =
        i > 0
          ? (c.misoType === YAMABUKI ? 'yamabuki-wait' : 'contention')
          : (decided === '木' && c.misoType !== YAMABUKI && s.wed ? 'pair-order' : 'ideal')
      const placed = place(c, monday, decided, reason, getCompletion)
      if (decided === '水') s.wed = placed
      else s.thu = placed
      break
    }
  }

  return [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, s]) => ({ weekMonday: new Date(`${k}T00:00:00`), wed: s.wed, thu: s.thu }))
    .filter(w => w.wed || w.thu)
}

// その週に置けるか、置くならどちらの曜日かを決める。置けないときは null
function decideSlot(c: CombineCandidate, s: WeekSlots): BrewSlot | null {
  if (c.misoType === YAMABUKI) {
    // ② 山吹は木曜だけ。かつ水曜に田舎か無添加が入っていること
    if (s.thu) return null
    if (!s.wed || !canCarryYamabuki(s.wed.misoType)) return null
    return '木'
  }
  if (c.misoType === INAKA) {
    // ③ 無添加と同じ週なら田舎が水。木に無添加が入っていても水が空いていれば置ける
    if (!s.wed) return '水'
    // 水が埋まっている週に田舎を入れると③を満たせない（田舎が木になってしまう）
    return null
  }
  // 無添加：水が空いていれば水、田舎か無添加が水にいれば木（③・④）
  if (!s.wed) return '水'
  if (!s.thu) return '木'
  return null
}

function place(
  c:      CombineCandidate,
  monday: Date,
  slot:   BrewSlot,
  reason: PlacedReason,
  getCompletion?: CombineOptions['getCompletion'],
): PlacedBrew {
  const brewDate = c.isFixed ? c.brewDate : (slot === '水' ? wedOf(monday) : thuOf(monday))
  const moved    = differenceInDays(startOfDay(brewDate), startOfDay(c.brewDate))

  // 動かしたら完成日も変わる。常温は季節で熟成の速さが変わるため引き直す
  let completionDate   = c.completionDate
  let fermentationDays = c.fermentationDays
  if (moved !== 0) {
    const fn = getCompletion?.[c.misoType]
    if (fn) {
      const r = fn(brewDate)
      completionDate   = r.completionDate
      fermentationDays = r.days
    } else {
      completionDate = addDays(brewDate, c.fermentationDays)
    }
  }
  const marginDays = differenceInDays(c.stockOutDate, completionDate)
  return {
    misoType:              c.misoType,
    location:              c.location,
    slot,
    brewDate,
    idealBrewDate:         c.brewDate,
    movedDays:             moved,
    completionDate,
    fermentationDays,
    materialOrderDeadline: moved === 0 ? c.materialOrderDeadline : addDays(brewDate, -c.orderLeadDays),
    stockOutDate:          c.stockOutDate,
    fits:                  marginDays >= 0,
    marginDays,
    reason,
    isFixed:               c.isFixed,
    bucketNumbers:         c.bucketNumbers ?? null,
  }
}

export const REASON_LABEL: Record<PlacedReason, string> = {
  'fixed':         '仮登録済み',
  'ideal':         '品種ごとの提案どおり',
  'contention':    '同じ週が埋まっていたため後ろへ',
  'pair-order':    '水＝田舎／木＝無添加の順で組んだ',
  'yamabuki-wait': '前日に組める品種が無く後ろへ',
}

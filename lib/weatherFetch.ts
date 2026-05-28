// 防府アメダス（prec_no=81, block_no=0775）から日別気温データを取得
// 気象庁「過去の気象データ検索」> 地域気象観測所 日ごとの値
// URL: https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=81&block_no=0775&year=YYYY&month=MM

const PREC_NO  = '81'
const BLOCK_NO = '0775'  // 防府の気象庁内部コード（WMO番号47835とは別）
const BASE_URL = 'https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php'

export type WeatherDay = {
  date:          Date
  avgTempC:      number
  effectiveTemp: number  // max(avgTempC - 10, 0)
}

// 指定年月の日別気温データを取得
export async function fetchMonthlyWeather(year: number, month: number): Promise<WeatherDay[]> {
  const url = `${BASE_URL}?prec_no=${PREC_NO}&block_no=${BLOCK_NO}&year=${year}&month=${month}&day=&view=`
  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; miso-system)' },
    cache:   'no-store',
  })
  if (!res.ok) throw new Error(`気象庁API HTTP ${res.status}`)
  const html = await res.text()
  return parseHtml(html, year, month)
}

// HTMLから日別平均気温を抽出
// データ行: <tr class="mtx" style="text-align:right;">
// 列構成（data_0_0クラスのtd、0始まり）:
//   0: 降水量合計, 1: 最大1時間降水量, 2: 最大10分間降水量
//   3: 平均気温 ← 取得対象, 4: 最高気温, 5: 最低気温, ...
function parseHtml(html: string, year: number, month: number): WeatherDay[] {
  const results: WeatherDay[] = []

  // style属性でヘッダー行とデータ行を区別
  const rowRegex = /<tr\s+class="mtx"\s+style="text-align:right;">([\s\S]*?)<\/tr>/g
  let m: RegExpExecArray | null

  while ((m = rowRegex.exec(html)) !== null) {
    const content = m[1]

    // 日番号を href の day= パラメータから取得
    const dayMatch = content.match(/day=(\d{1,2})/)
    if (!dayMatch) continue
    const day = parseInt(dayMatch[1])
    if (isNaN(day) || day < 1 || day > 31) continue

    // data_0_0 クラスのセルを抽出（クォートなしの属性に対応）
    const cells = [...content.matchAll(/<td[^>]*class=data_0_0[^>]*>([\s\S]*?)<\/td>/g)]
      .map(c => c[1].replace(/<[^>]*>/g, '').trim())

    if (cells.length < 4) continue
    const avgTemp = parseFloat(cells[3])
    if (isNaN(avgTemp)) continue

    results.push({
      date:          new Date(Date.UTC(year, month - 1, day)),
      avgTempC:      avgTemp,
      effectiveTemp: Math.max(avgTemp - 10, 0),
    })
  }

  return results
}

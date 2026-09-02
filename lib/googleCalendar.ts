// Googleカレンダー APIの最小クライアント（サービスアカウント認証）。
//
// googleapis パッケージは依存が重くVercelのサーバーレスには過剰なため、
// JWTの署名（RS256）とトークン交換だけ自前で行い、あとはREST APIを fetch で叩く。
//
// 必要な環境変数:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  サービスアカウントのメールアドレス
//   GOOGLE_PRIVATE_KEY            JSON鍵の private_key（改行は \\n のままでよい）
import { createSign } from 'crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE     = 'https://www.googleapis.com/auth/calendar.events'
const API_BASE  = 'https://www.googleapis.com/calendar/v3'

export type CalendarEvent = {
  id:          string
  summary:     string
  description?: string
  date:        Date     // 終日予定の日付
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/[+]/g, '-').replace(/[/]/g, '_')

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function hasCalendarCredentials(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
}

// サービスアカウントのJWTでアクセストークンを取る（有効1時間・呼び出しごとに取得）
async function getAccessToken(): Promise<string> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(new RegExp(String.raw`\n`, 'g'), String.fromCharCode(10))
  if (!email || !key) throw new Error('Googleサービスアカウントの環境変数が未設定です')

  const now    = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim  = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const jwt = `${header}.${claim}.${b64url(signer.sign(key))}`

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  })
  if (!res.ok) throw new Error(`アクセストークンの取得に失敗しました: ${res.status} ${await res.text()}`)
  return (await res.json()).access_token as string
}

type ApiEvent = {
  id: string
  summary?: string
  description?: string
  start?: { date?: string }
  status?: string
}

export class CalendarClient {
  private token: string | null = null

  private async call(path: string, init?: RequestInit): Promise<Response> {
    if (!this.token) this.token = await getAccessToken()
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization:  `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  }

  // このシステムが作った予定だけを一覧する（他の手入力の予定は触らない）。
  // 目印は拡張プロパティ（private）の misoSystem。
  async listOwned(calendarId: string, tag: string): Promise<ApiEvent[]> {
    const out: ApiEvent[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        privateExtendedProperty: `misoSystem=${tag}`,
        maxResults: '250',
        showDeleted: 'false',
        singleEvents: 'true',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const res = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
      if (!res.ok) throw new Error(`予定の取得に失敗しました: ${res.status} ${await res.text()}`)
      const json = await res.json()
      out.push(...(json.items ?? []))
      pageToken = json.nextPageToken
    } while (pageToken)
    return out
  }

  private body(ev: CalendarEvent, tag: string) {
    const end = new Date(ev.date)
    end.setDate(end.getDate() + 1)   // 終日予定の終了日は翌日
    return {
      id:          ev.id,
      summary:     ev.summary,
      description: ev.description,
      start:       { date: ymd(ev.date) },
      end:         { date: ymd(end) },
      transparency: 'transparent',
      extendedProperties: { private: { misoSystem: tag } },
    }
  }

  async insert(calendarId: string, ev: CalendarEvent, tag: string): Promise<void> {
    const res = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body:   JSON.stringify(this.body(ev, tag)),
    })
    // 409 = 同じIDの予定が既にある（削除済みで残っている場合など）→ 更新で復活させる
    if (res.status === 409) { await this.update(calendarId, ev, tag); return }
    if (!res.ok) throw new Error(`予定の作成に失敗しました: ${res.status} ${await res.text()}`)
  }

  async update(calendarId: string, ev: CalendarEvent, tag: string): Promise<void> {
    const res = await this.call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`,
      { method: 'PUT', body: JSON.stringify({ ...this.body(ev, tag), status: 'confirmed' }) },
    )
    if (!res.ok) throw new Error(`予定の更新に失敗しました: ${res.status} ${await res.text()}`)
  }

  async remove(calendarId: string, eventId: string): Promise<void> {
    const res = await this.call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: 'DELETE' },
    )
    // 410 = 既に削除済み
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`予定の削除に失敗しました: ${res.status} ${await res.text()}`)
    }
  }
}

// 既存の予定と突き合わせて、作成・更新・削除をまとめて行う
export async function syncCalendar(
  calendarId: string,
  tag:        string,
  desired:    CalendarEvent[],
): Promise<{ created: number; updated: number; deleted: number }> {
  const client   = new CalendarClient()
  const existing = await client.listOwned(calendarId, tag)
  const byId     = new Map(existing.map(e => [e.id, e]))
  let created = 0, updated = 0, deleted = 0

  for (const ev of desired) {
    const cur = byId.get(ev.id)
    if (!cur) {
      await client.insert(calendarId, ev, tag)
      created++
    } else if (
      cur.summary !== ev.summary ||
      (cur.description ?? '') !== (ev.description ?? '') ||
      cur.start?.date !== ymd(ev.date)
    ) {
      await client.update(calendarId, ev, tag)
      updated++
    }
    byId.delete(ev.id)
  }
  // 残ったもの＝システム側に対応が無くなった予定なので消す
  for (const id of byId.keys()) {
    await client.remove(calendarId, id)
    deleted++
  }
  return { created, updated, deleted }
}

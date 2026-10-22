// Ma trận Story 2.2 — kết nối Fanpage + Instagram Business qua OAuth (Meta giả `fake-meta.ts`).
// Kiểm thêm: DB chỉ chứa envelope, log / URL chuyển hướng / phản hồi không chứa token, IG không có token riêng.
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import {
  ConfirmConnectionsResponse,
  ErrorResponse,
  INSTAGRAM_REQUIRED_SCOPES,
  ListPagesResponse,
  META_LOGIN_SCOPES,
  OAuthResultResponse,
  StartConnectResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { FAKE_CODE, cleanupExpiredOAuth, getAccessToken, type ConnectionsConfig } from '../src/modules/connections/index.ts'
import { FAKE_APP_ID, FAKE_IG, FAKE_PAGES, FAKE_USER, createFakeMetaGraph, fakeGranularScopes } from '../src/modules/connections/fake-meta.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const ORIGIN = 'http://localhost:5173'
/** Mọi token giả do `fake-meta.ts` cấp đều có dạng này — không được xuất hiện ở DB, log, URL hay phản hồi. */
const PLAIN_TOKEN = /FAKE_(SHORT|LONG|PAGE)_/
const ENVELOPE = /^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const REAL_SECRET = 'real-app-secret-should-not-leak'

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const logLines: string[] = []
const logSink = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(String(chunk))
    cb()
  },
})
/** Mọi URL chuyển hướng và body phản hồi trong file — cuối file kiểm không chứa token. */
const seen: string[] = []

const WEB = 'http://localhost:4173'
const FAKE_CONFIG: ConnectionsConfig = {
  META_FAKE: true,
  META_GRAPH_VERSION: 'v26.0',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  // Host web khác host api (Hostinger + VPS): mọi Location sau callback phải tuyệt đối theo WEB_BASE_URL.
  WEB_BASE_URL: WEB,
  META_APP_ID: undefined,
  META_APP_SECRET: undefined,
  META_LOGIN_CONFIG_ID: undefined,
}

async function wipe() {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from oauth_states`
  await handle.sql`delete from oauth_results`
  await handle.sql`delete from meta_accounts`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-connections', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await wipe()
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})

let app: FastifyInstance
let graph: FakeMetaClient
let token: string
let sessionId: string

function build(config: ConnectionsConfig = FAKE_CONFIG, options: { cipher?: SecretCipher | null } = {}) {
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'trace' }, logSink),
    http: { allowedOrigins: [ORIGIN] },
    events,
    connections: { graph, cipher: options.cipher === undefined ? cipher : options.cipher, config },
  })
}

beforeEach(async () => {
  await wipe()
  realtime.messages.length = 0
  graph = createFakeMetaGraph()
  app = build()
  const s = await createSession(handle.db)
  token = s.token
  sessionId = s.session.id
})
afterEach(async () => {
  await app.close()
})

const cookieOf = (t: string | null) => (t ? { cookie: `${SESSION_COOKIE}=${t}` } : {})

async function api(method: 'GET' | 'POST', url: string, payload?: unknown, as: string | null = token) {
  const res = await app.inject({
    method,
    url,
    headers: { ...cookieOf(as), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
  seen.push(res.body)
  return res
}

const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code

async function start(from: 'pages' | 'welcome' = 'pages', as: string | null = token) {
  const res = await api('POST', '/api/v1/connections/facebook/start', { from }, as)
  expect(res.statusCode).toBe(200)
  const { url } = StartConnectResponse.parse(res.json())
  return { url, state: new URL(url, 'http://x').searchParams.get('state')! }
}

async function callback(params: Record<string, string>, as: string | null = token) {
  const res = await app.inject({ method: 'GET', url: `/oauth/facebook/callback?${new URLSearchParams(params)}`, headers: cookieOf(as) })
  // Callback luôn kết thúc Location bằng fragment rỗng (đè `#_` mà Meta/Threads nối vào URL callback).
  const raw = String(res.headers.location ?? '')
  expect(raw.endsWith('#')).toBe(true)
  // Location tuyệt đối trên host web; phần còn lại so như đường dẫn.
  expect(raw.startsWith(`${WEB}/`)).toBe(true)
  const location = raw.slice(WEB.length, -1)
  seen.push(location, res.body)
  return { status: res.statusCode, location }
}

/** start → (trang giả) → callback với `code`; trả id kết quả. */
async function connect(code: string = FAKE_CODE.full, from: 'pages' | 'welcome' = 'pages') {
  const { state } = await start(from)
  const cb = await callback({ state, code })
  expect(cb.status).toBe(302)
  const id = new URL(cb.location, 'http://x').searchParams.get('ket-noi')
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  return id!
}

async function readResult(id: string, as: string | null = token) {
  const res = await api('GET', `/api/v1/connections/oauth-results/${id}`, undefined, as)
  return res
}

const confirm = (resultId: string, accountIds: string[]) => api('POST', '/api/v1/connections/confirm', { resultId, accountIds })

const pageRows = () =>
  handle.sql<{ id: string; platform: string; platform_account_id: string; connection_status: string; removed_at: Date | null; name: string }[]>`
    select id, platform, platform_account_id, connection_status, removed_at, name from pages order by platform, platform_account_id`
const credRows = () =>
  handle.sql<{ page_id: string; access_token: string | null; token_source_page_id: string | null; expires_at: string; data_access_expires_at: string | null; granular_scopes: string[] }[]>`
    select page_id, access_token, token_source_page_id, expires_at, data_access_expires_at, granular_scopes from page_credentials`

describe('xác thực', () => {
  it('chưa đăng nhập → 401 ở mọi route /api/v1 của story; không gọi Meta', async () => {
    for (const [m, u, body] of [
      ['POST', '/api/v1/connections/facebook/start', { from: 'pages' }],
      ['GET', `/api/v1/connections/oauth-results/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`, undefined],
      ['POST', '/api/v1/connections/confirm', { resultId: '00000000-0000-7000-8000-000000000000', accountIds: ['1'] }],
      ['GET', '/api/v1/pages', undefined],
    ] as const) {
      const res = await api(m, u, body, null)
      expect(res.statusCode).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
    }
    expect(graph.calls).toHaveLength(0)
  })
})

describe('POST /api/v1/connections/facebook/start', () => {
  it('Meta giả → URL trang đồng ý giả; state lưu kèm id phiên, màn gốc, TTL 15 phút', async () => {
    const before = Date.now()
    const { url, state } = await start('welcome')
    expect(url).toBe(`http://localhost:5173/oauth/facebook/fake-consent?state=${state}`)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = await handle.sql<{ session_id: string; return_to: string; intent: string; provider: string; expires_at: Date }[]>`
      select session_id, return_to, intent, provider, expires_at from oauth_states where state = ${state}`
    expect(row).toMatchObject({ session_id: sessionId, return_to: 'welcome', intent: 'connect', provider: 'facebook' })
    const ttl = new Date(row!.expires_at).getTime() - before
    expect(ttl).toBeGreaterThan(14 * 60_000)
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 2_000)
    expect(graph.calls).toHaveLength(0)
  })

  it('app thật: URL hộp thoại Meta pin phiên bản, redirect_uri từ PUBLIC_BASE_URL, scope đủ danh sách', async () => {
    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false, META_APP_ID: '123456', META_APP_SECRET: REAL_SECRET })
    const { url, state } = await start()
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '123456',
      redirect_uri: 'http://localhost:5173/oauth/facebook/callback',
      state,
      response_type: 'code',
      scope: META_LOGIN_SCOPES.join(','),
    })
    expect(url).not.toContain(REAL_SECRET)
  })

  it('có META_LOGIN_CONFIG_ID → dùng config_id thay scope', async () => {
    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false, META_APP_ID: '123456', META_APP_SECRET: REAL_SECRET, META_LOGIN_CONFIG_ID: '777' })
    const u = new URL((await start()).url)
    expect(u.searchParams.get('config_id')).toBe('777')
    expect(u.searchParams.has('scope')).toBe(false)
  })

  it('thiếu META_APP_ID và không bật giả → 500 META_NOT_CONFIGURED, không lưu state', async () => {
    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false })
    const res = await api('POST', '/api/v1/connections/facebook/start', { from: 'pages' })
    expect(res.statusCode).toBe(500)
    expect(errorCode(res)).toBe('META_NOT_CONFIGURED')
    expect(await handle.sql`select 1 from oauth_states`).toHaveLength(0)
  })

  it('chưa có khoá chủ mã hoá → 500 ENCRYPTION_NOT_CONFIGURED', async () => {
    await app.close()
    app = build(FAKE_CONFIG, { cipher: null })
    const res = await api('POST', '/api/v1/connections/facebook/start', { from: 'pages' })
    expect(res.statusCode).toBe(500)
    expect(errorCode(res)).toBe('ENCRYPTION_NOT_CONFIGURED')
  })

  it('from sai → 400 VALIDATION_FAILED', async () => {
    const res = await api('POST', '/api/v1/connections/facebook/start', { from: 'khac' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })
})

describe('GET /oauth/facebook/fake-consent', () => {
  it('chỉ có khi bật Meta giả; state được escape; có Đồng ý, Huỷ, bỏ quyền tin nhắn', async () => {
    const res = await app.inject({ method: 'GET', url: '/oauth/facebook/fake-consent?state=%22%3E%3Cscript%3Ex' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('value="&quot;&gt;&lt;script&gt;x"')
    expect(res.body).not.toContain('"><script>x')
    expect(res.body).toContain('Đồng ý')
    expect(res.body).toContain('Huỷ')
    expect(res.body).toContain('Bỏ quyền tin nhắn')
    expect(res.body).toContain('action="/oauth/facebook/callback"')

    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false, META_APP_ID: '1', META_APP_SECRET: 's' })
    const off = await app.inject({ method: 'GET', url: '/oauth/facebook/fake-consent?state=x' })
    expect(off.statusCode).toBe(404)
  })
})

describe('GET /oauth/facebook/callback', () => {
  it('thành công → 302 về /trang-nhom?ket-noi=<id>; state dùng một lần; đổi token đủ bước', async () => {
    const { state } = await start()
    const cb = await callback({ state, code: FAKE_CODE.full })
    expect(cb.status).toBe(302)
    expect(cb.location).toMatch(/^\/trang-nhom\?ket-noi=[0-9a-f-]{36}$/)
    expect(graph.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /oauth/access_token',
      'GET /oauth/access_token',
      'GET /debug_token',
      'GET /me',
      'GET /me/accounts',
    ])
    expect(graph.calls[0]!.options.params).toMatchObject({ redirect_uri: 'http://localhost:5173/oauth/facebook/callback', code: FAKE_CODE.full })
    expect(graph.calls[1]!.options.params).toMatchObject({ grant_type: 'fb_exchange_token' })
    // Dùng lại cùng state → không đổi code lần nữa.
    const again = await callback({ state, code: FAKE_CODE.full })
    expect(again.location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect(graph.calls).toHaveLength(5)
    // User token dài hạn lưu dạng envelope theo FB user id.
    const [acc] = await handle.sql<{ fb_user_id: string; user_token: string; expires_at: string; data_access_expires_at: string }[]>`
      select fb_user_id, user_token, expires_at, data_access_expires_at from meta_accounts`
    expect(acc!.user_token).toMatch(ENVELOPE)
    expect(cipher.decrypt(acc!.user_token)).toMatch(/^FAKE_LONG_full_/)
    expect(Number(acc!.expires_at)).toBeGreaterThan(Date.now() / 1000 + 59 * 86_400)
    expect(Number(acc!.data_access_expires_at)).toBeGreaterThan(Date.now() / 1000 + 89 * 86_400)
  })

  it('bắt đầu từ Màn chào → 302 về /bat-dau?ket-noi=<id>', async () => {
    const { state } = await start('welcome')
    const cb = await callback({ state, code: FAKE_CODE.full })
    expect(cb.location).toMatch(/^\/bat-dau\?ket-noi=[0-9a-f-]{36}$/)
  })

  it.each([
    ['state lạ', async () => ({ state: 'khong-co-state-nay', as: token })],
    ['không có cookie phiên', async () => ({ state: (await start()).state, as: null })],
    ['cookie của phiên khác', async () => ({ state: (await start()).state, as: (await createSession(handle.db)).token })],
    [
      'state hết hạn',
      async () => {
        const { state } = await start()
        await handle.sql`update oauth_states set expires_at = now() - interval '1 second' where state = ${state}`
        return { state, as: token }
      },
    ],
  ])('%s → 302 /trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID, không đổi code', async (_name, setup) => {
    const { state, as } = await setup()
    const cb = await callback({ state, code: FAKE_CODE.full }, as)
    expect(cb.status).toBe(302)
    expect(cb.location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect(graph.calls).toHaveLength(0)
    expect(await handle.sql`select 1 from oauth_results`).toHaveLength(0)
  })

  it('cookie phiên khác không tiêu state: chủ phiên vẫn hoàn tất được', async () => {
    const { state } = await start()
    const other = (await createSession(handle.db)).token
    expect((await callback({ state, code: FAKE_CODE.full }, other)).location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect((await callback({ state, code: FAKE_CODE.full })).location).toMatch(/^\/trang-nhom\?ket-noi=/)
  })

  it('huỷ (error=access_denied) → kết quả OAUTH_CANCELLED, không gọi Meta', async () => {
    const { state } = await start()
    const cb = await callback({ state, error: 'access_denied', error_reason: 'user_denied' })
    const id = new URL(cb.location, 'http://x').searchParams.get('ket-noi')!
    expect(graph.calls).toHaveLength(0)
    const res = await readResult(id)
    expect(res.statusCode).toBe(200)
    expect(OAuthResultResponse.parse(res.json())).toEqual({ provider: 'facebook', status: 'error', candidates: [], errorCode: 'OAUTH_CANCELLED', truncated: false })
  })

  it('Meta từ chối khi đổi code → kết quả lỗi INTERNAL; log chỉ có loại lỗi, không có secret/code', async () => {
    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false, META_APP_ID: '123456', META_APP_SECRET: REAL_SECRET })
    const { state } = await start()
    const cb = await callback({ state, code: 'ma-code-that-xyz' })
    const id = new URL(cb.location, 'http://x').searchParams.get('ket-noi')!
    expect(graph.calls).toHaveLength(1)
    expect(OAuthResultResponse.parse((await readResult(id)).json())).toEqual({ provider: 'facebook', status: 'error', candidates: [], errorCode: 'INTERNAL', truncated: false })
    const logs = logLines.join('')
    expect(logs).toContain('code_exchange')
    expect(logs).not.toContain(REAL_SECRET)
    expect(logs).not.toContain('ma-code-that-xyz')
  })
})

describe('GET /api/v1/connections/oauth-results/:id', () => {
  it('Fanpage và IG liên kết; IG chưa phải Business bị khoá IG_NOT_BUSINESS; không có token', async () => {
    const id = await connect()
    const res = await readResult(id)
    expect(res.statusCode).toBe(200)
    const body = OAuthResultResponse.parse(res.json())
    expect(body.status).toBe('ok')
    expect(body.errorCode).toBeUndefined()
    expect(body.candidates).toEqual([
      { accountId: FAKE_PAGES.beauty.id, platform: 'facebook', name: FAKE_PAGES.beauty.name, handle: FAKE_PAGES.beauty.username, avatarUrl: null, selectable: true, missing: [] },
      {
        accountId: FAKE_IG.business.id,
        platform: 'instagram',
        name: FAKE_IG.business.name,
        handle: FAKE_IG.business.username,
        avatarUrl: null,
        linkedToAccountId: FAKE_PAGES.beauty.id,
        selectable: true,
        missing: [],
      },
      { accountId: FAKE_PAGES.home.id, platform: 'facebook', name: FAKE_PAGES.home.name, handle: FAKE_PAGES.home.username, avatarUrl: null, selectable: true, missing: [] },
      {
        accountId: FAKE_IG.personal.id,
        platform: 'instagram',
        name: FAKE_IG.personal.username,
        handle: FAKE_IG.personal.username,
        avatarUrl: null,
        linkedToAccountId: FAKE_PAGES.home.id,
        selectable: false,
        missing: [],
        reason: 'IG_NOT_BUSINESS',
      },
    ])
    expect(res.body).not.toMatch(PLAIN_TOKEN)
    expect(res.body).not.toContain('v1:k1:')
    expect(res.body).not.toContain('tokenEnvelope')
  })

  it('thiếu quyền tin nhắn → mọi ứng viên có missing[], không chọn được (PERMISSIONS_MISSING)', async () => {
    const id = await connect(FAKE_CODE.noMessaging)
    const { candidates } = OAuthResultResponse.parse((await readResult(id)).json())
    const by = Object.fromEntries(candidates.map((c) => [c.accountId, c]))
    expect(by[FAKE_PAGES.beauty.id]).toMatchObject({ selectable: false, missing: ['pages_messaging'], reason: 'PERMISSIONS_MISSING' })
    expect(by[FAKE_PAGES.home.id]).toMatchObject({ selectable: false, missing: ['pages_messaging'], reason: 'PERMISSIONS_MISSING' })
    expect(by[FAKE_IG.business.id]).toMatchObject({ selectable: false, reason: 'PERMISSIONS_MISSING' })
    expect([...by[FAKE_IG.business.id]!.missing].sort()).toEqual(['instagram_manage_messages', 'pages_messaging'])
    expect(by[FAKE_IG.personal.id]).toMatchObject({ selectable: false, reason: 'IG_NOT_BUSINESS' })
  })

  it('phiên khác / hết hạn / id sai dạng → 404; bản hết hạn bị dọn khi đọc', async () => {
    const id = await connect()
    const other = (await createSession(handle.db)).token
    expect((await readResult(id, other)).statusCode).toBe(404)
    expect((await readResult('khong-phai-uuid')).statusCode).toBe(404)
    await handle.sql`update oauth_results set expires_at = now() - interval '1 second' where id = ${id}`
    const res = await readResult(id)
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(await handle.sql`select 1 from oauth_results where id = ${id}`).toHaveLength(0)
  })
})

describe('POST /api/v1/connections/confirm', () => {
  it('chọn IG → tự gồm Fanpage nguồn; token Fanpage mã hoá, IG trỏ token_source_page_id; active; page.connected; kết quả bị xoá', async () => {
    const id = await connect()
    const res = await confirm(id, [FAKE_IG.business.id])
    expect(res.statusCode).toBe(200)
    const { pages } = ConfirmConnectionsResponse.parse(res.json())
    expect(pages.map((p) => [p.platform, p.name, p.connectionStatus])).toEqual([
      ['facebook', FAKE_PAGES.beauty.name, 'active'],
      ['instagram', FAKE_IG.business.name, 'active'],
    ])
    expect(res.body).not.toMatch(PLAIN_TOKEN)
    const [fb, ig] = pages

    const rows = await pageRows()
    expect(rows.map((r) => [r.platform, r.platform_account_id, r.connection_status])).toEqual([
      ['facebook', FAKE_PAGES.beauty.id, 'active'],
      ['instagram', FAKE_IG.business.id, 'active'],
    ])
    const creds = Object.fromEntries((await credRows()).map((c) => [c.page_id, c]))
    expect(creds[fb!.id]!.access_token).toMatch(ENVELOPE)
    expect(creds[fb!.id]!.token_source_page_id).toBeNull()
    expect(Number(creds[fb!.id]!.expires_at)).toBe(0)
    expect(Number(creds[fb!.id]!.data_access_expires_at)).toBeGreaterThan(Date.now() / 1000)
    expect(creds[fb!.id]!.granular_scopes).toEqual(expect.arrayContaining(['pages_messaging', 'pages_manage_posts']))
    // IG không giữ token riêng.
    expect(creds[ig!.id]!.access_token).toBeNull()
    expect(creds[ig!.id]!.token_source_page_id).toBe(fb!.id)
    expect(creds[ig!.id]!.granular_scopes).toEqual(expect.arrayContaining([...INSTAGRAM_REQUIRED_SCOPES]))

    // getAccessToken: IG lấy theo Fanpage nguồn.
    const fbToken = await getAccessToken({ db: handle.db, cipher }, fb!.id)
    expect(fbToken).toMatch(new RegExp(`^FAKE_PAGE_${FAKE_PAGES.beauty.id}_`))
    expect(await getAccessToken({ db: handle.db, cipher }, ig!.id)).toBe(fbToken)

    const msgs = await waitFor(() => {
      const m = realtime.messages.filter((x) => String(x.type).startsWith('page.'))
      return m.length >= 2 ? m : null
    })
    expect(msgs).toEqual([
      { type: 'page.connected', entity: 'page', id: fb!.id, pageId: fb!.id },
      { type: 'page.connected', entity: 'page', id: ig!.id, pageId: ig!.id },
    ])

    // Kết quả đã dùng → đọc lại / xác nhận lại 404.
    expect((await readResult(id)).statusCode).toBe(404)
    expect((await confirm(id, [FAKE_PAGES.home.id])).statusCode).toBe(404)
  })

  it('không tự tạo mọi Fanpage được cấp: chỉ trang được chọn', async () => {
    const id = await connect()
    expect((await confirm(id, [FAKE_PAGES.home.id])).statusCode).toBe(200)
    expect((await pageRows()).map((r) => r.platform_account_id)).toEqual([FAKE_PAGES.home.id])
  })

  it.each([
    ['id không có trong kết quả', () => ['999'], FAKE_CODE.full],
    ['IG chưa phải Business', () => [FAKE_IG.personal.id], FAKE_CODE.full],
    ['ứng viên thiếu quyền', () => [FAKE_PAGES.beauty.id], FAKE_CODE.noMessaging],
  ])('%s → 400 VALIDATION_FAILED, không tạo trang, kết quả còn nguyên', async (_n, ids, code) => {
    const id = await connect(code)
    const res = await confirm(id, ids())
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    expect(await pageRows()).toHaveLength(0)
    expect(await credRows()).toHaveLength(0)
    expect((await readResult(id)).statusCode).toBe(200)
  })

  it('kết quả của phiên khác hoặc kết quả lỗi (huỷ) → 404', async () => {
    const { state } = await start()
    const cancelled = new URL((await callback({ state, error: 'access_denied' })).location, 'http://x').searchParams.get('ket-noi')!
    expect((await confirm(cancelled, [FAKE_PAGES.beauty.id])).statusCode).toBe(404)

    const id = await connect()
    const other = (await createSession(handle.db)).token
    const res = await api('POST', '/api/v1/connections/confirm', { resultId: id, accountIds: [FAKE_PAGES.beauty.id] }, other)
    expect(res.statusCode).toBe(404)
  })

  it('kết nối lại trang đã gỡ → khôi phục đúng dòng cũ (giữ id, xoá removed_at), token mới, page.reconnected', async () => {
    const first = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_PAGES.beauty.id, FAKE_IG.business.id])).json())
    const [fb, ig] = first.pages
    const oldEnvelope = (await credRows()).find((c) => c.page_id === fb!.id)!.access_token
    await handle.sql`update pages set removed_at = now(), connection_status = 'disconnected', group_id = ${'0199a000-0000-7000-8000-000000000001'} where id = ${fb!.id}`
    await sleep(100)
    realtime.messages.length = 0

    // Trang đã gỡ không còn trong danh sách.
    const listed = ListPagesResponse.parse((await api('GET', '/api/v1/pages')).json())
    expect(listed.items.map((p) => p.id)).toEqual([ig!.id])

    const again = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_PAGES.beauty.id, FAKE_IG.business.id])).json())
    expect(again.pages.map((p) => p.id)).toEqual([fb!.id, ig!.id])
    const rows = await pageRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.removed_at === null && r.connection_status === 'active')).toBe(true)
    const [kept] = await handle.sql<{ group_id: string }[]>`select group_id from pages where id = ${fb!.id}`
    expect(kept!.group_id).toBe('0199a000-0000-7000-8000-000000000001')
    const newEnvelope = (await credRows()).find((c) => c.page_id === fb!.id)!.access_token
    expect(newEnvelope).toMatch(ENVELOPE)
    expect(newEnvelope).not.toBe(oldEnvelope)

    // Chỉ Fanpage đã gỡ phát page.reconnected; IG vẫn đang hoạt động → không phát gì.
    await waitFor(() => realtime.messages.some((x) => String(x.type).startsWith('page.')))
    await sleep(200)
    expect(realtime.messages.filter((x) => String(x.type).startsWith('page.')).map((m) => [m.type, m.id])).toEqual([['page.reconnected', fb!.id]])
  })
})

describe('kết nối lại một trang (Story 2.4)', () => {
  async function connectBeauty() {
    const { pages } = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_PAGES.beauty.id])).json())
    return pages[0]!
  }
  const startReconnect = (pageId: string, from: 'pages' | 'welcome' | 'settings' = 'pages') =>
    api('POST', '/api/v1/connections/facebook/start', { from, pageId })

  it('start với pageId → intent=reconnect:<id> trong oauth_states, auth_type=reauthorize ở URL hộp thoại Meta', async () => {
    // Tạo trang bằng luồng giả, rồi đổi sang app thật chỉ để kiểm URL hộp thoại Meta.
    const fb = await connectBeauty()
    await app.close()
    app = build({ ...FAKE_CONFIG, META_FAKE: false, META_APP_ID: '123456', META_APP_SECRET: REAL_SECRET })
    const res = await startReconnect(fb.id)
    expect(res.statusCode).toBe(200)
    const { url } = StartConnectResponse.parse(res.json())
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(u.searchParams.get('auth_type')).toBe('reauthorize')
    const state = u.searchParams.get('state')!
    const [row] = await handle.sql<{ intent: string }[]>`select intent from oauth_states where state = ${state}`
    expect(row!.intent).toBe(`reconnect:${fb.id}`)
  })

  it('pageId không tồn tại → 404, không tạo state, không gọi Meta', async () => {
    const res = await startReconnect('00000000-0000-7000-8000-000000000000')
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(await handle.sql`select 1 from oauth_states`).toHaveLength(0)
    expect(graph.calls).toHaveLength(0)
  })

  it('hoàn tất → cập nhật token đúng dòng (giữ id, nhóm), về active, phát page.reconnected', async () => {
    const fb = await connectBeauty()
    const groupId = '0199a000-0000-7000-8000-000000000042'
    // Trang đang expiring (có lý do) và đã gán nhóm (dữ liệu cấu hình phải giữ qua reconnect).
    await handle.sql`update pages set connection_status = 'expiring', connection_status_reason = 'TOKEN_EXPIRING', group_id = ${groupId} where id = ${fb.id}`
    const oldEnvelope = (await credRows()).find((c) => c.page_id === fb.id)!.access_token
    await sleep(100)
    realtime.messages.length = 0

    // Bắt đầu reconnect rồi chạy nốt callback + confirm như luồng thường (Meta giả).
    const startRes = StartConnectResponse.parse((await startReconnect(fb.id)).json())
    const st = new URL(startRes.url, 'http://x').searchParams.get('state')!
    const cb = await callback({ state: st, code: FAKE_CODE.full })
    const resultId = new URL(cb.location, 'http://x').searchParams.get('ket-noi')!
    const again = ConfirmConnectionsResponse.parse((await confirm(resultId, [FAKE_PAGES.beauty.id])).json())

    expect(again.pages[0]!.id).toBe(fb.id)
    expect(again.pages[0]!.connectionStatus).toBe('active')
    const [kept] = await handle.sql<{ group_id: string; connection_status_reason: string | null }[]>`
      select group_id, connection_status_reason from pages where id = ${fb.id}`
    expect(kept!.group_id).toBe(groupId)
    // Về active → lý do trạng thái bị xoá.
    expect(kept!.connection_status_reason).toBeNull()
    const newEnvelope = (await credRows()).find((c) => c.page_id === fb.id)!.access_token
    expect(newEnvelope).not.toBe(oldEnvelope)

    await waitFor(() => realtime.messages.some((m) => String(m.type).startsWith('page.')))
    await sleep(150)
    expect(realtime.messages.filter((m) => String(m.type).startsWith('page.')).map((m) => [m.type, m.id])).toEqual([['page.reconnected', fb.id]])
  })

  it('thiếu quyền bắt buộc → KHÔNG về active (giữ trạng thái cũ), ứng viên nêu quyền thiếu', async () => {
    const fb = await connectBeauty()
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${fb.id}`
    const startRes = StartConnectResponse.parse((await startReconnect(fb.id)).json())
    const st = new URL(startRes.url, 'http://x').searchParams.get('state')!
    const cb = await callback({ state: st, code: FAKE_CODE.noMessaging })
    const resultId = new URL(cb.location, 'http://x').searchParams.get('ket-noi')!
    // Ứng viên Fanpage bị khoá (thiếu pages_messaging) → confirm từ chối, trạng thái giữ disconnected.
    const res = await confirm(resultId, [FAKE_PAGES.beauty.id])
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    expect((await pageRows()).find((r) => r.id === fb.id)!.connection_status).toBe('disconnected')
  })
})

describe('GET /api/v1/pages', () => {
  it('trang chưa gỡ với đúng các trường; không có token', async () => {
    expect(ListPagesResponse.parse((await api('GET', '/api/v1/pages')).json())).toEqual({ items: [] })
    await confirm(await connect(), [FAKE_IG.business.id, FAKE_PAGES.home.id])
    const res = await api('GET', '/api/v1/pages')
    expect(res.statusCode).toBe(200)
    const { items } = ListPagesResponse.parse(res.json())
    // Cùng transaction → cùng connected_at; thứ tự theo id (Fanpage trước IG liên kết).
    expect(items.map((p) => p.platform)).toEqual(['facebook', 'facebook', 'instagram'])
    for (const p of items) {
      expect(Object.keys(p).sort()).toEqual(['avatarUrl', 'connectedAt', 'connectionStatus', 'handle', 'id', 'name', 'platform'])
      expect(p.connectionStatus).toBe('active')
    }
    expect(res.body).not.toMatch(PLAIN_TOKEN)
  })
})

describe('không lộ token (AD-5, AD-12)', () => {
  it('sau trọn luồng: DB chỉ chứa envelope; job, log, URL chuyển hướng, phản hồi không chứa token', async () => {
    await confirm(await connect(), [FAKE_IG.business.id, FAKE_PAGES.home.id])
    await connect(FAKE_CODE.noMessaging)
    const dump = JSON.stringify([
      await handle.sql`select * from pages`,
      await handle.sql`select * from page_credentials`,
      await handle.sql`select * from oauth_results`,
      await handle.sql`select * from oauth_states`,
      await handle.sql`select * from meta_accounts`,
      await handle.sql.unsafe(`select data from ${BOSS_SCHEMA}.job`),
    ])
    expect(dump).not.toMatch(PLAIN_TOKEN)
    for (const env of (await handle.sql<{ t: string }[]>`
      select access_token as t from page_credentials where access_token is not null
      union all select user_token from meta_accounts`).map((r) => r.t)) {
      expect(env).toMatch(ENVELOPE)
    }
    // Ứng viên nội bộ giữ envelope, không giữ token rõ.
    const [res] = await handle.sql<{ candidates: { tokenEnvelope?: string; platform: string }[] }[]>`select candidates from oauth_results`
    for (const c of res!.candidates) {
      if (c.platform === 'facebook') expect(c.tokenEnvelope).toMatch(ENVELOPE)
      else expect(c.tokenEnvelope).toBeUndefined()
    }
  })

  it('cuối file: mọi log và URL/phản hồi đã thấy không chứa token rõ', () => {
    expect(logLines.length).toBeGreaterThan(0)
    expect(logLines.join('')).not.toMatch(PLAIN_TOKEN)
    expect(seen.join('\n')).not.toMatch(PLAIN_TOKEN)
  })
})

describe('buildCandidates (granular_scopes theo trang)', () => {
  const all = (ids?: string[]) => META_LOGIN_SCOPES.map((scope) => (ids ? { scope, target_ids: ids } : { scope }))

  it('quyền không có target_ids áp cho mọi trang; target_ids khác trang → thiếu; Fanpage không có token bị bỏ', async () => {
    const { buildCandidates } = await import('../src/modules/connections/candidates.ts')
    const pages = [
      { id: 'p1', name: 'A', access_token: 'tok1', instagram_business_account: { id: 'ig1', username: 'a.ig' } },
      { id: 'p2', name: 'B' },
    ]
    const enc = (t: string) => `enc(${t})`
    // Cấp chung (không target_ids) → đủ quyền.
    const ok = buildCandidates(pages, all(), enc)
    expect(ok.map((c) => [c.accountId, c.selectable, c.tokenEnvelope])).toEqual([
      ['p1', true, 'enc(tok1)'],
      ['ig1', true, undefined],
    ])
    // Cấp cho trang khác → p1 thiếu mọi quyền bắt buộc; IG thiếu cả quyền IG lẫn quyền của Fanpage nguồn.
    const other = buildCandidates(pages, all(['p9']), enc)
    expect(other[0]).toMatchObject({ selectable: false, reason: 'PERMISSIONS_MISSING' })
    expect(other[0]!.missing).toHaveLength(6)
    expect(other[1]!.missing).toHaveLength(10)
  })
})


/** Phản hồi `debug_token` hợp lệ của Meta giả, ghi đè / bỏ trường (giá trị `undefined` → bỏ khoá). */
function debugData(overrides: Record<string, unknown> = {}) {
  const nowS = Math.floor(Date.now() / 1000)
  const data: Record<string, unknown> = {
    app_id: FAKE_APP_ID,
    type: 'USER',
    is_valid: true,
    user_id: FAKE_USER.id,
    expires_at: nowS + 60 * 86_400,
    data_access_expires_at: nowS + 90 * 86_400,
    granular_scopes: fakeGranularScopes('full'),
    ...overrides,
  }
  for (const [k, v] of Object.entries(data)) if (v === undefined) delete data[k]
  return { ok: true as const, data: { data } }
}

const resultOf = async (id: string) => OAuthResultResponse.parse((await readResult(id)).json())

describe('callback — lỗi và trường hợp biên của Meta', () => {
  it('lỗi bất ngờ khi xử lý (cipher ném) → kết quả INTERNAL, 302 về đúng màn gốc; log không có token/code', async () => {
    await app.close()
    const throwing: SecretCipher = {
      ...cipher,
      encrypt: () => {
        throw new Error('hỏng mã hoá')
      },
    }
    app = build(FAKE_CONFIG, { cipher: throwing })
    const { state } = await start('welcome')
    const cb = await callback({ state, code: FAKE_CODE.full })
    expect(cb.status).toBe(302)
    expect(cb.location).toMatch(/^\/bat-dau\?ket-noi=[0-9a-f-]{36}$/)
    const id = new URL(cb.location, 'http://x').searchParams.get('ket-noi')!
    expect(await resultOf(id)).toEqual({ provider: 'facebook', status: 'error', candidates: [], errorCode: 'INTERNAL', truncated: false })
    const logs = logLines.join('')
    expect(logs).not.toMatch(PLAIN_TOKEN)
    expect(logs).not.toContain(FAKE_CODE.full)
  })

  it('lỗi trước khi đọc state (DB ném khi xoá oauth_states) → 302 tuyệt đối về host web, Trang & Nhóm, INTERNAL', async () => {
    const { state } = await start('welcome')
    await app.close()
    // DB của connections ném ở bước tiêu state → lỗi lọt ra route (nhánh catch của app/oauth.ts).
    const brokenDb = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === 'delete') {
          return () => {
            throw new Error('db hỏng')
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    app = buildApp({
      sql: handle.sql,
      db: brokenDb,
      logger: createLogger({ level: 'trace' }, logSink),
      http: { allowedOrigins: [ORIGIN] },
      events,
      connections: { graph, cipher, config: FAKE_CONFIG },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/facebook/callback?${new URLSearchParams({ state, code: FAKE_CODE.full })}`,
      headers: cookieOf(token),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${WEB}/trang-nhom?ket-noi-loi=INTERNAL#`)
    seen.push(String(res.headers.location))
  })

  it.each([
    ['token của app khác', { app_id: '999' }],
    ['không phải user token', { type: 'PAGE' }],
  ])('debug_token: %s → OAUTH_FAILED', async (_n, overrides) => {
    graph.on('GET', '/debug_token', debugData(overrides))
    const res = await resultOf(await connect())
    expect(res).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED', candidates: [] })
    expect(graph.calls.map((c) => c.path)).not.toContain('/me/accounts')
  })

  it('code hết hạn / đã dùng (Meta 100) → OAUTH_FAILED; error khác access_denied → OAUTH_FAILED', async () => {
    graph.on('GET', '/oauth/access_token', { ok: false, kind: 'REJECTED', code: 100, status: 400 })
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED' })

    const { state } = await start()
    const cb = await callback({ state, error: 'server_error' })
    expect(await resultOf(new URL(cb.location, 'http://x').searchParams.get('ket-noi')!)).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED' })
  })

  it.each([
    ['RATE_LIMITED', { ok: false as const, kind: 'RATE_LIMITED' as const, code: 4, status: 400, retryAfterMs: 1000 }],
    ['PERMISSION_DENIED', { ok: false as const, kind: 'PERMISSION_DENIED' as const, code: 200, status: 403 }],
  ])('/me/accounts trả %s → kết quả lỗi cùng mã', async (code, failure) => {
    graph.on('GET', '/me/accounts', failure)
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: code, candidates: [] })
  })

  it('/me/accounts hai trang: lần 2 mang `after`, ứng viên từ cả hai', async () => {
    graph.on('GET', '/me/accounts', (call) => {
      const after = call.options.params?.after
      if (after === undefined) {
        return { ok: true, data: { data: [{ ...FAKE_PAGES.beauty, access_token: 'FAKE_PAGE_1_x' }], paging: { cursors: { after: 'CUR1' }, next: 'https://graph/next' } } }
      }
      expect(after).toBe('CUR1')
      return { ok: true, data: { data: [{ ...FAKE_PAGES.home, access_token: 'FAKE_PAGE_2_x' }], paging: { cursors: { after: 'CUR2' } } } }
    })
    const res = await resultOf(await connect())
    expect(graph.calls.filter((c) => c.path === '/me/accounts').map((c) => c.options.params?.after)).toEqual([undefined, 'CUR1'])
    expect(res.candidates.map((c) => c.accountId)).toEqual([FAKE_PAGES.beauty.id, FAKE_PAGES.home.id])
    expect(res.truncated).toBe(false)
  })

  it('quá giới hạn trang → dừng ở 10 lần gọi, truncated: true, log cảnh báo', async () => {
    let n = 0
    graph.on('GET', '/me/accounts', () => {
      n += 1
      return { ok: true, data: { data: [{ id: `90000000000${String(n).padStart(4, '0')}`, name: `P${n}`, access_token: `FAKE_PAGE_${n}_x` }], paging: { cursors: { after: `C${n}` }, next: 'https://graph/next' } } }
    })
    const res = await resultOf(await connect())
    expect(n).toBe(10)
    expect(res.truncated).toBe(true)
    expect(res.candidates).toHaveLength(10)
    expect(logLines.join('')).toContain('quá nhiều Fanpage')
  })

  it('không có granular_scopes → dùng `scopes` (cấp chung): ứng viên chọn được', async () => {
    graph.on('GET', '/debug_token', debugData({ granular_scopes: undefined, scopes: [...META_LOGIN_SCOPES] }))
    const res = await resultOf(await connect())
    expect(res.candidates.filter((c) => c.reason !== 'IG_NOT_BUSINESS').every((c) => c.selectable)).toBe(true)
  })

  it('Meta không cho biết hạn user token → lưu now + 60 ngày (không phải 0)', async () => {
    graph.on('GET', '/debug_token', debugData({ expires_at: undefined }))
    graph.on('GET', '/oauth/access_token', (call) =>
      call.options.params?.grant_type === 'fb_exchange_token'
        ? { ok: true, data: { access_token: 'FAKE_LONG_full_x' } }
        : { ok: true, data: { access_token: 'FAKE_SHORT_full_x' } },
    )
    await connect()
    const [acc] = await handle.sql<{ expires_at: string }[]>`select expires_at from meta_accounts`
    const expected = Date.now() / 1000 + 60 * 86_400
    expect(Math.abs(Number(acc!.expires_at) - expected)).toBeLessThan(60)
  })
})

describe('xác nhận lại trang đang hoạt động', () => {
  it('giữ id và connected_at, làm mới token, không phát sự kiện', async () => {
    const [fb] = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_PAGES.beauty.id])).json()).pages
    const [before] = await handle.sql<{ connected_at: Date }[]>`select connected_at from pages where id = ${fb!.id}`
    const oldEnvelope = (await credRows())[0]!.access_token
    await waitFor(() => realtime.messages.some((m) => m.type === 'page.connected'))
    await sleep(50)
    realtime.messages.length = 0

    const [again] = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_PAGES.beauty.id])).json()).pages
    expect(again!.id).toBe(fb!.id)
    const [after] = await handle.sql<{ connected_at: Date }[]>`select connected_at from pages where id = ${fb!.id}`
    expect(new Date(after!.connected_at).getTime()).toBe(new Date(before!.connected_at).getTime())
    expect((await credRows())[0]!.access_token).not.toBe(oldEnvelope)
    await sleep(300)
    expect(realtime.messages.filter((m) => String(m.type).startsWith('page.'))).toEqual([])
  })
})

describe('getAccessToken từ chối trang không dùng được', () => {
  async function connectBoth() {
    const { pages } = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_IG.business.id])).json())
    return { fb: pages[0]!, ig: pages[1]! }
  }
  const tokenError = async (pageId: string) => {
    try {
      await getAccessToken({ db: handle.db, cipher }, pageId)
    } catch (err) {
      return (err as { code?: string }).code
    }
    return 'OK'
  }

  it('trang mất kết nối → PAGE_DISCONNECTED; trang đã gỡ → PAGE_REMOVED', async () => {
    const { fb } = await connectBoth()
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${fb.id}`
    expect(await tokenError(fb.id)).toBe('PAGE_DISCONNECTED')
    await handle.sql`update pages set removed_at = now() where id = ${fb.id}`
    expect(await tokenError(fb.id)).toBe('PAGE_REMOVED')
  })

  it('IG có Fanpage nguồn mất kết nối hoặc đã gỡ → PAGE_DISCONNECTED', async () => {
    const { fb, ig } = await connectBoth()
    expect(await tokenError(ig.id)).toBe('OK')
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${fb.id}`
    expect(await tokenError(ig.id)).toBe('PAGE_DISCONNECTED')
    await handle.sql`update pages set connection_status = 'active', removed_at = now() where id = ${fb.id}`
    expect(await tokenError(ig.id)).toBe('PAGE_DISCONNECTED')
  })
})

describe('dọn OAuth', () => {
  it('đăng xuất xoá state và kết quả OAuth của phiên', async () => {
    await connect()
    await start()
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...cookieOf(token), origin: ORIGIN } })
    expect(res.statusCode).toBe(204)
    expect(await handle.sql`select 1 from oauth_results where session_id = ${sessionId}`).toHaveLength(0)
    expect(await handle.sql`select 1 from oauth_states where session_id = ${sessionId}`).toHaveLength(0)
  })

  it('cleanupExpiredOAuth (cron connections.oauth_gc) chỉ xoá bản hết hạn', async () => {
    const keep = await connect()
    const gone = await connect()
    await start()
    await handle.sql`update oauth_results set expires_at = now() - interval '1 second' where id = ${gone}`
    await handle.sql`update oauth_states set expires_at = now() - interval '1 second'`
    expect(await cleanupExpiredOAuth(handle.db)).toBe(2)
    expect((await handle.sql<{ id: string }[]>`select id from oauth_results`).map((r) => r.id)).toEqual([keep])
  })
})

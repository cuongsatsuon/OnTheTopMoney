// Ma trận Story 2.3 — kết nối Threads qua OAuth riêng (Threads giả `fake-meta.ts`).
// Kiểm thêm: bỏ `#_` khỏi code, `expires_at` = now + expires_in, DB chỉ chứa envelope, log / URL chuyển hướng /
// phản hồi không chứa token, `debug_token` của app khác bị từ chối.
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import {
  ConfirmConnectionsResponse,
  ErrorResponse,
  ListPagesResponse,
  OAuthResultResponse,
  StartConnectResponse,
  THREADS_LOGIN_SCOPES,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { FAKE_CODE, FAKE_THREADS_CODE, errorLocation, getAccessToken, type ConnectionsConfig } from '../src/modules/connections/index.ts'
import {
  FAKE_PAGES,
  FAKE_THREADS_APP_ID,
  FAKE_THREADS_LONG_TTL_S,
  FAKE_THREADS_USER,
  createFakeMetaGraph,
  createFakeThreads,
} from '../src/modules/connections/fake-meta.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const ORIGIN = 'http://localhost:5173'
/** Mọi token giả do Threads giả / Meta giả cấp — không được xuất hiện ở DB, log, URL hay phản hồi. */
const PLAIN_TOKEN = /FAKE_(TH_SHORT|TH_LONG|SHORT|LONG|PAGE)_/
const ENVELOPE = /^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const REAL_SECRET = 'real-threads-secret-should-not-leak'
const RESULT_LOCATION = /^\/trang-nhom\?ket-noi=[0-9a-f-]{36}&nen-tang=threads$/

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
  THREADS_APP_ID: undefined,
  THREADS_APP_SECRET: undefined,
}
const REAL_CONFIG: ConnectionsConfig = { ...FAKE_CONFIG, META_FAKE: false, THREADS_APP_ID: '424242', THREADS_APP_SECRET: REAL_SECRET }

async function wipe() {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from oauth_states`
  await handle.sql`delete from oauth_results`
  await handle.sql`delete from meta_accounts`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-connections-threads', { background: false })
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
let threads: FakeMetaClient
let token: string

function build(config: ConnectionsConfig = FAKE_CONFIG, options: { threads?: FakeMetaClient | null } = {}) {
  const client = options.threads === undefined ? threads : (options.threads ?? undefined)
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'trace' }, logSink),
    http: { allowedOrigins: [ORIGIN] },
    events,
    connections: { graph, threads: client, cipher, config },
  })
}

beforeEach(async () => {
  await wipe()
  realtime.messages.length = 0
  graph = createFakeMetaGraph()
  threads = createFakeThreads()
  app = build()
  token = (await createSession(handle.db)).token
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

async function start(from: 'pages' | 'welcome' | 'settings' = 'pages', provider: 'threads' | 'facebook' = 'threads') {
  const res = await api('POST', `/api/v1/connections/${provider}/start`, { from })
  expect(res.statusCode).toBe(200)
  const { url } = StartConnectResponse.parse(res.json())
  return { url, state: new URL(url, 'http://x').searchParams.get('state')! }
}

async function callback(params: Record<string, string>, as: string | null = token, provider: 'threads' | 'facebook' = 'threads') {
  const res = await app.inject({ method: 'GET', url: `/oauth/${provider}/callback?${new URLSearchParams(params)}`, headers: cookieOf(as) })
  // Callback luôn kết thúc Location bằng fragment rỗng (đè `#_` mà Meta/Threads nối vào URL callback).
  const raw = String(res.headers.location ?? '')
  expect(raw.endsWith('#')).toBe(true)
  // Location tuyệt đối trên host web; phần còn lại so như đường dẫn.
  expect(raw.startsWith(`${WEB}/`)).toBe(true)
  const location = raw.slice(WEB.length, -1)
  seen.push(location, res.body)
  return { status: res.statusCode, location }
}

const resultIdOf = (location: string) => new URL(location, 'http://x').searchParams.get('ket-noi')!

/** start → (trang giả) → callback với `code`; trả id kết quả. (`#_` thật là fragment, server không nhận.) */
async function connect(code: string = FAKE_THREADS_CODE.full, from: 'pages' | 'welcome' = 'pages') {
  const { state } = await start(from)
  const cb = await callback({ state, code })
  expect(cb.status).toBe(302)
  const id = resultIdOf(cb.location)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  return id
}

const readResult = (id: string, as: string | null = token) => api('GET', `/api/v1/connections/oauth-results/${id}`, undefined, as)
const resultOf = async (id: string) => OAuthResultResponse.parse((await readResult(id)).json())
const confirm = (resultId: string, accountIds: string[]) => api('POST', '/api/v1/connections/confirm', { resultId, accountIds })

const credRows = () =>
  handle.sql<{ page_id: string; access_token: string | null; token_source_page_id: string | null; meta_account_id: string | null; expires_at: string; granular_scopes: string[] }[]>`
    select page_id, access_token, token_source_page_id, meta_account_id, expires_at, granular_scopes from page_credentials`

/** Phản hồi `debug_token` hợp lệ của Threads giả, ghi đè / bỏ trường (`undefined` → bỏ khoá). */
function debugData(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    app_id: FAKE_THREADS_APP_ID,
    type: 'USER',
    is_valid: true,
    user_id: FAKE_THREADS_USER.id,
    scopes: [...THREADS_LOGIN_SCOPES],
    ...overrides,
  }
  for (const [k, v] of Object.entries(data)) if (v === undefined) delete data[k]
  return { ok: true as const, data: { data } }
}

describe('POST /api/v1/connections/threads/start', () => {
  it('chưa đăng nhập → 401, không gọi Threads', async () => {
    const res = await api('POST', '/api/v1/connections/threads/start', { from: 'pages' }, null)
    expect(res.statusCode).toBe(401)
    expect(errorCode(res)).toBe('UNAUTHENTICATED')
    expect(threads.calls).toHaveLength(0)
  })

  it('Meta giả → trang đồng ý Threads giả; state provider threads, gắn phiên, màn gốc, TTL 15 phút', async () => {
    const before = Date.now()
    const { url, state } = await start('welcome')
    expect(url).toBe(`http://localhost:5173/oauth/threads/fake-consent?state=${state}`)
    const [row] = await handle.sql<{ provider: string; return_to: string; intent: string; expires_at: Date }[]>`
      select provider, return_to, intent, expires_at from oauth_states where state = ${state}`
    expect(row).toMatchObject({ provider: 'threads', return_to: 'welcome', intent: 'connect' })
    const ttl = new Date(row!.expires_at).getTime() - before
    expect(ttl).toBeGreaterThan(14 * 60_000)
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 2_000)
    expect(threads.calls).toHaveLength(0)
  })

  it('app thật → threads.com/oauth/authorize với client_id, redirect_uri, scope (phẩy), response_type, state', async () => {
    await app.close()
    app = build(REAL_CONFIG)
    const { url, state } = await start()
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://threads.com/oauth/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '424242',
      redirect_uri: 'http://localhost:5173/oauth/threads/callback',
      scope: 'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights',
      response_type: 'code',
      state,
    })
    expect(url).not.toContain(REAL_SECRET)
  })

  it.each([
    ['thiếu cặp THREADS_APP_ID/SECRET, không bật giả', { ...FAKE_CONFIG, META_FAKE: false }, undefined],
    ['có cặp nhưng không dựng được client Threads', REAL_CONFIG, null],
  ] as const)('%s → 500 META_NOT_CONFIGURED, không lưu state', async (_n, config, client) => {
    await app.close()
    app = build(config, { threads: client })
    const res = await api('POST', '/api/v1/connections/threads/start', { from: 'pages' })
    expect(res.statusCode).toBe(500)
    expect(errorCode(res)).toBe('META_NOT_CONFIGURED')
    expect(await handle.sql`select 1 from oauth_states`).toHaveLength(0)
  })

  it('from sai → 400 VALIDATION_FAILED', async () => {
    const res = await api('POST', '/api/v1/connections/threads/start', { from: 'khac' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })
})

describe('GET /oauth/threads/fake-consent', () => {
  it('chỉ có khi bật Meta giả; state được escape; Đồng ý / Huỷ / bỏ quyền trả lời; #_ ở fragment; Đồng ý bật lại ô code', async () => {
    const res = await app.inject({ method: 'GET', url: '/oauth/threads/fake-consent?state=%22%3E%3Cscript%3Ex' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('value="&quot;&gt;&lt;script&gt;x"')
    expect(res.body).not.toContain('"><script>x')
    expect(res.body).toContain('Đồng ý')
    expect(res.body).toContain('Huỷ')
    expect(res.body).toContain('Bỏ quyền trả lời')
    // Như Threads thật: `#_` nằm ở fragment của URL callback, không nằm trong `code`.
    expect(res.body).toContain('action="/oauth/threads/callback#_"')
    expect(res.body).toContain(`value="${FAKE_THREADS_CODE.full}"`)
    expect(res.body).not.toContain(`${FAKE_THREADS_CODE.full}#_`)
    // Huỷ (tắt ô code) rồi quay lại bằng bfcache → Đồng ý phải bật lại ô code.
    expect(res.body).toContain("document.getElementById('code').disabled = false")

    await app.close()
    app = build(REAL_CONFIG)
    expect((await app.inject({ method: 'GET', url: '/oauth/threads/fake-consent?state=x' })).statusCode).toBe(404)
  })
})

describe('GET /oauth/threads/callback', () => {
  it('thành công → bỏ #_, đổi token ngắn → dài, debug_token + hồ sơ; 302 /trang-nhom?ket-noi=<id>&nen-tang=threads; state dùng một lần', async () => {
    const { state } = await start()
    const cb = await callback({ state, code: `${FAKE_THREADS_CODE.full}#_` })
    expect(cb.status).toBe(302)
    expect(cb.location).toMatch(RESULT_LOCATION)
    expect(threads.calls.map((c) => `${c.method} ${c.path}${c.options.unversioned ? ' (không phiên bản)' : ''}`)).toEqual([
      'POST /oauth/access_token (không phiên bản)',
      'GET /access_token (không phiên bản)',
      'GET /debug_token',
      'GET /me',
    ])
    const [exchange, longLived, debug, me] = threads.calls
    // Đổi mã gửi bằng form body: client_secret và code không nằm trong URL.
    expect(exchange!.options.params).toBeUndefined()
    expect(exchange!.options.form).toEqual({
      client_id: FAKE_THREADS_APP_ID,
      client_secret: 'fake-threads-app-secret',
      grant_type: 'authorization_code',
      redirect_uri: 'http://localhost:5173/oauth/threads/callback',
      code: FAKE_THREADS_CODE.full,
    })
    expect(longLived!.options.params).toEqual({ grant_type: 'th_exchange_token', client_secret: 'fake-threads-app-secret' })
    expect(longLived!.options.token).toMatch(/^FAKE_TH_SHORT_full_/)
    expect(debug!.options.token).toBe(`TH|${FAKE_THREADS_APP_ID}|fake-threads-app-secret`)
    expect(debug!.options.params?.input_token).toMatch(/^FAKE_TH_LONG_full_/)
    expect(me!.options.params).toEqual({ fields: 'id,username,name,threads_profile_picture_url' })
    // Không đụng Graph Facebook, không tạo meta_accounts.
    expect(graph.calls).toHaveLength(0)
    expect(await handle.sql`select 1 from meta_accounts`).toHaveLength(0)

    const again = await callback({ state, code: FAKE_THREADS_CODE.full })
    expect(again.location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect(threads.calls).toHaveLength(4)
  })

  it('bắt đầu từ Cài đặt → /cai-dat?ket-noi=<id>&nen-tang=threads', async () => {
    const { state } = await start('settings')
    const cb = await callback({ state, code: FAKE_THREADS_CODE.full })
    expect(cb.location).toMatch(/^\/cai-dat\?ket-noi=[0-9a-f-]{36}&nen-tang=threads$/)
  })

  it('code không có hậu tố #_ vẫn dùng nguyên; bắt đầu từ Màn chào → /bat-dau', async () => {
    const { state } = await start('welcome')
    const cb = await callback({ state, code: FAKE_THREADS_CODE.full })
    expect(cb.location).toMatch(/^\/bat-dau\?ket-noi=[0-9a-f-]{36}&nen-tang=threads$/)
    expect(threads.calls[0]!.options.form?.code).toBe(FAKE_THREADS_CODE.full)
    expect((await resultOf(resultIdOf(cb.location))).status).toBe('ok')
  })

  it.each([
    ['state lạ', async () => ({ state: 'khong-co-state-nay', as: token as string | null })],
    ['không có cookie phiên', async () => ({ state: (await start()).state, as: null })],
    ['cookie của phiên khác', async () => ({ state: (await start()).state, as: (await createSession(handle.db)).token })],
    ['state của luồng Facebook', async () => ({ state: (await start('pages', 'facebook')).state, as: token })],
  ])('%s → 302 OAUTH_STATE_INVALID, không đổi code', async (_n, setup) => {
    const { state, as } = await setup()
    const cb = await callback({ state, code: FAKE_THREADS_CODE.full }, as)
    expect(cb.location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect(threads.calls).toHaveLength(0)
    expect(await handle.sql`select 1 from oauth_results`).toHaveLength(0)
  })

  it('state của luồng Threads gửi tới callback Facebook → OAUTH_STATE_INVALID, không đổi code; state còn dùng được ở Threads', async () => {
    const { state } = await start()
    const fb = await callback({ state, code: FAKE_CODE.full }, token, 'facebook')
    expect(fb.location).toBe('/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID')
    expect(graph.calls).toHaveLength(0)
    expect(threads.calls).toHaveLength(0)
    expect(await handle.sql`select 1 from oauth_results`).toHaveLength(0)
    expect((await callback({ state, code: FAKE_THREADS_CODE.full })).location).toMatch(RESULT_LOCATION)
  })

  it('huỷ (error=access_denied) → kết quả OAUTH_CANCELLED, không gọi Threads', async () => {
    const { state } = await start()
    const cb = await callback({ state, error: 'access_denied' })
    expect(cb.location).toMatch(RESULT_LOCATION)
    expect(threads.calls).toHaveLength(0)
    expect(await resultOf(resultIdOf(cb.location))).toEqual({ provider: 'threads', status: 'error', candidates: [], errorCode: 'OAUTH_CANCELLED', truncated: false })
  })

  it('mã hết hạn / đã dùng (đổi mã trả lỗi) → OAUTH_FAILED; log chỉ có bước + loại lỗi', async () => {
    expect(await resultOf(await connect('ma-da-dung-xyz'))).toMatchObject({ provider: 'threads', status: 'error', errorCode: 'OAUTH_FAILED' })
    threads.on('POST', '/oauth/access_token', { ok: false, kind: 'PERMISSION_DENIED', code: 190, status: 400 })
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED' })
    expect(threads.calls.map((c) => c.path)).not.toContain('/access_token')
    const logs = logLines.join('')
    expect(logs).toContain('code_exchange')
    expect(logs).not.toContain('ma-da-dung-xyz')
  })

  it('debug_token của app khác → OAUTH_FAILED, không đọc hồ sơ', async () => {
    threads.on('GET', '/debug_token', debugData({ app_id: '999' }))
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED', candidates: [] })
    expect(threads.calls.map((c) => c.path)).not.toContain('/me')
  })

  it.each([
    ['is_valid false', { is_valid: false }],
    ['thiếu is_valid', { is_valid: undefined }],
    ['type không phải USER', { type: 'APP' }],
    ['user_id (chuỗi) khác hồ sơ', { user_id: '99999' }],
    ['user_id (số) khác hồ sơ', { user_id: 99999 }],
    ['app_id (số) của app khác', { app_id: 999 }],
  ])('debug_token: %s → OAUTH_FAILED', async (_n, overrides) => {
    threads.on('GET', '/debug_token', debugData(overrides))
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'OAUTH_FAILED', candidates: [] })
  })

  it.each([
    ['không có type', { type: undefined }],
    ['app_id dạng số', { app_id: Number(FAKE_THREADS_APP_ID) }],
    ['user_id dạng số khớp hồ sơ', { user_id: 77 }, { id: '77', username: 'so.77' }],
    ['không có user_id', { user_id: undefined }],
  ])('debug_token: %s → vẫn nhận (so chuỗi)', async (_n, overrides, profile?: Record<string, string>) => {
    threads.on('GET', '/debug_token', debugData(overrides))
    if (profile) threads.on('GET', '/me', { ok: true, data: profile })
    expect(await resultOf(await connect())).toMatchObject({ status: 'ok' })
  })

  it.each([
    ['đổi mã thiếu access_token', () => threads.on('POST', '/oauth/access_token', { ok: true, data: { user_id: FAKE_THREADS_USER.id } })],
    ['đổi token dài hạn thiếu access_token', () => threads.on('GET', '/access_token', { ok: true, data: { expires_in: 100 } })],
    ['debug_token thiếu data', () => threads.on('GET', '/debug_token', { ok: true, data: {} })],
    [
      'không có id tài khoản (hồ sơ và debug_token)',
      () => {
        threads.on('GET', '/debug_token', debugData({ user_id: undefined }))
        threads.on('GET', '/me', { ok: true, data: { username: 'khong.id' } })
      },
    ],
  ])('%s → INTERNAL (log bước, không token)', async (_n, program) => {
    program()
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'INTERNAL', candidates: [] })
    expect(logLines.join('')).toContain('thiếu trường cần thiết')
  })

  it('đổi mã trả RATE_LIMITED → kết quả lỗi RATE_LIMITED (không phải OAUTH_FAILED)', async () => {
    threads.on('POST', '/oauth/access_token', { ok: false, kind: 'RATE_LIMITED', code: 4, status: 400, retryAfterMs: 1000 })
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'RATE_LIMITED' })
    expect(threads.calls.map((c) => c.path)).toEqual(['/oauth/access_token'])
  })

  it('Threads trả RATE_LIMITED khi đọc hồ sơ → kết quả lỗi RATE_LIMITED', async () => {
    threads.on('GET', '/me', { ok: false, kind: 'RATE_LIMITED', code: 4, status: 400, retryAfterMs: 1000 })
    expect(await resultOf(await connect())).toMatchObject({ status: 'error', errorCode: 'RATE_LIMITED' })
  })
})

describe('GET /api/v1/connections/oauth-results/:id (Threads)', () => {
  it('một ứng viên Threads chọn được; provider threads; không có token', async () => {
    const id = await connect()
    const res = await readResult(id)
    expect(res.statusCode).toBe(200)
    expect(OAuthResultResponse.parse(res.json())).toEqual({
      provider: 'threads',
      status: 'ok',
      truncated: false,
      candidates: [
        {
          accountId: FAKE_THREADS_USER.id,
          platform: 'threads',
          name: FAKE_THREADS_USER.name,
          handle: FAKE_THREADS_USER.username,
          avatarUrl: null,
          selectable: true,
          missing: [],
        },
      ],
    })
    expect(res.body).not.toMatch(PLAIN_TOKEN)
    expect(res.body).not.toContain('v1:k1:')
    expect(res.body).not.toContain('tokenEnvelope')
  })

  it('bỏ quyền trả lời → ứng viên có missing[], không chọn được; xác nhận → 400', async () => {
    const id = await connect(FAKE_THREADS_CODE.noReplies)
    const [c] = (await resultOf(id)).candidates
    expect(c).toMatchObject({ platform: 'threads', selectable: false, reason: 'PERMISSIONS_MISSING', missing: ['threads_read_replies', 'threads_manage_replies'] })
    const res = await confirm(id, [FAKE_THREADS_USER.id])
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    expect(await handle.sql`select 1 from pages`).toHaveLength(0)
  })

  it('không có data.scopes → coi như đã cấp đủ những gì đã xin', async () => {
    threads.on('GET', '/debug_token', debugData({ scopes: undefined }))
    const id = await connect()
    expect((await resultOf(id)).candidates[0]).toMatchObject({ selectable: true, missing: [] })
    expect((await confirm(id, [FAKE_THREADS_USER.id])).statusCode).toBe(200)
    expect((await credRows())[0]!.granular_scopes).toEqual([...THREADS_LOGIN_SCOPES])
  })
})

describe('POST /api/v1/connections/confirm (Threads)', () => {
  it('upsert trang Threads, token mã hoá có expires_at = now + expires_in, active, page.connected', async () => {
    const before = Math.floor(Date.now() / 1000)
    const resultId = await connect()
    const res = await confirm(resultId, [FAKE_THREADS_USER.id])
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(PLAIN_TOKEN)
    const { pages } = ConfirmConnectionsResponse.parse(res.json())
    expect(pages.map((p) => [p.platform, p.name, p.handle, p.connectionStatus])).toEqual([
      ['threads', FAKE_THREADS_USER.name, FAKE_THREADS_USER.username, 'active'],
    ])
    const page = pages[0]!
    const [row] = await handle.sql<{ platform: string; platform_account_id: string }[]>`select platform, platform_account_id from pages where id = ${page.id}`
    expect(row).toEqual({ platform: 'threads', platform_account_id: FAKE_THREADS_USER.id })

    const [cred] = await credRows()
    expect(cred!.page_id).toBe(page.id)
    expect(cred!.access_token).toMatch(ENVELOPE)
    expect(cred!.token_source_page_id).toBeNull()
    expect(cred!.meta_account_id).toBeNull()
    expect(Number(cred!.expires_at) - before - FAKE_THREADS_LONG_TTL_S).toBeGreaterThanOrEqual(0)
    expect(Number(cred!.expires_at) - before - FAKE_THREADS_LONG_TTL_S).toBeLessThan(60)
    expect(cred!.granular_scopes).toEqual([...THREADS_LOGIN_SCOPES])
    expect(await getAccessToken({ db: handle.db, cipher }, page.id)).toMatch(/^FAKE_TH_LONG_full_/)

    const msgs = await waitFor(() => {
      const m = realtime.messages.filter((x) => String(x.type).startsWith('page.'))
      return m.length >= 1 ? m : null
    })
    expect(msgs).toEqual([{ type: 'page.connected', entity: 'page', id: page.id, pageId: page.id }])
    // Kết quả đã dùng → đọc lại 404.
    expect((await readResult(resultId)).statusCode).toBe(404)
  })

  it.each([
    ['expires_in lẻ → làm tròn xuống', { expires_in: 5_183_944.75 }, undefined, (now: number) => now + 5_183_944],
    ['thiếu expires_in → mốc expires_at của debug_token', {}, 1_900_000_000, () => 1_900_000_000],
    ['thiếu cả hai → now + 60 ngày', {}, undefined, (now: number) => now + 60 * 86_400],
  ])('hạn token: %s', async (_n, extra, debugExpiresAt, expected) => {
    threads.on('GET', '/access_token', { ok: true, data: { access_token: 'FAKE_TH_LONG_full_x', ...extra } })
    threads.on('GET', '/debug_token', debugData({ expires_at: debugExpiresAt }))
    const before = Math.floor(Date.now() / 1000)
    const res = await confirm(await connect(), [FAKE_THREADS_USER.id])
    expect(res.statusCode).toBe(200)
    const got = Number((await credRows())[0]!.expires_at)
    expect(Number.isInteger(got)).toBe(true)
    expect(got - expected(before)).toBeGreaterThanOrEqual(0)
    expect(got - expected(before)).toBeLessThan(60)
  })

  it('kết nối lại Threads đã gỡ / mất kết nối → khôi phục đúng dòng cũ, token mới, page.reconnected', async () => {
    const [first] = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_THREADS_USER.id])).json()).pages
    const oldEnvelope = (await credRows())[0]!.access_token
    for (const broken of [sql_removed, sql_disconnected]) {
      await broken(first!.id)
      await sleep(100)
      realtime.messages.length = 0
      const [again] = ConfirmConnectionsResponse.parse((await confirm(await connect(), [FAKE_THREADS_USER.id])).json()).pages
      expect(again!.id).toBe(first!.id)
      expect(again!.connectionStatus).toBe('active')
      const [row] = await handle.sql<{ removed_at: Date | null }[]>`select removed_at from pages where id = ${first!.id}`
      expect(row!.removed_at).toBeNull()
      await waitFor(() => realtime.messages.some((x) => x.type === 'page.reconnected'))
      expect(realtime.messages.filter((x) => String(x.type).startsWith('page.')).map((m) => [m.type, m.id])).toEqual([['page.reconnected', first!.id]])
    }
    expect((await credRows())[0]!.access_token).not.toBe(oldEnvelope)
  })

  it('Threads là tài khoản riêng: kết nối cùng Facebook → hai nền tảng tách biệt trong danh sách trang', async () => {
    const fbStart = await start('pages', 'facebook')
    const fbCb = await callback({ state: fbStart.state, code: FAKE_CODE.full }, token, 'facebook')
    expect(fbCb.location).toMatch(/^\/trang-nhom\?ket-noi=[0-9a-f-]{36}$/)
    expect((await confirm(resultIdOf(fbCb.location), [FAKE_PAGES.beauty.id])).statusCode).toBe(200)
    expect((await confirm(await connect(), [FAKE_THREADS_USER.id])).statusCode).toBe(200)
    const { items } = ListPagesResponse.parse((await api('GET', '/api/v1/pages')).json())
    expect(items.map((p) => p.platform).sort()).toEqual(['facebook', 'threads'])
    const creds = await credRows()
    expect(creds.filter((c) => c.meta_account_id !== null)).toHaveLength(1)
  })
})

async function sql_removed(id: string) {
  await handle.sql`update pages set removed_at = now(), connection_status = 'disconnected' where id = ${id}`
}
async function sql_disconnected(id: string) {
  await handle.sql`update pages set connection_status = 'disconnected' where id = ${id}`
}

describe('URL lỗi theo màn gốc + nền tảng', () => {
  it('errorLocation: Threads kèm nen-tang, Facebook không; đúng màn gốc', () => {
    expect(errorLocation('threads', 'welcome', 'INTERNAL')).toBe('/bat-dau?ket-noi-loi=INTERNAL&nen-tang=threads')
    expect(errorLocation('threads', 'settings', 'INTERNAL')).toBe('/cai-dat?ket-noi-loi=INTERNAL&nen-tang=threads')
    expect(errorLocation('facebook', 'pages', 'INTERNAL')).toBe('/trang-nhom?ket-noi-loi=INTERNAL')
  })

  it('lỗi trước khi đọc state (DB ném khi xoá oauth_states) → 302 tuyệt đối về host web, Trang & Nhóm + nen-tang=threads', async () => {
    const { state } = await start('welcome')
    await app.close()
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
      connections: { graph, threads, cipher, config: FAKE_CONFIG },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/threads/callback?${new URLSearchParams({ state, code: FAKE_THREADS_CODE.full })}`,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${WEB}/trang-nhom?ket-noi-loi=INTERNAL&nen-tang=threads#`)
    seen.push(String(res.headers.location))
  })

  it('lỗi khi lưu kết quả (sau khi đọc state) → về đúng màn gốc + nền tảng với INTERNAL', async () => {
    const { state } = await start('welcome')
    // Ứng viên không serialize được vào jsonb → insert oauth_results ném.
    threads.on('GET', '/me', { ok: true, data: { id: FAKE_THREADS_USER.id, name: 'x\u0000y' } })
    const cb = await callback({ state, code: FAKE_THREADS_CODE.full })
    expect(cb.location).toBe('/bat-dau?ket-noi-loi=INTERNAL&nen-tang=threads')
  })
})

describe('không lộ token (AD-5, AD-12)', () => {
  it('sau trọn luồng: DB chỉ chứa envelope; job, log, URL chuyển hướng, phản hồi không chứa token', async () => {
    await confirm(await connect(), [FAKE_THREADS_USER.id])
    await connect(FAKE_THREADS_CODE.noReplies)
    const dump = JSON.stringify([
      await handle.sql`select * from pages`,
      await handle.sql`select * from page_credentials`,
      await handle.sql`select * from oauth_results`,
      await handle.sql`select * from oauth_states`,
      await handle.sql.unsafe(`select data from ${BOSS_SCHEMA}.job`),
    ])
    expect(dump).not.toMatch(PLAIN_TOKEN)
    const [res] = await handle.sql<{ candidates: { tokenEnvelope?: string }[] }[]>`select candidates from oauth_results`
    for (const c of res!.candidates) expect(c.tokenEnvelope).toMatch(ENVELOPE)
  })

  it('cuối file: mọi log và URL/phản hồi đã thấy không chứa token rõ hay secret', () => {
    expect(logLines.length).toBeGreaterThan(0)
    const logs = logLines.join('')
    expect(logs).not.toMatch(PLAIN_TOKEN)
    expect(logs).not.toContain(REAL_SECRET)
    expect(logs).not.toContain('fake-threads-app-secret')
    expect(seen.join('\n')).not.toMatch(PLAIN_TOKEN)
  })
})

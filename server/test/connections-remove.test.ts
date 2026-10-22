// Story 2.7 — Gỡ trang khỏi app (Meta giả `fake-meta.ts`). Kiểm: soft-delete + xoá token + phát `page.removed`
// trong một transaction (AD-3); trang biến khỏi danh sách và bộ chọn phạm vi; 404 cho id lạ / đã gỡ; 401/403;
// ranh giới token khi gỡ Fanpage nguồn của IG (AD-5); và kết nối lại khôi phục đúng dòng cũ giữ nhóm + lịch sử.
import { randomBytes } from 'node:crypto'
import {
  ConfirmConnectionsResponse,
  ErrorResponse,
  ListPagesResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { FAKE_CODE, getAccessToken, type ConnectionsConfig } from '../src/modules/connections/index.ts'
import { FAKE_IG, FAKE_PAGES, createFakeMetaGraph } from '../src/modules/connections/fake-meta.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const ORIGIN = 'http://localhost:5173'
const WEB = 'http://localhost:4173'
const FAKE_CONFIG: ConnectionsConfig = {
  META_FAKE: true,
  META_GRAPH_VERSION: 'v26.0',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  WEB_BASE_URL: WEB,
  META_APP_ID: undefined,
  META_APP_SECRET: undefined,
  META_LOGIN_CONFIG_ID: undefined,
}
const GROUP_ID = '0199a000-0000-7000-8000-0000000007a7'
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000'

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })

async function wipe() {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from oauth_states`
  await handle.sql`delete from oauth_results`
  await handle.sql`delete from meta_accounts`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-remove', { background: false })
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

function build() {
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    http: { allowedOrigins: [ORIGIN] },
    events,
    connections: { graph, cipher, config: FAKE_CONFIG },
  })
}

beforeEach(async () => {
  await wipe()
  realtime.messages.length = 0
  graph = createFakeMetaGraph()
  app = build()
  token = (await createSession(handle.db)).token
})
afterEach(async () => {
  await app.close()
})

const cookieOf = (t: string | null) => (t ? { cookie: `${SESSION_COOKIE}=${t}` } : {})

async function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, as: string | null = token, origin: string | null = ORIGIN) {
  return app.inject({
    method,
    url,
    headers: { ...cookieOf(as), ...(method === 'GET' ? {} : origin ? { origin } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code

async function callback(params: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: `/oauth/facebook/callback?${new URLSearchParams(params)}`, headers: cookieOf(token) })
  return new URL(String(res.headers.location ?? '').replace(/#$/, ''), 'http://x').searchParams.get('ket-noi')!
}

/** start → callback → trả resultId để confirm. */
async function connect(code: string = FAKE_CODE.full) {
  const startRes = await api('POST', '/api/v1/connections/facebook/start', { from: 'pages' })
  const url = (startRes.json() as { url: string }).url
  const state = new URL(url, 'http://x').searchParams.get('state')!
  return callback({ state, code })
}

const confirm = (resultId: string, accountIds: string[]) =>
  api('POST', '/api/v1/connections/confirm', { resultId, accountIds })

/** Kết nối rồi xác nhận các tài khoản; trả các trang đã tạo. */
async function connectConfirm(accountIds: string[]) {
  const res = await confirm(await connect(), accountIds)
  expect(res.statusCode).toBe(200)
  return ConfirmConnectionsResponse.parse(res.json()).pages
}

const pageRows = () =>
  handle.sql<{ id: string; platform: string; connection_status: string; removed_at: Date | null; group_id: string | null }[]>`
    select id, platform, connection_status, removed_at, group_id from pages order by platform`
const credPageIds = async () => (await handle.sql<{ page_id: string }[]>`select page_id from page_credentials`).map((r) => r.page_id)
const listPages = async () => ListPagesResponse.parse((await api('GET', '/api/v1/pages')).json()).items.map((p) => p.id)
const remove = (id: string, as: string | null = token, origin: string | null = ORIGIN) => api('DELETE', `/api/v1/pages/${id}`, undefined, as, origin)

async function seedGroup(id: string) {
  await handle.sql`insert into groups (id, name, color) values (${id}, 'Nhóm test', 'group-1') on conflict (id) do nothing`
}

describe('DELETE /api/v1/pages/:id — gỡ trang', () => {
  it('trang active → 204; removed_at set, token xoá, page.removed; biến khỏi danh sách và phạm vi', async () => {
    const [fb] = await connectConfirm([FAKE_PAGES.beauty.id])
    await waitFor(() => realtime.messages.some((m) => m.type === 'page.connected'))
    await sleep(50)
    realtime.messages.length = 0

    const res = await remove(fb!.id)
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')

    const rows = await pageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.removed_at).not.toBeNull()
    // Lịch sử trang (dòng) vẫn còn — chỉ đánh dấu gỡ, không xoá cứng.
    expect(rows[0]!.id).toBe(fb!.id)
    // Token của trang bị xoá.
    expect(await credPageIds()).toEqual([])

    // Danh sách và phạm vi không còn trang đó.
    expect(await listPages()).toEqual([])
    expect((await api('GET', `/api/v1/pages?scope=page:${fb!.id}`)).statusCode).toBe(404)
    const all = await api('GET', '/api/v1/pages?scope=all')
    expect(ListPagesResponse.parse(all.json()).items).toEqual([])

    // page.removed phát qua realtime.
    const msgs = await waitFor(() => {
      const m = realtime.messages.filter((x) => String(x.type).startsWith('page.'))
      return m.length >= 1 ? m : null
    })
    expect(msgs).toEqual([{ type: 'page.removed', entity: 'page', id: fb!.id, pageId: fb!.id }])
  })

  it('pageId lạ (uuid hợp lệ, không tồn tại) → 404', async () => {
    const res = await remove(UNKNOWN_ID)
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
  })

  it('trang đã gỡ → 404 (nhất quán: đã gỡ xem như không còn); không phát sự kiện lần hai', async () => {
    const [fb] = await connectConfirm([FAKE_PAGES.beauty.id])
    expect((await remove(fb!.id)).statusCode).toBe(204)
    await sleep(50)
    realtime.messages.length = 0
    const again = await remove(fb!.id)
    expect(again.statusCode).toBe(404)
    expect(errorCode(again)).toBe('NOT_FOUND')
    await sleep(150)
    expect(realtime.messages.filter((m) => String(m.type).startsWith('page.'))).toEqual([])
  })

  it('id sai dạng (không phải uuid) → 400 VALIDATION_FAILED', async () => {
    const res = await remove('khong-phai-uuid')
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('chưa đăng nhập → 401, không gỡ', async () => {
    const [fb] = await connectConfirm([FAKE_PAGES.beauty.id])
    const res = await remove(fb!.id, null)
    expect(res.statusCode).toBe(401)
    expect(errorCode(res)).toBe('UNAUTHENTICATED')
    expect((await pageRows())[0]!.removed_at).toBeNull()
  })

  it('Origin ngoài allowlist → 403, không gỡ', async () => {
    const [fb] = await connectConfirm([FAKE_PAGES.beauty.id])
    const res = await remove(fb!.id, token, 'http://evil.example')
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('FORBIDDEN')
    expect((await pageRows())[0]!.removed_at).toBeNull()
  })
})

describe('ranh giới token khi gỡ (AD-5)', () => {
  it('gỡ Fanpage nguồn token: IG liên kết chuyển disconnected + phát page.disconnected (cùng transaction)', async () => {
    const [fb, ig] = await connectConfirm([FAKE_IG.business.id])
    expect(await getAccessToken({ db: handle.db, cipher }, ig!.id)).toContain('FAKE_PAGE_')
    await waitFor(() => realtime.messages.some((m) => m.type === 'page.connected'))
    await sleep(50)
    realtime.messages.length = 0

    expect((await remove(fb!.id)).statusCode).toBe(204)

    const rows = Object.fromEntries((await pageRows()).map((r) => [r.id, r]))
    expect(rows[fb!.id]!.removed_at).not.toBeNull()
    // IG không bị gỡ (removed_at null) nhưng mất kết nối vì token nguồn đã mất.
    expect(rows[ig!.id]!.removed_at).toBeNull()
    expect(rows[ig!.id]!.connection_status).toBe('disconnected')
    // Chỉ token của Fanpage bị xoá; credential IG (trỏ token_source) vẫn còn.
    expect((await credPageIds()).sort()).toEqual([ig!.id].sort())

    const tokenErr = await getAccessToken({ db: handle.db, cipher }, ig!.id).then(() => 'OK', (e: { code?: string }) => e.code)
    expect(tokenErr).toBe('PAGE_DISCONNECTED')

    // page.removed (Fanpage) + page.disconnected (IG) cùng phát.
    const msgs = await waitFor(() => {
      const m = realtime.messages.filter((x) => String(x.type).startsWith('page.'))
      return m.length >= 2 ? m : null
    })
    expect(msgs).toEqual(
      expect.arrayContaining([
        { type: 'page.removed', entity: 'page', id: fb!.id, pageId: fb!.id },
        { type: 'page.disconnected', entity: 'page', id: ig!.id, pageId: ig!.id },
      ]),
    )
  })

  it('gỡ IG (không phải nguồn token): chỉ xoá credential của IG; Fanpage còn active, không ảnh hưởng', async () => {
    const [fb, ig] = await connectConfirm([FAKE_IG.business.id])
    await waitFor(() => realtime.messages.some((m) => m.type === 'page.connected'))
    await sleep(50)
    realtime.messages.length = 0

    expect((await remove(ig!.id)).statusCode).toBe(204)
    expect((await credPageIds()).sort()).toEqual([fb!.id].sort())
    const rows = Object.fromEntries((await pageRows()).map((r) => [r.id, r]))
    expect(rows[fb!.id]!.removed_at).toBeNull()
    expect(rows[fb!.id]!.connection_status).toBe('active')
    expect(await getAccessToken({ db: handle.db, cipher }, fb!.id)).toContain('FAKE_PAGE_')

    // Gỡ IG không làm trang nào mất kết nối (chỉ page.removed của chính IG).
    await sleep(200)
    expect(realtime.messages.filter((m) => String(m.type).startsWith('page.')).map((m) => [m.type, m.id])).toEqual([['page.removed', ig!.id]])
  })
})

describe('kết nối lại trang đã gỡ (AC2)', () => {
  it('confirm OAuth khôi phục đúng dòng cũ: removed_at=null, giữ id + nhóm + lịch sử, active, page.reconnected', async () => {
    const [fb] = await connectConfirm([FAKE_PAGES.beauty.id])
    await seedGroup(GROUP_ID)
    await handle.sql`update pages set group_id = ${GROUP_ID} where id = ${fb!.id}`

    expect((await remove(fb!.id)).statusCode).toBe(204)
    await sleep(50)
    realtime.messages.length = 0
    expect(await listPages()).toEqual([])

    const again = await connectConfirm([FAKE_PAGES.beauty.id])
    // Khôi phục đúng dòng cũ (cùng id), không tạo dòng mới.
    expect(again.map((p) => p.id)).toEqual([fb!.id])
    const rows = await pageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.removed_at).toBeNull()
    expect(rows[0]!.connection_status).toBe('active')
    // Nhóm (cấu hình/lịch sử) được giữ qua vòng gỡ → kết nối lại.
    expect(rows[0]!.group_id).toBe(GROUP_ID)
    // Token mới được lưu lại.
    expect(await credPageIds()).toEqual([fb!.id])

    await waitFor(() => realtime.messages.some((m) => String(m.type).startsWith('page.')))
    await sleep(150)
    expect(realtime.messages.filter((m) => String(m.type).startsWith('page.')).map((m) => [m.type, m.id])).toEqual([['page.reconnected', fb!.id]])
  })
})

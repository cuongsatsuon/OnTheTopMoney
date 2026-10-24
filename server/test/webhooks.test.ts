// Story 4.1 — cổng webhook: verify HMAC raw body → ghi + enqueue → 200; sai chữ ký 401 không ghi; dedupe
// UNIQUE; GET challenge/403; job route ignore trang-không-có/test/routed; retry; API Cài đặt › Webhook.
import { createHmac } from 'node:crypto'
import { WebhookConfigResponse, WebhookEventDto, WebhookLogResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { WEBHOOK_SIGNATURE_PREFIX } from '../src/adapters/meta/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { upsertFromPlatform } from '../src/modules/pages/index.ts'
import { markEventFailed, routeWebhookEvent, webhookEventsTable } from '../src/modules/webhooks/index.ts'
import { createSession } from '../src/modules/settings/index.ts'

const ORIGIN = 'http://localhost:5173'
const META_SECRET = 'meta-app-secret-123'
const THREADS_SECRET = 'threads-app-secret-123'
const VERIFY_TOKEN = 'verify-token-abcdef-1234567890'
const PUBLIC_BASE_URL = 'https://app.example.com'

let handle: DbHandle
let boss: PgBoss
let jobs: JobSender
let app: FastifyInstance

const sign = (raw: string, secret = META_SECRET) => WEBHOOK_SIGNATURE_PREFIX + createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')

function postMeta(raw: string, opts: { signature?: string; product?: 'meta' | 'threads' } = {}) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/${opts.product ?? 'meta'}`,
    headers: {
      'content-type': 'application/json',
      ...(opts.signature !== undefined ? { 'x-hub-signature-256': opts.signature } : {}),
    },
    payload: raw,
  })
}

async function countEvents() {
  const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from webhook_events`
  return row!.n
}
async function countRouteJobs() {
  const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = 'webhook.route'`
  return row!.n
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-webhooks', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss) // tạo queue webhook.route để boss.send không lỗi
  jobs = createJobSender(boss)
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    webhooks: { jobs, verifyToken: VERIFY_TOKEN, metaAppSecret: META_SECRET, threadsAppSecret: THREADS_SECRET, publicBaseUrl: PUBLIC_BASE_URL },
  })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name = 'webhook.route'`
})

const graphBody = (mid = 'm_1', pageId = 'PAGE_1') =>
  JSON.stringify({ object: 'page', entry: [{ id: pageId, messaging: [{ sender: { id: 'u1' }, message: { mid, text: 'hi' } }] }] })

describe('POST /webhooks/meta — verify + ghi + enqueue', () => {
  it('chữ ký đúng → 200, ghi mục, enqueue webhook.route mỗi mục', async () => {
    const raw = graphBody()
    const res = await postMeta(raw, { signature: sign(raw) })
    expect(res.statusCode).toBe(200)
    expect(await countEvents()).toBe(1)
    expect(await countRouteJobs()).toBe(1)
    const [row] = await handle.sql<{ product: string; field: string; dedupe_key: string; status: string }[]>`
      select product, field, dedupe_key, status from webhook_events`
    expect(row).toMatchObject({ product: 'meta', field: 'messages', dedupe_key: 'messages:m_1', status: 'received' })
  })

  it('chữ ký sai → 401, KHÔNG ghi, KHÔNG enqueue', async () => {
    const raw = graphBody()
    const res = await postMeta(raw, { signature: sign(raw, 'secret-khac') })
    expect(res.statusCode).toBe(401)
    expect(await countEvents()).toBe(0)
    expect(await countRouteJobs()).toBe(0)
  })

  it('thiếu chữ ký → 401, KHÔNG ghi', async () => {
    const raw = graphBody()
    const res = await postMeta(raw)
    expect(res.statusCode).toBe(401)
    expect(await countEvents()).toBe(0)
  })

  it('verify trên ĐÚNG raw body: body có khoảng trắng lạ, ký trên đúng byte → 200', async () => {
    const raw = '{\n  "object":"page",\n  "entry":[{"id":"PAGE_1","messaging":[{"message":{"mid":"m_ws"}}]}]\n}'
    const res = await postMeta(raw, { signature: sign(raw) })
    expect(res.statusCode).toBe(200)
    expect(await countEvents()).toBe(1)
  })

  it('gửi lại gom khác cùng mid → UNIQUE chặn bản thứ hai (1 dòng)', async () => {
    const first = graphBody('m_dup')
    expect((await postMeta(first, { signature: sign(first) })).statusCode).toBe(200)
    // Lần 2: cùng mid nhưng gom trong entry khác (thêm trang khác không có mục) — vẫn chỉ 1 dòng cho m_dup.
    const second = JSON.stringify({
      object: 'page',
      entry: [{ id: 'PAGE_1', messaging: [{ message: { mid: 'm_dup', text: 'hi' } }] }],
    })
    expect((await postMeta(second, { signature: sign(second) })).statusCode).toBe(200)
    expect(await countEvents()).toBe(1)
  })

  it('threads ký bằng Threads app secret', async () => {
    const raw = JSON.stringify({ object: 'threads', entry: [{ id: 'TH_1', changes: [{ field: 'replies', value: { id: 'r_1' } }] }] })
    const res = await postMeta(raw, { product: 'threads', signature: sign(raw, THREADS_SECRET) })
    expect(res.statusCode).toBe(200)
    const [row] = await handle.sql<{ product: string; field: string }[]>`select product, field from webhook_events`
    expect(row).toMatchObject({ product: 'threads', field: 'replies' })
  })
})

describe('GET /webhooks/{meta,threads} — xác minh', () => {
  it('verify token khớp → 200 trả hub.challenge', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CH_123`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('CH_123')
  })

  it('verify token sai → 403', async () => {
    const res = await app.inject({ method: 'GET', url: `/webhooks/threads?hub.mode=subscribe&hub.verify_token=sai&hub.challenge=X` })
    expect(res.statusCode).toBe(403)
  })
})

describe('routeWebhookEvent (job webhook.route)', () => {
  // Story 4.3: route cần `events` + `jobs` (ingest DM). Mục `messages` thật được phủ ở inbox.test.ts.
  const routeDeps = () => ({ db: handle.db, events: createEventPublisher(boss), jobs })
  async function insertEvent(values: { platformPageId?: string | null; field?: string; test?: boolean }) {
    const [row] = await handle.db
      .insert(webhookEventsTable)
      .values({
        product: 'meta',
        platformPageId: values.platformPageId ?? null,
        field: values.field ?? 'messages',
        dedupeKey: `k_${Math.random().toString(36).slice(2)}`,
        payload: {},
        test: values.test ?? false,
      })
      .returning({ id: webhookEventsTable.id })
    return row!.id
  }
  async function statusOf(id: string) {
    const [row] = await handle.sql<{ status: string; page_id: string | null }[]>`
      select status, page_id from webhook_events where id = ${id}`
    return row!
  }

  it('trang không có trong DB → ignored (lưu, không route)', async () => {
    const id = await insertEvent({ platformPageId: 'KHONG_CO' })
    expect(await routeWebhookEvent(routeDeps(), { eventId: id })).toBe('ignored_no_page')
    expect((await statusOf(id)).status).toBe('ignored')
  })

  it('sự kiện thử → ignored (chỉ nhật ký)', async () => {
    const id = await insertEvent({ test: true, field: 'test' })
    expect(await routeWebhookEvent(routeDeps(), { eventId: id })).toBe('ignored_test')
    expect((await statusOf(id)).status).toBe('ignored')
  })

  // Story 4.4: không còn `routed` giả — bình luận thật được phủ ở inbox-comments.test.ts; mục rỗng không ingest được.
  it('trang có + mục bình luận không chuẩn hoá được → ignored, vẫn gắn page_id nội bộ', async () => {
    const { page } = await upsertFromPlatform(handle.db, {
      platform: 'facebook',
      platformAccountId: 'PAGE_R',
      name: 'Trang R',
      handle: null,
      avatarUrl: null,
    })
    const id = await insertEvent({ platformPageId: 'PAGE_R', field: 'comments' })
    expect(await routeWebhookEvent(routeDeps(), { eventId: id })).toBe('ignored')
    expect(await statusOf(id)).toMatchObject({ status: 'ignored', page_id: page.id })
  })

  it('trùng platform_account_id khác nền tảng → chọn đúng trang theo sản phẩm (không route chéo)', async () => {
    const fb = await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'SAME_ID', name: 'FB', handle: null, avatarUrl: null })
    const th = await upsertFromPlatform(handle.db, { platform: 'threads', platformAccountId: 'SAME_ID', name: 'TH', handle: null, avatarUrl: null })
    const metaId = await insertEvent({ platformPageId: 'SAME_ID', field: 'comments' })
    expect(await routeWebhookEvent(routeDeps(), { eventId: metaId })).toBe('ignored')
    expect((await statusOf(metaId)).page_id).toBe(fb.page.id)
    // Mục Threads cùng id → khớp trang Threads, không phải trang Facebook.
    const [thRow] = await handle.db
      .insert(webhookEventsTable)
      .values({ product: 'threads', platformPageId: 'SAME_ID', field: 'replies', dedupeKey: `k_${Math.random().toString(36).slice(2)}`, payload: {} })
      .returning({ id: webhookEventsTable.id })
    expect(await routeWebhookEvent(routeDeps(), { eventId: thRow!.id })).toBe('ignored')
    expect((await statusOf(thRow!.id)).page_id).toBe(th.page.id)
  })

  it('trang có nhưng loại không route (reaction) → ignored', async () => {
    await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'PAGE_X', name: 'X', handle: null, avatarUrl: null })
    const id = await insertEvent({ platformPageId: 'PAGE_X', field: 'message_reactions' })
    expect(await routeWebhookEvent(routeDeps(), { eventId: id })).toBe('ignored')
  })

  it('markEventFailed → status failed + error_code', async () => {
    const id = await insertEvent({ platformPageId: 'PAGE_X' })
    await markEventFailed(handle.db, id, 'WEBHOOK_ROUTE_FAILED')
    const [row] = await handle.sql<{ status: string; error_code: string }[]>`select status, error_code from webhook_events where id = ${id}`
    expect(row).toMatchObject({ status: 'failed', error_code: 'WEBHOOK_ROUTE_FAILED' })
  })

  it('Story 9.3: payload thô đã dọn → missing, trạng thái giữ nguyên', async () => {
    await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'PAGE_X', name: 'X', handle: null, avatarUrl: null })
    const id = await insertEvent({ platformPageId: 'PAGE_X' })
    await handle.sql`update webhook_events set payload = null where id = ${id}`
    expect(await routeWebhookEvent(routeDeps(), { eventId: id })).toBe('missing')
    expect((await statusOf(id)).status).toBe('received')
  })
})

describe('API Cài đặt › Webhook (dưới guard phiên)', () => {
  async function cookie() {
    const { token } = await createSession(handle.db)
    return `${SESSION_COOKIE}=${token}`
  }

  it('GET /config trả URL callback + verify token đầy đủ (giá trị của chủ shop)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/webhooks/config', headers: { cookie: await cookie() } })
    expect(res.statusCode).toBe(200)
    const body = WebhookConfigResponse.parse(res.json())
    expect(body.callbacks.meta).toBe(`${PUBLIC_BASE_URL}/webhooks/meta`)
    expect(body.callbacks.threads).toBe(`${PUBLIC_BASE_URL}/webhooks/threads`)
    expect(body.verifyToken).toBe(VERIFY_TOKEN)
    expect(body.verifyTokenConfigured).toBe(true)
    expect(body.fields.page).toContain('messages')
  })

  it('cần phiên: không cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/webhooks/events' })
    expect(res.statusCode).toBe(401)
  })

  it('POST /test tạo sự kiện cờ test (chỉ ghi nhật ký) rồi enqueue route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/test',
      headers: { cookie: await cookie(), origin: ORIGIN, 'content-type': 'application/json' },
      payload: { product: 'meta' },
    })
    expect(res.statusCode).toBe(201)
    const event = WebhookEventDto.parse(res.json())
    expect(event).toMatchObject({ test: true, status: 'received', product: 'meta' })
    expect(await countRouteJobs()).toBe(1)
  })

  it('GET /events liệt kê nhật ký mới nhất trước', async () => {
    const raw = graphBody('m_log')
    await postMeta(raw, { signature: sign(raw) })
    const res = await app.inject({ method: 'GET', url: '/api/v1/webhooks/events', headers: { cookie: await cookie() } })
    expect(res.statusCode).toBe(200)
    const body = WebhookLogResponse.parse(res.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ field: 'messages', status: 'received' })
  })

  it('POST /events/:id/retry đưa mục failed về received và enqueue lại', async () => {
    const [row] = await handle.db
      .insert(webhookEventsTable)
      .values({ product: 'meta', platformPageId: 'PAGE_1', field: 'messages', dedupeKey: 'k_retry', payload: {}, status: 'failed', errorCode: 'WEBHOOK_ROUTE_FAILED' })
      .returning({ id: webhookEventsTable.id })
    const id = row!.id
    await handle.sql`delete from pgboss.job where name = 'webhook.route'`
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/events/${id}/retry`,
      headers: { cookie: await cookie(), origin: ORIGIN },
    })
    expect(res.statusCode).toBe(200)
    const event = WebhookEventDto.parse(res.json())
    expect(event).toMatchObject({ status: 'received', errorCode: null })
    expect(await countRouteJobs()).toBe(1)
  })

  it('retry id không tồn tại → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/events/00000000-0000-7000-8000-000000000000/retry`,
      headers: { cookie: await cookie(), origin: ORIGIN },
    })
    expect(res.statusCode).toBe(404)
  })

  it('retry mục KHÔNG phải failed (routed) → 409, không reset/re-route', async () => {
    const [row] = await handle.db
      .insert(webhookEventsTable)
      .values({ product: 'meta', platformPageId: 'PAGE_1', field: 'messages', dedupeKey: 'k_routed', payload: {}, status: 'routed' })
      .returning({ id: webhookEventsTable.id })
    await handle.sql`delete from pgboss.job where name = 'webhook.route'`
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/events/${row!.id}/retry`,
      headers: { cookie: await cookie(), origin: ORIGIN },
    })
    expect(res.statusCode).toBe(409)
    // Không đổi trạng thái, không enqueue.
    const [after] = await handle.sql<{ status: string }[]>`select status from webhook_events where id = ${row!.id}`
    expect(after!.status).toBe('routed')
    expect(await countRouteJobs()).toBe(0)
  })

  // Story 9.3: payload thô quá hạn đã dọn (null) → nhật ký báo `payloadPurged`, "Xử lý lại" bị từ chối.
  it('mục failed đã dọn payload thô → 409, không enqueue; nhật ký có payloadPurged', async () => {
    const [row] = await handle.db
      .insert(webhookEventsTable)
      .values({ product: 'meta', platformPageId: 'PAGE_1', field: 'messages', dedupeKey: 'k_purged', payload: null, status: 'failed', errorCode: 'WEBHOOK_ROUTE_FAILED' })
      .returning({ id: webhookEventsTable.id })
    await handle.sql`delete from pgboss.job where name = 'webhook.route'`
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/events/${row!.id}/retry`,
      headers: { cookie: await cookie(), origin: ORIGIN },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toContain('30 ngày')
    const [after] = await handle.sql<{ status: string }[]>`select status from webhook_events where id = ${row!.id}`
    expect(after!.status).toBe('failed')
    expect(await countRouteJobs()).toBe(0)

    const log = WebhookLogResponse.parse((await app.inject({ method: 'GET', url: '/api/v1/webhooks/events', headers: { cookie: await cookie() } })).json())
    expect(log.items.find((e) => e.id === row!.id)?.payloadPurged).toBe(true)
  })
})

describe('app thiếu cấu hình (app secret / verify token)', () => {
  let bareApp: FastifyInstance
  beforeAll(async () => {
    // Không truyền metaAppSecret/threadsAppSecret/verifyToken → không verify được, chưa xác minh được.
    bareApp = buildApp({
      sql: handle.sql,
      db: handle.db,
      logger: createLogger({ level: 'silent' }),
      webhooks: { jobs, publicBaseUrl: PUBLIC_BASE_URL },
    })
    await bareApp.ready()
  })
  afterAll(async () => {
    await bareApp.close()
  })

  it('thiếu app secret → POST webhook 401, KHÔNG ghi DB', async () => {
    const raw = graphBody('m_nosecret')
    const res = await bareApp.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    })
    expect(res.statusCode).toBe(401)
    expect(await countEvents()).toBe(0)
  })

  it('verify token chưa cấu hình → GET /webhooks/* 403', async () => {
    const res = await bareApp.inject({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=C' })
    expect(res.statusCode).toBe(403)
  })
})

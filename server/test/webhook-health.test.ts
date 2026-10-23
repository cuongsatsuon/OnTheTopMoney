// Story 4.2 — sức khoẻ webhook: `computeHealthStatus` (biên 08:00 / 08:30 / 22:00 / 30 phút, giờ VN),
// cron `runHealthCheck` (chuyển trạng thái phát `webhook.stalled|recovered` đúng một lần, cùng transaction) và
// `GET /api/v1/webhooks/health` (sản phẩm + trang đăng ký lỗi, chỉ trang chưa gỡ).
import { WebhookHealthResponse, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { computeHealthStatus, runHealthCheck, webhookEventsTable } from '../src/modules/webhooks/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, waitFor } from './helpers/realtime.ts'

/** Thời điểm theo giờ VN (UTC+7), vd `vn('2026-10-23T10:00')`. */
const vn = (local: string) => new Date(`${local}:00+07:00`)
const MIN = 60_000
const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MIN)

describe('computeHealthStatus (thuần, giờ VN)', () => {
  const at10 = vn('2026-10-23T10:00')

  it('chưa từng có sự kiện → waiting_first (kể cả có trang active giữa khung giờ)', () => {
    expect(computeHealthStatus({ now: at10, lastEventAt: null, hasActivePages: true })).toBe('waiting_first')
    expect(computeHealthStatus({ now: at10, lastEventAt: null, hasActivePages: false })).toBe('waiting_first')
  })

  it('10:00, im 31 phút, có trang active → stalled; đúng 30 phút → ok', () => {
    expect(computeHealthStatus({ now: at10, lastEventAt: ago(at10, 31), hasActivePages: true })).toBe('stalled')
    expect(computeHealthStatus({ now: at10, lastEventAt: ago(at10, 30), hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: at10, lastEventAt: ago(at10, 5), hasActivePages: true })).toBe('ok')
  })

  it('không có trang active → không stalled', () => {
    expect(computeHealthStatus({ now: at10, lastEventAt: ago(at10, 600), hasActivePages: false })).toBe('ok')
  })

  it('im lâu nhưng 23:00 hoặc 08:20 → không stalled (im qua đêm tính từ 08:00)', () => {
    const lastNight = vn('2026-10-22T21:00')
    expect(computeHealthStatus({ now: vn('2026-10-23T23:00'), lastEventAt: lastNight, hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: vn('2026-10-23T08:20'), lastEventAt: lastNight, hasActivePages: true })).toBe('ok')
  })

  it('biên 08:00 / 08:30 / 08:31: đếm từ 08:00 hôm nay', () => {
    const lastNight = vn('2026-10-22T21:00')
    expect(computeHealthStatus({ now: vn('2026-10-23T07:59'), lastEventAt: lastNight, hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: vn('2026-10-23T08:00'), lastEventAt: lastNight, hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: vn('2026-10-23T08:30'), lastEventAt: lastNight, hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: vn('2026-10-23T08:31'), lastEventAt: lastNight, hasActivePages: true })).toBe('stalled')
  })

  it('biên 22:00: 21:59 còn trong khung (stalled), 22:00 ra khỏi khung (ok)', () => {
    const last = vn('2026-10-23T21:00')
    expect(computeHealthStatus({ now: vn('2026-10-23T21:59'), lastEventAt: last, hasActivePages: true })).toBe('stalled')
    expect(computeHealthStatus({ now: vn('2026-10-23T22:00'), lastEventAt: last, hasActivePages: true })).toBe('ok')
  })

  it('ngày tính theo giờ VN, không theo UTC (00:30 VN = 17:30 UTC hôm trước)', () => {
    // 07:30 UTC = 14:30 VN (trong khung); 23:30 UTC = 06:30 VN hôm sau (ngoài khung).
    const last = new Date('2026-10-23T06:00:00Z')
    expect(computeHealthStatus({ now: new Date('2026-10-23T07:30:00Z'), lastEventAt: last, hasActivePages: true })).toBe('stalled')
    expect(computeHealthStatus({ now: new Date('2026-10-23T23:30:00Z'), lastEventAt: last, hasActivePages: true })).toBe('ok')
    expect(computeHealthStatus({ now: vn('2026-10-24T00:30'), lastEventAt: last, hasActivePages: true })).toBe('ok')
  })
})

// ---------------------------------------------------------------------------------------------------------
// DB: cron + API
// ---------------------------------------------------------------------------------------------------------

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
/** Sự kiện đã phát (qua publisher thật, trong transaction của cron). */
const emitted: { name: EventName; payload: unknown }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload })
  },
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-webhook-health', { background: false })
  boss.on('error', () => {})
  await boss.start()
  realEvents = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from webhook_health`
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  emitted.length = 0
  realtime.messages.length = 0
})

let seq = 0
async function insertEvent(product: 'meta' | 'threads', receivedAt: Date, test = false) {
  seq += 1
  await handle.db.insert(webhookEventsTable).values({
    product,
    platformPageId: 'P',
    field: test ? 'test' : 'messages',
    dedupeKey: `k_${seq}_${Math.random().toString(36).slice(2)}`,
    payload: {},
    test,
    receivedAt,
  })
}
async function insertPage(platform: 'facebook' | 'instagram' | 'threads', status = 'active', opts: { removed?: boolean; subscribeError?: string } = {}) {
  seq += 1
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, removed_at)
    values (${platform}, ${'acc-' + seq}, ${'Trang ' + seq}, ${status}, ${opts.removed ? new Date().toISOString() : null}::timestamptz)
    returning id`
  await handle.sql`
    insert into page_credentials (page_id, access_token, webhook_subscribe_error)
    values (${row!.id}, 'v1:k1:x:y:z', ${opts.subscribeError ?? null})`
  return row!.id
}
const healthRow = async (product: string) =>
  (await handle.sql<{ status: string; last_event_at: string | null; status_changed_at: string; checked_at: string }[]>`
    select status, last_event_at, status_changed_at, checked_at from webhook_health where product = ${product}`)[0]
const run = (now: Date) => runHealthCheck({ db: handle.db, events, now: () => now })
const names = () => emitted.map((e) => e.name)

describe('runHealthCheck (cron webhooks.health)', () => {
  const at10 = vn('2026-10-23T10:00')

  it('chưa từng có sự kiện → waiting_first cho cả hai sản phẩm, không phát gì', async () => {
    await insertPage('facebook')
    const results = await run(at10)
    expect(results.map((r) => [r.product, r.status])).toEqual([
      ['meta', 'waiting_first'],
      ['threads', 'waiting_first'],
    ])
    expect(emitted).toEqual([])
    expect((await healthRow('meta'))!.status).toBe('waiting_first')
  })

  it('sự kiện thử không tính là sự kiện', async () => {
    await insertPage('facebook')
    await insertEvent('meta', ago(at10, 1), true)
    expect((await run(at10))[0]!.status).toBe('waiting_first')
  })

  it('im 31 phút lúc 10:00 VN, có trang active → stalled + webhook.stalled MỘT lần (cron sau không phát lại)', async () => {
    await insertPage('instagram')
    await insertEvent('meta', ago(at10, 31))
    const r1 = await run(at10)
    expect(r1[0]).toMatchObject({ product: 'meta', status: 'stalled', previous: null, emitted: 'webhook.stalled' })
    expect(emitted).toEqual([{ name: 'webhook.stalled', payload: { id: 'meta', product: 'meta' } }])
    // Hint realtime cho web (khoá query `['webhooks', …]` tự làm cũ).
    await waitFor(() => realtime.messages.find((m) => m.type === 'webhook.stalled'))

    const r2 = await run(new Date(at10.getTime() + 5 * MIN))
    expect(r2[0]).toMatchObject({ status: 'stalled', previous: 'stalled', emitted: null })
    expect(names()).toEqual(['webhook.stalled'])
    const row = await healthRow('meta')
    expect(new Date(row!.status_changed_at).toISOString()).toBe(at10.toISOString())
    expect(new Date(row!.checked_at).toISOString()).toBe(new Date(at10.getTime() + 5 * MIN).toISOString())
    expect(new Date(row!.last_event_at!).toISOString()).toBe(ago(at10, 31).toISOString())
    // Threads không có trang/sự kiện → không bị ảnh hưởng.
    expect(r2[1]).toMatchObject({ product: 'threads', status: 'waiting_first' })
  })

  it('có sự kiện lại sau stalled → ok + webhook.recovered', async () => {
    await insertPage('facebook')
    await insertEvent('meta', ago(at10, 45))
    await run(at10)
    await insertEvent('meta', ago(at10, -2))
    const r = await run(new Date(at10.getTime() + 5 * MIN))
    expect(r[0]).toMatchObject({ status: 'ok', previous: 'stalled', emitted: 'webhook.recovered' })
    expect(names()).toEqual(['webhook.stalled', 'webhook.recovered'])
    expect(emitted[1]!.payload).toEqual({ id: 'meta', product: 'meta' })
  })

  it('stalled → ra khỏi khung giờ (22:00) cũng là recovered', async () => {
    await insertPage('threads')
    await insertEvent('threads', vn('2026-10-23T20:00'))
    expect((await run(vn('2026-10-23T21:55')))[1]!.emitted).toBe('webhook.stalled')
    expect((await run(vn('2026-10-23T22:00')))[1]).toMatchObject({ status: 'ok', emitted: 'webhook.recovered' })
  })

  it('im lâu nhưng 23:00 hoặc 08:20 VN → không stalled', async () => {
    await insertPage('facebook')
    await insertEvent('meta', vn('2026-10-22T21:00'))
    expect((await run(vn('2026-10-22T23:00')))[0]!.status).toBe('ok')
    expect((await run(vn('2026-10-23T08:20')))[0]!.status).toBe('ok')
    expect(emitted).toEqual([])
  })

  it('không có trang active (chỉ mất kết nối / sản phẩm khác) → không stalled', async () => {
    await insertPage('facebook', 'disconnected')
    await insertPage('threads')
    await insertEvent('meta', ago(at10, 120))
    expect((await run(at10))[0]).toMatchObject({ product: 'meta', status: 'ok', emitted: null })
  })
})

describe('GET /api/v1/webhooks/health', () => {
  let app: FastifyInstance
  const fixedNow = vn('2026-10-23T10:00')

  beforeAll(async () => {
    app = buildApp({
      sql: handle.sql,
      db: handle.db,
      logger: createLogger({ level: 'silent' }),
      webhooks: { jobs: createJobSender(boss), publicBaseUrl: 'https://app.example.com', now: () => fixedNow },
    })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  const get = async (cookie?: string) =>
    app.inject({ method: 'GET', url: '/api/v1/webhooks/health', headers: cookie ? { cookie } : {} })
  const cookie = async () => `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`

  it('cần phiên', async () => {
    expect((await get()).statusCode).toBe(401)
  })

  it('trạng thái theo cron + lastEventAt trực tiếp + trang đăng ký lỗi (chỉ trang chưa gỡ)', async () => {
    const fb = await insertPage('facebook', 'active', { subscribeError: 'PERMISSION_DENIED' })
    await insertPage('instagram', 'active', { removed: true, subscribeError: 'REJECTED' })
    await insertPage('threads')
    const last = ago(fixedNow, 40)
    await insertEvent('meta', last)
    await run(fixedNow)
    // Cron ghi `stalled`; API trả đúng trạng thái đó khi chưa có tin mới.
    const stalledBody = WebhookHealthResponse.parse((await get(await cookie())).json())
    expect(stalledBody.products[0]).toEqual({ product: 'meta', status: 'stalled', lastEventAt: last.toISOString() })
    // Sự kiện mới sau lần cron: lastEventAt đọc trực tiếp, `stalled` hạ thành `ok` ngay (không chờ cron).
    const fresh = ago(fixedNow, -1)
    await insertEvent('meta', fresh)

    const res = await get(await cookie())
    expect(res.statusCode).toBe(200)
    const body = WebhookHealthResponse.parse(res.json())
    expect(body.products).toEqual([
      { product: 'meta', status: 'ok', lastEventAt: fresh.toISOString() },
      { product: 'threads', status: 'waiting_first', lastEventAt: null },
    ])
    expect(body.pageSubscriptionErrors).toEqual([{ pageId: fb, name: expect.any(String), platform: 'facebook', errorCode: 'PERMISSION_DENIED' }])
  })

  it('chưa có dòng cron → tính tại chỗ', async () => {
    await insertPage('facebook')
    await insertEvent('meta', ago(fixedNow, 2))
    const body = WebhookHealthResponse.parse((await get(await cookie())).json())
    expect(body.products[0]).toEqual({ product: 'meta', status: 'ok', lastEventAt: ago(fixedNow, 2).toISOString() })
    expect(body.pageSubscriptionErrors).toEqual([])
  })
})

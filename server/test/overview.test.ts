// Ma trận Story 8.5 — Tổng quan (`GET /overview`, `GET /overview/metrics`; AD-18, AD-1). Qua app thật (buildApp) + Postgres
// nhúng; dữ liệu chèn thẳng vào bảng của từng module (như các luồng đã có để lại). Phủ: "Cần xử lý" đúng tab, bài lỗi gom
// theo bài + target ngoài phạm vi, bài chờ duyệt, trang cần kết nối lại, webhook ngừng nhận tin theo phạm vi, hạn mức AI,
// bài sắp đăng, chiến dịch đang chạy + tương tác 7 ngày, phạm vi rỗng / lạ / sai / chưa đăng nhập, số liệu chính khớp
// màn Hiệu suất.
import { OverviewMetricsResponse, OverviewResponse, PerformanceResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import type { EventPublisher } from '../src/platform/events/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** "Bây giờ": 10:00 giờ VN thứ Bảy 24/10/2026 (trong khung theo dõi webhook). */
const NOW = new Date('2026-10-24T03:00:00.000Z')
/** Ngày VN cách hôm nay `back` ngày. */
const vnDay = (back: number) => new Date(NOW.getTime() + 7 * HOUR - back * DAY).toISOString().slice(0, 10)
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)
const noEvents: EventPublisher = { publishEvent: async () => {} }

let handle: DbHandle
let app: FastifyInstance
let cookie: string
let seq = 0

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, clock: () => NOW })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from posts`
  await handle.sql`delete from campaigns`
  await handle.sql`delete from webhook_health`
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from page_daily_metrics`
  await handle.sql`delete from contacts`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from sessions`
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'

async function page(platform: Platform = 'facebook', opts: { status?: string; removed?: boolean; groupId?: string; connectedDaysAgo?: number } = {}): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, group_id, connected_at, removed_at)
    values (${platform}, ${'acc_' + ++seq}, ${'Trang ' + seq}, ${opts.status ?? 'active'}, ${opts.groupId ?? null},
      ${at(-(opts.connectedDaysAgo ?? 120) * DAY).toISOString()}::timestamptz, ${opts.removed ? NOW.toISOString() : null}::timestamptz)
    returning id`
  return p!.id
}

async function group(): Promise<string> {
  const [g] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${'Nhóm ' + ++seq}, 'group-1') returning id`
  return g!.id
}

/** Hội thoại DM; `waitMin` = khách chờ từ bao nhiêu phút trước; `last` = gốc tin hiệu lực mới nhất. */
async function conv(pageId: string, state: string, opts: { waitMin?: number; last?: 'customer' | 'app_human' } = {}): Promise<string> {
  const key = `psid_${++seq}`
  const [c] = await handle.sql<{ id: string }[]>`insert into contacts (name) values (${'Khách ' + seq}) returning id`
  const [ident] = await handle.sql<{ id: string }[]>`
    insert into contact_identities (contact_id, page_id, platform_user_id) values (${c!.id}, ${pageId}, ${key}) returning id`
  const waiting = opts.waitMin !== undefined ? at(-opts.waitMin * MIN).toISOString() : null
  const [row] = await handle.sql<{ id: string }[]>`
    insert into conversations (page_id, channel, thread_key, contact_identity_id, state, state_reason, waiting_since, last_message_at)
    values (${pageId}, 'dm', ${key}, ${ident!.id}, ${state}, ${state === 'handoff' ? 'KEYWORD' : null}, ${waiting}::timestamptz,
      ${at(-MIN).toISOString()}::timestamptz)
    returning id`
  if (opts.last) {
    const out = opts.last !== 'customer'
    await handle.sql`
      insert into messages (conversation_id, page_id, direction, origin, status, delivery, text, sent_at, platform_timestamp, created_at)
      values (${row!.id}, ${pageId}, ${out ? 'outbound' : 'inbound'}, ${opts.last}, ${out ? 'sent' : null}, ${out ? 'dm' : null}, 'Nội dung',
        ${out ? NOW.toISOString() : null}::timestamptz, ${at(-MIN).toISOString()}::timestamptz, ${at(-MIN).toISOString()}::timestamptz)`
  }
  return row!.id
}

interface TargetSpec {
  pageId: string
  status: string
  scheduledAt?: Date
  held?: boolean
  errorCode?: string
  campaignId?: string
  publishedAt?: Date
}

/** Một bài + target; slot chiến dịch (`campaignId`) có `slot_at` = giờ đăng. Trả id target theo thứ tự. */
async function post(targets: TargetSpec[], opts: { caption?: string; topic?: string } = {}): Promise<{ postId: string; ids: string[] }> {
  const source = targets.some((t) => t.campaignId) ? 'campaign' : 'manual'
  const [p] = await handle.sql<{ id: string }[]>`insert into posts (source, topic) values (${source}, ${opts.topic ?? null}) returning id`
  const ids: string[] = []
  for (const [i, t] of targets.entries()) {
    const when = t.scheduledAt?.toISOString() ?? null
    const [row] = await handle.sql<{ id: string }[]>`
      insert into post_targets (post_id, page_id, position, status, caption, held, scheduled_at, error_code, campaign_id, slot_at, published_at, version)
      values (${p!.id}, ${t.pageId}, ${i}, ${t.status}, ${opts.caption ?? 'Bài viết mới'}, ${t.held ?? false}, ${when}::timestamptz,
        ${t.errorCode ?? (t.status === 'failed' ? 'PUBLISH_FAILED' : null)}, ${t.campaignId ?? null},
        ${t.campaignId ? (when ?? NOW.toISOString()) : null}::timestamptz, ${t.publishedAt?.toISOString() ?? null}::timestamptz, ${i + 2})
      returning id`
    ids.push(row!.id)
  }
  return { postId: p!.id, ids }
}

async function campaign(status: 'draft' | 'running' | 'paused' | 'done', pageIds: string[], opts: { startDaysAgo?: number; pauseReason?: string; name?: string } = {}): Promise<string> {
  const started = status === 'draft' ? null : at(-(opts.startDaysAgo ?? 1) * DAY).toISOString()
  const reason = status === 'paused' ? (opts.pauseReason ?? 'MANUAL') : null
  const [c] = await handle.sql<{ id: string }[]>`
    insert into campaigns (name, goal, status, start_date, duration_days, default_frequency, image_ratio, post_times, started_at, pause_reason, paused_at)
    values (${opts.name ?? 'Chiến dịch ' + ++seq}, 'engage', ${status}, ${vnDay(opts.startDaysAgo ?? 1)}, 30, '1_per_day', 0, ${['11:30']},
      ${started}::timestamptz, ${reason}, ${reason ? NOW.toISOString() : null}::timestamptz)
    returning id`
  for (const [i, pageId] of pageIds.entries()) await handle.sql`insert into campaign_pages (campaign_id, page_id, position) values (${c!.id}, ${pageId}, ${i})`
  await handle.sql`insert into campaign_topics (campaign_id, position, name, share) values (${c!.id}, 0, 'Mẹo hay', 100)`
  return c!.id
}

async function snapshot(targetId: string, pageId: string, back: number, engagement: number): Promise<void> {
  await handle.sql`insert into post_metrics (post_target_id, page_id, metric_date, engagement, fetched_at)
    values (${targetId}, ${pageId}, ${vnDay(back)}, ${engagement}, ${NOW.toISOString()}::timestamptz)`
}

async function get(url: string, opts: { auth?: boolean } = {}) {
  return app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(opts.auth === false ? {} : { cookie }) } })
}
async function overview(scope?: string): Promise<OverviewResponse> {
  const res = await get(`/api/v1/overview${scope ? `?scope=${scope}` : ''}`)
  expect(res.statusCode, res.body).toBe(200)
  return OverviewResponse.parse(res.json())
}

/* ---------- Việc cần xử lý ---------- */

describe('GET /overview — việc cần xử lý', () => {
  it('"Cần xử lý" đúng điều kiện tab: đếm đủ, 5 mục chờ lâu nhất trước', async () => {
    const a = await page()
    const longest = await conv(a, 'handoff', { waitMin: 90 })
    const human = await conv(a, 'human', { waitMin: 80, last: 'customer' })
    await conv(a, 'human', { last: 'app_human' })
    await conv(a, 'ai', { waitMin: 100 })
    const others = []
    for (let i = 0; i < 6; i++) others.push(await conv(a, 'handoff', { waitMin: 70 - i }))
    const o = await overview()
    const tab = await get('/api/v1/conversations/count?tab=needs_human')
    expect(o.needsHuman.count).toBe(8)
    expect(o.needsHuman.count).toBe(tab.json().count)
    expect(o.needsHuman.items.map((c) => c.id)).toEqual([longest, human, ...others.slice(0, 3)])
    expect(o.needsHuman.items.every((c) => c.needsAttention)).toBe(true)
  })

  it('bài lỗi gom theo bài, target ở trang ngoài phạm vi (chưa gỡ) vẫn trả; bài đã đăng không tính', async () => {
    const fb = await page('facebook')
    const ig = await page('instagram')
    const th = await page('threads')
    const gone = await page('facebook', { removed: true })
    const a = await post(
      [
        { pageId: fb, status: 'failed', scheduledAt: at(-2 * HOUR), errorCode: 'PUBLISH_REJECTED' },
        { pageId: ig, status: 'failed', scheduledAt: at(-2 * HOUR) },
        { pageId: gone, status: 'failed', scheduledAt: at(-2 * HOUR) },
      ],
      { caption: 'Giảm giá nồi chiên' },
    )
    const b = await post([{ pageId: th, status: 'failed', scheduledAt: at(-HOUR) }])
    await post([{ pageId: fb, status: 'published', scheduledAt: at(-3 * HOUR), publishedAt: at(-3 * HOUR) }])

    const scoped = await overview(`page:${fb}`)
    expect(scoped.failedPosts.count).toBe(1)
    expect(scoped.failedPosts.items).toHaveLength(1)
    const item = scoped.failedPosts.items[0]!
    expect(item).toMatchObject({ postId: a.postId, status: 'failed', title: 'Giảm giá nồi chiên', source: 'manual', ai: false, scheduledAt: at(-2 * HOUR).toISOString() })
    expect(item.targets).toEqual([
      { id: a.ids[0], pageId: fb, version: 2, errorCode: 'PUBLISH_REJECTED' },
      { id: a.ids[1], pageId: ig, version: 3, errorCode: 'PUBLISH_FAILED' },
    ])

    const all = await overview()
    expect(all.failedPosts.count).toBe(2)
    expect(all.failedPosts.items.map((p) => p.postId)).toEqual([b.postId, a.postId])
  })

  it('bài chờ duyệt: slot chưa giữ của chiến dịch đã bắt đầu, trang trong phạm vi', async () => {
    const a = await page()
    const b = await page('threads')
    const run = await campaign('running', [a, b])
    const draft = await campaign('draft', [a])
    await post([{ pageId: a, status: 'pending_approval', scheduledAt: at(HOUR), campaignId: run }])
    await post([{ pageId: a, status: 'pending_approval', scheduledAt: at(-HOUR), campaignId: run }])
    await post([{ pageId: b, status: 'pending_approval', scheduledAt: at(2 * HOUR), campaignId: run }])
    await post([{ pageId: a, status: 'pending_approval', scheduledAt: at(3 * HOUR), campaignId: run, held: true }])
    await post([{ pageId: a, status: 'pending_approval', scheduledAt: at(4 * HOUR), campaignId: draft }])
    expect((await overview(`page:${a}`)).pendingApproval).toBe(2)
    expect((await overview()).pendingApproval).toBe(3)
  })

  it('trang cần kết nối lại: mất kết nối trước, sắp hết hạn sau; bỏ trang active, ngoài phạm vi, đã gỡ', async () => {
    const g = await group()
    await page('facebook', { groupId: g })
    const expiring = await page('instagram', { status: 'expiring', groupId: g })
    const lost = await page('threads', { status: 'disconnected', groupId: g })
    await page('facebook', { status: 'disconnected', groupId: g, removed: true })
    await page('facebook', { status: 'disconnected' })
    const o = await overview(`group:${g}`)
    expect(o.pageAlerts.map((p) => [p.id, p.connectionStatus])).toEqual([
      [lost, 'disconnected'],
      [expiring, 'expiring'],
    ])
  })

  it('webhook ngừng nhận tin chỉ báo khi phạm vi có trang của sản phẩm đó', async () => {
    const fb = await page('facebook')
    const th = await page('threads')
    await handle.sql`insert into webhook_events (product, platform_page_id, field, dedupe_key, payload, test, received_at)
      values ('meta', 'P', 'messages', ${'k' + ++seq}, '{}'::jsonb, false, ${at(-40 * MIN).toISOString()}::timestamptz)`
    await handle.sql`insert into webhook_health (product, status, last_event_at, status_changed_at, checked_at)
      values ('meta', 'stalled', ${at(-40 * MIN).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`
    expect((await overview(`page:${th}`)).webhookStalled).toEqual([])
    expect((await overview(`page:${fb}`)).webhookStalled).toEqual(['meta'])
  })

  it('hạn mức AI tháng này (không theo phạm vi)', async () => {
    await setOpenAiPrefs(handle.db, noEvents, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 1_000_000, warn80: true })
    await handle.sql`insert into ai_budget_months (month, spent_vnd) values ('2026-10', 850000)`
    expect((await overview()).aiBudget).toEqual({ percent: 85, state: 'warn', spentVnd: 850_000, limitVnd: 1_000_000 })
  })
})

/* ---------- Bài sắp đăng + chiến dịch ---------- */

describe('GET /overview — bài sắp đăng, chiến dịch', () => {
  it('5 bài sớm nhất từ bây giờ, gom target cùng giờ; bỏ bài bị giữ, quá giờ, nháp', async () => {
    const fb = await page('facebook')
    const ig = await page('instagram')
    const run = await campaign('running', [fb])
    const manual = await post(
      [
        { pageId: fb, status: 'scheduled', scheduledAt: at(HOUR) },
        { pageId: ig, status: 'scheduled', scheduledAt: at(HOUR) },
      ],
      { caption: 'Mở bán bộ nồi' },
    )
    const slot = await post([{ pageId: fb, status: 'pending_approval', scheduledAt: at(2 * HOUR), campaignId: run }], { caption: '', topic: 'Mẹo hay' })
    await post([{ pageId: fb, status: 'scheduled', scheduledAt: at(30 * MIN), campaignId: run, held: true }])
    await post([{ pageId: fb, status: 'pending_approval', scheduledAt: at(-HOUR), campaignId: run }])
    await post([{ pageId: fb, status: 'draft' }])
    const later: string[] = []
    for (let i = 3; i <= 9; i++) later.push((await post([{ pageId: fb, status: 'scheduled', scheduledAt: at(i * HOUR) }])).postId)

    const o = await overview(`page:${fb}`)
    expect(o.upcoming.map((p) => p.postId)).toEqual([manual.postId, slot.postId, ...later.slice(0, 3)])
    expect(o.upcoming[0]!.targets.map((t) => t.pageId)).toEqual([fb, ig])
    expect(o.upcoming[0]).toMatchObject({ status: 'scheduled', title: 'Mở bán bộ nồi', scheduledAt: at(HOUR).toISOString() })
    expect(o.upcoming[1]).toMatchObject({ status: 'pending_approval', title: null, topic: 'Mẹo hay', ai: true, source: 'campaign', campaignId: run })
  })

  it('chiến dịch đang chạy / tạm dừng kèm lý do; bỏ nháp, đã xong, chiến dịch ngoài phạm vi', async () => {
    const a = await page()
    const b = await page('threads')
    const running = await campaign('running', [a], { name: 'Đang chạy' })
    const paused = await campaign('paused', [a], { name: 'Tạm dừng', pauseReason: 'PAGE_DISCONNECTED' })
    await campaign('done', [a])
    await campaign('draft', [a])
    await campaign('running', [b])
    const o = await overview(`page:${a}`)
    expect(o.campaigns.map((c) => [c.id, c.status, c.pauseReason])).toEqual([
      [paused, 'paused', 'PAGE_DISCONNECTED'],
      [running, 'running', null],
    ])
    expect((await overview()).campaigns).toHaveLength(3)
  })

  it('tương tác 7 ngày của thẻ chiến dịch: tăng theo ngày, giảm tính 0, so 7 ngày trước khi đủ 14 ngày', async () => {
    const a = await page()
    const old = await campaign('running', [a], { startDaysAgo: 20, name: 'Cũ' })
    const fresh = await campaign('running', [a], { startDaysAgo: 3, name: 'Mới' })
    const none = await campaign('running', [a], { startDaysAgo: 20, name: 'Chưa số liệu' })
    const pub = (c: string, back: number) => post([{ pageId: a, status: 'published', scheduledAt: at(-back * DAY), publishedAt: at(-back * DAY), campaignId: c }])
    const t1 = (await pub(old, 16)).ids[0]!
    const t2 = (await pub(old, 1)).ids[0]!
    await pub(old, 2) // không có snapshot
    // t1: mức 4 trước cửa sổ → 10 (10 ngày trước, kỳ trước) → 8 (5 ngày trước, giảm) → 25 (hôm nay).
    await snapshot(t1, a, 15, 4)
    await snapshot(t1, a, 10, 10)
    await snapshot(t1, a, 5, 8)
    await snapshot(t1, a, 0, 25)
    // t2: đăng hôm qua, snapshot đầu 5.
    await snapshot(t2, a, 1, 5)
    const t3 = (await pub(fresh, 2)).ids[0]!
    await snapshot(t3, a, 2, 3)
    await snapshot(t3, a, 0, 7)
    await pub(none, 2)

    const byName = new Map((await overview()).campaigns.map((c) => [c.name, c]))
    expect(byName.get('Cũ')).toMatchObject({ trend: [0, 0, 0, 0, 0, 5, 17], engagement7d: { current: 22, previous: 6 } })
    expect(byName.get('Mới')).toMatchObject({ trend: [0, 0, 0, 0, 3, 0, 4], engagement7d: { current: 7, previous: null } })
    expect(byName.get('Chưa số liệu')).toMatchObject({ trend: [0, 0, 0, 0, 0, 0, 0], engagement7d: { current: null, previous: null } })
  })
})

/* ---------- Phạm vi ---------- */

describe('GET /overview — phạm vi', () => {
  it('không có trang → mọi phần rỗng (hạn mức vẫn có); nhóm lạ 404, scope sai 400, chưa đăng nhập 401', async () => {
    const o = await overview()
    expect(o).toMatchObject({
      needsHuman: { count: 0, items: [] },
      failedPosts: { count: 0, items: [] },
      pendingApproval: 0,
      pageAlerts: [],
      webhookStalled: [],
      upcoming: [],
      campaigns: [],
    })
    expect(o.aiBudget.state).toBe('ok')
    const g = await group()
    expect((await overview(`group:${g}`)).needsHuman.count).toBe(0)
    expect((await get('/api/v1/overview?scope=group:00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await get('/api/v1/overview?scope=bad')).statusCode).toBe(400)
    expect((await get('/api/v1/overview', { auth: false })).statusCode).toBe(401)
    expect((await get('/api/v1/overview/metrics?range=1y')).statusCode).toBe(400)
    expect((await get('/api/v1/overview/metrics', { auth: false })).statusCode).toBe(401)
  })
})

/* ---------- Số liệu chính ---------- */

describe('GET /overview/metrics', () => {
  it('KPI + chuỗi theo nền tảng + tin khách khớp màn Hiệu suất cùng phạm vi, cùng kỳ', async () => {
    const fb = await page('facebook')
    const th = await page('threads')
    for (const [pageId, back, reach, engagement] of [
      [fb, 1, 100, 10],
      [fb, 3, 200, 20],
      [th, 2, null, 7],
      [fb, 9, 50, 5],
    ] as const) {
      await handle.sql`insert into page_daily_metrics (page_id, date, views, reach, engagement, followers_delta, fetched_at)
        values (${pageId}, ${vnDay(back)}, null, ${reach}, ${engagement}, 1, ${NOW.toISOString()}::timestamptz)`
    }
    const c = await conv(fb, 'ai')
    await handle.sql`insert into messages (conversation_id, page_id, direction, origin, text, platform_timestamp, created_at)
      values (${c}, ${fb}, 'inbound', 'customer', 'Còn hàng không?', ${at(-DAY).toISOString()}::timestamptz, ${at(-DAY).toISOString()}::timestamptz)`

    const res = await get('/api/v1/overview/metrics?range=7d')
    expect(res.statusCode, res.body).toBe(200)
    const m = OverviewMetricsResponse.parse(res.json())
    const p = PerformanceResponse.parse((await get('/api/v1/performance?range=7d')).json())
    expect(m).toEqual({
      range: '7d',
      from: p.from,
      to: p.to,
      insufficientData: false,
      platforms: ['facebook', 'threads'],
      kpis: { reach: p.kpis.reach, engagement: p.kpis.engagement, messages: p.kpis.messages, followersDelta: p.kpis.followersDelta },
      series: p.series,
      customerMessages: 1,
      aiAnswered: 0,
    })
    expect(m.kpis.engagement.current).toBe(37)
    expect(m.kpis.reach.current).toBe(300)
    expect(m.series.at(-1)!.facebook).toBe(10)
  })
})

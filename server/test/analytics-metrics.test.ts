// Ma trận Story 8.1 — Thu thập số liệu trang và bài (AD-17, AD-6, AD-5, AD-24). Postgres nhúng + Meta giả
// (`adapters/meta/fake.ts`, không gọi mạng); dòng "usage ≥75%" dùng client Meta thật với `fetch` giả + store tần suất trong
// bộ nhớ. Phủ: cron rải job, bài FB / IG / Threads, chọn bài, trang FB / IG / Threads, chạy lại không nhân đôi, thiếu quyền,
// hoãn khi Meta giới hạn, token hỏng, bị từ chối quyền, lỗi tạm, metric vắng / hỏng, bỏ qua trang; bảng ánh xạ không có
// `*impressions*`.
import { randomBytes } from 'node:crypto'
import type { EventName } from '@ottm/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { inject } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createGraphClient, createMemoryRateStore, type MetaResult } from '../src/adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import {
  METRICS_DEFER_MAX_MS,
  MetricsRetryableError,
  POST_METRIC_MAP,
  PAGE_METRIC_MAP,
  collectPageMetrics,
  collectPostMetrics,
  handleCollectPageJob,
  handleCollectPostsJob,
  insightDayOf,
  referencedMetricNames,
  runPageMetricsCron,
  runPostMetricsCron,
  standardize,
  type AnalyticsDeps,
} from '../src/modules/analytics/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import type { EventPublisher } from '../src/platform/events/index.ts'
import type { JobSender, SendJobOptions } from '../src/platform/jobs/index.ts'

const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const MIN = 60_000
const DAY = 24 * 60 * MIN
/** 10:00 giờ VN ngày 24/10. */
const NOW = new Date('2026-10-24T03:00:00.000Z')
const FB = '9001'
const IG = '17841400000009'
const TH = '25000000000009'
const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights']
const IG_SCOPES = ['instagram_basic', 'instagram_manage_insights']
const TH_SCOPES = ['threads_basic', 'threads_manage_insights']

let handle: DbHandle
let graph: FakeMetaClient
let threads: FakeMetaClient
let now: Date

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(_tx, name, payload) {
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const sent: { name: string; data: Record<string, unknown>; options: SendJobOptions | undefined }[] = []
const jobs = {
  async send(name: string, data: Record<string, unknown>, options?: SendJobOptions) {
    sent.push({ name, data, options })
    return 'job'
  },
} as unknown as JobSender

const deps = (over: Partial<AnalyticsDeps> = {}): AnalyticsDeps => ({ db: handle.db, events, jobs, cipher, graph, threads, now: () => now, ...over })

beforeAll(() => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
})
afterAll(async () => {
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from post_metrics`
  await handle.sql`delete from page_daily_metrics`
  await handle.sql`delete from metric_sync_states`
  await handle.sql`delete from posts`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  emitted.length = 0
  sent.length = 0
  now = NOW
  graph = createFakeMetaClient()
  threads = createFakeMetaClient('https://graph.threads.com/v1.0')
})

/* ---------- Helper ---------- */

const iso = (d: Date | null) => d?.toISOString() ?? null

type Status = 'active' | 'expiring' | 'disconnected'

async function page(
  platform: 'facebook' | 'instagram' | 'threads',
  accountId: string,
  opts: { status?: Status; scopes?: string[]; tokenSource?: string; removed?: boolean } = {},
): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, removed_at)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, ${opts.status ?? 'active'}, ${opts.removed ? NOW.toISOString() : null}::timestamptz) returning id`
  const scopes = opts.scopes ?? (platform === 'facebook' ? FB_SCOPES : platform === 'instagram' ? IG_SCOPES : TH_SCOPES)
  if (opts.tokenSource) {
    await handle.sql`insert into page_credentials (page_id, token_source_page_id, granular_scopes)
      values (${p!.id}, ${opts.tokenSource}, ${JSON.stringify(scopes)}::jsonb)`
  } else {
    await handle.sql`insert into page_credentials (page_id, access_token, granular_scopes)
      values (${p!.id}, ${cipher.encrypt(`TOKEN_${accountId}`)}, ${JSON.stringify(scopes)}::jsonb)`
  }
  return p!.id
}

async function target(
  pageId: string,
  opts: { status?: string; platformPostId?: string | null; publishedAt?: Date | null; errorCode?: string } = {},
): Promise<string> {
  const [post] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
  const status = opts.status ?? 'published'
  const [t] = await handle.sql<{ id: string }[]>`
    insert into post_targets (post_id, page_id, position, status, caption, platform_post_id, published_at, error_code)
    values (${post!.id}, ${pageId}, 0, ${status}, 'Bài', ${opts.platformPostId === undefined ? null : opts.platformPostId},
      ${iso(opts.publishedAt === undefined ? (status === 'published' ? new Date(NOW.getTime() - 2 * DAY) : null) : opts.publishedAt)}::timestamptz,
      ${opts.errorCode ?? null})
    returning id`
  return t!.id
}

const postRows = () =>
  handle.sql<{ post_target_id: string; metric_date: string; views: number | null; reach: number | null; engagement: number | null; raw: Record<string, number> }[]>`
    select post_target_id, metric_date::text, views::int, reach::int, engagement::int, raw from post_metrics order by metric_date, post_target_id`
const pageRows = () =>
  handle.sql<{ date: string; views: number | null; reach: number | null; engagement: number | null; followers_delta: number | null }[]>`
    select date::text, views::int, reach::int, engagement::int, followers_delta::int from page_daily_metrics order by date`
const syncState = async (pageId: string, kind: 'posts' | 'page') => {
  const [row] = await handle.sql<{ status: string; missing_scopes: string[]; succeeded_ms: number | null }[]>`
    select status, missing_scopes, (extract(epoch from succeeded_at) * 1000)::float8 as succeeded_ms
    from metric_sync_states where page_id = ${pageId} and kind = ${kind}`
  return row && { status: row.status, missing_scopes: row.missing_scopes, succeeded_at: row.succeeded_ms === null ? null : new Date(row.succeeded_ms) }
}
const connectionOf = async (pageId: string) => (await handle.sql<{ s: string }[]>`select connection_status s from pages where id = ${pageId}`)[0]!.s

const fail = (kind: string, extra: Record<string, unknown> = {}): MetaResult => ({ ok: false, kind, status: 400, ...extra }) as MetaResult
const insight = (name: string, value: number) => ({ name, period: 'lifetime', values: [{ value }] })
const total = (name: string, value: number) => ({ name, period: 'day', total_value: { value } })
const fbPost = (o: { reactions?: number; comments?: number; shares?: number; views?: number; reach?: number }) => ({
  ok: true as const,
  data: {
    id: 'x',
    ...(o.reactions !== undefined ? { reactions: { data: [], summary: { total_count: o.reactions } } } : {}),
    ...(o.comments !== undefined ? { comments: { data: [], summary: { total_count: o.comments } } } : {}),
    ...(o.shares !== undefined ? { shares: { count: o.shares } } : {}),
    insights: {
      data: [
        ...(o.views !== undefined ? [insight('post_media_view', o.views)] : []),
        ...(o.reach !== undefined ? [insight('post_total_media_view_unique', o.reach)] : []),
      ],
    },
  },
})
const posts = (opts = { finalAttempt: false }) => (pageId: string, d = deps()) => collectPostMetrics(d, { pageId }, opts)

/* ---------- Bảng ánh xạ ---------- */

describe('bảng ánh xạ metric', () => {
  it('không tham chiếu metric *impressions*; mọi lời gọi đều có metric', () => {
    const names = referencedMetricNames()
    expect(names.length).toBeGreaterThan(10)
    expect(names.filter((n) => /impressions/i.test(n))).toEqual([])
    expect(names).toEqual(expect.arrayContaining(['post_media_view', 'page_media_view', 'views']))
  })

  it('metric vắng hết → null (không 0); có một phần → cộng phần có; minus', () => {
    expect(standardize(POST_METRIC_MAP.instagram.rules, {})).toEqual({ views: null, reach: null, engagement: null })
    expect(standardize(POST_METRIC_MAP.instagram.rules, { likes: 4, saved: 1, views: 0 })).toEqual({ views: 0, reach: null, engagement: 5 })
    expect(standardize(PAGE_METRIC_MAP.facebook.rules, { page_daily_follows_unique: 2, page_daily_unfollows_unique: 5 }).followers_delta).toBe(-3)
    expect(standardize(PAGE_METRIC_MAP.threads.rules, { views: 9, likes: 1 })).toEqual({ views: 9, reach: null, engagement: 1, followers_delta: null })
  })

  it('end_time của insight ngày → ngày của giá trị', () => {
    expect(insightDayOf('2026-10-23T07:00:00+0000')).toBe('2026-10-22')
    expect(insightDayOf('2026-10-23T07:00:00Z')).toBe('2026-10-22')
    expect(insightDayOf('hỏng')).toBeNull()
  })
})

/* ---------- Cron ---------- */

describe('cron rải job', () => {
  it('mỗi trang chưa gỡ, không mất kết nối một job; không gọi Meta', async () => {
    const fb = await page('facebook', FB)
    const ig = await page('instagram', IG, { status: 'expiring', tokenSource: fb })
    await page('threads', TH, { status: 'disconnected' })
    await page('facebook', '9002', { removed: true })

    expect(await runPostMetricsCron({ db: handle.db, jobs })).toBe(2)
    expect(await runPageMetricsCron({ db: handle.db, jobs })).toBe(2)
    expect(sent.map((s) => [s.name, s.data.pageId]).sort()).toEqual(
      [
        ['analytics.collect_page', fb],
        ['analytics.collect_page', ig],
        ['analytics.collect_posts', fb],
        ['analytics.collect_posts', ig],
      ].sort(),
    )
    expect(graph.calls).toHaveLength(0)
  })
})

/* ---------- Bài ---------- */

describe('số liệu bài', () => {
  it('FB: một dòng chuẩn hoá, raw lưu, hạng background, token + scope đúng; trạng thái ok', async () => {
    const fb = await page('facebook', FB)
    const t = await target(fb, { platformPostId: `${FB}_1` })
    graph.on('GET', `/${FB}_1`, fbPost({ reactions: 10, comments: 3, views: 500, reach: 300 }))

    expect(await posts()(fb)).toEqual({ status: 'collected', saved: 1, skipped: 0 })
    expect(await postRows()).toEqual([
      {
        post_target_id: t,
        metric_date: '2026-10-24',
        views: 500,
        reach: 300,
        engagement: 13,
        raw: { reactions: 10, comments: 3, post_media_view: 500, post_total_media_view_unique: 300 },
      },
    ])
    expect(graph.calls).toHaveLength(1)
    const call = graph.calls[0]!.options
    expect(call).toMatchObject({ token: `TOKEN_${FB}`, tier: 'background', scope: `page:${FB}` })
    expect(String(call.params?.fields)).toContain('insights.metric(post_media_view,post_total_media_view_unique)')
    expect(await syncState(fb, 'posts')).toMatchObject({ status: 'ok', missing_scopes: [], succeeded_at: NOW })
  })

  it('IG (token Fanpage nguồn) và Threads: engagement theo nền tảng, Threads reach null', async () => {
    const fb = await page('facebook', FB)
    const ig = await page('instagram', IG, { tokenSource: fb })
    const th = await page('threads', TH)
    await target(ig, { platformPostId: '1790001' })
    await target(th, { platformPostId: '1800001' })
    graph.on('GET', '/1790001/insights', {
      ok: true,
      data: { data: [insight('views', 900), insight('reach', 400), insight('likes', 20), insight('comments', 4), insight('shares', 2), insight('saved', 3)] },
    })
    threads.on('GET', '/1800001/insights', { ok: true, data: { data: [insight('views', 80), insight('likes', 5), insight('replies', 2)] } })

    await posts()(ig)
    await posts()(th)
    const rows = await postRows()
    expect(rows.map((r) => [r.views, r.reach, r.engagement])).toEqual(expect.arrayContaining([[900, 400, 29], [80, null, 7]]))
    expect(graph.calls[0]!.options).toMatchObject({ token: `TOKEN_${FB}`, scope: `page:${IG}`, params: { metric: 'views,reach,likes,comments,shares,saved' } })
    expect(threads.calls[0]!.options).toMatchObject({ token: `TOKEN_${TH}`, scope: `threads:${th}`, tier: 'background' })
  })

  it('chọn bài: chỉ bài đã đăng có id, trong 30 ngày, của đúng trang', async () => {
    const fb = await page('facebook', FB)
    const other = await page('facebook', '9002')
    await target(fb, { platformPostId: `${FB}_ok` })
    await target(fb, { status: 'draft' })
    await target(fb, { status: 'failed', errorCode: 'PUBLISH_FAILED' })
    await target(fb, { platformPostId: null })
    await target(fb, { platformPostId: `${FB}_old`, publishedAt: new Date(NOW.getTime() - 31 * DAY) })
    await target(other, { platformPostId: '9002_x' })
    graph.setFallback(fbPost({ reactions: 1 }))

    await posts()(fb)
    expect(graph.calls.map((c) => c.path)).toEqual([`/${FB}_ok`])
  })

  it('chạy lại cùng ngày → vẫn một dòng, số mới; ngày sau → thêm dòng', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_1` })
    graph.onSequence('GET', `/${FB}_1`, [fbPost({ reactions: 1, views: 10 }), fbPost({ reactions: 4, views: 40 }), fbPost({ reactions: 9, views: 90 })])

    await posts()(fb)
    now = new Date(NOW.getTime() + 6 * 60 * MIN)
    await posts()(fb)
    expect((await postRows()).map((r) => [r.metric_date, r.views, r.engagement])).toEqual([['2026-10-24', 40, 4]])
    now = new Date(NOW.getTime() + DAY)
    await posts()(fb)
    expect((await postRows()).map((r) => [r.metric_date, r.views])).toEqual([
      ['2026-10-24', 40],
      ['2026-10-25', 90],
    ])
  })

  it('metric vắng → null; số âm / không phải số → bỏ', async () => {
    const ig = await page('instagram', IG, { tokenSource: await page('facebook', FB) })
    await target(ig, { platformPostId: 'm1' })
    graph.on('GET', '/m1/insights', { ok: true, data: { data: [insight('views', -5), { name: 'reach', values: [{ value: 'nhiều' }] }] } })
    await posts()(ig)
    expect((await postRows()).map((r) => [r.views, r.reach, r.engagement])).toEqual([[null, null, null]])
  })
})

/* ---------- Trang ---------- */

describe('số liệu trang', () => {
  it('FB: một lời gọi nhiều ngày, mỗi ngày Meta một dòng; followers_delta = theo dõi − bỏ theo dõi', async () => {
    const fb = await page('facebook', FB)
    const day = (end: string, v: number) => ({ value: v, end_time: end })
    graph.on('GET', `/${FB}/insights`, {
      ok: true,
      data: {
        data: [
          { name: 'page_media_view', period: 'day', values: [day('2026-10-22T07:00:00+0000', 100), day('2026-10-23T07:00:00+0000', 120)] },
          { name: 'page_total_media_view_unique', period: 'day', values: [day('2026-10-22T07:00:00+0000', 60), day('2026-10-23T07:00:00+0000', 70)] },
          { name: 'page_post_engagements', period: 'day', values: [day('2026-10-22T07:00:00+0000', 8), day('2026-10-23T07:00:00+0000', 9)] },
          { name: 'page_daily_follows_unique', period: 'day', values: [day('2026-10-22T07:00:00+0000', 7), day('2026-10-23T07:00:00+0000', 1)] },
          { name: 'page_daily_unfollows_unique', period: 'day', values: [day('2026-10-22T07:00:00+0000', 2), day('2026-10-23T07:00:00+0000', 3)] },
        ],
      },
    })

    expect(await collectPageMetrics(deps(), { pageId: fb }, { finalAttempt: false })).toEqual({ status: 'collected', saved: 2, skipped: 0 })
    expect(await pageRows()).toEqual([
      { date: '2026-10-21', views: 100, reach: 60, engagement: 8, followers_delta: 5 },
      { date: '2026-10-22', views: 120, reach: 70, engagement: 9, followers_delta: -2 },
    ])
    expect(graph.calls).toHaveLength(1)
    expect(graph.calls[0]!.options).toMatchObject({
      tier: 'background',
      params: { period: 'day', since: Math.floor((NOW.getTime() - 4 * DAY) / 1000), until: Math.floor(NOW.getTime() / 1000) },
    })
    expect(await syncState(fb, 'page')).toMatchObject({ status: 'ok' })
  })

  it('IG: 3 ngày VN × 2 lời gọi; followers_delta = FOLLOWER − NON_FOLLOWER; lời gọi theo dõi bị từ chối → chỉ followers_delta null', async () => {
    const fb = await page('facebook', FB)
    const ig = await page('instagram', IG, { tokenSource: fb })
    graph.on('GET', `/${IG}/insights`, (call) =>
      call.options.params?.breakdown
        ? {
            ok: true,
            data: {
              data: [
                {
                  name: 'follows_and_unfollows',
                  total_value: {
                    breakdowns: [
                      {
                        dimension_keys: ['follow_type'],
                        results: [
                          { dimension_values: ['FOLLOWER'], value: 6 },
                          { dimension_values: ['NON_FOLLOWER'], value: 1 },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          }
        : { ok: true, data: { data: [total('views', 300), total('reach', 150), total('total_interactions', 12)] } },
    )

    await collectPageMetrics(deps(), { pageId: ig }, { finalAttempt: false })
    expect(await pageRows()).toEqual(
      ['2026-10-21', '2026-10-22', '2026-10-23'].map((date) => ({ date, views: 300, reach: 150, engagement: 12, followers_delta: 5 })),
    )
    expect(graph.calls).toHaveLength(6)
    // Cửa sổ ngày VN: 23/10 00:00 giờ VN = 22/10 17:00 UTC.
    const last = graph.calls.at(-1)!.options.params!
    expect(last).toMatchObject({ since: Date.parse('2026-10-22T17:00:00Z') / 1000, until: Date.parse('2026-10-23T17:00:00Z') / 1000 })

    await handle.sql`delete from page_daily_metrics`
    graph.on('GET', `/${IG}/insights`, (call) =>
      call.options.params?.breakdown ? fail('REJECTED', { code: 100 }) : { ok: true, data: { data: [total('views', 1), total('reach', 1), total('total_interactions', 1)] } },
    )
    expect(await collectPageMetrics(deps(), { pageId: ig }, { finalAttempt: false })).toMatchObject({ status: 'collected', saved: 3 })
    expect((await pageRows()).map((r) => [r.views, r.followers_delta])).toEqual([
      [1, null],
      [1, null],
      [1, null],
    ])
  })

  it('Threads: reach và followers_delta null; chạy lại không thêm dòng', async () => {
    const th = await page('threads', TH)
    threads.on('GET', `/${TH}/threads_insights`, {
      ok: true,
      data: { data: [{ name: 'views', period: 'day', values: [{ value: 50, end_time: '2026-10-23T07:00:00+0000' }] }, total('likes', 3), total('replies', 1)] },
    })
    await collectPageMetrics(deps(), { pageId: th }, { finalAttempt: false })
    await collectPageMetrics(deps(), { pageId: th }, { finalAttempt: false })
    expect(await pageRows()).toEqual(
      ['2026-10-21', '2026-10-22', '2026-10-23'].map((date) => ({ date, views: 50, reach: null, engagement: 4, followers_delta: null })),
    )
  })
})

/* ---------- Quyền, giới hạn, lỗi ---------- */

describe('thiếu quyền / giới hạn / lỗi', () => {
  it('thiếu quyền insight → không gọi Meta, ghi rõ quyền thiếu, trang vẫn kết nối', async () => {
    const fb = await page('facebook', FB, { scopes: ['pages_show_list', 'pages_read_engagement'] })
    await target(fb, { platformPostId: `${FB}_1` })
    expect(await posts()(fb)).toEqual({ status: 'permissions_missing' })
    expect(await collectPageMetrics(deps(), { pageId: fb }, { finalAttempt: false })).toEqual({ status: 'permissions_missing' })
    expect(graph.calls).toHaveLength(0)
    expect(await syncState(fb, 'posts')).toMatchObject({ status: 'permissions_missing', missing_scopes: ['read_insights'], succeeded_at: null })
    expect(await syncState(fb, 'page')).toMatchObject({ status: 'permissions_missing', missing_scopes: ['read_insights'] })
    expect(await connectionOf(fb)).toBe('active')
    expect(emitted).toEqual([])
  })

  it('usage ≥75%: lời gọi background bị giữ (không gửi), job hoãn tới hết giữ; gửi tin interactive vẫn đi', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_1` })
    const rateStore = createMemoryRateStore()
    await rateStore.record('app:graph', { bucket: 'app', usagePct: 80, blockedUntil: null, updatedAt: NOW })
    let fetched = 0
    const real = createGraphClient({
      rateStore,
      now: () => NOW,
      random: () => 0.5,
      fetch: (async () => {
        fetched++
        return new Response('{"id":"1"}', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })

    const out = await collectPostMetrics(deps({ graph: real }), { pageId: fb }, { finalAttempt: false })
    expect(out).toMatchObject({ status: 'deferred' })
    expect(fetched).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ name: 'analytics.collect_posts', data: { pageId: fb, deferredSince: NOW.toISOString() } })
    // Usage ghi lúc NOW, giữ tới hết TTL 5 phút (random 0.5 = không giãn).
    expect((sent[0]!.options!.startAfter as Date).getTime()).toBe(NOW.getTime() + 5 * MIN)
    expect(await postRows()).toEqual([])

    const send = await real.post('/me/messages', { token: 'T', tier: 'interactive', scope: `page:${FB}`, body: { message: { text: 'Chào' } } })
    expect(send.ok).toBe(true)
    expect(fetched).toBe(1)
  })

  it('hoãn quá 3 giờ kể từ lần hoãn đầu → bỏ lượt, không enqueue', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_1` })
    graph.setFallback(fail('RATE_LIMITED', { retryAfterMs: 10 * MIN }))
    const since = new Date(NOW.getTime() - METRICS_DEFER_MAX_MS).toISOString()
    expect(await collectPostMetrics(deps(), { pageId: fb, deferredSince: since }, { finalAttempt: false })).toEqual({ status: 'gave_up' })
    expect(sent).toEqual([])
  })

  it('Meta chặn giữa chừng: bài đã ghi giữ nguyên, job mới startAfter, không ném', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_new`, publishedAt: new Date(NOW.getTime() - DAY) })
    await target(fb, { platformPostId: `${FB}_old`, publishedAt: new Date(NOW.getTime() - 3 * DAY) })
    graph.on('GET', `/${FB}_new`, fbPost({ reactions: 2 }))
    graph.on('GET', `/${FB}_old`, fail('RATE_LIMITED', { retryAfterMs: 2 * MIN }))

    expect(await posts()(fb)).toMatchObject({ status: 'deferred' })
    expect(await postRows()).toHaveLength(1)
    expect(sent[0]).toMatchObject({ name: 'analytics.collect_posts', options: { startAfter: new Date(NOW.getTime() + 2 * MIN) } })

    // Trang: tương tự với queue của trang.
    graph.on('GET', `/${FB}/insights`, fail('RATE_LIMITED', { retryAfterMs: 3 * MIN }))
    expect(await collectPageMetrics(deps(), { pageId: fb }, { finalAttempt: false })).toMatchObject({ status: 'deferred' })
    expect(sent[1]).toMatchObject({ name: 'analytics.collect_page', data: { pageId: fb } })
  })

  it('hoãn: startAfter tính từ lúc bị chặn; job hoãn bỏ bài đã ghi trong lượt, chỉ gọi bài còn lại', async () => {
    const fb = await page('facebook', FB)
    const done = await target(fb, { platformPostId: `${FB}_new`, publishedAt: new Date(NOW.getTime() - DAY) })
    await target(fb, { platformPostId: `${FB}_old`, publishedAt: new Date(NOW.getTime() - 3 * DAY) })
    graph.on('GET', `/${FB}_new`, fbPost({ reactions: 2 }))
    graph.on('GET', `/${FB}_old`, () => {
      // Lượt đã chạy 10 phút khi bị chặn.
      now = new Date(NOW.getTime() + 10 * MIN)
      return fail('RATE_LIMITED', { retryAfterMs: 2 * MIN })
    })
    expect(await posts()(fb)).toMatchObject({ status: 'deferred' })
    expect(sent[0]).toMatchObject({ data: { deferredSince: NOW.toISOString() }, options: { startAfter: new Date(NOW.getTime() + 12 * MIN) } })

    graph.reset()
    graph.setFallback(fbPost({ reactions: 5 }))
    now = new Date(NOW.getTime() + 12 * MIN)
    expect(await collectPostMetrics(deps(), { pageId: fb, deferredSince: NOW.toISOString() }, { finalAttempt: false })).toEqual({
      status: 'collected',
      saved: 1,
      skipped: 0,
    })
    expect(graph.calls.map((c) => c.path)).toEqual([`/${FB}_old`])
    expect((await postRows()).map((r) => r.post_target_id)).toContain(done)
  })

  it('lượt sau thiếu metric (follows IG bị từ chối) → giữ số cũ của ngày đó, số khác cập nhật', async () => {
    const ig = await page('instagram', IG, { tokenSource: await page('facebook', FB) })
    const follows = {
      ok: true as const,
      data: {
        data: [
          {
            name: 'follows_and_unfollows',
            total_value: { breakdowns: [{ results: [{ dimension_values: ['FOLLOWER'], value: 4 }, { dimension_values: ['NON_FOLLOWER'], value: 1 }] }] },
          },
        ],
      },
    }
    const main = (v: number) => ({ ok: true as const, data: { data: [total('views', v), total('reach', v), total('total_interactions', v)] } })
    graph.on('GET', `/${IG}/insights`, (call) => (call.options.params?.breakdown ? follows : main(10)))
    await collectPageMetrics(deps(), { pageId: ig }, { finalAttempt: false })

    now = new Date(NOW.getTime() + DAY)
    graph.on('GET', `/${IG}/insights`, (call) => (call.options.params?.breakdown ? fail('REJECTED', { code: 100 }) : main(20)))
    await collectPageMetrics(deps(), { pageId: ig }, { finalAttempt: false })
    expect((await pageRows()).map((r) => [r.date, r.views, r.followers_delta])).toEqual([
      ['2026-10-21', 10, 3],
      ['2026-10-22', 20, 3],
      ['2026-10-23', 20, 3],
      ['2026-10-24', 20, null],
    ])
  })

  it('token hỏng (IG) → Fanpage nguồn + IG mất kết nối, page.disconnected, dừng', async () => {
    const fb = await page('facebook', FB)
    const ig = await page('instagram', IG, { tokenSource: fb })
    await target(ig, { platformPostId: 'm1' })
    await target(ig, { platformPostId: 'm2', publishedAt: new Date(NOW.getTime() - 5 * DAY) })
    graph.setFallback(fail('TOKEN_INVALID', { code: 190 }))

    expect(await posts()(ig)).toEqual({ status: 'disconnected' })
    expect(graph.calls).toHaveLength(1)
    expect(await connectionOf(fb)).toBe('disconnected')
    expect(await connectionOf(ig)).toBe('disconnected')
    expect(emitted.filter((e) => e.name === 'page.disconnected').map((e) => e.payload.pageId).sort()).toEqual([fb, ig].sort())
    expect(await syncState(ig, 'posts')).toMatchObject({ status: 'disconnected' })
  })

  it('token hỏng ở số liệu trang → mất kết nối, dừng', async () => {
    const fb = await page('facebook', FB)
    graph.setFallback(fail('TOKEN_INVALID', { code: 190 }))
    expect(await collectPageMetrics(deps(), { pageId: fb }, { finalAttempt: false })).toEqual({ status: 'disconnected' })
    expect(await connectionOf(fb)).toBe('disconnected')
  })

  it('Meta từ chối quyền: lời gọi trang → permission_denied; một bài → bỏ bài; mọi bài → permission_denied; trang vẫn kết nối', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_a` })
    await target(fb, { platformPostId: `${FB}_b` })

    graph.on('GET', `/${FB}/insights`, fail('PERMISSION_DENIED', { code: 10 }))
    expect(await collectPageMetrics(deps(), { pageId: fb }, { finalAttempt: false })).toEqual({ status: 'permission_denied' })
    expect(await syncState(fb, 'page')).toMatchObject({ status: 'permission_denied', missing_scopes: [] })

    graph.on('GET', `/${FB}_a`, fail('PERMISSION_DENIED', { code: 10 }))
    graph.on('GET', `/${FB}_b`, fbPost({ reactions: 1 }))
    expect(await posts()(fb)).toEqual({ status: 'collected', saved: 1, skipped: 1 })
    expect(await syncState(fb, 'posts')).toMatchObject({ status: 'ok' })

    graph.on('GET', `/${FB}_b`, fail('PERMISSION_DENIED', { code: 10 }))
    expect(await posts()(fb)).toEqual({ status: 'permission_denied' })
    expect(await syncState(fb, 'posts')).toMatchObject({ status: 'permission_denied', succeeded_at: NOW })
    expect(await connectionOf(fb)).toBe('active')
    expect(emitted).toEqual([])
  })

  it('bài đã xoá / không hỗ trợ (REJECTED) → bỏ bài đó, bài khác vẫn ghi', async () => {
    const fb = await page('facebook', FB)
    await target(fb, { platformPostId: `${FB}_gone` })
    await target(fb, { platformPostId: `${FB}_ok` })
    graph.on('GET', `/${FB}_gone`, fail('REJECTED', { code: 100 }))
    graph.on('GET', `/${FB}_ok`, fbPost({ comments: 2 }))
    expect(await posts()(fb)).toEqual({ status: 'collected', saved: 1, skipped: 1 })
  })

  it('lỗi tạm: một bài → bỏ; 3 bài liên tiếp → ném retry, lần cuối failed; lời gọi trang → ném, lần cuối failed', async () => {
    const fb = await page('facebook', FB)
    const ids = ['a', 'b', 'c', 'd'].map((s) => `${FB}_${s}`)
    for (const [i, id] of ids.entries()) await target(fb, { platformPostId: id, publishedAt: new Date(NOW.getTime() - (i + 1) * DAY) })
    graph.setFallback(fbPost({ reactions: 1 }))
    graph.on('GET', `/${ids[0]}`, fail('TRANSIENT'))
    expect(await posts()(fb)).toEqual({ status: 'collected', saved: 3, skipped: 1 })

    for (const id of ids.slice(0, 3)) graph.on('GET', `/${id}`, fail('TRANSIENT'))
    await expect(posts()(fb)).rejects.toBeInstanceOf(MetricsRetryableError)
    expect(await handleCollectPostsJob(deps(), { data: { pageId: fb }, retryCount: 3, retryLimit: 3 })).toEqual({ status: 'failed' })
    expect(await syncState(fb, 'posts')).toMatchObject({ status: 'failed' })

    graph.on('GET', `/${FB}/insights`, fail('ABORTED'))
    await expect(handleCollectPageJob(deps(), { data: { pageId: fb }, retryCount: 0, retryLimit: 3 })).rejects.toBeInstanceOf(MetricsRetryableError)
    expect(await handleCollectPageJob(deps(), { data: { pageId: fb }, retryCount: 3, retryLimit: 3 })).toEqual({ status: 'failed' })
    expect(await syncState(fb, 'page')).toMatchObject({ status: 'failed' })
  })

  it('bỏ qua: trang đã gỡ / mất kết nối lúc chạy, Threads chưa cấu hình → không gọi Meta, không ghi', async () => {
    const removed = await page('facebook', FB, { removed: true })
    const off = await page('facebook', '9002', { status: 'disconnected' })
    const th = await page('threads', TH)
    for (const p of [removed, off]) await target(p, { platformPostId: `${p}_1` })
    await target(th, { platformPostId: 't1' })

    for (const p of [removed, off]) {
      expect(await posts()(p)).toEqual({ status: 'skipped' })
      expect(await collectPageMetrics(deps(), { pageId: p }, { finalAttempt: false })).toEqual({ status: 'skipped' })
    }
    expect(await posts()(th, deps({ threads: undefined }))).toEqual({ status: 'skipped' })
    expect(graph.calls.length + threads.calls.length).toBe(0)
    expect(await handle.sql`select 1 from metric_sync_states`).toHaveLength(0)
  })
})

// Ma trận Story 8.2 — Màn Hiệu suất theo phạm vi (AD-17, AD-18, AD-1). Qua app thật (buildApp) + Postgres nhúng; số liệu
// chèn thẳng vào bảng của `analytics` (như lượt thu của Story 8.1 để lại) — route không gọi Meta. Phủ: nhóm 30 ngày (KPI +
// kỳ trước, chuỗi theo nền tảng, bảng trang), thành viên hiện tại, ranh giới ngày VN, `null` ≠ 0, bài tốt nhất, đếm bài,
// chưa đủ dữ liệu, trạng thái thu (thiếu quyền), phạm vi rỗng / sai, 401.
import { ErrorResponse, PerformanceResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { performanceWindow } from '../src/modules/analytics/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const DAY = 24 * 60 * 60_000
/** "Bây giờ": 10:00 giờ VN 24/10/2026 → kỳ 30 ngày = 24/09 – 23/10, kỳ trước = 25/08 – 23/09. */
const NOW = new Date('2026-10-24T03:00:00.000Z')
const FROM = '2026-09-24'
const TO = '2026-10-23'

let handle: DbHandle
let app: FastifyInstance
let cookie: string
let accounts = 0

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
  await handle.sql`delete from post_metrics`
  await handle.sql`delete from page_daily_metrics`
  await handle.sql`delete from metric_sync_states`
  await handle.sql`delete from posts`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from sessions`
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'
type Metrics = { views?: number | null; reach?: number | null; engagement?: number | null; followersDelta?: number | null }

async function group(name = 'Mỹ phẩm'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-1') returning id`
  return row!.id
}

/** Trang kết nối `connectedDaysAgo` ngày trước (mặc định 60 — đủ dữ liệu). */
async function page(platform: Platform, opts: { groupId?: string | null; connectedDaysAgo?: number; removed?: boolean } = {}): Promise<string> {
  const accountId = String(7000 + ++accounts)
  const connectedAt = new Date(NOW.getTime() - (opts.connectedDaysAgo ?? 60) * DAY).toISOString()
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, group_id, connected_at, removed_at)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, 'active', ${opts.groupId ?? null}, ${connectedAt}::timestamptz,
      ${opts.removed ? NOW.toISOString() : null}::timestamptz)
    returning id`
  return p!.id
}

async function daily(pageId: string, date: string, m: Metrics): Promise<void> {
  await handle.sql`
    insert into page_daily_metrics (page_id, date, views, reach, engagement, followers_delta, fetched_at)
    values (${pageId}, ${date}, ${m.views ?? null}, ${m.reach ?? null}, ${m.engagement ?? null}, ${m.followersDelta ?? null}, ${NOW.toISOString()}::timestamptz)`
}

async function target(
  pageId: string,
  opts: { publishedAt?: Date; status?: string; caption?: string; aiCaption?: boolean; permalink?: string | null } = {},
): Promise<string> {
  const [post] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
  const status = opts.status ?? 'published'
  const [t] = await handle.sql<{ id: string }[]>`
    insert into post_targets (post_id, page_id, position, status, caption, ai_caption, platform_post_id, published_at, permalink, error_code)
    values (${post!.id}, ${pageId}, 0, ${status}, ${opts.caption ?? 'Bài viết'}, ${opts.aiCaption ?? false}, ${'pp_' + accounts + '_' + Math.random()},
      ${(opts.publishedAt ?? new Date(NOW.getTime() - 3 * DAY)).toISOString()}::timestamptz, ${opts.permalink ?? null},
      ${status === 'failed' ? 'PUBLISH_FAILED' : null})
    returning id`
  return t!.id
}

async function snapshot(targetId: string, pageId: string, date: string, m: Metrics): Promise<void> {
  await handle.sql`
    insert into post_metrics (post_target_id, page_id, metric_date, views, reach, engagement, fetched_at)
    values (${targetId}, ${pageId}, ${date}, ${m.views ?? null}, ${m.reach ?? null}, ${m.engagement ?? null}, ${NOW.toISOString()}::timestamptz)`
}

async function sync(pageId: string, kind: 'posts' | 'page', status: string, missing: string[] = []): Promise<void> {
  await handle.sql`
    insert into metric_sync_states (page_id, kind, status, missing_scopes, attempted_at)
    values (${pageId}, ${kind}, ${status}, ${missing}::text[], ${NOW.toISOString()}::timestamptz)`
}

function get(query: Record<string, string>, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN }
  if (opts.auth !== false) headers.cookie = cookie
  return app.inject({ method: 'GET', url: `/api/v1/performance?${new URLSearchParams(query)}`, headers })
}

async function perf(query: Record<string, string> = {}): Promise<PerformanceResponse> {
  const res = await get(query)
  expect(res.statusCode, res.body).toBe(200)
  return PerformanceResponse.parse(res.json())
}

const dayIndex = (date: string, from = FROM) => Math.round((Date.parse(date) - Date.parse(from)) / DAY)

/* ---------- Ma trận ---------- */

describe('GET /performance — tổng hợp theo phạm vi', () => {
  it('nhóm 30 ngày: KPI + kỳ trước, chuỗi theo nền tảng, bảng trang; trang ngoài nhóm không tính', async () => {
    const g = await group()
    const fb = await page('facebook', { groupId: g })
    const ig = await page('instagram', { groupId: g })
    const other = await page('facebook')
    // Số liệu bắt đầu trước kỳ trước (ngoài cả hai kỳ) → kỳ trước đủ để so.
    await daily(fb, '2026-08-01', {})
    await daily(ig, '2026-08-01', {})
    await daily(fb, TO, { views: 100, reach: 80, engagement: 10, followersDelta: 2 })
    await daily(fb, '2026-10-01', { views: 20, reach: 15, engagement: 3, followersDelta: -1 })
    await daily(ig, '2026-10-01', { views: 50, reach: 40, engagement: 5, followersDelta: 1 })
    await daily(fb, '2026-09-10', { views: 30, reach: 25, engagement: 4, followersDelta: 0 })
    await daily(other, TO, { views: 9000, reach: 9000, engagement: 1000, followersDelta: 50 })

    const r = await perf({ scope: `group:${g}`, range: '30d' })
    expect(r).toMatchObject({ range: '30d', from: FROM, to: TO, insufficientData: false, platforms: ['facebook', 'instagram'] })
    expect(r.kpis).toEqual({
      views: { current: 170, previous: 30 },
      reach: { current: 135, previous: 25 },
      engagement: { current: 18, previous: 4 },
      followersDelta: { current: 2, previous: 0 },
      engagementRate: { current: (18 / 135) * 100, previous: (4 / 25) * 100 },
    })
    expect(r.series).toHaveLength(30)
    expect(r.series[0]!.date).toBe(FROM)
    expect(r.series[29]).toEqual({ date: TO, facebook: 10, instagram: null, threads: null, previous: null })
    expect(r.series[dayIndex('2026-10-01')]).toMatchObject({ facebook: 3, instagram: 5, threads: null })
    // 10/09 là ngày thứ 17 (chỉ số 16) của kỳ trước 25/08 – 23/09 → nét đứt cùng vị trí.
    expect(r.series[dayIndex('2026-09-10', '2026-08-25')]!.previous).toBe(4)
    expect(r.pages.map((p) => p.pageId)).toEqual([fb, ig])
    expect(r.pages[0]).toMatchObject({ views: 120, reach: 95, engagement: 13, followersDelta: 1, insufficientData: false })
    expect(r.pages[0]!.trend).toHaveLength(30)
    expect(r.pages[0]!.trend[29]).toBe(10)
    expect(r.pages[0]!.trend[0]).toBeNull()
  })

  it('gộp theo thành viên hiện tại: trang rời nhóm và trang đã gỡ không tính', async () => {
    const g = await group()
    const stay = await page('facebook', { groupId: g })
    const left = await page('facebook', { groupId: g })
    const removed = await page('instagram', { removed: true })
    await daily(stay, TO, { engagement: 7 })
    await daily(left, TO, { engagement: 100 })
    await daily(removed, TO, { engagement: 1000 })
    await handle.sql`update pages set group_id = null where id = ${left}`

    const inGroup = await perf({ scope: `group:${g}` })
    expect(inGroup.kpis.engagement.current).toBe(7)
    expect(inGroup.pages.map((p) => p.pageId)).toEqual([stay])
    const all = await perf()
    expect(all.kpis.engagement.current).toBe(107)
    expect(all.platforms).toEqual(['facebook'])
  })

  it('ranh giới ngày VN: hôm nay không tính, ngày trước `from` vào kỳ trước, `from` vào kỳ này', async () => {
    const fb = await page('facebook')
    await daily(fb, '2026-08-25', {})
    await daily(fb, '2026-10-24', { engagement: 1000 })
    await daily(fb, '2026-09-23', { engagement: 20 })
    await daily(fb, FROM, { engagement: 3 })
    const r = await perf({ range: '30d' })
    expect(r.kpis.engagement).toEqual({ current: 3, previous: 20 })
    expect(r.series[0]!.facebook).toBe(3)
    expect(r.series[29]!.previous).toBe(20)
    expect(performanceWindow('7d', NOW)).toEqual({ days: 7, from: '2026-10-17', to: TO, prevFrom: '2026-10-10', prevTo: '2026-10-16' })
  })

  it('null ≠ 0: Threads không có reach / theo dõi; FB + Threads chỉ cộng phần có', async () => {
    const th = await page('threads')
    const fb = await page('facebook')
    await daily(th, TO, { views: 40, reach: null, engagement: 6, followersDelta: null })
    await daily(fb, TO, { views: 10, reach: 9, engagement: 0, followersDelta: 0 })

    const onlyThreads = await perf({ scope: `page:${th}` })
    expect(onlyThreads.kpis.reach).toEqual({ current: null, previous: null })
    expect(onlyThreads.kpis.followersDelta.current).toBeNull()
    expect(onlyThreads.kpis.engagement.current).toBe(6)
    const all = await perf()
    expect(all.kpis.reach.current).toBe(9)
    expect(all.kpis.engagement.current).toBe(6)
    expect(all.kpis.followersDelta.current).toBe(0)
    expect(all.pages.find((p) => p.pageId === fb)!.engagement).toBe(0)
  })

  it('tỉ lệ tương tác KPI chỉ tính ngày có tiếp cận: tương tác Threads không thổi phồng tỉ lệ', async () => {
    const th = await page('threads')
    const fb = await page('facebook')
    await daily(th, TO, { views: 40, engagement: 60 })
    await daily(fb, TO, { views: 10, reach: 100, engagement: 5 })
    const all = await perf()
    expect(all.kpis.engagement.current).toBe(65)
    expect(all.kpis.engagementRate.current).toBe(5)
    expect((await perf({ scope: `page:${th}` })).kpis.engagementRate.current).toBeNull()
  })

  it('kỳ trước chưa đủ dữ liệu (trang có số liệu đầu tiên sau ngày đầu kỳ trước) → previous null, không % giả', async () => {
    const old = await page('facebook')
    const fresh = await page('instagram', { connectedDaysAgo: 20 })
    await daily(old, '2026-08-01', {})
    await daily(old, '2026-09-20', { views: 10, reach: 10, engagement: 2 })
    await daily(old, TO, { views: 10, reach: 10, engagement: 2 })
    await daily(fresh, '2026-10-05', { views: 50, reach: 50, engagement: 9 })
    const all = await perf({ range: '30d' })
    expect(all.kpis.engagement).toEqual({ current: 11, previous: null })
    expect(all.kpis.engagementRate.previous).toBeNull()
    const onlyOld = await perf({ scope: `page:${old}`, range: '30d' })
    expect(onlyOld.kpis.engagement).toEqual({ current: 2, previous: 2 })
  })
})

describe('GET /performance — bài', () => {
  it('bài tốt nhất: 5 bài trong kỳ thuộc phạm vi, xếp theo tương tác, số = snapshot mới nhất', async () => {
    const g = await group()
    const fb = await page('facebook', { groupId: g })
    const outsider = await page('facebook')
    const day = (n: number) => new Date(NOW.getTime() - n * DAY)
    const ids: string[] = []
    for (const [i, eng] of [5, 50, 20, 40, 10, 30].entries()) {
      const t = await target(fb, { publishedAt: day(2 + i), caption: `Bài số ${i}\n  mẹo chăm da`, aiCaption: i === 1, permalink: i === 1 ? 'https://facebook.com/p/1' : null })
      await snapshot(t, fb, TO, { views: eng * 10, reach: eng * 5, engagement: eng })
      ids.push(t)
    }
    // Hai snapshot: ngày mới nhất thắng (dù số ngày cũ cao hơn).
    await snapshot(ids[0]!, fb, '2026-10-20', { views: 1, reach: 1, engagement: 999 })
    await handle.sql`update post_metrics set engagement = 45 where post_target_id = ${ids[0]!} and metric_date = ${TO}`
    const old = await target(fb, { publishedAt: day(40) })
    await snapshot(old, fb, TO, { engagement: 5000 })
    const foreign = await target(outsider, { publishedAt: day(3) })
    await snapshot(foreign, outsider, TO, { engagement: 5000 })
    const failed = await target(fb, { status: 'failed', publishedAt: day(3) })
    await snapshot(failed, fb, TO, { engagement: 5000 })
    const noMetrics = await target(fb, { publishedAt: day(4) })

    const r = await perf({ scope: `group:${g}` })
    expect(r.topPosts.map((p) => p.engagement)).toEqual([50, 45, 40, 30, 20])
    expect(r.topPosts.map((p) => p.targetId)).not.toContain(noMetrics)
    const best = r.topPosts[0]!
    expect(best).toMatchObject({
      targetId: ids[1],
      pageId: fb,
      title: 'Bài số 1 mẹo chăm da',
      permalink: 'https://facebook.com/p/1',
      ai: true,
      source: 'manual',
      campaignId: null,
      views: 500,
      reach: 250,
    })
    expect(r.topPosts[1]).toMatchObject({ targetId: ids[0], ai: false, views: 50 })
    // Đếm bài: 6 bài + bài chưa có số liệu trong kỳ; bài 40 ngày trước và bài lỗi không tính.
    expect(r.pages[0]!.posts).toBe(7)
  })

  it('đếm bài theo trang: chỉ bài đã đăng trong kỳ', async () => {
    const a = await page('facebook')
    const b = await page('instagram')
    for (const n of [1, 5, 29]) await target(a, { publishedAt: new Date(NOW.getTime() - n * DAY) })
    await target(a, { publishedAt: new Date(NOW.getTime() - 31 * DAY) })
    await target(a, { publishedAt: new Date(NOW.getTime() - 60_000) }) // hôm nay — ngoài kỳ
    const r = await perf()
    expect(r.pages.find((p) => p.pageId === a)!.posts).toBe(3)
    expect(r.pages.find((p) => p.pageId === b)!.posts).toBe(0)
    expect(r.topPosts).toEqual([])
  })
})

describe('GET /performance — trạng thái', () => {
  it('chưa đủ dữ liệu: trang kết nối 3 ngày → true; nhóm có trang cũ → chỉ dòng trang mới', async () => {
    const g = await group()
    const fresh = await page('instagram', { groupId: g, connectedDaysAgo: 3 })
    const old = await page('facebook', { groupId: g })
    const single = await perf({ scope: `page:${fresh}` })
    expect(single.insufficientData).toBe(true)
    expect(single.pages[0]!.insufficientData).toBe(true)
    const mixed = await perf({ scope: `group:${g}` })
    expect(mixed.insufficientData).toBe(false)
    expect(Object.fromEntries(mixed.pages.map((p) => [p.pageId, p.insufficientData]))).toEqual({ [fresh]: true, [old]: false })
  })

  it('trạng thái thu: thiếu quyền / bị từ chối / lỗi / chưa thu / ổn', async () => {
    const missing = await page('facebook')
    const denied = await page('instagram')
    const failed = await page('threads')
    const pending = await page('facebook')
    const ok = await page('facebook')
    await sync(missing, 'posts', 'permissions_missing', ['read_insights'])
    await sync(missing, 'page', 'permissions_missing', ['read_insights'])
    await sync(denied, 'posts', 'ok')
    await sync(denied, 'page', 'permission_denied')
    await sync(failed, 'page', 'failed')
    await sync(ok, 'posts', 'ok')
    await sync(ok, 'page', 'ok')
    const r = await perf()
    const state = Object.fromEntries(r.pages.map((p) => [p.pageId, [p.metricsState, p.missingScopes]]))
    expect(state).toEqual({
      [missing]: ['permissions_missing', ['read_insights']],
      [denied]: ['permissions_missing', []],
      [failed]: ['failed', []],
      [pending]: ['pending', []],
      [ok]: ['ok', []],
    })
  })

  it('phạm vi rỗng → 200 rỗng; scope / range sai → 400; nhóm không tồn tại → 404; chưa đăng nhập → 401', async () => {
    const g = await group('Trống')
    const empty = await perf({ scope: `group:${g}`, range: '7d' })
    expect(empty).toMatchObject({ insufficientData: false, platforms: [], pages: [], topPosts: [], from: '2026-10-17', to: TO })
    expect(empty.kpis.views).toEqual({ current: null, previous: null })
    expect(empty.series).toHaveLength(7)
    expect(empty.series.every((p) => p.facebook === null && p.previous === null)).toBe(true)

    const invalid: Record<string, string>[] = [{ scope: 'foo' }, { range: '14d' }, { range: '30d', extra: '1' }]
    for (const query of invalid) {
      const res = await get(query)
      expect(res.statusCode).toBe(400)
      expect(ErrorResponse.parse(res.json()).error.code).toBe('VALIDATION_FAILED')
    }
    const missing = await get({ scope: 'group:00000000-0000-7000-8000-000000000000' })
    expect(missing.statusCode).toBe(404)
    expect((await get({}, { auth: false })).statusCode).toBe(401)
  })
})

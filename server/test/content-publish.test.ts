// Ma trận Story 6.4 — Lên lịch và đăng bài theo từng trang (AD-13, AD-6, AD-14, AD-24). Qua app thật (buildApp) + Postgres
// nhúng + pg-boss + Meta giả (`adapters/meta/fake.ts`, không gọi mạng). Phủ: lên lịch / đăng ngay (tất cả hoặc không, luật
// nền tảng, giờ, phiên bản, giới hạn/24h), bỏ lịch / đổi giờ an toàn với job cũ, job đăng FB / IG / Threads (khung ảnh IG,
// container, hạn mức Meta), ánh xạ lỗi, chống đăng trùng khi không rõ kết quả, `RATE_LIMITED`, một trang lỗi không chặn
// trang khác, đăng lại, cron `content.requeue`, 401.
import { randomBytes } from 'node:crypto'
import { ErrorResponse, PostDto, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import type { MetaResult } from '../src/adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import {
  PUBLISHING_STUCK_MS,
  PUBLISH_RATE_DEFER_MAX_MS,
  PublishRetryableError,
  REQUEUE_OVERDUE_MS,
  handlePublishJob,
  publishTarget,
  requeueTargets,
  type PublishDeps,
} from '../src/modules/content/index.ts'
import { dedupeKey } from '../src/modules/notifications/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const FB = '9001'
const IG = '17841400000009'
const TH = '25000000000009'
const IMG = (name: string) => `https://res.cloudinary.com/demo/image/upload/v1/ottm/public/${name}.jpg`

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance
let cookie: string
let graph: FakeMetaClient
let threads: FakeMetaClient
/** "Bây giờ" của route (lên lịch); job dùng giờ thật trừ khi test truyền `now`. */
let clockNow: Date | null = null

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name).map((e) => e.payload)

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-content-publish', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    http: { allowedOrigins: [ORIGIN] },
    events,
    jobs,
    clock: () => clockNow ?? new Date(),
  })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from posts`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name = 'publish.target'`
  emitted.length = 0
  clockNow = null
  graph = createFakeMetaClient()
  threads = createFakeMetaClient('https://graph.threads.com/v1.0')
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

async function page(platform: 'facebook' | 'instagram' | 'threads', accountId: string, status: 'active' | 'expiring' | 'disconnected' = 'active') {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, ${status}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${accountId}`)})`
  return p!.id
}

async function image(name: string, width = 1024, height = 1024): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into media_assets (source, status, public_id, url, width, height, bytes, format)
    values ('upload', 'ready', ${'ottm/public/' + name}, ${IMG(name)}, ${width}, ${height}, 1000, 'jpg') returning id`
  return row!.id
}

const headers = () => ({ origin: ORIGIN, cookie, 'content-type': 'application/json' })

async function createPost(targets: { pageId: string; caption: string; mediaIds?: string[] }[]): Promise<PostDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: headers(),
    payload: JSON.stringify({ topic: 'Khuyến mãi', targets: targets.map((t) => ({ mediaIds: [], ...t })) }),
  })
  expect(res.statusCode, res.body).toBe(201)
  return PostDto.parse(res.json())
}

function transition(postId: string, body: unknown, opts: { auth?: boolean } = {}) {
  const h: Record<string, string> = headers()
  if (opts.auth === false) delete h.cookie
  return app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/targets/transition`, headers: h, payload: JSON.stringify(body) })
}

const refs = (post: PostDto) => post.targets.map((t) => ({ id: t.id, version: t.version }))

async function scheduleOk(post: PostDto, scheduledAt: string | null = null): Promise<PostDto> {
  const res = await transition(post.id, { action: 'schedule', scheduledAt, targets: refs(post) })
  expect(res.statusCode, res.body).toBe(200)
  return PostDto.parse(res.json())
}

const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error

const rowOf = async (id: string) =>
  (await handle.sql<
    { status: string; error_code: string | null; schedule_version: number; version: number; scheduled_at: Date | null; platform_post_id: string | null; permalink: string | null; published_at: Date | null }[]
  >`select status, error_code, schedule_version, version, scheduled_at, platform_post_id, permalink, published_at from post_targets where id = ${id}`)[0]!

const jobRows = async () =>
  (
    await handle.sql<{ data: { targetId: string; scheduleVersion: number }; start_after: string; state: string }[]>`
      select data, start_after, state from pgboss.job where name = 'publish.target' order by created_on`
  ).map((r) => ({ ...r, start_after: new Date(r.start_after) }))

const deps = (extra: Partial<PublishDeps> = {}): PublishDeps => ({
  db: handle.db,
  events,
  jobs,
  cipher,
  graph,
  threads,
  sleep: async () => {},
  pollMax: 3,
  ...extra,
})

/** Chạy job cho target với `schedule_version` hiện tại (hoặc `version` chỉ định). */
async function run(targetId: string, opts: { finalAttempt?: boolean; version?: number; extra?: Partial<PublishDeps> } = {}) {
  const sv = opts.version ?? (await rowOf(targetId)).schedule_version
  return publishTarget(deps(opts.extra), { targetId, scheduleVersion: sv }, { finalAttempt: opts.finalAttempt ?? false })
}

const ok = (data: unknown): MetaResult => ({ ok: true, data })
const posts = (client: FakeMetaClient, path?: string) => client.calls.filter((c) => c.method === 'POST' && (!path || c.path === path))

/** Một bài FB (chỉ chữ) đã "Đăng ngay". */
async function scheduledFacebook(caption = 'Bài FB'): Promise<{ post: PostDto; targetId: string; pageId: string }> {
  const pageId = await page('facebook', FB)
  const post = await scheduleOk(await createPost([{ pageId, caption }]))
  return { post, targetId: post.targets[0]!.id, pageId }
}

/* ---------- Lên lịch (route) ---------- */

describe('POST /posts/:id/targets/transition — lên lịch', () => {
  it('3 trang, Thứ Bảy 19:00 giờ VN → 3 target scheduled lúc 12:00Z, schedule_version 1, 3 job startAfter', async () => {
    clockNow = new Date('2026-10-24T03:00:00.000Z')
    const [fb, ig, th] = [await page('facebook', FB), await page('instagram', IG), await page('threads', TH)]
    const post = await createPost([
      { pageId: fb, caption: 'FB' },
      { pageId: ig, caption: 'IG', mediaIds: [await image('a')] },
      { pageId: th, caption: 'TH' },
    ])
    const at = '2026-10-31T12:00:00.000Z' // Thứ Bảy 31/10/2026 19:00 (UTC+7)
    const done = await scheduleOk(post, at)
    expect(done.targets.map((t) => [t.status, t.scheduledAt])).toEqual(Array(3).fill(['scheduled', at]))
    expect(done.targets.every((t, i) => t.version === post.targets[i]!.version + 1)).toBe(true)
    for (const t of done.targets) expect((await rowOf(t.id)).schedule_version).toBe(1)
    const rows = await jobRows()
    expect(rows.map((r) => r.data).sort((a, b) => a.targetId.localeCompare(b.targetId))).toEqual(
      done.targets.map((t) => ({ targetId: t.id, scheduleVersion: 1 })).sort((a, b) => a.targetId.localeCompare(b.targetId)),
    )
    expect(rows.every((r) => r.start_after.toISOString() === at)).toBe(true)
    expect(graph.calls).toHaveLength(0) // không gọi Meta trong request
  })

  it('đăng ngay (scheduledAt null) → scheduled_at = bây giờ của máy chủ, job chạy ngay', async () => {
    clockNow = new Date(Date.now() - 1000)
    const pageId = await page('facebook', FB)
    const done = await scheduleOk(await createPost([{ pageId, caption: 'Ngay' }]), null)
    expect(done.targets[0]!.scheduledAt).toBe(clockNow.toISOString())
    const [job] = await jobRows()
    expect(job!.start_after.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('một trang vi phạm (IG không ảnh) → 422 MEDIA_REQUIRED + pageId; không target nào đổi, không job', async () => {
    const [fb, ig] = [await page('facebook', FB), await page('instagram', IG)]
    const post = await createPost([{ pageId: fb, caption: 'FB' }, { pageId: ig, caption: 'IG chưa ảnh' }])
    const res = await transition(post.id, { action: 'schedule', scheduledAt: null, targets: refs(post) })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res)).toMatchObject({ code: 'MEDIA_REQUIRED', details: { pageId: ig } })
    for (const t of post.targets) expect((await rowOf(t.id)).status).toBe('draft')
    expect(await jobRows()).toHaveLength(0)
  })

  it('giờ đã qua 422; quá một năm 400; version cũ 409; retry trên nháp 409; target bài khác 404; body sai 400 — không đổi gì', async () => {
    clockNow = new Date('2026-10-24T03:00:00.000Z')
    const pageId = await page('facebook', FB)
    const post = await createPost([{ pageId, caption: 'FB' }])
    const other = await createPost([{ pageId, caption: 'Bài khác' }])
    const t = post.targets[0]!
    const cases: [unknown, number, string][] = [
      [{ action: 'schedule', scheduledAt: '2026-10-24T02:59:00.000Z', targets: refs(post) }, 422, 'SCHEDULE_IN_PAST'],
      [{ action: 'schedule', scheduledAt: '2027-12-01T00:00:00.000Z', targets: refs(post) }, 400, 'VALIDATION_FAILED'],
      [{ action: 'schedule', scheduledAt: null, targets: [{ id: t.id, version: t.version + 5 }] }, 409, 'VERSION_CONFLICT'],
      [{ action: 'retry', scheduledAt: null, targets: refs(post) }, 409, 'VERSION_CONFLICT'],
      [{ action: 'unschedule', targets: refs(post) }, 409, 'VERSION_CONFLICT'],
      [{ action: 'schedule', scheduledAt: null, targets: refs(other) }, 404, 'NOT_FOUND'],
      [{ action: 'schedule', targets: refs(post) }, 400, 'VALIDATION_FAILED'],
      [{ action: 'unschedule', scheduledAt: null, targets: refs(post) }, 400, 'VALIDATION_FAILED'],
      [{ action: 'schedule', scheduledAt: null, targets: [...refs(post), ...refs(post)] }, 400, 'VALIDATION_FAILED'],
      [{ action: 'publish', scheduledAt: null, targets: refs(post) }, 400, 'VALIDATION_FAILED'],
    ]
    for (const [body, status, code] of cases) {
      const res = await transition(post.id, body)
      expect([res.statusCode, errorOf(res).code], JSON.stringify(body)).toEqual([status, code])
    }
    expect((await rowOf(t.id)).status).toBe('draft')
    expect(await jobRows()).toHaveLength(0)
  })

  it('giới hạn đăng/24h: trang IG có 99 bài trong ±24h (+1 ngoài cửa sổ) → được; đủ 100 → 422 PUBLISH_LIMIT_REACHED', async () => {
    clockNow = new Date('2026-10-24T03:00:00.000Z')
    const ig = await page('instagram', IG)
    const at = new Date('2026-10-25T12:00:00.000Z')
    const seed = async (n: number, from: Date, status = 'scheduled') => {
      await handle.sql`
        with p as (insert into posts (source) select 'manual' from generate_series(1, ${n}) returning id)
        insert into post_targets (post_id, page_id, position, status, scheduled_at, published_at)
        select id, ${ig}, 0, ${status}, ${from.toISOString()}::timestamptz, ${status === 'published' ? from.toISOString() : null}::timestamptz from p`
    }
    await seed(98, new Date(at.getTime() - 23 * HOUR))
    await seed(1, new Date(at.getTime() - 2 * HOUR), 'published')
    await seed(5, new Date(at.getTime() + DAY)) // đúng biên t+24h: không tính
    await seed(5, new Date(at.getTime() - 3 * HOUR), 'draft') // nháp không tính
    const first = await createPost([{ pageId: ig, caption: 'IG', mediaIds: [await image('a')] }])
    await scheduleOk(first, at.toISOString())
    const second = await createPost([{ pageId: ig, caption: 'IG 2', mediaIds: [await image('b')] }])
    const res = await transition(second.id, { action: 'schedule', scheduledAt: at.toISOString(), targets: refs(second) })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res)).toMatchObject({ code: 'PUBLISH_LIMIT_REACHED', details: { pageId: ig, limit: 100 } })
  })

  it('401 khi chưa đăng nhập', async () => {
    const pageId = await page('facebook', FB)
    const post = await createPost([{ pageId, caption: 'x' }])
    const res = await transition(post.id, { action: 'schedule', scheduledAt: null, targets: refs(post) }, { auth: false })
    expect(res.statusCode).toBe(401)
  })
})

/* ---------- Bỏ lịch / đổi giờ ---------- */

describe('bỏ lịch / đổi giờ an toàn với job cũ', () => {
  it('bỏ lịch → draft, scheduled_at null, schedule_version +1; job cũ chạy tới → bỏ qua, không gọi Meta; sửa nháp lại được', async () => {
    const pageId = await page('facebook', FB)
    const post = await scheduleOk(await createPost([{ pageId, caption: 'FB' }]), new Date(Date.now() + HOUR).toISOString())
    const t = post.targets[0]!
    const res = await transition(post.id, { action: 'unschedule', targets: refs(post) })
    expect(res.statusCode, res.body).toBe(200)
    expect(PostDto.parse(res.json()).targets[0]).toMatchObject({ status: 'draft', scheduledAt: null })
    expect((await rowOf(t.id)).schedule_version).toBe(2)
    expect(await run(t.id, { version: 1 })).toBe('skipped')
    expect(graph.calls).toHaveLength(0)
    const put = await app.inject({ method: 'PUT', url: `/api/v1/posts/${post.id}`, headers: headers(), payload: JSON.stringify({ targets: [{ pageId, caption: 'Sửa lại', mediaIds: [] }] }) })
    expect(put.statusCode, put.body).toBe(200)
  })

  it('đổi giờ → giờ mới + job mới (schedule_version 2); job cũ bỏ qua; target đang publishing → 409', async () => {
    const pageId = await page('facebook', FB)
    const post = await scheduleOk(await createPost([{ pageId, caption: 'FB' }]), new Date(Date.now() + HOUR).toISOString())
    const at = new Date(Date.now() + 2 * HOUR).toISOString()
    const res = await transition(post.id, { action: 'reschedule', scheduledAt: at, targets: refs(post) })
    expect(res.statusCode, res.body).toBe(200)
    const t = PostDto.parse(res.json()).targets[0]!
    expect(t.scheduledAt).toBe(at)
    expect((await jobRows()).map((j) => j.data.scheduleVersion)).toEqual([1, 2])
    expect(await run(t.id, { version: 1 })).toBe('skipped')
    expect(graph.calls).toHaveLength(0)

    await handle.sql`update post_targets set status = 'publishing', publishing_at = now() where id = ${t.id}`
    const busy = await transition(post.id, { action: 'unschedule', targets: [{ id: t.id, version: t.version }] })
    expect([busy.statusCode, errorOf(busy).code]).toEqual([409, 'VERSION_CONFLICT'])
  })
})

/* ---------- Job: điều kiện trước khi gọi Meta ---------- */

describe('job publish.target — trước khi gọi Meta', () => {
  it('target published / đã xoá / chạy lần hai → bỏ qua, không gọi Meta', async () => {
    const { targetId, post } = await scheduledFacebook()
    graph.on('POST', `/${FB}/feed`, ok({ id: `${FB}_1` }))
    expect(await run(targetId)).toBe('published')
    expect(await run(targetId, { version: 1 })).toBe('skipped')
    await handle.sql`delete from posts where id = ${post.id}`
    expect(await run(targetId, { version: 1 })).toBe('skipped')
    expect(posts(graph)).toHaveLength(1)
    expect(emittedOf('post_target.published')).toHaveLength(1)
  })

  it('trang đã gỡ → PAGE_REMOVED; mất kết nối → PAGE_DISCONNECTED; expiring → vẫn đăng; sự kiện failed một lần', async () => {
    const { targetId, pageId } = await scheduledFacebook()
    await handle.sql`update pages set removed_at = now() where id = ${pageId}`
    expect(await run(targetId)).toBe('failed')
    expect(await rowOf(targetId)).toMatchObject({ status: 'failed', error_code: 'PAGE_REMOVED' })
    expect(await run(targetId, { version: 1 })).toBe('skipped')
    expect(emittedOf('post_target.failed')).toEqual([expect.objectContaining({ id: targetId, pageId, errorCode: 'PAGE_REMOVED', campaignId: null })])

    await handle.sql`delete from posts`
    await handle.sql`delete from page_credentials`
    await handle.sql`delete from pages`
    const off = await page('facebook', '9002', 'disconnected')
    const p2 = await scheduleOk(await createPost([{ pageId: off, caption: 'x' }]))
    expect(await run(p2.targets[0]!.id)).toBe('failed')
    expect((await rowOf(p2.targets[0]!.id)).error_code).toBe('PAGE_DISCONNECTED')

    const soon = await page('facebook', '9003', 'expiring')
    graph.on('POST', '/9003/feed', ok({ id: '9003_5' }))
    const p3 = await scheduleOk(await createPost([{ pageId: soon, caption: 'y' }]))
    expect(await run(p3.targets[0]!.id)).toBe('published')
    expect(posts(graph)).toHaveLength(1)
  })
})

/* ---------- Job: đăng theo nền tảng ---------- */

describe('job publish.target — đăng theo nền tảng', () => {
  it('FB có ảnh: /photos {url, message} hạng publish → post_id chuẩn hoá, published_at, sự kiện, permalink', async () => {
    const pageId = await page('facebook', FB)
    const post = await scheduleOk(await createPost([{ pageId, caption: 'Có ảnh', mediaIds: [await image('fb', 3000, 4000)] }]))
    const id = post.targets[0]!.id
    graph.on('POST', `/${FB}/photos`, ok({ id: 'photo1', post_id: `${FB}_777` }))
    graph.on('GET', `/${FB}_777`, ok({ permalink_url: 'https://www.facebook.com/p/777' }))
    expect(await run(id)).toBe('published')
    const [call] = posts(graph)
    expect(call!.options.form).toEqual({ url: IMG('fb'), message: 'Có ảnh' }) // FB nhận ảnh gốc
    expect(call!.options).toMatchObject({ token: `TOKEN_${FB}`, tier: 'publish', scope: `page:${FB}` })
    expect(call!.options.signal).toBeUndefined() // bước tạo bài không bao giờ bị huỷ giữa chừng
    expect(await rowOf(id)).toMatchObject({ status: 'published', platform_post_id: `${FB}_777`, permalink: 'https://www.facebook.com/p/777', error_code: null })
    expect((await rowOf(id)).published_at).not.toBeNull()
    expect(emittedOf('post_target.published')).toEqual([expect.objectContaining({ id, pageId, campaignId: null })])
  })

  it('FB chỉ chữ: /feed {message}; permalink lỗi → vẫn published', async () => {
    const { targetId } = await scheduledFacebook('Chỉ chữ')
    graph.on('POST', `/${FB}/feed`, ok({ id: `${FB}_9` }))
    graph.on('GET', `/${FB}_9`, { ok: false, kind: 'TRANSIENT', status: 500 })
    expect(await run(targetId)).toBe('published')
    expect(posts(graph)[0]!.options.form).toEqual({ message: 'Chỉ chữ' })
    expect(await rowOf(targetId)).toMatchObject({ status: 'published', platform_post_id: `${FB}_9`, permalink: null })
  })

  it('IG ảnh 3:4 4032px: container image_url đệm trắng khung 4:5 rộng 1440, hỏi tới FINISHED, media_publish → id media', async () => {
    const ig = await page('instagram', IG)
    const post = await scheduleOk(await createPost([{ pageId: ig, caption: 'IG #sale', mediaIds: [await image('ig', 3024, 4032)] }]))
    const id = post.targets[0]!.id
    graph.on('POST', `/${IG}/media`, ok({ id: 'c1' }))
    graph.onSequence('GET', '/c1', [ok({ status_code: 'IN_PROGRESS' }), ok({ status_code: 'FINISHED' })])
    graph.on('POST', `/${IG}/media_publish`, ok({ id: 'igm1' }))
    graph.on('GET', '/igm1', ok({ permalink: 'https://www.instagram.com/p/abc/' }))
    expect(await run(id)).toBe('published')
    const [create, publish] = posts(graph)
    expect(create!.options.form).toEqual({
      image_url: 'https://res.cloudinary.com/demo/image/upload/c_pad,w_1440,h_1800,b_white/v1/ottm/public/ig.jpg',
      caption: 'IG #sale',
    })
    expect(publish!.options.form).toEqual({ creation_id: 'c1' })
    expect(graph.calls.filter((c) => c.path === '/c1')).toHaveLength(2)
    expect(await rowOf(id)).toMatchObject({ status: 'published', platform_post_id: 'igm1', permalink: 'https://www.instagram.com/p/abc/' })
  })

  it('IG container ERROR → PUBLISH_REJECTED, không publish', async () => {
    const ig = await page('instagram', IG)
    const post = await scheduleOk(await createPost([{ pageId: ig, caption: 'IG', mediaIds: [await image('x')] }]))
    graph.on('POST', `/${IG}/media`, ok({ id: 'c2' }))
    graph.on('GET', '/c2', ok({ status_code: 'ERROR' }))
    expect(await run(post.targets[0]!.id)).toBe('failed')
    expect((await rowOf(post.targets[0]!.id)).error_code).toBe('PUBLISH_REJECTED')
    expect(posts(graph, `/${IG}/media_publish`)).toHaveLength(0)
  })

  it('Threads chỉ chữ: container TEXT → threads_publish; có ảnh: IMAGE (rộng ≤1440, không đệm)', async () => {
    const th = await page('threads', TH)
    const post = await scheduleOk(await createPost([{ pageId: th, caption: 'Chào Threads' }]))
    threads.on('POST', '/me/threads', ok({ id: 'tc1' }))
    threads.on('GET', '/tc1', ok({ status: 'FINISHED' }))
    threads.on('POST', '/me/threads_publish', ok({ id: 'thm1' }))
    expect(await run(post.targets[0]!.id)).toBe('published')
    expect(posts(threads, '/me/threads')[0]!.options).toMatchObject({ form: { media_type: 'TEXT', text: 'Chào Threads' }, scope: `threads:${th}` })
    expect((await rowOf(post.targets[0]!.id)).platform_post_id).toBe('thm1')

    const withImg = await scheduleOk(await createPost([{ pageId: th, caption: 'Ảnh', mediaIds: [await image('th', 2000, 3000)] }]))
    expect(await run(withImg.targets[0]!.id)).toBe('published')
    expect(posts(threads, '/me/threads')[1]!.options.form).toEqual({
      media_type: 'IMAGE',
      image_url: 'https://res.cloudinary.com/demo/image/upload/c_limit,w_1440/v1/ottm/public/th.jpg',
      text: 'Ảnh',
    })
  })

  it('hạn mức đăng Meta đã hết → PUBLISH_LIMIT_REACHED, không tạo container; hỏi hạn mức lỗi → vẫn đăng', async () => {
    const ig = await page('instagram', IG)
    const a = await scheduleOk(await createPost([{ pageId: ig, caption: 'A', mediaIds: [await image('a')] }]))
    graph.on('GET', `/${IG}/content_publishing_limit`, ok({ data: [{ quota_usage: 100, config: { quota_total: 100, quota_duration: 86400 } }] }))
    expect(await run(a.targets[0]!.id)).toBe('failed')
    expect((await rowOf(a.targets[0]!.id)).error_code).toBe('PUBLISH_LIMIT_REACHED')
    expect(posts(graph)).toHaveLength(0)

    const b = await scheduleOk(await createPost([{ pageId: ig, caption: 'B', mediaIds: [await image('b')] }]))
    graph.on('GET', `/${IG}/content_publishing_limit`, { ok: false, kind: 'TRANSIENT', status: 500 })
    graph.on('POST', `/${IG}/media`, ok({ id: 'c3' }))
    graph.on('GET', '/c3', ok({ status_code: 'FINISHED' }))
    graph.on('POST', `/${IG}/media_publish`, ok({ id: 'igm3' }))
    expect(await run(b.targets[0]!.id)).toBe('published')
  })
})

/* ---------- Job: lỗi ---------- */

describe('job publish.target — ánh xạ lỗi và chống đăng trùng', () => {
  it('lỗi dứt khoát: REJECTED → PUBLISH_REJECTED; PERMISSION_DENIED → PAGE_DISCONNECTED; TOKEN_INVALID → PAGE_DISCONNECTED + trang disconnected', async () => {
    const cases: [MetaResult, string][] = [
      [{ ok: false, kind: 'REJECTED', code: 100, status: 400 }, 'PUBLISH_REJECTED'],
      [{ ok: false, kind: 'PERMISSION_DENIED', code: 10, status: 403 }, 'PAGE_DISCONNECTED'],
      [{ ok: false, kind: 'TOKEN_INVALID', code: 190, status: 400 }, 'PAGE_DISCONNECTED'],
    ]
    for (const [result, code] of cases) {
      await handle.sql`delete from posts`
      await handle.sql`delete from page_credentials`
      await handle.sql`delete from pages`
      emitted.length = 0
      const { targetId, pageId } = await scheduledFacebook()
      graph.on('POST', `/${FB}/feed`, result)
      expect(await run(targetId), code).toBe('failed')
      expect((await rowOf(targetId)).error_code).toBe(code)
      expect(emittedOf('post_target.failed')).toHaveLength(1)
      const [p] = await handle.sql<{ connection_status: string }[]>`select connection_status from pages where id = ${pageId}`
      expect(p!.connection_status).toBe(result.ok === false && result.kind === 'TOKEN_INVALID' ? 'disconnected' : 'active')
    }
  })

  it('lỗi tạm ở bước container (5xx) → trả scheduled giữ schedule_version rồi ném; lần cuối → PUBLISH_FAILED', async () => {
    const ig = await page('instagram', IG)
    const post = await scheduleOk(await createPost([{ pageId: ig, caption: 'IG', mediaIds: [await image('a')] }]))
    const id = post.targets[0]!.id
    graph.on('POST', `/${IG}/media`, { ok: false, kind: 'TRANSIENT', status: 503 })
    await expect(run(id)).rejects.toBeInstanceOf(PublishRetryableError)
    expect(await rowOf(id)).toMatchObject({ status: 'scheduled', schedule_version: 1, error_code: null })
    expect(await run(id, { finalAttempt: true })).toBe('failed')
    expect((await rowOf(id)).error_code).toBe('PUBLISH_FAILED')
    expect(posts(graph, `/${IG}/media_publish`)).toHaveLength(0)
  })

  it('container chưa xong sau số lần hỏi tối đa → retry (tạo container mới lần sau)', async () => {
    const ig = await page('instagram', IG)
    const post = await scheduleOk(await createPost([{ pageId: ig, caption: 'IG', mediaIds: [await image('a')] }]))
    graph.on('POST', `/${IG}/media`, ok({ id: 'slow' }))
    graph.on('GET', '/slow', ok({ status_code: 'IN_PROGRESS' }))
    await expect(run(post.targets[0]!.id)).rejects.toBeInstanceOf(PublishRetryableError)
    expect(graph.calls.filter((c) => c.path === '/slow')).toHaveLength(3)
    expect((await rowOf(post.targets[0]!.id)).status).toBe('scheduled')
  })

  it('FB lỗi chắc chắn chưa gửi (notSent) → retry; FB hết giờ / 5xx sau khi gửi → PUBLISH_UNKNOWN, không retry, không gọi lần hai', async () => {
    const { targetId } = await scheduledFacebook()
    graph.on('POST', `/${FB}/feed`, { ok: false, kind: 'TRANSIENT', notSent: true })
    await expect(run(targetId)).rejects.toBeInstanceOf(PublishRetryableError)
    expect((await rowOf(targetId)).status).toBe('scheduled')

    graph.on('POST', `/${FB}/feed`, { ok: false, kind: 'TRANSIENT' })
    expect(await run(targetId)).toBe('failed')
    expect((await rowOf(targetId)).error_code).toBe('PUBLISH_UNKNOWN')
    expect(await run(targetId, { version: 1 })).toBe('skipped')
    expect(posts(graph, `/${FB}/feed`)).toHaveLength(2)
    expect(emittedOf('post_target.failed')).toEqual([expect.objectContaining({ errorCode: 'PUBLISH_UNKNOWN' })])
  })

  it('IG media_publish hết giờ: container FINISHED → PUBLISH_UNKNOWN; container PUBLISHED → published (không id); publish gọi đúng một lần', async () => {
    const ig = await page('instagram', IG)
    for (const [after, expected] of [
      ['FINISHED', 'failed'],
      ['PUBLISHED', 'published'],
    ] as const) {
      graph.reset()
      const post = await scheduleOk(await createPost([{ pageId: ig, caption: after, mediaIds: [await image(after)] }]))
      graph.on('POST', `/${IG}/media`, ok({ id: `c_${after}` }))
      graph.onSequence('GET', `/c_${after}`, [ok({ status_code: 'FINISHED' }), ok({ status_code: after })])
      graph.on('POST', `/${IG}/media_publish`, { ok: false, kind: 'TRANSIENT', status: 504 })
      expect(await run(post.targets[0]!.id)).toBe(expected)
      const row = await rowOf(post.targets[0]!.id)
      if (expected === 'failed') expect(row.error_code).toBe('PUBLISH_UNKNOWN')
      else expect(row).toMatchObject({ status: 'published', platform_post_id: null })
      expect(posts(graph, `/${IG}/media_publish`)).toHaveLength(1)
      await handle.sql`delete from posts`
    }
  })

  it('RATE_LIMITED 60 giây → scheduled + job mới startAfter (không ném); trễ quá 30 phút so với giờ hẹn → PUBLISH_FAILED', async () => {
    const { targetId } = await scheduledFacebook()
    await handle.sql`delete from pgboss.job where name = 'publish.target'`
    const now = new Date(Date.now() + 1000)
    graph.on('POST', `/${FB}/feed`, { ok: false, kind: 'RATE_LIMITED', retryAfterMs: 60_000, notSent: true })
    expect(await run(targetId, { extra: { now: () => now } })).toBe('deferred')
    expect(await rowOf(targetId)).toMatchObject({ status: 'scheduled', schedule_version: 1 })
    const [job] = await jobRows()
    expect(job!.data).toEqual({ targetId, scheduleVersion: 1 })
    expect(job!.start_after.getTime()).toBe(now.getTime() + 60_000)

    const late = new Date(Date.now() + PUBLISH_RATE_DEFER_MAX_MS)
    expect(await run(targetId, { extra: { now: () => late } })).toBe('failed')
    expect((await rowOf(targetId)).error_code).toBe('PUBLISH_FAILED')
  })

  it('một trang lỗi không chặn trang khác: IG REJECTED, FB và Threads vẫn published', async () => {
    const [fb, ig, th] = [await page('facebook', FB), await page('instagram', IG), await page('threads', TH)]
    const post = await scheduleOk(
      await createPost([
        { pageId: fb, caption: 'FB' },
        { pageId: ig, caption: 'IG', mediaIds: [await image('a')] },
        { pageId: th, caption: 'TH' },
      ]),
    )
    graph.on('POST', `/${FB}/feed`, ok({ id: `${FB}_1` }))
    graph.on('POST', `/${IG}/media`, { ok: false, kind: 'REJECTED', code: 36003, status: 400 })
    threads.on('POST', '/me/threads', ok({ id: 'tc' }))
    threads.on('GET', '/tc', ok({ status: 'FINISHED' }))
    threads.on('POST', '/me/threads_publish', ok({ id: 'thm' }))
    const outcomes = []
    for (const t of post.targets) outcomes.push(await run(t.id))
    expect(outcomes).toEqual(['published', 'failed', 'published'])
    expect(emittedOf('post_target.failed')).toEqual([expect.objectContaining({ pageId: ig, errorCode: 'PUBLISH_REJECTED' })])
    expect(emittedOf('post_target.published')).toHaveLength(2)
  })

  it('handlePublishJob: lần thử cuối theo retryCount/retryLimit; data hỏng → ném', async () => {
    const { targetId } = await scheduledFacebook()
    graph.on('POST', `/${FB}/feed`, { ok: false, kind: 'TRANSIENT', notSent: true })
    expect(await handlePublishJob(deps(), { data: { targetId, scheduleVersion: 1 }, retryCount: 5, retryLimit: 5 })).toBe('failed')
    expect((await rowOf(targetId)).error_code).toBe('PUBLISH_FAILED')
    await expect(handlePublishJob(deps(), { data: { targetId }, retryCount: 0, retryLimit: 5 })).rejects.toThrow('scheduleVersion')
  })
})

/* ---------- Đăng lại ---------- */

describe('Đăng lại (failed → scheduled)', () => {
  it('retry → scheduled, error_code null, schedule_version +1, job mới; lỗi lần hai vẫn ra thông báo riêng (dedupe theo version)', async () => {
    const { post, targetId } = await scheduledFacebook()
    graph.on('POST', `/${FB}/feed`, { ok: false, kind: 'REJECTED', code: 100, status: 400 })
    expect(await run(targetId)).toBe('failed')
    const failed = (await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}`, headers: { cookie } })).json() as PostDto
    expect(failed.targets[0]).toMatchObject({ status: 'failed', errorCode: 'PUBLISH_REJECTED' })

    const at = new Date(Date.now() + HOUR).toISOString()
    const res = await transition(post.id, { action: 'retry', scheduledAt: at, targets: refs(failed) })
    expect(res.statusCode, res.body).toBe(200)
    expect(PostDto.parse(res.json()).targets[0]).toMatchObject({ status: 'scheduled', scheduledAt: at, errorCode: null })
    expect((await rowOf(targetId)).schedule_version).toBe(2)
    expect((await jobRows()).map((j) => j.data.scheduleVersion)).toEqual([1, 2])

    expect(await run(targetId)).toBe('failed')
    const keys = emitted
      .filter((e) => e.name === 'post_target.failed')
      .map((e) => dedupeKey({ event: 'post_target.failed', payload: e.payload } as unknown as EventEnvelope))
    expect(new Set(keys).size).toBe(2)
  })
})

/* ---------- Cron content.requeue ---------- */

describe('cron content.requeue', () => {
  it('scheduled quá giờ >10 phút không job → enqueue lại; còn job sống → không; publishing 16 phút → PUBLISH_UNKNOWN, 10 phút → giữ', async () => {
    const pageId = await page('facebook', FB)
    const mk = async (caption: string) => (await createPost([{ pageId, caption }])).targets[0]!.id
    const [lost, alive, stuck, busy] = [await mk('lost'), await mk('alive'), await mk('stuck'), await mk('busy')]
    const overdue = new Date(Date.now() - REQUEUE_OVERDUE_MS - MIN).toISOString()
    await handle.sql`update post_targets set status = 'scheduled', scheduled_at = ${overdue}, schedule_version = 3 where id in (${lost}, ${alive})`
    await jobs.send('publish.target', { targetId: alive, scheduleVersion: 3 }, { startAfter: new Date(Date.now() + HOUR) })
    await handle.sql`update post_targets set status = 'publishing', scheduled_at = ${overdue}, publishing_at = ${new Date(Date.now() - PUBLISHING_STUCK_MS - MIN).toISOString()} where id = ${stuck}`
    await handle.sql`update post_targets set status = 'publishing', scheduled_at = ${overdue}, publishing_at = ${new Date(Date.now() - 10 * MIN).toISOString()} where id = ${busy}`

    expect(await requeueTargets({ db: handle.db, events, jobs })).toEqual({ requeued: 1, stuck: 1 })
    const data = (await jobRows()).map((j) => j.data)
    expect(data).toContainEqual({ targetId: lost, scheduleVersion: 3 })
    expect(data.filter((d) => d.targetId === alive)).toHaveLength(1)
    expect(await rowOf(stuck)).toMatchObject({ status: 'failed', error_code: 'PUBLISH_UNKNOWN' })
    expect((await rowOf(busy)).status).toBe('publishing')
    expect(emittedOf('post_target.failed')).toEqual([expect.objectContaining({ id: stuck, errorCode: 'PUBLISH_UNKNOWN' })])
    // Lần hai: job vừa enqueue còn sống → không enqueue nữa.
    expect(await requeueTargets({ db: handle.db, events, jobs })).toEqual({ requeued: 0, stuck: 0 })
  })
})

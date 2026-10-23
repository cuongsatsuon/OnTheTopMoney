// Ma trận Story 6.5 — Lịch nội dung với kéo thả (AD-13, AD-18, UX-DR10). Qua app thật (buildApp) + Postgres nhúng +
// pg-boss + Meta giả (job chỉ để xác nhận bỏ qua, không gọi mạng). Phủ: `GET /calendar` (khoảng, phạm vi, cờ `ai`, bỏ
// target huỷ / nháp / trang đã gỡ), kéo thả = `reschedule` / `retry` qua route chuyển trạng thái có sẵn, xoá (`cancel`
// → `cancelled` + `cancel_reason`, sự kiện, job cũ bỏ qua), khoá giới hạn/24h theo `pageId` (không deadlock), lưu cờ
// caption AI, 401.
import { randomBytes } from 'node:crypto'
import { CalendarResponse, ErrorResponse, PostDto, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { calendarTitle, publishTarget } from '../src/modules/content/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const IMG = (name: string) => `https://res.cloudinary.com/demo/image/upload/v1/ottm/public/${name}.jpg`
/** "Bây giờ" của route: 10:00 Thứ Bảy 24/10/2026 giờ VN. */
const NOW = new Date('2026-10-24T03:00:00.000Z')
/** Thứ Bảy 31/10/2026 19:00 giờ VN. */
const SAT = '2026-10-31T12:00:00.000Z'
/** Tuần 26/10 – 01/11 theo giờ VN. */
const WEEK = { from: '2026-10-25T17:00:00.000Z', to: '2026-11-01T17:00:00.000Z' }

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance
let cookie: string
let accounts = 0

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 8 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-content-calendar', { background: false })
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
    clock: () => NOW,
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
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

async function page(platform: 'facebook' | 'instagram' | 'threads', groupId: string | null = null) {
  const accountId = String(9000 + ++accounts)
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, group_id)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, 'active', ${groupId}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${accountId}`)})`
  return p!.id
}

async function image(name: string, source: 'upload' | 'ai' = 'upload'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into media_assets (source, status, public_id, url, width, height, bytes, format)
    values (${source}, 'ready', ${'ottm/public/' + name}, ${IMG(name)}, 1080, 1080, 1000, 'jpg') returning id`
  return row!.id
}

const headers = () => ({ origin: ORIGIN, cookie, 'content-type': 'application/json' })

async function createPost(targets: { pageId: string; caption: string; mediaIds?: string[]; aiCaption?: boolean }[]): Promise<PostDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: headers(),
    payload: JSON.stringify({ topic: 'Khuyến mãi', targets: targets.map((t) => ({ mediaIds: [], ...t })) }),
  })
  expect(res.statusCode, res.body).toBe(201)
  return PostDto.parse(res.json())
}

function transition(postId: string, body: unknown) {
  return app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/targets/transition`, headers: headers(), payload: JSON.stringify(body) })
}

const refs = (post: PostDto) => post.targets.map((t) => ({ id: t.id, version: t.version }))

async function act(post: PostDto, body: Record<string, unknown>): Promise<PostDto> {
  const res = await transition(post.id, { targets: refs(post), ...body })
  expect(res.statusCode, res.body).toBe(200)
  return PostDto.parse(res.json())
}

const schedule = (post: PostDto, scheduledAt: string | null = SAT) => act(post, { action: 'schedule', scheduledAt })

function calendar(query: Record<string, string>, opts: { auth?: boolean } = {}) {
  const h: Record<string, string> = { origin: ORIGIN }
  if (opts.auth !== false) h.cookie = cookie
  return app.inject({ method: 'GET', url: `/api/v1/calendar?${new URLSearchParams(query)}`, headers: h })
}

async function calendarOk(query: Record<string, string> = WEEK): Promise<CalendarResponse> {
  const res = await calendar(query)
  expect(res.statusCode, res.body).toBe(200)
  return CalendarResponse.parse(res.json())
}

const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error

const rowOf = async (id: string) => {
  const row = (await handle.sql<{ status: string; cancel_reason: string | null; error_code: string | null; schedule_version: number; version: number; scheduled_at: string | null }[]>`
    select status, cancel_reason, error_code, schedule_version, version, scheduled_at from post_targets where id = ${id}`)[0]!
  return { ...row, scheduled_at: row.scheduled_at === null ? null : new Date(row.scheduled_at).toISOString() }
}

const jobVersions = async (targetId: string) =>
  (await handle.sql<{ v: number }[]>`select (data->>'scheduleVersion')::int as v from pgboss.job where name = 'publish.target' and data->>'targetId' = ${targetId} order by created_on`).map((r) => r.v)

/** Job cũ của target chạy tới (Meta giả: gọi là lỗi test). */
const runJob = (targetId: string, scheduleVersion: number) =>
  publishTarget(
    { db: handle.db, events, jobs, cipher, graph: createFakeMetaClient(), threads: createFakeMetaClient('https://graph.threads.com/v1.0'), sleep: async () => {} },
    { targetId, scheduleVersion },
    { finalAttempt: false },
  )

/** Bài 3 trang FB (caption AI) / IG (ảnh AI) / Threads (tay) đã lên lịch Thứ Bảy 19:00. */
async function threePagePost() {
  const [fb, ig, th] = [await page('facebook'), await page('instagram'), await page('threads')]
  const post = await schedule(
    await createPost([
      { pageId: fb, caption: '  Ưu đãi\n\ncuối tuần  ', aiCaption: true },
      { pageId: ig, caption: 'IG', mediaIds: [await image('ai-1', 'ai')] },
      { pageId: th, caption: '', mediaIds: [await image('tay')] },
    ]),
  )
  return { post, fb, ig, th }
}

/* ---------- Đọc lịch ---------- */

describe('GET /calendar', () => {
  it('trả target theo scheduled_at với trạng thái, version, cờ ai; bỏ target ngoài khoảng / huỷ / nháp', async () => {
    const { post, fb, ig, th } = await threePagePost()
    const later = await schedule(await createPost([{ pageId: fb, caption: 'Tuần sau' }]), '2026-11-02T01:00:00.000Z')
    const gone = await schedule(await createPost([{ pageId: fb, caption: 'Xoá' }]), SAT)
    await act(gone, { action: 'cancel' })
    await createPost([{ pageId: fb, caption: 'Nháp' }])

    const { items, truncated } = await calendarOk()
    expect(truncated).toBe(false)
    // Cùng giờ → theo id (uuidv7 theo thứ tự tạo).
    expect(items.map((i) => [i.pageId, i.status, i.scheduledAt, i.ai])).toEqual([
      [fb, 'scheduled', SAT, true],
      [ig, 'scheduled', SAT, true],
      [th, 'scheduled', SAT, false],
    ])
    expect(items.map((i) => i.id).sort()).toEqual(post.targets.map((t) => t.id).sort())
    const byPage = new Map(items.map((i) => [i.pageId, i]))
    expect(byPage.get(fb)).toMatchObject({ postId: post.id, version: post.targets[0]!.version, title: 'Ưu đãi cuối tuần', thumbnailUrl: null, source: 'manual', campaignId: null, errorCode: null })
    expect(byPage.get(ig)!.thumbnailUrl).toBe(IMG('ai-1'))
    expect(byPage.get(th)).toMatchObject({ title: null, thumbnailUrl: IMG('tay') })
    expect(items.some((i) => i.postId === later.id || i.postId === gone.id)).toBe(false)
    // Khoảng tiếp theo thấy bài tuần sau.
    expect((await calendarOk({ from: WEEK.to, to: new Date(Date.parse(WEEK.to) + 7 * DAY).toISOString() })).items.map((i) => i.postId)).toEqual([later.id])
  })

  it('phạm vi: page:<IG> trả cả 3 target của bài có IG, không trả bài chỉ ở trang khác; trang đã gỡ không hiện; nhóm lạ 404; scope sai 400', async () => {
    const { post, ig, th } = await threePagePost()
    const otherFb = await page('facebook')
    await schedule(await createPost([{ pageId: otherFb, caption: 'Chỉ FB khác' }]))
    const scoped = await calendarOk({ ...WEEK, scope: `page:${ig}` })
    expect(scoped.items.map((i) => i.postId)).toEqual([post.id, post.id, post.id])
    expect((await calendarOk()).items).toHaveLength(4)

    await handle.sql`update pages set removed_at = now() where id = ${th}`
    expect((await calendarOk({ ...WEEK, scope: `page:${ig}` })).items.map((i) => i.pageId)).not.toContain(th)

    const missing = await calendar({ ...WEEK, scope: 'group:0199c0de-0000-7000-8000-000000000000' })
    expect([missing.statusCode, errorOf(missing).code]).toEqual([404, 'NOT_FOUND'])
    const bad = await calendar({ ...WEEK, scope: 'page:abc' })
    expect([bad.statusCode, errorOf(bad).code]).toEqual([400, 'VALIDATION_FAILED'])
  })

  it('khoảng sai (from ≥ to, > 43 ngày, thiếu from, không phải ISO) → 400; chưa đăng nhập → 401', async () => {
    const cases: Record<string, string>[] = [
      { from: WEEK.to, to: WEEK.from },
      { from: WEEK.from, to: WEEK.from },
      { from: WEEK.from, to: new Date(Date.parse(WEEK.from) + 44 * DAY).toISOString() },
      { to: WEEK.to },
      { from: '2026-10-26', to: WEEK.to },
    ]
    for (const q of cases) {
      const res = await calendar(q)
      expect([res.statusCode, errorOf(res).code], JSON.stringify(q)).toEqual([400, 'VALIDATION_FAILED'])
    }
    expect((await calendar({ from: WEEK.from, to: new Date(Date.parse(WEEK.from) + 42 * DAY).toISOString() })).statusCode).toBe(200)
    expect((await calendar(WEEK, { auth: false })).statusCode).toBe(401)
  })

  it('tiêu đề: gộp khoảng trắng, cắt 120 code point', () => {
    expect(calendarTitle('  a \n\n b ')).toBe('a b')
    expect(calendarTitle(' \n ')).toBeNull()
    const long = calendarTitle('😍'.repeat(200))!
    expect([...long]).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
  })
})

/* ---------- Kéo thả = route chuyển trạng thái có sẵn ---------- */

describe('kéo thả trên lịch', () => {
  it('kéo bài đã lên lịch sang ngày khác (reschedule) → scheduled_at đổi, schedule_version +1, job mới; job cũ bỏ qua; lịch thấy giờ mới', async () => {
    const { post } = await threePagePost()
    const sun = '2026-11-01T12:00:00.000Z'
    const moved = await act(post, { action: 'reschedule', scheduledAt: sun })
    for (const t of moved.targets) {
      expect(await rowOf(t.id)).toMatchObject({ status: 'scheduled', schedule_version: 2, scheduled_at: sun })
      expect(await jobVersions(t.id)).toEqual([1, 2])
      expect(await runJob(t.id, 1)).toBe('skipped')
    }
    const { items } = await calendarOk()
    expect(items.every((i) => i.scheduledAt === sun)).toBe(true)
    expect(items.map((i) => i.version).sort()).toEqual(moved.targets.map((t) => t.version).sort())
  })

  it('kéo bài lỗi sang ngày mai (retry giờ mới) → scheduled, error_code null; bài đã đăng không đổi lịch được (409)', async () => {
    const fb = await page('facebook')
    const post = await schedule(await createPost([{ pageId: fb, caption: 'Lỗi' }]))
    const t = post.targets[0]!
    await handle.sql`update post_targets set status = 'failed', error_code = 'PAGE_DISCONNECTED', version = version + 1 where id = ${t.id}`
    const failed = (await calendarOk()).items[0]!
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'PAGE_DISCONNECTED' })
    const at = '2026-10-25T12:00:00.000Z'
    const res = await transition(post.id, { action: 'retry', scheduledAt: at, targets: [{ id: t.id, version: failed.version }] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await rowOf(t.id)).toMatchObject({ status: 'scheduled', error_code: null, scheduled_at: at })

    await handle.sql`update post_targets set status = 'published', published_at = now(), version = version + 1 where id = ${t.id}`
    const v = (await rowOf(t.id)).version
    const moved = await transition(post.id, { action: 'reschedule', scheduledAt: SAT, targets: [{ id: t.id, version: v }] })
    expect([moved.statusCode, errorOf(moved).code]).toEqual([409, 'VERSION_CONFLICT'])
  })
})

/* ---------- Xoá ---------- */

describe('xoá bài chưa đăng (cancel)', () => {
  it('scheduled → cancelled + USER_DELETED, schedule_version +1, sự kiện post_target.cancelled một lần; job cũ bỏ qua; biến khỏi lịch', async () => {
    const { post, fb, ig, th } = await threePagePost()
    const done = await act(post, { action: 'cancel' })
    expect(done.targets.map((t) => t.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    for (const t of done.targets) {
      expect(await rowOf(t.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'USER_DELETED', error_code: null, schedule_version: 2 })
      expect(await runJob(t.id, 1)).toBe('skipped')
    }
    const cancelled = emitted.filter((e) => e.name === 'post_target.cancelled').map((e) => e.payload)
    expect(cancelled.map((p) => p.pageId).sort()).toEqual([fb, ig, th].sort())
    expect(cancelled.every((p) => p.campaignId === null && typeof p.version === 'number')).toBe(true)
    expect((await calendarOk()).items).toHaveLength(0)
  })

  it('draft → cancelled giữ schedule_version; failed → cancelled xoá error_code', async () => {
    const fb = await page('facebook')
    const draft = await createPost([{ pageId: fb, caption: 'Nháp' }])
    await act(draft, { action: 'cancel' })
    expect(await rowOf(draft.targets[0]!.id)).toMatchObject({ status: 'cancelled', schedule_version: 0 })

    const failed = await schedule(await createPost([{ pageId: fb, caption: 'Lỗi' }]))
    const t = failed.targets[0]!
    await handle.sql`update post_targets set status = 'failed', error_code = 'PUBLISH_REJECTED', version = version + 1 where id = ${t.id}`
    const res = await transition(failed.id, { action: 'cancel', targets: [{ id: t.id, version: t.version + 1 }] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await rowOf(t.id)).toMatchObject({ status: 'cancelled', error_code: null, schedule_version: 1, cancel_reason: 'USER_DELETED' })
  })

  it('published / publishing / cancelled → 409; kèm scheduledAt → 400; không đổi gì', async () => {
    const fb = await page('facebook')
    const post = await schedule(await createPost([{ pageId: fb, caption: 'x' }]))
    const t = post.targets[0]!
    const bad = await transition(post.id, { action: 'cancel', scheduledAt: null, targets: refs(post) })
    expect([bad.statusCode, errorOf(bad).code]).toEqual([400, 'VALIDATION_FAILED'])
    for (const status of ['publishing', 'published']) {
      await handle.sql`update post_targets set status = ${status}, version = version + 1 where id = ${t.id}`
      const row = await rowOf(t.id)
      const res = await transition(post.id, { action: 'cancel', targets: [{ id: t.id, version: row.version }] })
      expect([res.statusCode, errorOf(res).code], status).toEqual([409, 'VERSION_CONFLICT'])
      expect((await rowOf(t.id)).status).toBe(status)
    }
    await handle.sql`update post_targets set status = 'cancelled', cancel_reason = 'USER_DELETED', version = version + 1 where id = ${t.id}`
    const again = await transition(post.id, { action: 'cancel', targets: [{ id: t.id, version: (await rowOf(t.id)).version }] })
    expect(again.statusCode).toBe(409)
    expect(emitted.filter((e) => e.name === 'post_target.cancelled')).toHaveLength(0)
  })
})

/* ---------- Khoá giới hạn/24h + cờ AI ---------- */

describe('khoá giới hạn/24h theo pageId', () => {
  it('hai request song song lên lịch 2 bài cùng 2 trang IG theo thứ tự body ngược nhau → cả hai 200 (không deadlock)', async () => {
    const [ig1, ig2] = [await page('instagram'), await page('instagram')]
    const media = await image('x')
    for (let round = 0; round < 5; round++) {
      const a = await createPost([
        { pageId: ig1, caption: `A${round}`, mediaIds: [media] },
        { pageId: ig2, caption: `A${round}`, mediaIds: [media] },
      ])
      const b = await createPost([
        { pageId: ig2, caption: `B${round}`, mediaIds: [media] },
        { pageId: ig1, caption: `B${round}`, mediaIds: [media] },
      ])
      const [ra, rb] = await Promise.all([
        transition(a.id, { action: 'schedule', scheduledAt: SAT, targets: refs(a) }),
        transition(b.id, { action: 'schedule', scheduledAt: SAT, targets: refs(b) }),
      ])
      expect([ra.statusCode, rb.statusCode], `${ra.body} ${rb.body}`).toEqual([200, 200])
    }
  })
})

describe('cờ caption AI', () => {
  it('lưu aiCaption true → đọc lại true; sửa nháp không gửi → false', async () => {
    const fb = await page('facebook')
    const post = await createPost([{ pageId: fb, caption: 'AI viết', aiCaption: true }])
    expect(post.targets[0]!.aiCaption).toBe(true)
    const get = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}`, headers: headers() })
    expect(PostDto.parse(get.json()).targets[0]!.aiCaption).toBe(true)
    const put = await app.inject({ method: 'PUT', url: `/api/v1/posts/${post.id}`, headers: headers(), payload: JSON.stringify({ targets: [{ pageId: fb, caption: 'Tự viết', mediaIds: [] }] }) })
    expect(put.statusCode, put.body).toBe(200)
    expect(PostDto.parse(put.json()).targets[0]!.aiCaption).toBe(false)
  })
})

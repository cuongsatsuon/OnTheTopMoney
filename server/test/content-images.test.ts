// Ma trận Story 6.3 — Sinh ảnh AI (AD-14, AD-7, AD-24). Qua app thật (buildApp) + Postgres nhúng + pg-boss + OpenAI giả +
// Cloudinary giả (không gọi mạng). Phủ: bấm sinh ảnh (4 ô `pending` + 4 job cùng transaction), body sai, chặn trước (kho /
// khoá / hạn mức), job thành công (gateway `image_generate`, JPEG sRGB không EXIF, `ai_usage`, `media_asset.created`), bị
// từ chối, lỗi tạm (retry / lần cuối), lỗi khác (hết hạn mức, kho lỗi — không retry), ô không còn chờ, huỷ job, đọc
// trạng thái (thứ tự, id lạ, ô kẹt quá 15 phút), gắn ảnh chưa xong vào nháp, cron dọn ảnh, 401.
import { randomBytes } from 'node:crypto'
import { ErrorResponse, GeneratedImagesResponse, IMAGE_PENDING_MS, PostDto, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { FAKE_PNG, createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { FAKE_JPEG, createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { buildImagePrompt, setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import {
  ImageGenerateRetryableError,
  MEDIA_GC_AFTER_MS,
  gcOrphanMedia,
  generateImageAsset,
  handleImageGenerateJob,
} from '../src/modules/content/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-IMAGES-key-aaaa1111'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-IMAGES' }
const IDEA = 'Nồi chiên không dầu trên bếp, khuyến mãi cuối tuần'
const DAY = 24 * 60 * 60_000
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
let cloud: FakeCloudinary
let media: MediaStores
let app: FastifyInstance
let cookie: string

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name).map((e) => e.payload)

async function cleanup() {
  await handle.sql`delete from posts`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from pages`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name = 'content.image.generate'`
}

function build(stores: MediaStores = media) {
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: log,
    http: { allowedOrigins: [ORIGIN] },
    events,
    jobs,
    media: stores,
    ai: { cipher, openai },
  })
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-content-images', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
})
afterAll(async () => {
  await cleanup()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  emitted.length = 0
  openai = createFakeOpenAiAdapter()
  openai.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
  cloud = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: cloud.fetch })
  app = build()
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

function generate(body: unknown, opts: { auth?: boolean; target?: FastifyInstance } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }
  if (opts.auth !== false) headers.cookie = cookie
  return (opts.target ?? app).inject({ method: 'POST', url: '/api/v1/media-assets/generate', headers, payload: JSON.stringify(body) })
}
async function generateOk(body: unknown = { prompt: IDEA }): Promise<string[]> {
  const res = await generate(body)
  expect(res.statusCode, res.body).toBe(202)
  return GeneratedImagesResponse.parse(res.json()).images.map((i) => i.id)
}
function status(ids: string, opts: { auth?: boolean } = {}) {
  return app.inject({ method: 'GET', url: `/api/v1/media-assets/generated?ids=${ids}`, headers: opts.auth === false ? {} : { cookie } })
}
const statusOk = async (ids: readonly string[]) => GeneratedImagesResponse.parse((await status(ids.join(','))).json()).images

const deps = () => ({ db: handle.db, events, cipher, openai, media, log })
const run = (id: string, finalAttempt = false, signal?: AbortSignal) => generateImageAsset(deps(), id, { finalAttempt, signal })

const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error
const counts = async () => {
  const [row] = await handle.sql<{ assets: number; jobs: number; usage: number }[]>`
    select (select count(*)::int from media_assets) as assets,
           (select count(*)::int from pgboss.job where name = 'content.image.generate') as jobs,
           (select count(*)::int from ai_usage) as usage`
  return row!
}
const rowOf = async (id: string) =>
  (await handle.sql<{ status: string; error_code: string | null; public_id: string | null; url: string | null }[]>`
    select status, error_code, public_id, url from media_assets where id = ${id}`)[0]

/** Một ô `pending` dựng thẳng trong DB (job không qua route). */
async function pendingAsset(prompt = buildImagePrompt({ description: IDEA, style: 'product' })): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into media_assets (source, status, prompt) values ('ai', 'pending', ${prompt}) returning id`
  return row!.id
}

/** Hạn mức tháng đã tiêu hết (100%). */
async function exhaustBudget() {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
  await settle({ db: handle.db, events }, { reservationId: null, month: '2026-10', feature: 'image_generate', model: 'gpt-image-2', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 }, cost: { usdMicros: 0, costVnd: 100 } })
  await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
}

/* ---------- Bấm sinh ảnh ---------- */

describe('POST /media-assets/generate', () => {
  it('202: 4 ô pending source=ai + 4 job content.image.generate; prompt có mô tả + phong cách', async () => {
    const res = await generate({ prompt: `  ${IDEA}  `, style: 'lifestyle' })
    expect(res.statusCode, res.body).toBe(202)
    const { images } = GeneratedImagesResponse.parse(res.json())
    expect(images).toHaveLength(4)
    expect(images.every((i) => i.status === 'pending' && i.errorCode === null && i.asset === null)).toBe(true)
    const rows = await handle.sql<{ id: string; source: string; status: string; prompt: string }[]>`select id, source, status, prompt from media_assets`
    expect(rows.map((r) => [r.source, r.status])).toEqual(Array(4).fill(['ai', 'pending']))
    expect(rows[0]!.prompt).toBe(buildImagePrompt({ description: IDEA, style: 'lifestyle' }))
    expect(rows[0]!.prompt).toContain(IDEA)
    expect(rows[0]!.prompt).toContain('phong cách sống')
    const jobRows = await handle.sql<{ data: { mediaAssetId: string } }[]>`select data from pgboss.job where name = 'content.image.generate'`
    expect(jobRows.map((j) => j.data.mediaAssetId).sort()).toEqual(images.map((i) => i.id).sort())
    expect(openai.imageRequests).toHaveLength(0) // route không gọi OpenAI
  })

  it('body sai → 400 VALIDATION_FAILED + path; không ghi, không enqueue', async () => {
    for (const [body, path] of [
      [{ prompt: '   ' }, 'prompt'],
      [{ prompt: 'x'.repeat(1001) }, 'prompt'],
      [{ prompt: IDEA, style: 'anime' }, 'style'],
      [{ prompt: IDEA, n: 8 }, ''],
    ] as const) {
      const res = await generate(body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(errorOf(res).code).toBe('VALIDATION_FAILED')
      if (path) expect((errorOf(res).details as { path: string[] }[]).map((d) => d.path.join('.'))).toContain(path)
    }
    expect(await counts()).toMatchObject({ assets: 0, jobs: 0 })
  })

  it('chặn trước: kho chưa cấu hình 500, thiếu khoá 400 OPENAI_KEY_MISSING, hết hạn mức 402 — không ghi, không gọi OpenAI', async () => {
    const noMedia = build(createMediaStores({ CLOUDINARY_FOLDER: 'ottm-test' }))
    const res1 = await generate({ prompt: IDEA }, { target: noMedia })
    expect([res1.statusCode, errorOf(res1).code]).toEqual([500, 'MEDIA_NOT_CONFIGURED'])
    await noMedia.close()

    await handle.sql`delete from secrets where name = 'openai_api_key'`
    const res2 = await generate({ prompt: IDEA })
    expect([res2.statusCode, errorOf(res2).code]).toEqual([400, 'OPENAI_KEY_MISSING'])

    await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
    await exhaustBudget()
    const res3 = await generate({ prompt: IDEA })
    expect([res3.statusCode, errorOf(res3).code]).toEqual([402, 'AI_BUDGET_EXCEEDED'])

    expect(await counts()).toMatchObject({ assets: 0, jobs: 0 })
    expect(openai.imageRequests).toHaveLength(0)
  })

  it('chưa đăng nhập → 401 (tạo và đọc trạng thái)', async () => {
    expect((await generate({ prompt: IDEA }, { auth: false })).statusCode).toBe(401)
    expect((await status(newId(), { auth: false })).statusCode).toBe(401)
  })
})

/* ---------- Job ---------- */

describe('job content.image.generate', () => {
  it('thành công: gateway image_generate n=1 + ref, Cloudinary JPEG sRGB không EXIF, ô ready, 1 ai_usage, media_asset.created', async () => {
    const [id] = await generateOk({ prompt: IDEA, style: 'minimal' })
    expect(await run(id!)).toBe('ready')

    expect(openai.imageRequests).toHaveLength(1)
    expect(openai.imageRequests[0]).toMatchObject({ n: 1, prompt: buildImagePrompt({ description: IDEA, style: 'minimal' }), size: '1024x1024' })
    const upload = cloud.requests.find((r) => r.url.endsWith('/image/upload'))!
    expect(upload.params).toMatchObject({ format: 'jpg', transformation: 'a_exif,cs_srgb,fl_force_strip.strip_profile' })
    const [usage] = await handle.sql<{ feature: string; ref: string; images: number; page_id: string | null }[]>`select feature, ref, images, page_id from ai_usage`
    expect(usage).toEqual({ feature: 'image_generate', ref: id, images: 1, page_id: null })
    expect(emittedOf('media_asset.created')).toEqual([{ id }])
    expect(emittedOf('media_asset.failed')).toEqual([])

    const [img] = await statusOk([id!])
    expect(img).toMatchObject({ id, status: 'ready', errorCode: null, asset: { id, source: 'ai' } })
    expect(img!.asset!.url).toMatch(/^https:\/\/res\.cloudinary\.com\//)
  })

  it('kích thước theo Cài đặt; 1024x1536 (2:3, ngoài tỉ lệ feed IG) → sinh 1024x1024, 1536x1024 giữ nguyên', async () => {
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, imageSize: '1024x1536' })
    expect(await run(await pendingAsset())).toBe('ready')
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, imageSize: '1536x1024' })
    expect(await run(await pendingAsset())).toBe('ready')
    expect(openai.imageRequests.map((r) => r.size)).toEqual(['1024x1024', '1536x1024'])
  })

  it('OpenAI từ chối (moderation_blocked) → failed IMAGE_REJECTED + media_asset.failed, không retry', async () => {
    openai.onImage({ ok: false, kind: 'CONTENT_REJECTED', status: 400 })
    const id = await pendingAsset()
    expect(await run(id, false)).toBe('failed')
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'IMAGE_REJECTED', public_id: null })
    expect(emittedOf('media_asset.failed')).toEqual([{ id, errorCode: 'IMAGE_REJECTED' }])
    expect(openai.imageRequests).toHaveLength(1)
    expect(cloud.requests).toHaveLength(0)
  })

  it('lỗi tạm: chưa phải lần cuối → ném để retry (ô vẫn pending); lần cuối → failed IMAGE_FAILED', async () => {
    openai.onImage({ ok: false, kind: 'TRANSIENT', status: 503 })
    const id = await pendingAsset()
    await expect(run(id, false)).rejects.toBeInstanceOf(ImageGenerateRetryableError)
    expect(await rowOf(id)).toMatchObject({ status: 'pending', error_code: null })
    expect(emittedOf('media_asset.failed')).toEqual([])
    // Lần cuối qua wrapper job (retryCount = retryLimit).
    expect(await handleImageGenerateJob(deps(), { data: { mediaAssetId: id }, retryCount: 2, retryLimit: 2 })).toBe('failed')
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'IMAGE_FAILED' })
  })

  it('hết hạn mức giữa chừng → failed IMAGE_FAILED ngay (không retry, không gọi OpenAI)', async () => {
    const id = await pendingAsset()
    await exhaustBudget()
    expect(await run(id, false)).toBe('failed')
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'IMAGE_FAILED' })
    expect(openai.imageRequests).toHaveLength(0)
  })

  it('kho lỗi sau khi đã có ảnh → failed IMAGE_FAILED, không retry (OpenAI đã tính tiền)', async () => {
    const id = await pendingAsset()
    cloud.failNext(503)
    expect(await run(id, false)).toBe('failed')
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error_code: 'IMAGE_FAILED', public_id: null })
    expect(openai.imageRequests).toHaveLength(1)
    expect((await counts()).usage).toBe(1)
  })

  it('bytes trả về không phải ảnh → failed IMAGE_FAILED, không tải lên kho', async () => {
    openai.onImage({ ok: true, images: [Buffer.from('not an image')], usage: null })
    const id = await pendingAsset()
    expect(await run(id)).toBe('failed')
    expect(cloud.requests).toHaveLength(0)
  })

  it('ô không còn chờ (ready / failed / đã bị dọn) → skipped, không gọi OpenAI', async () => {
    const id = await pendingAsset()
    expect(await run(id)).toBe('ready')
    expect(await run(id)).toBe('skipped')
    const failed = await pendingAsset()
    await handle.sql`update media_assets set status = 'failed', error_code = 'IMAGE_REJECTED' where id = ${failed}`
    expect(await run(failed)).toBe('skipped')
    expect(await run(newId())).toBe('skipped')
    expect(openai.imageRequests).toHaveLength(1)
  })

  it('ô bị dọn trong lúc đang sinh → xoá file vừa tải, không phát sự kiện', async () => {
    const id = await pendingAsset()
    openai.onImage(async () => {
      await handle.sql`delete from media_assets where id = ${id}`
      return { ok: true, images: [Buffer.from(FAKE_JPEG)], usage: null }
    })
    expect(await run(id)).toBe('skipped')
    expect(cloud.assets.size).toBe(0)
    expect(emittedOf('media_asset.created')).toEqual([])
  })

  it('huỷ job (job.signal) → ném lại, ô vẫn pending, không ghi lỗi', async () => {
    const id = await pendingAsset()
    const ac = new AbortController()
    ac.abort(new Error('job expired'))
    await expect(run(id, true, ac.signal)).rejects.toThrow('job expired')
    expect(await rowOf(id)).toMatchObject({ status: 'pending', error_code: null })
    expect(emittedOf('media_asset.failed')).toEqual([])
  })
})

/* ---------- Đọc trạng thái, gắn ảnh ---------- */

describe('GET /media-assets/generated', () => {
  it('đúng thứ tự ids, bỏ id lạ; ô chờ quá 15 phút đọc ra failed IMAGE_FAILED', async () => {
    const [a, b, c] = await generateOk()
    await run(b!)
    await handle.sql`update media_assets set created_at = now() - ${`${IMAGE_PENDING_MS + 60_000} milliseconds`}::interval where id = ${c!}`
    const images = await statusOk([c!, newId(), b!, a!])
    expect(images.map((i) => [i.id, i.status, i.errorCode])).toEqual([
      [c, 'failed', 'IMAGE_FAILED'],
      [b, 'ready', null],
      [a, 'pending', null],
    ])
    expect(await rowOf(c!)).toMatchObject({ status: 'pending' }) // chỉ đọc ra lỗi, dòng không đổi
  })

  it('ids sai → 400', async () => {
    for (const q of ['', 'abc', Array.from({ length: 41 }, () => newId()).join(',')]) {
      expect((await status(q)).statusCode, q.slice(0, 20)).toBe(400)
    }
  })

  it('lưu nháp với ô pending / failed → 400 "Ảnh chưa sẵn sàng"; ô ready gắn được', async () => {
    const [p] = await handle.sql<{ id: string }[]>`
      insert into pages (platform, platform_account_id, name) values ('instagram', ${newId()}, 'Trang IG') returning id`
    const [pending, failed, ready] = await generateOk()
    await run(ready!)
    await handle.sql`update media_assets set status = 'failed', error_code = 'IMAGE_FAILED' where id = ${failed!}`
    for (const mediaId of [pending, failed]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: { cookie, origin: ORIGIN },
        payload: { topic: null, targets: [{ pageId: p!.id, caption: 'x', mediaIds: [mediaId] }] },
      })
      expect(res.statusCode).toBe(400)
      expect(errorOf(res).details).toEqual([{ path: ['targets', 0, 'mediaIds', 0], message: 'Ảnh chưa sẵn sàng' }])
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { cookie, origin: ORIGIN },
      payload: { topic: null, targets: [{ pageId: p!.id, caption: 'x', mediaIds: [ready] }] },
    })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(PostDto.parse(ok.json()).targets[0]!.media.map((m) => [m.id, m.source])).toEqual([[ready, 'ai']])
  })
})

/* ---------- Cron dọn ảnh ---------- */

describe('cron content.media_gc', () => {
  const backdate = (id: string, ms: number) => handle.sql`update media_assets set created_at = now() - ${`${ms} milliseconds`}::interval where id = ${id}`
  const upload = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/media-assets', headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' }, payload: FAKE_PNG })
    expect(res.statusCode, res.body).toBe(201)
    return (res.json() as { id: string }).id
  }
  const ids = async () => (await handle.sql<{ id: string }[]>`select id from media_assets`).map((r) => r.id).sort()

  it('xoá ảnh quá 7 ngày không gắn (dòng + file); giữ ảnh đang gắn bài và ảnh mới; ô lỗi không file chỉ xoá dòng', async () => {
    const orphan = await upload()
    const attached = await upload()
    const fresh = await upload()
    const failedOld = await pendingAsset()
    await handle.sql`update media_assets set status = 'failed', error_code = 'IMAGE_REJECTED' where id = ${failedOld}`
    for (const id of [orphan, attached, failedOld]) await backdate(id, MEDIA_GC_AFTER_MS + DAY)
    await backdate(fresh, MEDIA_GC_AFTER_MS - DAY)
    const [p] = await handle.sql<{ id: string }[]>`insert into pages (platform, platform_account_id, name) values ('facebook', ${newId()}, 'FB') returning id`
    const post = await app.inject({ method: 'POST', url: '/api/v1/posts', headers: { cookie, origin: ORIGIN }, payload: { topic: null, targets: [{ pageId: p!.id, caption: 'x', mediaIds: [attached] }] } })
    expect(post.statusCode, post.body).toBe(201)
    const [orphanFile] = await handle.sql<{ public_id: string }[]>`select public_id from media_assets where id = ${orphan}`
    const filesBefore = cloud.assets.size

    expect(await gcOrphanMedia({ db: handle.db, media, log })).toEqual({ deleted: 2, skipped: 0, fileErrors: 0 })
    expect(await ids()).toEqual([attached, fresh].sort())
    expect(cloud.requests.filter((r) => r.url.endsWith('/image/destroy')).map((r) => r.params.public_id)).toEqual([orphanFile!.public_id])
    expect(cloud.assets.size).toBe(filesBefore - 1)
    // Chạy lại: không còn gì để dọn.
    expect(await gcOrphanMedia({ db: handle.db, media, log })).toEqual({ deleted: 0, skipped: 0, fileErrors: 0 })
  })

  it('kho lỗi khi xoá file → dòng vẫn xoá, đếm lỗi; kho chưa cấu hình → chỉ xoá dòng không có file', async () => {
    const orphan = await upload()
    const fileless = await pendingAsset()
    for (const id of [orphan, fileless]) await backdate(id, MEDIA_GC_AFTER_MS + DAY)

    const noMedia = createMediaStores({ CLOUDINARY_FOLDER: 'ottm-test' })
    expect(await gcOrphanMedia({ db: handle.db, media: noMedia, log })).toEqual({ deleted: 1, skipped: 0, fileErrors: 0 })
    expect(await ids()).toEqual([orphan])

    cloud.failNext(503)
    expect(await gcOrphanMedia({ db: handle.db, media, log })).toEqual({ deleted: 1, skipped: 0, fileErrors: 1 })
    expect(await ids()).toEqual([])
  })
})

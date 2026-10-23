// Ma trận Story 6.1 — Soạn bài nháp cho nhiều trang. Qua app thật (buildApp) + Postgres nhúng + Cloudinary giả (không
// gọi mạng). Phủ: lưu nháp nhóm 3 trang (caption/ảnh riêng), đích không hợp lệ, nháp vi phạm luật vẫn lưu, đọc nháp,
// sửa nháp (bỏ/thêm trang, đổi caption/ảnh, version), sửa bài không còn nháp, tải ảnh (JPEG sRGB không EXIF), ảnh sai,
// kho chưa cấu hình / lỗi, `assertPublishable` theo bảng ràng buộc nền tảng, 401.
import { ErrorResponse, MediaAssetDto, PLATFORM_RULES, POST_IMAGE_MAX_BYTES, PostDto, type Platform } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { FAKE_JPEG, FAKE_PNG, FAKE_WEBP, createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { assertPublishable } from '../src/modules/content/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { AppError } from '../src/platform/errors/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-CONTENT' }

let handle: DbHandle
let fake: FakeCloudinary
let media: MediaStores
let app: FastifyInstance
let cookie: string

async function cleanup() {
  await handle.sql`delete from posts`
  await handle.sql`delete from media_assets`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
}

function build(stores: MediaStores = media) {
  return buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, media: stores })
}

beforeAll(() => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
})
afterAll(async () => {
  await cleanup()
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  fake = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: fake.fetch })
  app = build()
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

async function seedGroup(name = 'Nhóm Gia dụng'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-2') returning id`
  return row!.id
}
async function seedPage(platform: Platform, opts: { groupId?: string | null; removed?: boolean; status?: string } = {}): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id, connection_status, removed_at)
    values (${platform}, ${newId()}, ${`Trang ${platform}`}, ${opts.groupId ?? null}, ${opts.status ?? 'active'}, ${opts.removed ? new Date().toISOString() : null})
    returning id`
  return row!.id
}

function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

function upload(data: Buffer, mime = 'image/png', target: FastifyInstance = app) {
  return target.inject({ method: 'POST', url: '/api/v1/media-assets', headers: { cookie, origin: ORIGIN, 'content-type': mime }, payload: data })
}
async function uploadOk(data: Buffer = FAKE_PNG, mime = 'image/png'): Promise<MediaAssetDto> {
  const res = await upload(data, mime)
  expect(res.statusCode, res.body).toBe(201)
  return MediaAssetDto.parse(res.json())
}

const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error
const paths = (res: { json(): unknown }) => (errorOf(res).details as { path: (string | number)[] }[]).map((d) => d.path.join('.'))

async function createOk(body: unknown): Promise<PostDto> {
  const res = await api('POST', '/api/v1/posts', body)
  expect(res.statusCode, res.body).toBe(201)
  return PostDto.parse(res.json())
}

const counts = async () => {
  const [row] = await handle.sql<{ posts: number; targets: number }[]>`
    select (select count(*)::int from posts) as posts, (select count(*)::int from post_targets) as targets`
  return row!
}

/* ---------- Lưu nháp ---------- */

describe('POST /posts — lưu nháp cho nhiều trang', () => {
  it('nhóm 3 trang: 1 post manual + 3 target draft, caption/ảnh riêng từng trang, đúng thứ tự tab', async () => {
    const g = await seedGroup()
    const [fb, ig, th] = [await seedPage('facebook', { groupId: g }), await seedPage('instagram', { groupId: g }), await seedPage('threads', { groupId: g })]
    const a = await uploadOk(FAKE_PNG)
    const b = await uploadOk(FAKE_JPEG, 'image/jpeg')
    const post = await createOk({
      topic: '  Khuyến mãi nồi chiên 20%  ',
      targets: [
        { pageId: fb, caption: 'Bài Facebook', mediaIds: [a.id] },
        { pageId: ig, caption: 'Bài Instagram #noichien', mediaIds: [b.id] },
        { pageId: th, caption: 'Bài Threads', mediaIds: [] },
      ],
    })
    expect(post.source).toBe('manual')
    expect(post.topic).toBe('Khuyến mãi nồi chiên 20%')
    expect(post.targets.map((t) => [t.pageId, t.status, t.caption, t.media.map((m) => m.id), t.version, t.scheduledAt, t.errorCode])).toEqual([
      [fb, 'draft', 'Bài Facebook', [a.id], 0, null, null],
      [ig, 'draft', 'Bài Instagram #noichien', [b.id], 0, null, null],
      [th, 'draft', 'Bài Threads', [], 0, null, null],
    ])
    expect(await counts()).toEqual({ posts: 1, targets: 3 })
  })

  it('ý tưởng trống → topic null; trang mất kết nối vẫn lưu nháp được', async () => {
    const p = await seedPage('facebook', { status: 'disconnected' })
    const post = await createOk({ topic: '   ', targets: [{ pageId: p, caption: 'x', mediaIds: [] }] })
    expect(post.topic).toBeNull()
    expect(post.targets).toHaveLength(1)
  })

  it('nháp vi phạm luật nền tảng (Threads 600 ký tự, IG không ảnh) vẫn lưu được', async () => {
    const th = await seedPage('threads')
    const ig = await seedPage('instagram')
    const post = await createOk({ targets: [{ pageId: th, caption: 'a'.repeat(600), mediaIds: [] }, { pageId: ig, caption: 'chưa có ảnh', mediaIds: [] }] })
    expect(post.targets.map((t) => t.caption.length)).toEqual([600, 11])
  })

  it('đích không hợp lệ: trang lạ / đã gỡ / trùng, ảnh lạ, 2 ảnh, targets rỗng, khoá thừa → 400, không ghi gì', async () => {
    const ok = await seedPage('facebook')
    const removed = await seedPage('facebook', { removed: true })
    const img = await uploadOk()
    const img2 = await uploadOk(FAKE_WEBP, 'image/webp')

    let res = await api('POST', '/api/v1/posts', {
      targets: [
        { pageId: newId(), caption: '', mediaIds: [] },
        { pageId: removed, caption: '', mediaIds: [] },
        { pageId: ok, caption: '', mediaIds: [newId()] },
      ],
    })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('VALIDATION_FAILED')
    expect(paths(res)).toEqual(['targets.0.pageId', 'targets.1.pageId', 'targets.2.mediaIds.0'])

    res = await api('POST', '/api/v1/posts', { targets: [{ pageId: ok, caption: '', mediaIds: [] }, { pageId: ok, caption: '', mediaIds: [] }] })
    expect(res.statusCode).toBe(400)
    expect(paths(res)).toEqual(['targets.1.pageId'])

    res = await api('POST', '/api/v1/posts', { targets: [{ pageId: ok, caption: '', mediaIds: [img.id, img2.id] }] })
    expect(res.statusCode).toBe(400)
    expect(paths(res)).toEqual(['targets.0.mediaIds'])

    res = await api('POST', '/api/v1/posts', { targets: [] })
    expect(res.statusCode).toBe(400)

    res = await api('POST', '/api/v1/posts', { source: 'campaign', targets: [{ pageId: ok, caption: '', mediaIds: [] }] })
    expect(res.statusCode).toBe(400)

    expect(await counts()).toEqual({ posts: 0, targets: 0 })
  })
})

/* ---------- Đọc + sửa nháp ---------- */

describe('GET/PUT /posts/:id — mở lại và sửa nháp', () => {
  it('đọc nháp: target theo thứ tự tab kèm ảnh; id lạ → 404', async () => {
    const fb = await seedPage('facebook')
    const img = await uploadOk()
    const created = await createOk({ topic: 'ý', targets: [{ pageId: fb, caption: 'c', mediaIds: [img.id] }] })
    const res = await api('GET', `/api/v1/posts/${created.id}`)
    expect(res.statusCode).toBe(200)
    expect(PostDto.parse(res.json())).toEqual(created)
    const missing = await api('GET', `/api/v1/posts/${newId()}`)
    expect(missing.statusCode).toBe(404)
    expect(errorOf(missing).code).toBe('NOT_FOUND')
  })

  it('bỏ 1 trang, thêm 1 trang, đổi caption/ảnh: target bỏ bị xoá, target mới draft, target giữ version+1', async () => {
    const [fb, ig, th] = [await seedPage('facebook'), await seedPage('instagram'), await seedPage('threads')]
    const a = await uploadOk()
    const b = await uploadOk(FAKE_JPEG, 'image/jpeg')
    const created = await createOk({ topic: 'cũ', targets: [{ pageId: fb, caption: 'fb', mediaIds: [a.id] }, { pageId: ig, caption: 'ig', mediaIds: [a.id] }] })
    const igTarget = created.targets.find((t) => t.pageId === ig)!

    const res = await api('PUT', `/api/v1/posts/${created.id}`, {
      topic: 'mới',
      targets: [
        { pageId: th, caption: 'threads', mediaIds: [] },
        { pageId: ig, caption: 'ig sửa', mediaIds: [b.id] },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    const post = PostDto.parse(res.json())
    expect(post.topic).toBe('mới')
    expect(post.targets.map((t) => [t.pageId, t.caption, t.media.map((m) => m.id), t.version, t.status])).toEqual([
      [th, 'threads', [], 0, 'draft'],
      [ig, 'ig sửa', [b.id], 1, 'draft'],
    ])
    expect(post.targets[1]!.id).toBe(igTarget.id)
    expect(await counts()).toEqual({ posts: 1, targets: 2 })
    // Ảnh bỏ khỏi bài vẫn còn trong kho (cron dọn ảnh mồ côi ở Story 6.3).
    const [{ n }] = await handle.sql<{ n: number }[]>`select count(*)::int as n from media_assets`
    expect(n).toBe(2)
  })

  it('bài có target đã rời nháp → 409, không đổi gì; id lạ → 404', async () => {
    const fb = await seedPage('facebook')
    const created = await createOk({ targets: [{ pageId: fb, caption: 'giữ', mediaIds: [] }] })
    await handle.sql`update post_targets set status = 'scheduled', scheduled_at = now() + interval '1 day'`
    const res = await api('PUT', `/api/v1/posts/${created.id}`, { targets: [{ pageId: fb, caption: 'đổi', mediaIds: [] }] })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('VERSION_CONFLICT')
    const [row] = await handle.sql<{ caption: string; version: number }[]>`select caption, version from post_targets`
    expect(row).toEqual({ caption: 'giữ', version: 0 })

    const missing = await api('PUT', `/api/v1/posts/${newId()}`, { targets: [{ pageId: fb, caption: 'x', mediaIds: [] }] })
    expect(missing.statusCode).toBe(404)
  })
})

/* ---------- Tải ảnh ---------- */

describe('POST /media-assets — ảnh bài', () => {
  it.each([
    ['image/png', FAKE_PNG],
    ['image/jpeg', FAKE_JPEG],
    ['image/webp', FAKE_WEBP],
  ])('%s hợp lệ → 201, lưu JPEG sRGB không EXIF trên kho công khai', async (mime, data) => {
    const asset = await uploadOk(data, mime)
    expect(asset.source).toBe('upload')
    expect(asset.url).toMatch(/^https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/.+\.jpg$/)
    const req = fake.requests.find((r) => r.url.endsWith('/image/upload'))!
    expect(req.params).toMatchObject({ format: 'jpg', transformation: 'a_exif,cs_srgb,fl_force_strip.strip_profile' })
    expect(req.params.public_id).toMatch(/^ottm-test\/public\//)
    const [row] = await handle.sql<{ format: string; source: string }[]>`select format, source from media_assets where id = ${asset.id}`
    expect(row).toEqual({ format: 'jpg', source: 'upload' })
  })

  it('ảnh sai: SVG/text, MIME lệch magic, rỗng, quá 10MB → 400 dưới ô ảnh; gif → 415; không gọi Cloudinary', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    // gif: Fastify không có parser cho MIME này → 415, error handler vẫn trả `VALIDATION_FAILED`.
    const cases: [Buffer, string, string | null, number][] = [
      [svg, 'image/png', 'Chỉ nhận ảnh PNG, JPEG hoặc WebP', 400],
      [FAKE_PNG, 'image/jpeg', 'Định dạng ảnh không khớp', 400],
      [Buffer.alloc(0), 'image/png', null, 400],
      [Buffer.concat([FAKE_JPEG, Buffer.alloc(POST_IMAGE_MAX_BYTES + 1 - FAKE_JPEG.length)]), 'image/jpeg', 'Ảnh tối đa 10MB', 400],
      [Buffer.from('GIF89a'), 'image/gif', null, 415],
    ]
    for (const [data, mime, message, status] of cases) {
      const res = await upload(data, mime)
      expect(res.statusCode, `${mime} ${data.length}`).toBe(status)
      expect(errorOf(res).code).toBe('VALIDATION_FAILED')
      if (message) expect(errorOf(res).details).toEqual([{ path: ['image'], message }])
    }
    expect(fake.requests).toHaveLength(0)
    const [{ n }] = await handle.sql<{ n: number }[]>`select count(*)::int as n from media_assets`
    expect(n).toBe(0)
  })

  it('kho chưa cấu hình → 500 MEDIA_NOT_CONFIGURED; Cloudinary 5xx → 502 UPLOAD_FAILED', async () => {
    const bare = build(createMediaStores({ CLOUDINARY_FOLDER: 'ottm-test' }))
    const res = await upload(FAKE_PNG, 'image/png', bare)
    await bare.close()
    expect(res.statusCode).toBe(500)
    expect(errorOf(res).code).toBe('MEDIA_NOT_CONFIGURED')

    fake.failNext(503)
    const failed = await upload(FAKE_PNG)
    expect(failed.statusCode).toBe(502)
    expect(errorOf(failed).code).toBe('UPLOAD_FAILED')
  })
})

/* ---------- Luật nền tảng phía server ---------- */

describe('content.assertPublishable', () => {
  async function targetOf(platform: Platform, caption: string, withImage = false): Promise<string> {
    const page = await seedPage(platform)
    const mediaIds = withImage ? [(await uploadOk()).id] : []
    const post = await createOk({ targets: [{ pageId: page, caption, mediaIds }] })
    return post.targets[0]!.id
  }
  async function issueOf(targetId: string) {
    try {
      await assertPublishable(handle.db, targetId)
      return null
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const e = err as AppError
      expect(e.statusCode).toBe(422)
      return { code: e.code, issues: (e.details as { issues: unknown[] }).issues }
    }
  }

  it('Threads: 501 ký tự → CAPTION_TOO_LONG; đúng 500 (emoji tính theo byte UTF-8 như Meta) → được', async () => {
    expect(await issueOf(await targetOf('threads', 'a'.repeat(501)))).toEqual({
      code: 'CAPTION_TOO_LONG',
      issues: [{ code: 'CAPTION_TOO_LONG', limit: PLATFORM_RULES.threads.captionMax, actual: 501 }],
    })
    expect(await issueOf(await targetOf('threads', `${'a'.repeat(492)}🔥😍`))).toBeNull()
    expect((await issueOf(await targetOf('threads', `${'a'.repeat(498)}🔥😍`)))?.issues).toEqual([
      { code: 'CAPTION_TOO_LONG', limit: 500, actual: 506 },
    ])
  })

  it('Instagram: không ảnh → MEDIA_REQUIRED; 31 hashtag → TOO_MANY_HASHTAGS; có ảnh + 30 hashtag → được', async () => {
    expect((await issueOf(await targetOf('instagram', 'chưa có ảnh')))?.code).toBe('MEDIA_REQUIRED')
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ')
    expect(await issueOf(await targetOf('instagram', tags(31), true))).toEqual({
      code: 'TOO_MANY_HASHTAGS',
      issues: [{ code: 'TOO_MANY_HASHTAGS', limit: 30, actual: 31 }],
    })
    expect(await issueOf(await targetOf('instagram', tags(30), true))).toBeNull()
  })

  it('Facebook: trống không ảnh → POST_EMPTY; có ảnh không chữ → được; target lạ → 404', async () => {
    expect((await issueOf(await targetOf('facebook', '   ')))?.code).toBe('POST_EMPTY')
    expect(await issueOf(await targetOf('facebook', '', true))).toBeNull()
    await expect(assertPublishable(handle.db, newId())).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 })
  })
})

describe('xác thực', () => {
  it('chưa đăng nhập → 401', async () => {
    for (const [method, url] of [
      ['POST', '/api/v1/posts'],
      ['GET', `/api/v1/posts/${newId()}`],
      ['POST', '/api/v1/media-assets'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin: ORIGIN } })
      expect(res.statusCode, url).toBe(401)
    }
  })
})

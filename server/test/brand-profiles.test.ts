// Ma trận Story 3.1 — hồ sơ thương hiệu. Qua app thật (buildApp) + Postgres nhúng. Logo đi qua adapter media thật
// chạy trên Cloudinary giả (không gọi mạng). Phủ: upsert group/page, tên rỗng → details.name, tone>3 / màu>6,
// owner 404, logo magic-bytes ok/sai/SVG/>2MB, MEDIA_NOT_CONFIGURED (chữ vẫn lưu), đọc rỗng, gỡ logo, cần phiên.
import { BrandProfileDto, BrandProfileResponse, ErrorResponse, LOGO_MAX_BYTES } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createFakeCloudinary, FAKE_JPEG, FAKE_PNG, FAKE_WEBP } from '../src/adapters/media/fake.ts'
import { createMediaStores } from '../src/adapters/media/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-profiles_xyz' }

let handle: DbHandle
let app: FastifyInstance // Cloudinary cấu hình (fake)
let appNoMedia: FastifyInstance // Cloudinary chưa cấu hình
let fake: ReturnType<typeof createFakeCloudinary>
let token: string

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  const logger = createLogger({ level: 'silent' })
  fake = createFakeCloudinary(CREDS)
  const media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: fake.fetch })
  app = buildApp({ sql: handle.sql, db: handle.db, logger, http: { allowedOrigins: [ORIGIN] }, media })
  appNoMedia = buildApp({ sql: handle.sql, db: handle.db, logger, http: { allowedOrigins: [ORIGIN] } })
})
afterAll(async () => {
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await app.close()
  await appNoMedia.close()
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  const s = await createSession(handle.db)
  token = s.token
})

const cookie = (t = token) => ({ cookie: `${SESSION_COOKIE}=${t}` })

async function api(
  instance: FastifyInstance,
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  t: string | null = token,
) {
  return instance.inject({
    method,
    url,
    headers: { ...(t ? cookie(t) : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code
const errorDetails = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.details

async function seedGroup(name = 'Nhóm Beauty', color = 'group-1'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, ${color}) returning id`
  return row!.id
}
async function seedPage(name = 'Shop A', platform = 'facebook'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${newId()}, ${name}) returning id`
  return row!.id
}

const VALID = {
  name: 'Shop A',
  slogan: 'Đẹp mỗi ngày',
  industry: 'Mỹ phẩm',
  tones: ['Thân thiện', 'Chuyên gia'],
  formality: 70,
  pronoun: 'Shop – chị/bạn',
  emoji: 'some',
  products: [{ name: 'Serum', price: '450.000đ' }],
  audience: 'Nữ 22–35',
  colors: ['#DB2777', '#FCE7F3'],
  hashtags: ['#shopa'],
  bannedWords: ['cam kết 100%'],
  allowedDomains: ['shopa.vn'],
}

const logoBody = (data: Buffer, mime = 'image/png') => ({ mime, data: data.toString('base64') })

describe('brand-profiles — upsert + đọc', () => {
  it('lưu hồ sơ nhóm rồi đọc lại khớp', async () => {
    const groupId = await seedGroup()
    const put = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    expect(put.statusCode).toBe(200)
    const saved = BrandProfileDto.parse(put.json())
    expect(saved).toMatchObject({ ownerType: 'group', ownerId: groupId, name: 'Shop A', tones: ['Thân thiện', 'Chuyên gia'], colors: ['#DB2777', '#FCE7F3'], logoPath: null })

    const get = await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    expect(get.statusCode).toBe(200)
    expect(BrandProfileResponse.parse(get.json()).profile?.name).toBe('Shop A')
  })

  it('lưu hồ sơ trang (owner=page)', async () => {
    const pageId = await seedPage()
    const put = await api(app, 'PUT', `/api/v1/brand-profiles/page/${pageId}`, VALID)
    expect(put.statusCode).toBe(200)
    expect(BrandProfileDto.parse(put.json()).ownerType).toBe('page')
  })

  it('upsert: lưu lần hai cập nhật đúng chủ (không tạo dòng mới)', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, name: 'Shop B' })
    const [{ count }] = await handle.sql<{ count: number }[]>`select count(*)::int from brand_profiles`
    expect(count).toBe(1)
    const get = await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    expect(BrandProfileResponse.parse(get.json()).profile?.name).toBe('Shop B')
  })

  it('đọc hồ sơ chưa có → profile null', async () => {
    const groupId = await seedGroup()
    const get = await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    expect(BrandProfileResponse.parse(get.json()).profile).toBeNull()
  })
})

describe('brand-profiles — validate', () => {
  it('tên rỗng → VALIDATION_FAILED, details có field name', async () => {
    const groupId = await seedGroup()
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, name: '   ' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    const details = errorDetails(res) as { path: (string | number)[] }[]
    expect(details.some((d) => d.path.includes('name'))).toBe(true)
  })

  it('giọng điệu > 3 → VALIDATION_FAILED', async () => {
    const groupId = await seedGroup()
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, tones: ['a', 'b', 'c', 'd'] })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('màu > 6 → VALIDATION_FAILED', async () => {
    const groupId = await seedGroup()
    const colors = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777']
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, colors })
    expect(res.statusCode).toBe(400)
  })

  it('owner không tồn tại → 404', async () => {
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${newId()}`, VALID)
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
  })

  it('ownerType sai / ownerId không phải uuid → VALIDATION_FAILED', async () => {
    expect((await api(app, 'GET', '/api/v1/brand-profiles/team/' + newId())).statusCode).toBe(400)
    expect((await api(app, 'GET', '/api/v1/brand-profiles/group/not-a-uuid')).statusCode).toBe(400)
  })

  it('màu sai định dạng (không phải #RRGGBB) → VALIDATION_FAILED', async () => {
    const groupId = await seedGroup()
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, colors: ['red'] })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('cần phiên đăng nhập (không cookie → 401) trên GET và mọi route ghi', async () => {
    const groupId = await seedGroup()
    expect((await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`, undefined, null)).statusCode).toBe(401)
    expect((await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID, null)).statusCode).toBe(401)
    expect((await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG), null)).statusCode).toBe(401)
    expect((await api(app, 'DELETE', `/api/v1/brand-profiles/group/${groupId}/logo`, undefined, null)).statusCode).toBe(401)
  })

  it('route ghi với Origin lạ → 403', async () => {
    const groupId = await seedGroup()
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/brand-profiles/group/${groupId}`,
      headers: { ...cookie(), origin: 'https://evil.example.com' },
      payload: VALID,
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('brand-profiles — logo', () => {
  it.each([
    ['image/png', FAKE_PNG],
    ['image/jpeg', FAKE_JPEG],
    ['image/webp', FAKE_WEBP],
  ] as const)('tải logo %s hợp lệ → logoPath là URL Cloudinary công khai', async (mime, data) => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(data, mime))
    expect(res.statusCode).toBe(200)
    const dto = BrandProfileDto.parse(res.json())
    expect(dto.logoPath).toMatch(/^https:\/\/res\.cloudinary\.com\//)
    const get = await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    expect(BrandProfileResponse.parse(get.json()).profile?.logoPath).toBe(dto.logoPath)
  })

  it('magic bytes không khớp MIME khai báo → 400 (dưới ô logo)', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_JPEG, 'image/png'))
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    const details = errorDetails(res) as { path: (string | number)[] }[]
    expect(details.some((d) => d.path.includes('logo'))).toBe(true)
  })

  it('SVG bị từ chối (không nhận SVG)', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(svg, 'image/png'))
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('ảnh > 2MB → 400', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const big = Buffer.concat([FAKE_PNG, Buffer.alloc(LOGO_MAX_BYTES, 0)])
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(big, 'image/png'))
    expect(res.statusCode).toBe(400)
  })

  it('tải logo khi chưa có hồ sơ → 404 và KHÔNG gọi Cloudinary (không bỏ asset mồ côi)', async () => {
    const groupId = await seedGroup()
    const before = fake.requests.length
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG))
    expect(res.statusCode).toBe(404)
    expect(fake.requests.length).toBe(before) // không có lời gọi upload nào
  })

  it('giữ logo khi lưu lại phần chữ (upsert không đụng logo_path)', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const uploaded = BrandProfileDto.parse((await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG))).json())
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, name: 'Shop B' })
    const get = await api(app, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    const profile = BrandProfileResponse.parse(get.json()).profile
    expect(profile?.name).toBe('Shop B')
    expect(profile?.logoPath).toBe(uploaded.logoPath)
  })

  it.each([
    [429, 'RATE_LIMITED', 429],
    [400, 'VALIDATION_FAILED', 400],
    [500, 'IMAGE_FAILED', 502],
  ] as const)('lỗi Cloudinary %i → %s (status %i)', async (fail, code, status) => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    fake.failNext(fail)
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG))
    expect(res.statusCode).toBe(status)
    expect(errorCode(res)).toBe(code)
  })

  it('gỡ logo khi chưa có hồ sơ → 404', async () => {
    const groupId = await seedGroup()
    const res = await api(app, 'DELETE', `/api/v1/brand-profiles/group/${groupId}/logo`)
    expect(res.statusCode).toBe(404)
  })

  it('body logo vượt bodyLimit → 413', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    const res = await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, { mime: 'image/png', data: 'A'.repeat(3_200_000) })
    expect(res.statusCode).toBe(413)
  })

  it('gỡ logo → logoPath null', async () => {
    const groupId = await seedGroup()
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    await api(app, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG))
    const res = await api(app, 'DELETE', `/api/v1/brand-profiles/group/${groupId}/logo`)
    expect(res.statusCode).toBe(200)
    expect(BrandProfileDto.parse(res.json()).logoPath).toBeNull()
  })

  it('chưa cấu hình Cloudinary → MEDIA_NOT_CONFIGURED, phần chữ vẫn lưu được', async () => {
    const groupId = await seedGroup()
    const put = await api(appNoMedia, 'PUT', `/api/v1/brand-profiles/group/${groupId}`, VALID)
    expect(put.statusCode).toBe(200) // chữ lưu được
    const res = await api(appNoMedia, 'PUT', `/api/v1/brand-profiles/group/${groupId}/logo`, logoBody(FAKE_PNG))
    expect(errorCode(res)).toBe('MEDIA_NOT_CONFIGURED')
    const get = await api(appNoMedia, 'GET', `/api/v1/brand-profiles/group/${groupId}`)
    expect(BrandProfileResponse.parse(get.json()).profile?.name).toBe('Shop A')
  })
})

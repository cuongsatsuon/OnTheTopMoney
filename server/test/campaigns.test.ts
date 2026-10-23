// Ma trận Story 7.1 — Wizard tạo chiến dịch (AD-15, AD-1, AD-18). Qua app thật (buildApp) + Postgres nhúng. Phủ:
// trang chọn được (`GET /campaigns/page-options`: mất kết nối / thiếu hồ sơ / sắp hết hạn), lưu nháp (`POST`), mở lại
// (`GET`), thay cấu hình (`PUT`, 404, 409 khi đã rời nháp), tổng tỉ lệ ≠ 100%, dữ liệu sai theo từng ô, nhóm nhãn,
// ngày bắt đầu theo lịch VN, 401.
import { CampaignDto, CampaignPageOptionsResponse, ErrorResponse, SaveBrandProfileRequest, type SaveCampaignRequest } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
/** "Bây giờ" của route: 01:00 Thứ Bảy 24/10/2026 giờ VN — ngày UTC vẫn là 23/10 (kiểm ngày theo lịch VN). */
const NOW = new Date('2026-10-23T18:00:00.000Z')
const BRAND = { name: 'Lan Anh Beauty', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const

let handle: DbHandle
let app: FastifyInstance
let cookie: string
let accounts = 0

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
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
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from sessions`
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'

async function group(name = 'Nhóm Mỹ phẩm', brand = true): Promise<string> {
  const [g] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-1') returning id`
  if (brand) await upsertProfile(handle.db, { ownerType: 'group', ownerId: g!.id }, SaveBrandProfileRequest.parse(BRAND))
  return g!.id
}

/** Trang; mặc định có hồ sơ riêng. `groupId` → theo hồ sơ nhóm. `brand: false` → không hồ sơ. */
async function page(
  platform: Platform,
  opts: { status?: 'active' | 'expiring' | 'disconnected'; groupId?: string; brand?: boolean; removed?: boolean } = {},
): Promise<string> {
  const accountId = String(7000 + ++accounts)
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, group_id, removed_at)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, ${opts.status ?? 'active'}, ${opts.groupId ?? null},
      ${opts.removed ? NOW.toISOString() : null}) returning id`
  if (opts.brand !== false && !opts.groupId && !opts.removed) {
    await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse(BRAND))
  }
  return p!.id
}

const body = (over: Partial<SaveCampaignRequest> & { pages: SaveCampaignRequest['pages'] }): SaveCampaignRequest => ({
  name: 'Mỹ phẩm – tăng tương tác 30 ngày',
  goal: 'engage',
  startDate: '2026-10-26',
  durationDays: 30,
  groupId: null,
  defaultFrequency: '1_per_day',
  topics: [
    { name: 'Mẹo hay', share: 40 },
    { name: 'Review sản phẩm', share: 30 },
    { name: 'Hỏi đáp', share: 20 },
    { name: 'Hậu trường', share: 10 },
  ],
  postTimes: ['19:30', '11:30'],
  imageRatio: 70,
  ...over,
})

function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, auth = true) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }
  if (auth) headers.cookie = cookie
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}

async function created(payload: unknown): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', payload)
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}

/** Lỗi validate → danh sách `{path, message, code?}`. */
function issuesOf(res: { statusCode: number; json(): unknown }) {
  expect(res.statusCode).toBe(400)
  const err = ErrorResponse.parse(res.json()).error
  expect(err.code).toBe('VALIDATION_FAILED')
  return err.details as { path: (string | number)[]; message: string; code?: string }[]
}

const counts = async (id: string) => {
  const [row] = await handle.sql<{ topics: number; pages: number }[]>`
    select (select count(*)::int from campaign_topics where campaign_id = ${id}) as topics,
           (select count(*)::int from campaign_pages where campaign_id = ${id}) as pages`
  return row!
}

/* ---------- Trang chọn được ---------- */

describe('GET /api/v1/campaigns/page-options', () => {
  it('mất kết nối → PAGE_DISCONNECTED (xét trước thiếu hồ sơ); chưa có hồ sơ → CONFIG_MISSING; sắp hết hạn có hồ sơ nhóm → chọn được; trang đã gỡ không có', async () => {
    const g = await group()
    const ok = await page('facebook')
    const off = await page('instagram', { status: 'disconnected', brand: false })
    const noBrand = await page('threads', { brand: false })
    const expiring = await page('instagram', { status: 'expiring', groupId: g })
    await page('facebook', { removed: true })
    const res = await api('GET', '/api/v1/campaigns/page-options')
    expect(res.statusCode, res.body).toBe(200)
    expect(CampaignPageOptionsResponse.parse(res.json()).items).toEqual([
      { pageId: ok, selectable: true, reason: null },
      { pageId: off, selectable: false, reason: 'PAGE_DISCONNECTED' },
      { pageId: noBrand, selectable: false, reason: 'CONFIG_MISSING' },
      { pageId: expiring, selectable: true, reason: null },
    ])
  })

  it('trang theo nhóm mà nhóm chưa có hồ sơ → CONFIG_MISSING', async () => {
    const g = await group('Nhóm Gia dụng', false)
    const p = await page('facebook', { groupId: g })
    const res = await api('GET', '/api/v1/campaigns/page-options')
    expect(CampaignPageOptionsResponse.parse(res.json()).items).toEqual([{ pageId: p, selectable: false, reason: 'CONFIG_MISSING' }])
  })
})

/* ---------- Lưu, mở lại, sửa ---------- */

describe('POST / GET / PUT /api/v1/campaigns', () => {
  it('lưu nháp theo nhóm: 201 draft, mode mặc định review, chủ đề / trang đúng thứ tự, tần suất đặt riêng, giờ tăng dần; GET trả như lúc lưu', async () => {
    const g = await group()
    const fb = await page('facebook', { groupId: g })
    const ig = await page('instagram', { groupId: g })
    const c = await created(body({ groupId: g, pages: [{ pageId: fb, frequency: null }, { pageId: ig, frequency: '2_per_day' }] }))
    expect(c).toMatchObject({
      name: 'Mỹ phẩm – tăng tương tác 30 ngày',
      goal: 'engage',
      status: 'draft',
      mode: 'review',
      startDate: '2026-10-26',
      durationDays: 30,
      groupId: g,
      defaultFrequency: '1_per_day',
      imageRatio: 70,
      postTimes: ['11:30', '19:30'],
      pages: [
        { pageId: fb, frequency: null },
        { pageId: ig, frequency: '2_per_day' },
      ],
      topics: [
        { name: 'Mẹo hay', share: 40 },
        { name: 'Review sản phẩm', share: 30 },
        { name: 'Hỏi đáp', share: 20 },
        { name: 'Hậu trường', share: 10 },
      ],
    })
    const res = await api('GET', `/api/v1/campaigns/${c.id}`)
    expect(res.statusCode).toBe(200)
    expect(CampaignDto.parse(res.json())).toEqual(c)
    // Story 7.2: lưu nháp dựng sẵn 7 bài xem trước (chi tiết ở `campaigns-preview.test.ts`).
    const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from post_targets where campaign_id = ${c.id}`
    expect(row!.n).toBe(7)
  })

  it('chọn từng trang + "Tự đăng" + ngày bắt đầu hôm nay theo giờ VN (ngày UTC vẫn là hôm qua) → 201', async () => {
    const fb = await page('facebook')
    const c = await created(body({ startDate: '2026-10-24', mode: 'auto', pages: [{ pageId: fb, frequency: '3_per_week' }] }))
    expect(c).toMatchObject({ status: 'draft', mode: 'auto', groupId: null, startDate: '2026-10-24' })
  })

  it('PUT thay toàn bộ: chủ đề mới, bỏ một trang — không còn dòng cũ; GET thấy bản mới', async () => {
    const fb = await page('facebook')
    const th = await page('threads')
    const c = await created(body({ pages: [{ pageId: fb, frequency: null }, { pageId: th, frequency: null }] }))
    const next = body({
      name: 'Đổi tên',
      goal: 'sell',
      durationDays: 7,
      pages: [{ pageId: th, frequency: '3_per_day' }],
      topics: [
        { name: 'Khuyến mãi', share: 50 },
        { name: 'Feedback khách', share: 50 },
      ],
      postTimes: ['08:00'],
      imageRatio: 0,
    })
    const res = await api('PUT', `/api/v1/campaigns/${c.id}`, next)
    expect(res.statusCode, res.body).toBe(200)
    const updated = CampaignDto.parse(res.json())
    expect(updated).toMatchObject({ id: c.id, name: 'Đổi tên', goal: 'sell', durationDays: 7, imageRatio: 0, postTimes: ['08:00'], pages: [{ pageId: th, frequency: '3_per_day' }] })
    expect(updated.topics).toEqual(next.topics)
    expect(await counts(c.id)).toEqual({ topics: 2, pages: 1 })
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json())).toEqual(updated)
  })

  it('id lạ → 404 (GET, PUT); chiến dịch đã rời nháp → PUT 409, cấu hình giữ nguyên', async () => {
    const fb = await page('facebook')
    const unknown = '0190a000-0000-7000-8000-000000000000'
    expect((await api('GET', `/api/v1/campaigns/${unknown}`)).statusCode).toBe(404)
    expect((await api('PUT', `/api/v1/campaigns/${unknown}`, body({ pages: [{ pageId: fb, frequency: null }] }))).statusCode).toBe(404)
    const c = await created(body({ pages: [{ pageId: fb, frequency: null }] }))
    await handle.sql`update campaigns set status = 'running' where id = ${c.id}`
    const res = await api('PUT', `/api/v1/campaigns/${c.id}`, body({ name: 'Khác', pages: [{ pageId: fb, frequency: null }] }))
    expect(res.statusCode).toBe(409)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('VERSION_CONFLICT')
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json()).name).toBe(c.name)
  })
})

/* ---------- Kiểm hợp lệ ---------- */

describe('kiểm hợp lệ khi lưu', () => {
  it('tổng tỉ lệ chủ đề 90% → 400 VALIDATION_FAILED dưới ô chủ đề (path topics), không lưu gì', async () => {
    const fb = await page('facebook')
    const res = await api(
      'POST',
      '/api/v1/campaigns',
      body({
        pages: [{ pageId: fb, frequency: null }],
        topics: [
          { name: 'Mẹo hay', share: 40 },
          { name: 'Review sản phẩm', share: 30 },
          { name: 'Hỏi đáp', share: 20 },
        ],
      }),
    )
    expect(issuesOf(res)).toEqual([expect.objectContaining({ path: ['topics'], message: 'Tổng tỉ lệ chủ đề phải đúng 100% (hiện 90%)' })])
    const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from campaigns`
    expect(row!.n).toBe(0)
  })

  it.each([
    ['tên chủ đề trùng (khác hoa thường)', { topics: [{ name: 'Mẹo hay', share: 50 }, { name: 'mẹo HAY', share: 50 }] }, ['topics', 1, 'name']],
    ['tỉ lệ 0%', { topics: [{ name: 'Mẹo hay', share: 100 }, { name: 'Hỏi đáp', share: 0 }] }, ['topics', 1, 'share']],
    ['khung giờ trùng', { postTimes: ['11:30', '11:30'] }, ['postTimes', 1]],
    ['giờ sai định dạng', { postTimes: ['25:00'] }, ['postTimes', 0]],
    ['không có khung giờ', { postTimes: [] }, ['postTimes']],
    ['thời lượng 10 ngày', { durationDays: 10 }, ['durationDays']],
    ['ngày bắt đầu hôm qua theo giờ VN', { startDate: '2026-10-23' }, ['startDate']],
    ['ngày bắt đầu quá 365 ngày', { startDate: '2027-10-25' }, ['startDate']],
    ['ngày không có thật', { startDate: '2026-02-30' }, ['startDate']],
    ['tỉ lệ ảnh 120%', { imageRatio: 120 }, ['imageRatio']],
  ] as const)('%s → 400 đúng ô', async (_label, over, path) => {
    const fb = await page('facebook')
    const res = await api('POST', '/api/v1/campaigns', { ...body({ pages: [{ pageId: fb, frequency: null }] }), ...over })
    expect(issuesOf(res).map((i) => i.path)).toContainEqual([...path])
  })

  it('trang bị chọn hai lần / không chọn trang nào → 400 đúng ô', async () => {
    const fb = await page('facebook')
    const dup = await api('POST', '/api/v1/campaigns', body({ pages: [{ pageId: fb, frequency: null }, { pageId: fb, frequency: '2_per_day' }] }))
    expect(issuesOf(dup).map((i) => i.path)).toEqual([['pages', 1, 'pageId']])
    const none = await api('POST', '/api/v1/campaigns', body({ pages: [] }))
    expect(issuesOf(none).map((i) => i.path)).toEqual([['pages']])
  })

  it('trang mất kết nối / chưa có hồ sơ → 400 kèm mã lý do đúng dòng; trang sắp hết hạn có hồ sơ vẫn lưu được', async () => {
    const ok = await page('facebook', { status: 'expiring' })
    const off = await page('instagram', { status: 'disconnected' })
    const noBrand = await page('threads', { brand: false })
    const res = await api(
      'POST',
      '/api/v1/campaigns',
      body({ pages: [{ pageId: ok, frequency: null }, { pageId: off, frequency: null }, { pageId: noBrand, frequency: null }] }),
    )
    expect(issuesOf(res)).toEqual([
      { path: ['pages', 1, 'pageId'], message: 'Trang đã mất kết nối — kết nối lại để chọn', code: 'PAGE_DISCONNECTED' },
      { path: ['pages', 2, 'pageId'], message: 'Trang chưa có hồ sơ thương hiệu', code: 'CONFIG_MISSING' },
    ])
    await created(body({ pages: [{ pageId: ok, frequency: null }] }))
  })

  it('nhóm nhãn: nhóm lạ → ô groupId; trang ngoài nhóm / trang đã gỡ → đúng dòng', async () => {
    const g = await group()
    const inGroup = await page('facebook', { groupId: g })
    const outside = await page('threads')
    const removed = await page('instagram', { groupId: g, removed: true })
    const unknown = await api('POST', '/api/v1/campaigns', body({ groupId: '0190a000-0000-7000-8000-000000000001', pages: [{ pageId: outside, frequency: null }] }))
    expect(issuesOf(unknown).map((i) => i.path)).toEqual([['groupId']])
    const res = await api(
      'POST',
      '/api/v1/campaigns',
      body({ groupId: g, pages: [{ pageId: inGroup, frequency: null }, { pageId: outside, frequency: null }, { pageId: removed, frequency: null }] }),
    )
    expect(issuesOf(res)).toEqual([
      { path: ['pages', 1, 'pageId'], message: 'Trang không thuộc nhóm đã chọn' },
      { path: ['pages', 2, 'pageId'], message: 'Trang không tồn tại hoặc đã gỡ' },
    ])
  })

  it('xoá nhóm nhãn → chiến dịch giữ nguyên, groupId về null', async () => {
    const g = await group()
    const fb = await page('facebook', { groupId: g })
    const c = await created(body({ groupId: g, pages: [{ pageId: fb, frequency: null }] }))
    await handle.sql`delete from groups where id = ${g}`
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json())).toMatchObject({ groupId: null, pages: [{ pageId: fb, frequency: null }] })
  })
})

describe('đăng nhập', () => {
  it('chưa đăng nhập → 401 cho mọi route', async () => {
    const fb = await page('facebook')
    expect((await api('GET', '/api/v1/campaigns/page-options', undefined, false)).statusCode).toBe(401)
    expect((await api('POST', '/api/v1/campaigns', body({ pages: [{ pageId: fb, frequency: null }] }), false)).statusCode).toBe(401)
    expect((await api('GET', '/api/v1/campaigns/0190a000-0000-7000-8000-000000000000', undefined, false)).statusCode).toBe(401)
  })
})

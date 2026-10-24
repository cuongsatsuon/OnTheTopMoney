// Ma trận Story 7.7 — ảnh sản phẩm (ảnh tham khảo) cho chiến dịch (AD-15, AD-7, AD-14, AD-1). Qua app thật (buildApp) +
// Postgres nhúng + pg-boss + OpenAI giả + Cloudinary giả; không gọi mạng. Phủ: lưu / đọc nháp có ảnh, ảnh sai, body cũ;
// slot có ảnh (xem trước + cuốn chiếu "Tự đăng") trỏ `reference_asset_id` + prompt tham khảo `ad` (không "Shop bán") → job
// ảnh đi edits (bytes, không URL, không `input_fidelity`, `campaign_generate`); không ảnh → 6.8; tải ảnh lỗi / có thể đã
// tính tiền; Tạo lại; đổi / bỏ ảnh ở nháp (giữ caption, ô cũ thôi chờ); job sửa slot sinh theo ảnh cũ; đã bắt đầu không
// đổi được; dọn ảnh (GC `keep`, khoá ngoại, xoá chiến dịch, file mồ côi).
import { randomBytes } from 'node:crypto'
import { CampaignDto, CampaignSlotActionResponse, ErrorResponse, MediaAssetDto, SaveBrandProfileRequest, type SaveCampaignRequest } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { FAKE_PNG, createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { IMAGE_NO_FAKE_UI, buildReferenceImagePrompt, setOpenAiKey } from '../src/modules/ai/index.ts'
import { PRODUCT_IMAGE_MESSAGE, campaignProductImageIds, runGenerate, runPreview } from '../src/modules/campaigns/index.ts'
import { ImageGenerateRetryableError, MEDIA_GC_AFTER_MS, gcOrphanMedia, generateImageAsset } from '../src/modules/content/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { sweepOrphanFiles } from '../src/worker/retention.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-PRODUCT-key-aaaa1111'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-PRODUCT' }
const BRAND = {
  name: 'Phím cơ Minh Phát',
  tones: ['Vui vẻ'],
  pronoun: 'Shop – bạn',
  emoji: 'some',
  industry: 'Phụ kiện bàn phím',
  products: [{ name: 'Móc khoá keycap phô mai', price: '' }],
  colors: ['#112233'],
} as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)
/** 00:00 giờ VN ngày bắt đầu — mốc cửa sổ cuốn chiếu: 3 ngày tới = bài 11:30 của ngày 0, 1, 2. */
const START_MIDNIGHT = new Date(`${START}T00:00:00.000+07:00`)

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
let cloud: FakeCloudinary
let media: MediaStores
let app: FastifyInstance
let cookie: string

async function cleanup() {
  await handle.sql`delete from posts`
  await handle.sql`delete from campaigns`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key in ('openai', 'media_orphan_cursors')`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate', 'content.image.generate', 'publish.target')`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-product-image', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  events = createEventPublisher(boss)
  jobs = createJobSender(boss)
})
afterAll(async () => {
  await cleanup()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  openai = createFakeOpenAiAdapter()
  openai.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
  let n = 0
  openai.onResponse(() => ok(`Bài số ${++n} cho shop nhé #phimco`))
  cloud = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: cloud.fetch })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, media, ai: { cipher, openai } })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'

async function page(platform: Platform): Promise<string> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${account}, ${'Trang ' + platform}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse(BRAND))
  return p!.id
}

const body = (pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}): SaveCampaignRequest => ({
  name: 'Phím cơ – tăng tương tác',
  goal: 'engage',
  startDate: START,
  durationDays: 7,
  groupId: null,
  defaultFrequency: '1_per_day',
  pages,
  topics: [{ name: 'Mẹo hay', share: 100 }],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function upload(): Promise<MediaAssetDto> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/media-assets', headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' }, payload: FAKE_PNG })
  expect(res.statusCode, res.body).toBe(201)
  return MediaAssetDto.parse(res.json())
}
async function draft(pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', body(pages, over))
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
async function put(id: string, pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}) {
  return api('PUT', `/api/v1/campaigns/${id}`, body(pages, over))
}
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error
const pathsOf = (res: { json(): unknown }) => (errorOf(res).details as { path: (string | number)[] }[]).map((d) => d.path.join('.'))
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })

const deps = (now?: Date) => ({ db: handle.db, events, jobs, cipher, openai, log, ...(now ? { now: () => now } : {}) })
const preview = (id: string) => runPreview(deps(), id, { finalAttempt: false, concurrency: 1 })
const imageDeps = () => ({ db: handle.db, events, jobs, cipher, openai, log, media })
const runImage = (id: string, finalAttempt = false, autoApprove = false) => generateImageAsset(imageDeps(), id, { finalAttempt, autoApprove })
/** Chạy mọi ô ảnh AI đang chờ (thay worker). */
async function runPendingImages(autoApprove = false) {
  const rows = await handle.sql<{ id: string }[]>`select id from media_assets where source = 'ai' and status = 'pending' order by created_at, id`
  for (const r of rows) expect(await runImage(r.id, false, autoApprove)).toBe('ready')
  return rows.length
}

interface SlotImage {
  target_id: string
  page_id: string
  status: string
  caption: string
  error_code: string | null
  version: number
  asset_id: string | null
  asset_status: string | null
  reference_asset_id: string | null
  prompt: string | null
}
/** Slot của chiến dịch (theo giờ đăng rồi thứ tự tạo) kèm ô ảnh đang gắn (nếu có). */
const slots = (campaignId: string) =>
  handle.sql<SlotImage[]>`
    select t.id as target_id, t.page_id, t.status, t.caption, t.error_code, t.version,
      m.id as asset_id, m.status as asset_status, m.reference_asset_id, m.prompt
    from post_targets t
    left join post_target_media ptm on ptm.post_target_id = t.id
    left join media_assets m on m.id = ptm.media_asset_id
    where t.campaign_id = ${campaignId} order by t.slot_at, t.id`
const imageJobs = () => handle.sql<{ data: { mediaAssetId: string; autoApprove?: boolean } }[]>`
  select data from pgboss.job where name = 'content.image.generate' and state in ('created', 'retry') order by created_on`
/** Lượt tải ảnh giao (GET res.cloudinary.com/…/image/upload/…) — server tải ảnh để gửi OpenAI. */
const deliveries = () => cloud.requests.filter((r) => r.method === 'GET' && r.url.startsWith('https://res.cloudinary.com/'))
const backdate = (id: string, ms: number) => handle.sql`update media_assets set created_at = now() - ${`${ms} milliseconds`}::interval where id = ${id}`
const assetRow = async (id: string) => (await handle.sql<{ status: string; error_code: string | null }[]>`select status, error_code from media_assets where id = ${id}`)[0]

/* ---------- Lưu nháp ---------- */

describe('lưu nháp có ảnh sản phẩm', () => {
  it('201: `productImage` có url, cột đặt; GET trả lại; body không có `productImageId` = không ảnh', async () => {
    const fb = await page('facebook')
    const image = await upload()
    const c = await draft([{ pageId: fb, frequency: null }], { productImageId: image.id })
    expect(c.productImage).toEqual(image)
    const [row] = await handle.sql<{ product_image_id: string | null }[]>`select product_image_id from campaigns where id = ${c.id}`
    expect(row!.product_image_id).toBe(image.id)
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json()).productImage).toEqual(image)

    const { productImageId: _drop, ...old } = body([{ pageId: fb, frequency: null }])
    const res = await api('POST', '/api/v1/campaigns', old)
    expect(res.statusCode, res.body).toBe(201)
    expect(CampaignDto.parse(res.json()).productImage).toBeNull()
  })

  it('ảnh sai (id lạ / ô AI đã xong / ô AI đang chờ / không phải uuid) → 400 path `productImageId`; không ghi chiến dịch, không slot', async () => {
    const fb = await page('facebook')
    const [aiReady] = await handle.sql<{ id: string }[]>`
      insert into media_assets (source, status, public_id, url, width, height, bytes, format)
      values ('ai', 'ready', 'ottm-test/public/ai', 'https://res.cloudinary.com/demo-cloud/image/upload/v1/ottm-test/public/ai.jpg', 1024, 1024, 10, 'jpg') returning id`
    const [aiPending] = await handle.sql<{ id: string }[]>`insert into media_assets (source, status, prompt) values ('ai', 'pending', 'p') returning id`
    for (const [productImageId, message] of [
      [newId(), PRODUCT_IMAGE_MESSAGE.missing],
      [aiReady!.id, PRODUCT_IMAGE_MESSAGE.not_upload],
      [aiPending!.id, PRODUCT_IMAGE_MESSAGE.not_ready],
      ['abc', null],
    ] as const) {
      const res = await api('POST', '/api/v1/campaigns', body([{ pageId: fb, frequency: null }], { productImageId }))
      expect(res.statusCode, productImageId).toBe(400)
      expect(errorOf(res).code).toBe('VALIDATION_FAILED')
      expect(pathsOf(res)).toEqual(['productImageId'])
      if (message) expect((errorOf(res).details as { message: string }[])[0]!.message).toBe(message)
    }
    const [n] = await handle.sql<{ campaigns: number; slots: number }[]>`
      select (select count(*)::int from campaigns) as campaigns, (select count(*)::int from post_targets) as slots`
    expect(n).toEqual({ campaigns: 0, slots: 0 })
  })
})

/* ---------- Slot có ảnh ---------- */

describe('slot có ảnh dùng ảnh sản phẩm', () => {
  it('xem trước: ô ảnh trỏ ảnh sản phẩm, prompt tham khảo `ad` (không "Shop bán"); job → editImage bytes (không URL, không input_fidelity), `campaign_generate`; slot chờ duyệt có ảnh', async () => {
    const ig = await page('instagram')
    const image = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: image.id })
    expect(await preview(c.id)).toEqual({ generated: 7, errors: 0 })

    const before = await slots(c.id)
    expect(before).toHaveLength(7)
    expect(before.every((s) => s.status === 'planned' && s.asset_status === 'pending' && s.reference_asset_id === image.id)).toBe(true)
    const prompt = before[0]!.prompt!
    expect(prompt).toBe(
      buildReferenceImagePrompt({ request: '', topic: 'Mẹo hay', caption: before[0]!.caption, mode: 'ad', goal: 'engagement', brandColors: ['#112233'] }),
    )
    expect(prompt).toMatch(/^Ý tưởng bài đăng: Mẹo hay\nNội dung bài: Bài số 1 cho shop nhé\n/)
    expect(prompt).toContain('Giữ NGUYÊN sản phẩm')
    expect(prompt).toContain('tông màu thương hiệu: #112233')
    expect(prompt).toContain(IMAGE_NO_FAKE_UI)
    expect(prompt).not.toContain('Shop bán')
    expect(await imageJobs()).toHaveLength(7)

    expect(await runPendingImages()).toBe(7)
    expect(openai.imageRequests).toHaveLength(0)
    expect(openai.editRequests).toHaveLength(7)
    const req = openai.editRequests[0]!
    expect(Buffer.from(req.images[0]!.data)).toEqual(FAKE_PNG)
    expect(req.inputFidelity).toBeUndefined()
    expect(JSON.stringify({ ...req, images: [] })).not.toContain('res.cloudinary.com')
    expect(deliveries()[0]!.url).toBe(image.url.replace('/image/upload/', '/image/upload/c_limit,w_1024,h_1024/'))
    const usage = await handle.sql<{ feature: string; page_id: string }[]>`select feature, page_id from ai_usage`
    expect(usage.every((u) => u.feature === 'campaign_generate' && u.page_id === ig)).toBe(true)

    const after = await slots(c.id)
    expect(after.every((s) => s.status === 'pending_approval' && s.error_code === null && s.asset_status === 'ready')).toBe(true)
    const res = await api('GET', `/api/v1/campaigns/${c.id}/preview`)
    expect((res.json() as { items: { media: unknown[] }[] }).items.every((i) => i.media.length === 1)).toBe(true)
  })

  it('không có ảnh sản phẩm → prompt 6.8 có "Shop bán", không trỏ ảnh tham khảo, job gọi generateImage', async () => {
    const ig = await page('instagram')
    const c = await draft([{ pageId: ig, frequency: null }])
    await preview(c.id)
    const [first] = await slots(c.id)
    expect(first!.reference_asset_id).toBeNull()
    expect(first!.prompt).toContain('Shop bán: ngành hàng «Phụ kiện bàn phím»; sản phẩm «Móc khoá keycap phô mai»')
    expect(first!.prompt).not.toContain('Giữ NGUYÊN sản phẩm')
    expect(await runImage(first!.asset_id!)).toBe('ready')
    expect([openai.imageRequests.length, openai.editRequests.length, deliveries().length]).toEqual([1, 0, 0])
  })

  it('tải ảnh sản phẩm lỗi tạm: lượt chưa cuối ném retry, không gọi OpenAI; lượt cuối → slot `pending_approval IMAGE_FAILED`; edits có thể đã tính tiền → không retry', async () => {
    const ig = await page('instagram')
    const image = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: image.id })
    await preview(c.id)
    const [a, b] = await slots(c.id)
    cloud.failNext(503)
    await expect(runImage(a!.asset_id!, false)).rejects.toBeInstanceOf(ImageGenerateRetryableError)
    expect((await slots(c.id))[0]).toMatchObject({ status: 'planned', asset_status: 'pending' })
    cloud.failNext(503)
    expect(await runImage(a!.asset_id!, true)).toBe('failed')
    expect(openai.editRequests).toHaveLength(0)

    openai.onEdit({ ok: false, kind: 'TRANSIENT', maybeBilled: true })
    expect(await runImage(b!.asset_id!, false)).toBe('failed')
    expect(openai.editRequests).toHaveLength(1)
    const rows = await slots(c.id)
    expect(rows.slice(0, 2).map((s) => [s.status, s.error_code, s.asset_id])).toEqual([
      ['pending_approval', 'IMAGE_FAILED', null],
      ['pending_approval', 'IMAGE_FAILED', null],
    ])
  })

  it('đang chạy "Tự đăng": lượt cuốn chiếu trỏ ảnh sản phẩm, job ảnh (`autoApprove`) xong → `scheduled`', async () => {
    const ig = await page('instagram')
    const image = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: image.id, mode: 'auto', durationDays: 14 })
    const start = await api('POST', `/api/v1/campaigns/${c.id}/start`, {})
    expect(start.statusCode, start.body).toBe(200)
    await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate')`

    expect(await runGenerate(deps(START_MIDNIGHT), c.id, { finalAttempt: false })).toMatchObject({ generated: 3, scheduled: 0 })
    const jobsNow = await imageJobs()
    expect(jobsNow).toHaveLength(3)
    expect(jobsNow.every((j) => j.data.autoApprove === true)).toBe(true)
    const rows = (await slots(c.id)).slice(0, 3)
    expect(rows.every((s) => s.reference_asset_id === image.id)).toBe(true)
    for (const j of jobsNow) expect(await runImage(j.data.mediaAssetId, false, true)).toBe('ready')
    expect((await slots(c.id)).slice(0, 3).map((s) => s.status)).toEqual(['scheduled', 'scheduled', 'scheduled'])
    expect(openai.editRequests).toHaveLength(3)
  })

  it('Tạo lại bài xem trước → viết lại, ô ảnh mới trỏ ảnh sản phẩm hiện tại', async () => {
    const ig = await page('instagram')
    const image = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: image.id })
    await preview(c.id)
    await runPendingImages()
    const [s] = await slots(c.id)
    const res = await api('POST', `/api/v1/campaigns/${c.id}/slots/${s!.target_id}/transition`, { action: 'regenerate', version: s!.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(CampaignSlotActionResponse.parse(res.json()).slot).toMatchObject({ status: 'planned', caption: '', media: [] })
    expect(await preview(c.id)).toEqual({ generated: 1, errors: 0 })
    const [again] = await slots(c.id)
    expect(again).toMatchObject({ status: 'planned', asset_status: 'pending', reference_asset_id: image.id })
    expect(again!.asset_id).not.toBe(s!.asset_id)
  })
})

/* ---------- Đổi ảnh ở nháp ---------- */

describe('đổi / bỏ ảnh sản phẩm ở nháp', () => {
  it('PUT ảnh mới: bài có ảnh làm lại ảnh (giữ caption, kể cả caption đã sửa), ô cũ còn chờ → failed; bài không ảnh giữ nguyên; bỏ ảnh → ô không tham khảo', async () => {
    const ig = await page('instagram')
    const fb = await page('facebook')
    const imageA = await upload()
    const pages = [
      { pageId: ig, frequency: null },
      { pageId: fb, frequency: null },
    ]
    const c = await draft(pages, { productImageId: imageA.id })
    await preview(c.id)
    const rows = await slots(c.id)
    const igSlots = rows.filter((s) => s.page_id === ig)
    const fbSlots = rows.filter((s) => s.page_id === fb)
    expect(igSlots).toHaveLength(4)
    expect(fbSlots.every((s) => s.status === 'pending_approval' && s.asset_id === null)).toBe(true)
    // 3 ô ảnh xong (1 bài chủ shop sửa caption), 1 ô còn chờ lúc lưu.
    for (const s of igSlots.slice(0, 3)) expect(await runImage(s.asset_id!)).toBe('ready')
    const edited = (await slots(c.id)).find((s) => s.target_id === igSlots[0]!.target_id)!
    const edit = await api('POST', `/api/v1/campaigns/${c.id}/slots/${edited.target_id}/transition`, { action: 'edit', version: edited.version, caption: 'Shop tự viết' })
    expect(edit.statusCode, edit.body).toBe(200)
    await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'content.image.generate')`
    const editsBefore = openai.editRequests.length
    const responsesBefore = openai.responseRequests.length

    const imageB = await upload()
    const res = await put(c.id, pages, { productImageId: imageB.id })
    expect(res.statusCode, res.body).toBe(200)
    expect(CampaignDto.parse(res.json()).productImage?.id).toBe(imageB.id)
    const after = await slots(c.id)
    const igAfter = after.filter((s) => s.page_id === ig)
    expect(igAfter.every((s) => s.status === 'planned' && s.asset_status === 'pending' && s.reference_asset_id === imageB.id)).toBe(true)
    expect(igAfter.map((s) => s.caption)).toEqual(['Shop tự viết', ...igSlots.slice(1).map((s) => s.caption)])
    expect(igAfter.every((s) => !igSlots.some((o) => o.asset_id === s.asset_id))).toBe(true)
    expect(await assetRow(igSlots[3]!.asset_id!)).toEqual({ status: 'failed', error_code: 'IMAGE_FAILED' })
    expect(await runImage(igSlots[3]!.asset_id!)).toBe('skipped') // job cũ tới muộn: không gọi OpenAI
    expect(after.filter((s) => s.page_id === fb)).toEqual(fbSlots)
    expect((await imageJobs()).map((j) => j.data.mediaAssetId).sort()).toEqual(igAfter.map((s) => s.asset_id).sort())
    // Không viết lại caption; ảnh làm lại xong → chờ duyệt, caption vẫn giữ.
    expect(await runPendingImages()).toBe(4)
    expect(openai.responseRequests.length).toBe(responsesBefore)
    expect(openai.editRequests.length).toBe(editsBefore + 4)
    expect((await slots(c.id)).filter((s) => s.page_id === ig).map((s) => [s.status, s.caption === '' ? '' : 'ok'])).toEqual(
      Array.from({ length: 4 }, () => ['pending_approval', 'ok']),
    )

    // Lưu lại không đổi ảnh → không làm lại gì.
    await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'content.image.generate')`
    expect((await put(c.id, pages, { productImageId: imageB.id })).statusCode).toBe(200)
    expect(await imageJobs()).toHaveLength(0)

    // Bỏ ảnh → ô mới không trỏ ảnh tham khảo, prompt 6.8 có "Shop bán".
    expect((await put(c.id, pages, { productImageId: null })).statusCode).toBe(200)
    const plain = (await slots(c.id)).filter((s) => s.page_id === ig)
    expect(plain.every((s) => s.status === 'planned' && s.reference_asset_id === null && s.prompt!.includes('Shop bán'))).toBe(true)
  })

  it('job xem trước sửa bài vừa sinh theo ảnh cũ (nháp đổi ảnh chen giữa lượt): làm lại ảnh theo ảnh hiện tại', async () => {
    const ig = await page('instagram')
    const imageA = await upload()
    const imageB = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: imageA.id })
    await preview(c.id)
    // Lưu nháp đổi ảnh đúng lúc lượt cũ đang viết (bài chưa có ô ảnh nên lưu không làm lại) → ô ghi theo ảnh A.
    await handle.sql`update campaigns set product_image_id = ${imageB.id} where id = ${c.id}`
    expect((await slots(c.id)).every((s) => s.reference_asset_id === imageA.id)).toBe(true)
    await preview(c.id)
    expect((await slots(c.id)).every((s) => s.status === 'planned' && s.reference_asset_id === imageB.id)).toBe(true)
  })

  it('đã bắt đầu: PUT → 409, ảnh sản phẩm giữ nguyên', async () => {
    const fb = await page('facebook')
    const imageA = await upload()
    const imageB = await upload()
    const c = await draft([{ pageId: fb, frequency: null }], { productImageId: imageA.id })
    expect((await api('POST', `/api/v1/campaigns/${c.id}/start`, {})).statusCode).toBe(200)
    const res = await put(c.id, [{ pageId: fb, frequency: null }], { productImageId: imageB.id })
    expect(res.statusCode).toBe(409)
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json()).productImage?.id).toBe(imageA.id)
  })
})

/* ---------- Dọn dữ liệu ---------- */

describe('dọn dữ liệu tôn trọng ảnh sản phẩm', () => {
  it('chiến dịch còn: `media_gc` có `keep` không đụng ảnh; thiếu `keep` thì khoá ngoại chặn (bỏ qua); xoá chiến dịch không ô ảnh → lượt sau dọn dòng + file', async () => {
    const fb = await page('facebook')
    const image = await upload()
    const c = await draft([{ pageId: fb, frequency: null }], { productImageId: image.id })
    await backdate(image.id, MEDIA_GC_AFTER_MS + DAY)
    expect(await campaignProductImageIds(handle.db)).toEqual([image.id])
    expect(await gcOrphanMedia({ db: handle.db, media, log, keep: await campaignProductImageIds(handle.db) })).toEqual({ deleted: 0, skipped: 0, fileErrors: 0 })
    expect(await gcOrphanMedia({ db: handle.db, media, log })).toEqual({ deleted: 0, skipped: 1, fileErrors: 0 })
    expect(await assetRow(image.id)).toMatchObject({ status: 'ready' })

    expect((await api('DELETE', `/api/v1/campaigns/${c.id}`)).statusCode).toBe(200)
    expect(await campaignProductImageIds(handle.db)).toEqual([])
    expect(await gcOrphanMedia({ db: handle.db, media, log, keep: [] })).toEqual({ deleted: 1, skipped: 0, fileErrors: 0 })
    expect(await assetRow(image.id)).toBeUndefined()
    expect(cloud.assets.size).toBe(0)
  })

  it('xoá chiến dịch khi slot còn ô ảnh chờ trỏ ảnh sản phẩm → ảnh giữ (job ảnh vẫn tải được); file ảnh có tham chiếu với lượt dọn file mồ côi', async () => {
    const ig = await page('instagram')
    const image = await upload()
    const c = await draft([{ pageId: ig, frequency: null }], { productImageId: image.id })
    await preview(c.id)
    expect((await api('DELETE', `/api/v1/campaigns/${c.id}`)).statusCode).toBe(200)
    await backdate(image.id, MEDIA_GC_AFTER_MS + DAY)
    expect(await gcOrphanMedia({ db: handle.db, media, log, keep: await campaignProductImageIds(handle.db) })).toEqual({ deleted: 0, skipped: 0, fileErrors: 0 })
    expect(await assetRow(image.id)).toMatchObject({ status: 'ready' })

    for (const a of cloud.assets.values()) a.createdAt = new Date(Date.now() - 30 * DAY)
    expect(await sweepOrphanFiles({ db: handle.db, media, mode: 'force', log })).toMatchObject({ orphans: 0, deleted: 0 })
    expect(cloud.assets.size).toBe(1)
  })
})

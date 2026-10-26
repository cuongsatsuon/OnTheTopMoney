// Ma trận Story 7.2 — Xem trước 7 bài đầu (AD-15, AD-13, AD-21, AD-24). Qua app thật (buildApp) + Postgres nhúng +
// pg-boss + OpenAI giả + Cloudinary giả (không gọi mạng). Phủ: luật slot (`campaignSlots`), lưu nháp dựng 7 slot `planned`
// + `held` + job `campaigns.preview`, job sinh caption (`campaign_generate`) / ảnh (job ảnh có sẵn) → `pending_approval`,
// idempotent, đổi cấu hình (dọn / giữ slot), hậu kiểm chặn, thiếu hồ sơ / khoá / hạn mức (mã dừng), lỗi tạm, ảnh bị từ
// chối, `held` không đăng được, Sửa / Xoá / Tạo lại qua `version`, route sai, hai tab (`baseUpdatedAt`), 401.
import { randomBytes } from 'node:crypto'
import {
  CampaignDto,
  CampaignPreviewResponse,
  CampaignSlotActionResponse,
  ErrorResponse,
  SaveBrandProfileRequest,
  campaignSlots,
  type EventName,
  type SaveCampaignRequest,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import { PreviewRetryableError, handlePreviewJob } from '../src/modules/campaigns/index.ts'
import { generateImageAsset, publishTarget, requeueTargets, type PublishDeps } from '../src/modules/content/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { captionRequests, isPlanRequest, planRequests } from './helpers/plan.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-PREVIEW-key-aaaa1111'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-PREVIEW' }
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const
const DAY = 24 * 60 * 60_000
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * 60_000 + DAY).toISOString().slice(0, 10)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
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
  await handle.sql`delete from campaigns`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from pages`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate', 'content.image.generate', 'publish.target')`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-preview', { background: false })
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
  const cloud = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: cloud.fetch })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, media, ai: { cipher, openai } })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'

async function page(platform: Platform, opts: { brand?: Record<string, unknown> | null } = {}): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${randomBytes(6).toString('hex')}, ${'Trang ' + platform}) returning id`
  if (opts.brand !== null) await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse({ ...BRAND, ...opts.brand }))
  return p!.id
}

const body = (pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}): SaveCampaignRequest => ({
  name: 'Gia dụng – tăng tương tác 30 ngày',
  goal: 'engage',
  startDate: START,
  durationDays: 30,
  groupId: null,
  defaultFrequency: '1_per_day',
  pages,
  topics: [
    { name: 'Mẹo hay', share: 40 },
    { name: 'Review sản phẩm', share: 30 },
    { name: 'Hỏi đáp', share: 20 },
    { name: 'Hậu trường', share: 10 },
  ],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, auth = true) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }
  if (auth) headers.cookie = cookie
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function created(payload: SaveCampaignRequest): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', payload)
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
async function preview(id: string) {
  const res = await api('GET', `/api/v1/campaigns/${id}/preview`)
  expect(res.statusCode, res.body).toBe(200)
  return CampaignPreviewResponse.parse(res.json())
}
const action = (id: string, targetId: string, payload: unknown) => api('POST', `/api/v1/campaigns/${id}/slots/${targetId}/transition`, payload)
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error

const deps = () => ({ db: handle.db, events, jobs, cipher, openai, log })
const runJob = (campaignId: string, retryCount = 0) => handlePreviewJob(deps(), { data: { campaignId }, retryCount, retryLimit: 2 })
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
/** Caption khác nhau theo lần gọi (để thấy sinh lại). */
function captions(prefix = 'Bài') {
  let n = 0
  openai.onResponse(() => ok(`${prefix} số ${++n} cho shop nhé`))
}
const jobCount = async (name: string) =>
  (await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${name} and state in ('created', 'retry')`)[0]!.n
const slotRows = (campaignId: string) =>
  handle.sql<{ id: string; status: string; held: boolean; scheduled_at: string | null; slot_at: string; caption: string; error_code: string | null; version: number; source: string; topic: string | null }[]>`
    select t.id, t.status, t.held, t.scheduled_at, t.slot_at, t.caption, t.error_code, t.version, p.source, p.topic
    from post_targets t join posts p on p.id = t.post_id where t.campaign_id = ${campaignId} order by t.slot_at, t.id`

/* ---------- Luật slot (shared) ---------- */

describe('campaignSlots', () => {
  it('2 trang (FB 1/ngày, IG 3/tuần), 2 khung giờ: 7 slot đầu đúng ngày/giờ UTC, giờ rồi thứ tự trang; chủ đề theo vòng có trọng số; IG luôn ảnh, FB theo ⌈⌉', () => {
    const slots = campaignSlots(
      {
        ...body([]),
        startDate: '2026-10-26',
        postTimes: ['19:30', '11:30'],
        imageRatio: 70,
        pages: [
          { pageId: 'fb', platform: 'facebook', frequency: null },
          { pageId: 'ig', platform: 'instagram', frequency: '3_per_week' },
        ],
      },
      7,
    )
    expect(slots).toEqual([
      { pageId: 'fb', slotAt: '2026-10-26T04:30:00.000Z', topic: 'Mẹo hay', withImage: true },
      { pageId: 'ig', slotAt: '2026-10-26T04:30:00.000Z', topic: 'Review sản phẩm', withImage: true },
      { pageId: 'fb', slotAt: '2026-10-27T04:30:00.000Z', topic: 'Hỏi đáp', withImage: true },
      { pageId: 'fb', slotAt: '2026-10-28T04:30:00.000Z', topic: 'Mẹo hay', withImage: true },
      { pageId: 'ig', slotAt: '2026-10-28T04:30:00.000Z', topic: 'Review sản phẩm', withImage: true },
      { pageId: 'fb', slotAt: '2026-10-29T04:30:00.000Z', topic: 'Hậu trường', withImage: false },
      { pageId: 'fb', slotAt: '2026-10-30T04:30:00.000Z', topic: 'Mẹo hay', withImage: true },
    ])
  })

  it('10 slot với 40/30/20/10 → đúng 4/3/2/1; 2 bài/ngày dùng cả hai khung giờ; ảnh 0% không ảnh, 100% luôn ảnh', () => {
    const plan = { ...body([]), startDate: '2026-10-26', pages: [{ pageId: 'fb', platform: 'facebook' as const, frequency: null }] }
    const tally = new Map<string, number>()
    for (const s of campaignSlots(plan, 10)) tally.set(s.topic, (tally.get(s.topic) ?? 0) + 1)
    expect(Object.fromEntries(tally)).toEqual({ 'Mẹo hay': 4, 'Review sản phẩm': 3, 'Hỏi đáp': 2, 'Hậu trường': 1 })
    const two = campaignSlots({ ...plan, defaultFrequency: '2_per_day', postTimes: ['08:00', '20:00'] }, 2)
    expect(two.map((s) => s.slotAt)).toEqual(['2026-10-26T01:00:00.000Z', '2026-10-26T13:00:00.000Z'])
    expect(campaignSlots(plan, 7).some((s) => s.withImage)).toBe(false)
    expect(campaignSlots({ ...plan, imageRatio: 100 }, 7).every((s) => s.withImage)).toBe(true)
  })
})

/* ---------- Lưu nháp + job ---------- */

describe('lưu nháp → 7 slot + job campaigns.preview', () => {
  it('POST: 7 slot `planned` + `held`, `source=campaign`, chưa lên Lịch; 1 job; GET preview trả 7 bài đang viết', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    const rows = await slotRows(c.id)
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.status === 'planned' && r.held && r.scheduled_at === null && r.source === 'campaign' && r.caption === '')).toBe(true)
    expect(rows.map((r) => r.topic)).toEqual(['Mẹo hay', 'Review sản phẩm', 'Hỏi đáp', 'Mẹo hay', 'Review sản phẩm', 'Hậu trường', 'Mẹo hay'])
    expect(await jobCount('campaigns.preview')).toBe(1)
    const p = await preview(c.id)
    expect(p.generating).toBe(true)
    expect(p.items).toHaveLength(7)
    // Lịch không thấy bài xem trước (chưa có `scheduled_at`).
    const cal = await api('GET', `/api/v1/calendar?from=${new Date(Date.now()).toISOString()}&to=${new Date(Date.now() + 40 * DAY).toISOString()}`)
    expect(cal.json().items).toEqual([])
  })

  it('job: caption `campaign_generate` (page_id, ref = target) → `pending_approval` + `held`; slot có ảnh chờ job ảnh rồi mới sang `pending_approval`; phát `post_target.updated`', async () => {
    captions()
    // 10% → chỉ bài đầu có ảnh.
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }], { imageRatio: 10 }))
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    const usage = await handle.sql<{ feature: string; page_id: string; ref: string }[]>`select feature, page_id, ref from ai_usage order by created_at`
    const rows = await slotRows(c.id)
    // Story 7.8: một lời gọi kế hoạch (`ref` = chiến dịch) trước 7 caption (`ref` = target).
    expect(usage).toHaveLength(8)
    expect(usage.every((u) => u.feature === 'campaign_generate' && u.page_id === fb)).toBe(true)
    expect(new Set(usage.map((u) => u.ref))).toEqual(new Set([c.id, ...rows.map((r) => r.id)]))
    expect(isPlanRequest(openai.responseRequests[0]!)).toBe(true)
    expect(captionRequests(openai)[0]!.input).toContain('Ý tưởng bài: «Mẹo hay')

    let p = await preview(c.id)
    expect(p.items[0]).toMatchObject({ status: 'planned', imagePending: true, aiCaption: true, media: [] })
    expect(p.items[0]!.caption).toMatch(/^Bài số \d cho shop nhé$/)
    expect(p.items.slice(1).every((s) => s.status === 'pending_approval' && s.errorCode === null && s.caption !== '')).toBe(true)
    expect(rows.every((r) => r.held)).toBe(true)
    expect(p.generating).toBe(true)
    expect(await jobCount('content.image.generate')).toBe(1)

    const [asset] = await handle.sql<{ media_asset_id: string }[]>`select media_asset_id from post_target_media where post_target_id = ${rows[0]!.id}`
    expect(await generateImageAsset({ ...deps(), media }, asset!.media_asset_id, { finalAttempt: false })).toBe('ready')
    const imageUsage = await handle.sql<{ feature: string; page_id: string }[]>`select feature, page_id from ai_usage where ref = ${asset!.media_asset_id}`
    expect(imageUsage).toEqual([{ feature: 'campaign_generate', page_id: fb }])
    p = await preview(c.id)
    expect(p.items[0]).toMatchObject({ status: 'pending_approval', imagePending: false, errorCode: null })
    expect(p.items[0]!.media).toHaveLength(1)
    expect(p.generating).toBe(false)
    expect(emittedOf('post_target.updated').filter((e) => e.id === rows[0]!.id)).toHaveLength(2)
    expect(emittedOf('post_target.updated').every((e) => e.campaignId === c.id)).toBe(true)
  })

  it('idempotent: chạy lại job / lưu lại không đổi cấu hình → không slot mới, không gọi AI thêm', async () => {
    captions()
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    await runJob(c.id)
    const before = (await slotRows(c.id)).map((r) => r.id)
    expect(await runJob(c.id)).toEqual({ generated: 0, errors: 0 })
    const res = await api('PUT', `/api/v1/campaigns/${c.id}`, body([{ pageId: fb, frequency: null }]))
    expect(res.statusCode, res.body).toBe(200)
    await runJob(c.id)
    expect((await slotRows(c.id)).map((r) => r.id)).toEqual(before)
    expect([captionRequests(openai).length, planRequests(openai).length]).toEqual([7, 1])
  })

  it('đổi cấu hình: đổi giờ đăng → slot cũ bị xoá, slot mới `planned`; đổi thời lượng → giữ nguyên, slot đã xoá vẫn `cancelled`', async () => {
    captions()
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    await runJob(c.id)
    const first = await slotRows(c.id)
    const del = await action(c.id, first[0]!.id, { action: 'cancel', version: first[0]!.version })
    expect(del.statusCode, del.body).toBe(200)

    const longer = await api('PUT', `/api/v1/campaigns/${c.id}`, body([{ pageId: fb, frequency: null }], { durationDays: 14 }))
    expect(longer.statusCode).toBe(200)
    const kept = await slotRows(c.id)
    expect(kept.map((r) => r.id)).toEqual(first.map((r) => r.id))
    expect(kept[0]!.status).toBe('cancelled')

    const moved = await api('PUT', `/api/v1/campaigns/${c.id}`, body([{ pageId: fb, frequency: null }], { postTimes: ['08:00'] }))
    expect(moved.statusCode).toBe(200)
    const now = await slotRows(c.id)
    expect(now).toHaveLength(7)
    expect(now.some((r) => first.some((f) => f.id === r.id))).toBe(false)
    expect(now.every((r) => r.status === 'planned' && new Date(r.slot_at).toISOString().endsWith('01:00:00.000Z'))).toBe(true)
  })
})

/* ---------- Lỗi khi sinh ---------- */

describe('job campaigns.preview — lỗi', () => {
  it('hậu kiểm chặn cả hai lần → `pending_approval AI_POLICY_BLOCKED`, giữ caption, không sinh ảnh, 2 lời gọi mỗi slot', async () => {
    openai.onResponse(ok('Siêu GIẢM GIÁ hôm nay'))
    const fb = await page('facebook', { brand: { bannedWords: ['giảm giá'] } })
    const c = await created(body([{ pageId: fb, frequency: null }], { imageRatio: 100, durationDays: 7, defaultFrequency: '3_per_week' }))
    expect(await runJob(c.id)).toEqual({ generated: 0, errors: 3 })
    const p = await preview(c.id)
    expect(p.items.map((s) => [s.status, s.errorCode, s.caption, s.imagePending])).toEqual(
      Array.from({ length: 3 }, () => ['pending_approval', 'AI_POLICY_BLOCKED', 'Siêu GIẢM GIÁ hôm nay', false]),
    )
    expect(captionRequests(openai)).toHaveLength(6)
    expect(await jobCount('content.image.generate')).toBe(0)
  })

  it('trang mất hồ sơ sau khi lưu → CONFIG_MISSING; thiếu khoá → OPENAI_KEY_MISSING cho mọi slot, không gọi OpenAI', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    expect(await runJob(c.id)).toEqual({ generated: 0, errors: 7 })
    expect((await preview(c.id)).items.every((s) => s.status === 'pending_approval' && s.errorCode === 'OPENAI_KEY_MISSING')).toBe(true)
    expect(openai.responseRequests).toHaveLength(0)

    const ig = await page('instagram')
    const c2 = await created(body([{ pageId: ig, frequency: null }]))
    await handle.sql`delete from brand_profiles`
    await runJob(c2.id)
    expect((await preview(c2.id)).items.every((s) => s.errorCode === 'CONFIG_MISSING')).toBe(true)
  })

  it('trang bị gỡ sau khi lưu → slot `pending_approval PAGE_REMOVED` (không kẹt `planned`), `generating` tắt, không gọi OpenAI', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }], { durationDays: 7, defaultFrequency: '3_per_week' }))
    await handle.sql`update pages set removed_at = now() where id = ${fb}`
    expect(await runJob(c.id)).toEqual({ generated: 0, errors: 3 })
    const p = await preview(c.id)
    expect(p.generating).toBe(false)
    expect(p.items.map((s) => [s.status, s.errorCode])).toEqual(Array.from({ length: 3 }, () => ['pending_approval', 'PAGE_REMOVED']))
    expect(openai.responseRequests).toHaveLength(0)
  })

  it('hết hạn mức → AI_BUDGET_EXCEEDED ở mọi slot (mã dừng), không gọi OpenAI', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
    await settle({ db: handle.db, events }, { reservationId: null, month: '2026-10', feature: 'compose_caption', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } })
    await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
    await runJob(c.id)
    expect((await preview(c.id)).items.map((s) => s.errorCode)).toEqual(Array.from({ length: 7 }, () => 'AI_BUDGET_EXCEEDED'))
    expect(openai.responseRequests).toHaveLength(0)
  })

  it('OpenAI 5xx: lượt chưa cuối → ném PreviewRetryableError, slot vẫn `planned`; lượt cuối → `pending_approval AI_PROVIDER_ERROR`', async () => {
    openai.onResponse({ ok: false, kind: 'TRANSIENT', status: 503, maybeBilled: false })
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }], { durationDays: 7, defaultFrequency: '3_per_week' }))
    await expect(runJob(c.id)).rejects.toBeInstanceOf(PreviewRetryableError)
    expect((await slotRows(c.id)).every((r) => r.status === 'planned' && r.caption === '')).toBe(true)
    await runJob(c.id, 2)
    expect((await slotRows(c.id)).map((r) => [r.status, r.error_code])).toEqual(Array.from({ length: 3 }, () => ['pending_approval', 'AI_PROVIDER_ERROR']))
  })

  it('OpenAI từ chối ảnh → slot `pending_approval IMAGE_REJECTED`, không gắn ảnh', async () => {
    captions()
    openai.onImage({ ok: false, kind: 'CONTENT_REJECTED', status: 400 })
    const ig = await page('instagram')
    const c = await created(body([{ pageId: ig, frequency: null }], { durationDays: 7, defaultFrequency: '3_per_week' }))
    expect(await runJob(c.id)).toEqual({ generated: 3, errors: 0 })
    const assets = await handle.sql<{ id: string }[]>`select id from media_assets`
    expect(assets).toHaveLength(3)
    for (const a of assets) await generateImageAsset({ ...deps(), media }, a.id, { finalAttempt: false })
    const p = await preview(c.id)
    expect(p.items.map((s) => [s.status, s.errorCode, s.media.length, s.imagePending])).toEqual(Array.from({ length: 3 }, () => ['pending_approval', 'IMAGE_REJECTED', 0, false]))
    expect(p.items.every((s) => s.caption !== '')).toBe(true)
  })

  it('chiến dịch không còn nháp → job bỏ qua', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    await handle.sql`update campaigns set status = 'running', started_at = now() where id = ${c.id}`
    expect(await runJob(c.id)).toBe('skipped')
    expect(openai.responseRequests).toHaveLength(0)
  })
})

/* ---------- held ---------- */

describe('held', () => {
  it('slot `held` ở `scheduled` có job `publish.target` → job bỏ qua; cron requeue bỏ qua', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    const [slot] = await slotRows(c.id)
    const past = new Date(Date.now() - 60 * 60_000)
    await handle.sql`update post_targets set status = 'scheduled', caption = 'Bài', scheduled_at = ${past.toISOString()}, schedule_version = 1 where id = ${slot!.id}`
    const publishDeps = { db: handle.db, events, jobs, cipher } as unknown as PublishDeps
    expect(await publishTarget(publishDeps, { targetId: slot!.id, scheduleVersion: 1 }, { finalAttempt: false })).toBe('skipped')
    expect((await slotRows(c.id))[0]!.status).toBe('scheduled')
    expect((await requeueTargets({ db: handle.db, events, jobs })).requeued).toBe(0)
  })
})

/* ---------- Sửa / Xoá / Tạo lại ---------- */

describe('POST /campaigns/:id/slots/:targetId/transition', () => {
  async function ready(over: Partial<SaveCampaignRequest> = {}) {
    captions()
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }], over))
    await runJob(c.id)
    return { c, fb, slots: (await preview(c.id)).items }
  }

  it('Sửa: caption mới, `error_code` về null, version + 1, vẫn chờ duyệt; version lệch 409; caption rỗng 400', async () => {
    const { c, slots } = await ready()
    const s = slots[0]!
    await handle.sql`update post_targets set error_code = 'AI_POLICY_BLOCKED' where id = ${s.id}`
    const res = await action(c.id, s.id, { action: 'edit', version: s.version, caption: '  Bài shop tự viết  ' })
    expect(res.statusCode, res.body).toBe(200)
    const after = CampaignSlotActionResponse.parse(res.json()).slot
    expect(after).toMatchObject({ status: 'pending_approval', caption: 'Bài shop tự viết', errorCode: null, version: s.version + 1, aiCaption: true })
    const stale = await action(c.id, s.id, { action: 'edit', version: s.version, caption: 'Khác' })
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'VERSION_CONFLICT'])
    const empty = await action(c.id, s.id, { action: 'edit', version: after.version, caption: '   ' })
    expect([empty.statusCode, errorOf(empty).code]).toEqual([400, 'VALIDATION_FAILED'])
    expect(emittedOf('post_target.updated').some((e) => e.id === s.id && e.version === after.version)).toBe(true)
  })

  it('Xoá: `cancelled USER_DELETED`, `post_target.cancelled` mang campaignId', async () => {
    const { c, slots } = await ready()
    const s = slots[1]!
    const res = await action(c.id, s.id, { action: 'cancel', version: s.version })
    expect(res.statusCode, res.body).toBe(200)
    const [row] = await handle.sql<{ status: string; cancel_reason: string }[]>`select status, cancel_reason from post_targets where id = ${s.id}`
    expect(row).toEqual({ status: 'cancelled', cancel_reason: 'USER_DELETED' })
    expect(emittedOf('post_target.cancelled')).toEqual([expect.objectContaining({ id: s.id, campaignId: c.id })])
  })

  it('Tạo lại: về `planned`, bỏ caption + ảnh gắn, enqueue `campaigns.preview`; job sinh lại đúng slot đó; slot đang `planned` → 409', async () => {
    const { c, slots } = await ready({ imageRatio: 10 })
    const [asset] = await handle.sql<{ media_asset_id: string }[]>`select media_asset_id from post_target_media where post_target_id = ${slots[0]!.id}`
    await generateImageAsset({ ...deps(), media }, asset!.media_asset_id, { finalAttempt: false })
    const s = (await preview(c.id)).items[0]!
    expect(s.media).toHaveLength(1)
    await handle.sql`delete from pgboss.job where name = 'campaigns.preview'`

    const res = await action(c.id, s.id, { action: 'regenerate', version: s.version })
    expect(res.statusCode, res.body).toBe(200)
    const again = CampaignSlotActionResponse.parse(res.json()).slot
    expect(again).toMatchObject({ id: s.id, status: 'planned', caption: '', media: [], imagePending: false, errorCode: null, aiCaption: false })
    expect((await preview(c.id)).generating).toBe(true)
    expect(await jobCount('campaigns.preview')).toBe(1)
    const planned = await action(c.id, s.id, { action: 'regenerate', version: again.version })
    expect([planned.statusCode, errorOf(planned).code]).toEqual([409, 'VERSION_CONFLICT'])

    const calls = captionRequests(openai).length
    const plans = planRequests(openai).length
    expect(await runJob(c.id)).toEqual({ generated: 1, errors: 0 })
    expect(captionRequests(openai)).toHaveLength(calls + 1)
    // Story 7.8: Tạo lại bỏ brief → brief mới cho đúng slot đó.
    expect(planRequests(openai)).toHaveLength(plans + 1)
    expect((await preview(c.id)).items[0]).toMatchObject({ status: 'planned', imagePending: true })
  })

  it('route sai: chiến dịch lạ 404; slot của chiến dịch khác 404; nháp không duyệt được 409; chiến dịch đã xong 409; chưa đăng nhập 401', async () => {
    const { c, fb, slots } = await ready()
    const other = await created(body([{ pageId: fb, frequency: null }], { name: 'Khác' }))
    const s = slots[0]!
    const unknown = await action('0190a000-0000-7000-8000-000000000000', s.id, { action: 'cancel', version: s.version })
    expect(unknown.statusCode).toBe(404)
    const stranger = await action(other.id, s.id, { action: 'cancel', version: s.version })
    expect([stranger.statusCode, errorOf(stranger).code]).toEqual([404, 'NOT_FOUND'])
    expect((await api('GET', '/api/v1/campaigns/0190a000-0000-7000-8000-000000000000/preview')).statusCode).toBe(404)
    const approveDraft = await action(c.id, s.id, { action: 'approve', version: s.version })
    expect([approveDraft.statusCode, errorOf(approveDraft).code]).toEqual([409, 'VERSION_CONFLICT'])
    await handle.sql`update campaigns set status = 'done', started_at = now() where id = ${c.id}`
    const done = await action(c.id, s.id, { action: 'cancel', version: s.version })
    expect([done.statusCode, errorOf(done).code]).toEqual([409, 'VERSION_CONFLICT'])
    expect((await api('GET', `/api/v1/campaigns/${c.id}/preview`, undefined, false)).statusCode).toBe(401)
  })
})

/* ---------- Hai tab ---------- */

describe('PUT /campaigns/:id — baseUpdatedAt', () => {
  it('`baseUpdatedAt` cũ → 409 VERSION_CONFLICT, không đổi gì; đúng bản hiện tại → 200', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb, frequency: null }]))
    const fresh = await api('PUT', `/api/v1/campaigns/${c.id}`, { ...body([{ pageId: fb, frequency: null }], { name: 'Tab 1' }), baseUpdatedAt: c.updatedAt })
    expect(fresh.statusCode, fresh.body).toBe(200)
    const stale = await api('PUT', `/api/v1/campaigns/${c.id}`, { ...body([{ pageId: fb, frequency: null }], { name: 'Tab 2' }), baseUpdatedAt: c.updatedAt })
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'VERSION_CONFLICT'])
    expect(CampaignDto.parse((await api('GET', `/api/v1/campaigns/${c.id}`)).json()).name).toBe('Tab 1')
  })
})

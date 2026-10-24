// Ma trận Story 7.4 — Sinh nội dung cuốn chiếu và hàng đợi "Bài chờ duyệt" (AD-15, AD-13, AD-21, AD-7). Qua app thật
// (buildApp) + Postgres nhúng + pg-boss + OpenAI giả + Cloudinary giả; không gọi mạng. Phủ: cron `generate_window` (chỉ
// chiến dịch đang chạy), cửa sổ 3 ngày, idempotent + lease (hai lượt song song không tính tiền hai lần), lô 9 + lượt tiếp,
// "Tự đăng" (không ảnh / có ảnh qua job ảnh / giờ sát), lỗi AI / ảnh / hậu kiểm về "Chờ duyệt", khoá / hạn mức chặn (trước
// lượt, giữa lượt), ảnh kẹt, nháp kẹt, bắt đầu "Tự đăng" khi bài xem trước đang viết, Duyệt / quá giờ / Từ chối / Tạo lại
// qua route chung, route sai, hàng đợi theo phạm vi.
import { randomBytes } from 'node:crypto'
import {
  CampaignDto,
  CampaignSlotActionResponse,
  ErrorResponse,
  PendingSlotsResponse,
  SaveBrandProfileRequest,
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
import { GENERATE_BATCH, GenerateRetryableError, runGenerate, runGenerateWindow, runPreview } from '../src/modules/campaigns/index.ts'
import { generateImageAsset, handleImageGenerateJob } from '../src/modules/content/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-GENERATE-key-aaaa1111'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-GENERATE' }
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)
/** 00:00 giờ VN ngày bắt đầu — mốc cửa sổ cố định: 3 ngày tới = bài 11:30 của ngày 0, 1, 2. */
const START_MIDNIGHT = new Date(`${START}T00:00:00.000+07:00`)

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
  await handle.sql`delete from page_credentials`
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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-generate', { background: false })
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
  let n = 0
  openai.onResponse(() => ok(`Bài số ${++n} cho shop nhé`))
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

async function page(platform: Platform, opts: { brand?: Record<string, unknown> } = {}): Promise<string> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${account}, ${'Trang ' + platform}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse({ ...BRAND, ...opts.brand }))
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
    { name: 'Mẹo hay', share: 50 },
    { name: 'Hỏi đáp', share: 50 },
  ],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST', url: string, payload?: unknown, auth = true) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }
  if (auth) headers.cookie = cookie
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function draft(pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', body(pages, over))
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
/** Chiến dịch đã bắt đầu (bài xem trước chưa viết — mọi slot `planned` trên Lịch); dọn job do lưu / bắt đầu enqueue. */
async function running(pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const c = await draft(pages, over)
  const res = await api('POST', `/api/v1/campaigns/${c.id}/start`, {})
  expect(res.statusCode, res.body).toBe(200)
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate')`
  return c
}
const action = (id: string, targetId: string, payload: unknown, auth = true) => api('POST', `/api/v1/campaigns/${id}/slots/${targetId}/transition`, payload, auth)
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error

const deps = (now?: Date) => ({ db: handle.db, events, jobs, cipher, openai, log, ...(now ? { now: () => now } : {}) })
const gen = (id: string, now = START_MIDNIGHT, opts: { finalAttempt?: boolean; concurrency?: number } = {}) =>
  runGenerate(deps(now), id, { finalAttempt: opts.finalAttempt ?? false, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) })
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
const jobCount = async (name: string) =>
  (await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${name} and state in ('created', 'retry')`)[0]!.n
const jobsOf = <T>(name: string) => handle.sql<{ data: T; start_after: string }[]>`select data, start_after from pgboss.job where name = ${name} and state in ('created', 'retry') order by start_after`

interface SlotRow {
  id: string
  page_id: string
  status: string
  scheduled_at: string | null
  caption: string
  error_code: string | null
  cancel_reason: string | null
  version: number
  lease: string | null
}
const slotRows = (campaignId: string) =>
  handle.sql<SlotRow[]>`
    select id, page_id, status, scheduled_at, caption, error_code, cancel_reason, version, generate_lease_until as lease
    from post_targets where campaign_id = ${campaignId} order by slot_at, id`
const statuses = async (campaignId: string) => (await slotRows(campaignId)).map((r) => r.status)

/* ---------- Cron + cửa sổ ---------- */

describe('cron campaigns.generate_window + job campaigns.generate', () => {
  it('cron enqueue đúng chiến dịch đang chạy; job sinh slot trong 3 ngày tới (`campaign_generate`, `ref` = target) → chờ duyệt; slot ngoài cửa sổ giữ `planned`', async () => {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    const other = await draft([{ pageId: fb, frequency: null }], { name: 'Nháp' })
    const paused = await running([{ pageId: fb, frequency: null }], { name: 'Tạm dừng' })
    await handle.sql`update campaigns set status = 'paused', pause_reason = 'MANUAL', paused_at = now() where id = ${paused.id}`
    await handle.sql`delete from pgboss.job where name = 'campaigns.preview'`

    expect(await runGenerateWindow({ db: handle.db, events, jobs })).toEqual({ stuckImages: 0, generate: 1, preview: 0 })
    expect((await jobsOf<{ campaignId: string }>('campaigns.generate')).map((j) => j.data.campaignId)).toEqual([c.id])

    expect(await gen(c.id)).toMatchObject({ generated: 3, errors: 0, scheduled: 0, more: false })
    const rows = await slotRows(c.id)
    expect(rows.map((r) => r.status)).toEqual([...Array(3).fill('pending_approval'), ...Array(27).fill('planned')])
    expect(rows.slice(0, 3).every((r) => r.caption !== '' && r.error_code === null && r.lease === null)).toBe(true)
    const usage = await handle.sql<{ feature: string; page_id: string; ref: string }[]>`select feature, page_id, ref from ai_usage`
    expect(usage.every((u) => u.feature === 'campaign_generate' && u.page_id === fb)).toBe(true)
    expect(new Set(usage.map((u) => u.ref))).toEqual(new Set(rows.slice(0, 3).map((r) => r.id)))
    // Không đăng gì ở chế độ "Duyệt trước"; chiến dịch khác không bị đụng.
    expect(await jobCount('publish.target')).toBe(0)
    expect(await gen(paused.id)).toBe('skipped')
    expect(await gen(other.id)).toBe('skipped')
    expect(emittedOf('post_target.updated').filter((e) => e.campaignId === c.id)).toHaveLength(3)
  })

  it('idempotent: chạy lại không gọi AI; hai lượt song song → mỗi slot đúng một lời gọi; slot đang có lease bỏ qua tới khi hết hạn', async () => {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    const [a, b] = await Promise.all([gen(c.id), gen(c.id)])
    expect([a, b].map((r) => (typeof r === 'object' && 'generated' in r ? r.generated : -1)).reduce((x, y) => x + y, 0)).toBe(3)
    expect(openai.responseRequests).toHaveLength(3)
    expect(await gen(c.id)).toMatchObject({ generated: 0 })
    expect(openai.responseRequests).toHaveLength(3)
    expect((await handle.sql<{ n: number }[]>`select count(*)::int as n from ai_usage`)[0]!.n).toBe(3)

    // Slot ngày 3 đang bị một lượt khác giữ → lượt này không viết; lease hết hạn → viết.
    const day3 = (await slotRows(c.id))[3]!
    await handle.sql`update post_targets set generate_lease_until = now() + interval '5 minutes' where id = ${day3.id}`
    const later = new Date(START_MIDNIGHT.getTime() + DAY)
    expect(await gen(c.id, later)).toMatchObject({ generated: 0 })
    await handle.sql`update post_targets set generate_lease_until = now() - interval '1 minute' where id = ${day3.id}`
    expect(await gen(c.id, later)).toMatchObject({ generated: 1 })
    expect((await slotRows(c.id))[3]).toMatchObject({ status: 'pending_approval', lease: null })
  })

  it(`lô ${GENERATE_BATCH} slot: còn slot trong cửa sổ → enqueue lượt tiếp; lượt cuối không enqueue`, async () => {
    const fb = await page('facebook')
    const th = await page('threads')
    const c = await running(
      [
        { pageId: fb, frequency: null },
        { pageId: th, frequency: null },
      ],
      { defaultFrequency: '3_per_day', postTimes: ['08:00', '12:00', '20:00'] },
    )
    expect(await gen(c.id)).toMatchObject({ generated: 9, more: true })
    expect(await jobCount('campaigns.generate')).toBe(1)
    await handle.sql`delete from pgboss.job where name = 'campaigns.generate'`
    expect(await gen(c.id)).toMatchObject({ generated: 9, more: false })
    expect(await jobCount('campaigns.generate')).toBe(0)
    expect((await statuses(c.id)).filter((s) => s === 'pending_approval')).toHaveLength(18)
  })

  it('lỗi tạm OpenAI: lượt chưa cuối ném GenerateRetryableError, slot vẫn `planned` và trả lease; lượt cuối → `pending_approval AI_PROVIDER_ERROR`', async () => {
    openai.onResponse({ ok: false, kind: 'TRANSIENT', status: 503, maybeBilled: false })
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    await expect(gen(c.id)).rejects.toBeInstanceOf(GenerateRetryableError)
    expect((await slotRows(c.id)).slice(0, 3).every((r) => r.status === 'planned' && r.lease === null)).toBe(true)
    await gen(c.id, START_MIDNIGHT, { finalAttempt: true })
    expect((await slotRows(c.id)).slice(0, 3).map((r) => [r.status, r.error_code])).toEqual(Array.from({ length: 3 }, () => ['pending_approval', 'AI_PROVIDER_ERROR']))
  })
})

/* ---------- Tự đăng ---------- */

describe('chế độ "Tự đăng"', () => {
  it('slot không ảnh → `scheduled` + job `publish.target` đúng giờ; slot còn dưới 2 phút → `pending_approval SCHEDULE_IN_PAST`', async () => {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }], { mode: 'auto' })
    const first = (await slotRows(c.id))[0]!
    // Mốc: 1 phút trước bài đầu → bài đầu không kịp duyệt; bài ngày 1, 2 lên lịch.
    const now = new Date(Date.parse(first.scheduled_at!) - MIN)
    expect(await gen(c.id, now)).toMatchObject({ generated: 3, scheduled: 2 })
    const rows = await slotRows(c.id)
    expect(rows.slice(0, 3).map((r) => [r.status, r.error_code])).toEqual([
      ['pending_approval', 'SCHEDULE_IN_PAST'],
      ['scheduled', null],
      ['scheduled', null],
    ])
    const publish = await jobsOf<{ targetId: string }>('publish.target')
    expect(publish.map((j) => j.data.targetId)).toEqual([rows[1]!.id, rows[2]!.id])
    expect(new Date(publish[0]!.start_after).getTime()).toBe(Date.parse(rows[1]!.scheduled_at!))
  })

  it('slot có ảnh: chờ job ảnh (payload `autoApprove`) rồi mới `scheduled`; ảnh bị từ chối → `pending_approval IMAGE_REJECTED`, không đăng', async () => {
    const ig = await page('instagram')
    const c = await running([{ pageId: ig, frequency: null }], { mode: 'auto' })
    expect(await gen(c.id)).toMatchObject({ generated: 3, scheduled: 0 })
    expect((await statuses(c.id)).slice(0, 3)).toEqual(['planned', 'planned', 'planned'])
    const imageJobs = await jobsOf<{ mediaAssetId: string; autoApprove?: boolean }>('content.image.generate')
    expect(imageJobs).toHaveLength(3)
    expect(imageJobs.every((j) => j.data.autoApprove === true)).toBe(true)

    const imageDeps = { db: handle.db, events, jobs, cipher, openai, log, media }
    expect(await handleImageGenerateJob(imageDeps, { data: imageJobs[0]!.data, retryCount: 0, retryLimit: 2 })).toBe('ready')
    openai.onImage({ ok: false, kind: 'CONTENT_REJECTED', status: 400 })
    expect(await handleImageGenerateJob(imageDeps, { data: imageJobs[1]!.data, retryCount: 0, retryLimit: 2 })).toBe('failed')
    const rows = await slotRows(c.id)
    const byAsset = await handle.sql<{ post_target_id: string; media_asset_id: string }[]>`select post_target_id, media_asset_id from post_target_media`
    const firstTarget = byAsset.find((m) => m.media_asset_id === imageJobs[0]!.data.mediaAssetId)!.post_target_id
    expect(rows.find((r) => r.id === firstTarget)).toMatchObject({ status: 'scheduled', error_code: null })
    expect(rows.filter((r) => r.error_code === 'IMAGE_REJECTED').map((r) => r.status)).toEqual(['pending_approval'])
    expect((await jobsOf<{ targetId: string }>('publish.target')).map((j) => j.data.targetId)).toEqual([firstTarget])
  })

  it('hậu kiểm chặn cả hai lần → `pending_approval AI_POLICY_BLOCKED` kể cả "Tự đăng", không đăng, slot không bị xoá', async () => {
    openai.onResponse(ok('Siêu GIẢM GIÁ hôm nay'))
    const fb = await page('facebook', { brand: { bannedWords: ['giảm giá'] } })
    const c = await running([{ pageId: fb, frequency: null }], { mode: 'auto' })
    expect(await gen(c.id)).toMatchObject({ generated: 0, errors: 3, scheduled: 0 })
    const rows = await slotRows(c.id)
    expect(rows).toHaveLength(30)
    expect(rows.slice(0, 3).map((r) => [r.status, r.error_code, r.caption])).toEqual(
      Array.from({ length: 3 }, () => ['pending_approval', 'AI_POLICY_BLOCKED', 'Siêu GIẢM GIÁ hôm nay']),
    )
    expect(await jobCount('publish.target')).toBe(0)
  })

  it('bắt đầu khi bài xem trước đang viết → lượt preview xong enqueue `campaigns.generate`, lượt đó duyệt mọi bài xem trước không lỗi', async () => {
    const fb = await page('facebook')
    const c = await draft([{ pageId: fb, frequency: null }], { mode: 'auto' })
    let n = 0
    openai.onResponse(async () => {
      // Lời gọi đầu: chủ shop bấm "Bắt đầu" đúng lúc AI đang viết.
      if (++n === 1) expect((await api('POST', `/api/v1/campaigns/${c.id}/start`, {})).statusCode).toBe(200)
      return ok(`Bài số ${n} cho shop nhé`)
    })
    await handle.sql`delete from pgboss.job where name = 'campaigns.generate'`
    await runPreview(deps(), c.id, { finalAttempt: false })
    expect(await jobCount('campaigns.generate')).toBe(1)
    expect((await statuses(c.id)).slice(0, 7).some((s) => s === 'pending_approval')).toBe(true)
    await gen(c.id)
    expect((await statuses(c.id)).slice(0, 7)).toEqual(Array(7).fill('scheduled'))
  })
})

/* ---------- Khoá / hạn mức ---------- */

describe('hạn mức AI', () => {
  it('khoá chưa nhập / hạn mức đã hết trước lượt → `stopped`, không gọi AI, slot giữ `planned`', async () => {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    expect(await gen(c.id)).toEqual({ stopped: 'OPENAI_KEY_MISSING', approved: 0 })
    await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
    await settle(
      { db: handle.db, events },
      { reservationId: null, month: '2026-10', feature: 'compose_caption', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } },
    )
    await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
    expect(await gen(c.id)).toEqual({ stopped: 'AI_BUDGET_EXCEEDED', approved: 0 })
    expect(openai.responseRequests).toHaveLength(0)
    expect(await statuses(c.id)).toEqual(Array(30).fill('planned'))
  })

  it('hết hạn mức giữa lượt → slot gặp lỗi `AI_BUDGET_EXCEEDED`, slot còn lại giữ `planned`, không enqueue lượt tiếp, không vượt hạn mức', async () => {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 1_000_000 })
    let n = 0
    openai.onResponse(async () => {
      // Lời gọi đầu xong thì hạn mức tháng đã dùng hết (tính cả lời gọi khác).
      if (++n === 1) await handle.sql`update ai_budget_months set spent_vnd = 1000000`
      return ok(`Bài số ${n} cho shop nhé`)
    })
    expect(await gen(c.id, START_MIDNIGHT, { concurrency: 1 })).toMatchObject({ generated: 1, errors: 1, more: false, stopCode: 'AI_BUDGET_EXCEEDED' })
    const rows = await slotRows(c.id)
    expect(rows.slice(0, 3).map((r) => [r.status, r.error_code])).toEqual([
      ['pending_approval', null],
      ['pending_approval', 'AI_BUDGET_EXCEEDED'],
      ['planned', null],
    ])
    expect(openai.responseRequests).toHaveLength(1)
    expect(await jobCount('campaigns.generate')).toBe(0)
  })
})

/* ---------- Slot kẹt ---------- */

describe('dọn slot kẹt', () => {
  it('ô ảnh `pending` quá 15 phút → ô `failed IMAGE_FAILED`, slot `pending_approval IMAGE_FAILED`; job ảnh tới muộn → skipped', async () => {
    const ig = await page('instagram')
    const c = await running([{ pageId: ig, frequency: null }])
    await gen(c.id)
    const [asset] = await handle.sql<{ id: string }[]>`select id from media_assets order by created_at limit 1`
    await handle.sql`update media_assets set created_at = now() - interval '16 minutes' where id = ${asset!.id}`
    expect(await runGenerateWindow({ db: handle.db, events, jobs })).toMatchObject({ stuckImages: 1 })
    const [row] = await handle.sql<{ status: string; error_code: string }[]>`select status, error_code from media_assets where id = ${asset!.id}`
    expect(row).toEqual({ status: 'failed', error_code: 'IMAGE_FAILED' })
    const rows = await slotRows(c.id)
    expect(rows.filter((r) => r.error_code === 'IMAGE_FAILED').map((r) => r.status)).toEqual(['pending_approval'])
    expect(await generateImageAsset({ ...deps(), media }, asset!.id, { finalAttempt: false })).toBe('skipped')
    // Chạy lại không chốt thêm.
    expect(await runGenerateWindow({ db: handle.db, events, jobs })).toMatchObject({ stuckImages: 0 })
  })

  it('nháp có bài xem trước chưa viết đứng yên 20 phút → enqueue lại `campaigns.preview`; vừa lưu / đang có lease → không', async () => {
    const fb = await page('facebook')
    const stale = await draft([{ pageId: fb, frequency: null }], { name: 'Kẹt' })
    const fresh = await draft([{ pageId: fb, frequency: null }], { name: 'Mới' })
    const leased = await draft([{ pageId: fb, frequency: null }], { name: 'Đang viết' })
    await handle.sql`update post_targets set updated_at = now() - interval '20 minutes' where campaign_id in (${stale.id}, ${leased.id})`
    await handle.sql`update post_targets set generate_lease_until = now() + interval '5 minutes' where campaign_id = ${leased.id}`
    await handle.sql`delete from pgboss.job where name = 'campaigns.preview'`
    expect(await runGenerateWindow({ db: handle.db, events, jobs })).toEqual({ stuckImages: 0, generate: 0, preview: 1 })
    expect((await jobsOf<{ campaignId: string }>('campaigns.preview')).map((j) => j.data.campaignId)).toEqual([stale.id])
    expect(fresh.id).not.toBe(stale.id)
  })
})

/* ---------- Duyệt / Từ chối / Tạo lại (route chung) ---------- */

describe('POST /campaigns/:id/slots/:targetId/transition — chiến dịch đang chạy', () => {
  async function pending() {
    const fb = await page('facebook')
    const c = await running([{ pageId: fb, frequency: null }])
    await gen(c.id)
    return { c, fb, rows: await slotRows(c.id) }
  }

  it('Duyệt: `scheduled` + job `publish.target startAfter` + `post_target.updated`; version lệch 409', async () => {
    const { c, rows } = await pending()
    const s = rows[0]!
    const res = await action(c.id, s.id, { action: 'approve', version: s.version })
    expect(res.statusCode, res.body).toBe(200)
    const slot = CampaignSlotActionResponse.parse(res.json()).slot
    expect(slot).toMatchObject({ id: s.id, status: 'scheduled', scheduledAt: new Date(s.scheduled_at!).toISOString(), errorCode: null })
    const publish = await jobsOf<{ targetId: string }>('publish.target')
    expect(publish.map((j) => j.data.targetId)).toEqual([s.id])
    expect(new Date(publish[0]!.start_after).getTime()).toBe(Date.parse(s.scheduled_at!))
    expect(emittedOf('post_target.updated').some((e) => e.id === s.id && e.version === slot.version)).toBe(true)
    const stale = await action(c.id, rows[1]!.id, { action: 'approve', version: rows[1]!.version - 1 })
    expect([stale.statusCode, errorOf(stale).code]).toEqual([409, 'VERSION_CONFLICT'])
    // Hậu kiểm chặn → 422, không lên lịch (phải Sửa trước).
    await handle.sql`update post_targets set error_code = 'AI_POLICY_BLOCKED' where id = ${rows[2]!.id}`
    const blocked = await action(c.id, rows[2]!.id, { action: 'approve', version: rows[2]!.version })
    expect([blocked.statusCode, errorOf(blocked).code]).toEqual([422, 'AI_POLICY_BLOCKED'])
    expect((await slotRows(c.id))[2]).toMatchObject({ status: 'pending_approval' })
  })

  it('Duyệt bài quá giờ / còn dưới 2 phút → 422 SCHEDULE_IN_PAST, không đổi; gửi giờ mới → `scheduled` đúng giờ đó', async () => {
    const { c, rows } = await pending()
    const s = rows[0]!
    await handle.sql`update post_targets set scheduled_at = now() + interval '1 minute' where id = ${s.id}`
    const past = await action(c.id, s.id, { action: 'approve', version: s.version })
    expect([past.statusCode, errorOf(past).code]).toEqual([422, 'SCHEDULE_IN_PAST'])
    expect((await slotRows(c.id))[0]).toMatchObject({ status: 'pending_approval', version: s.version })
    const at = new Date(Math.ceil((Date.now() + 2 * 60 * MIN) / MIN) * MIN).toISOString()
    const res = await action(c.id, s.id, { action: 'approve', version: s.version, scheduledAt: at })
    expect(res.statusCode, res.body).toBe(200)
    expect(CampaignSlotActionResponse.parse(res.json()).slot).toMatchObject({ status: 'scheduled', scheduledAt: at })
  })

  it('Từ chối → `cancelled USER_REJECTED` + `post_target.cancelled`; slot chưa viết → 409', async () => {
    const { c, rows } = await pending()
    const res = await action(c.id, rows[0]!.id, { action: 'reject', version: rows[0]!.version })
    expect(res.statusCode, res.body).toBe(200)
    expect((await slotRows(c.id))[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'USER_REJECTED' })
    expect(emittedOf('post_target.cancelled')).toEqual([expect.objectContaining({ id: rows[0]!.id, campaignId: c.id })])
    const planned = await action(c.id, rows[5]!.id, { action: 'reject', version: rows[5]!.version })
    expect([planned.statusCode, errorOf(planned).code]).toEqual([409, 'VERSION_CONFLICT'])
  })

  it('Tạo lại: `planned`, caption rỗng; `immediate` → enqueue `campaigns.generate` (lượt đó viết lại), không thì chờ cron', async () => {
    const { c, rows } = await pending()
    const later = await action(c.id, rows[1]!.id, { action: 'regenerate', version: rows[1]!.version })
    expect(later.statusCode, later.body).toBe(200)
    expect(CampaignSlotActionResponse.parse(later.json()).slot).toMatchObject({ status: 'planned', caption: '', aiCaption: false })
    expect(await jobCount('campaigns.generate')).toBe(0)
    const now = await action(c.id, rows[0]!.id, { action: 'regenerate', version: rows[0]!.version, immediate: true })
    expect(now.statusCode, now.body).toBe(200)
    expect(await jobCount('campaigns.generate')).toBe(1)
    const calls = openai.responseRequests.length
    expect(await gen(c.id)).toMatchObject({ generated: 2 })
    expect(openai.responseRequests).toHaveLength(calls + 2)
    expect((await statuses(c.id)).slice(0, 3)).toEqual(Array(3).fill('pending_approval'))
  })

  it('route sai: slot của chiến dịch khác 404; chiến dịch lạ 404; body lạ 400; chưa đăng nhập 401', async () => {
    const { c, fb, rows } = await pending()
    const other = await running([{ pageId: fb, frequency: null }], { name: 'Khác' })
    const stranger = await action(other.id, rows[0]!.id, { action: 'approve', version: rows[0]!.version })
    expect([stranger.statusCode, errorOf(stranger).code]).toEqual([404, 'NOT_FOUND'])
    expect((await action('0190a000-0000-7000-8000-000000000000', rows[0]!.id, { action: 'approve', version: 0 })).statusCode).toBe(404)
    expect((await action(c.id, rows[0]!.id, { action: 'approve', version: 0, extra: 1 })).statusCode).toBe(400)
    expect((await action(c.id, rows[0]!.id, { action: 'approve', version: rows[0]!.version }, false)).statusCode).toBe(401)
  })
})

/* ---------- Hàng đợi ---------- */

describe('GET /campaigns/pending-slots', () => {
  it('bài chờ duyệt của chiến dịch đã bắt đầu theo giờ, kèm tên / chế độ; lọc theo trang của phạm vi; bài xem trước của nháp không vào; scope sai 400 / lạ 404', async () => {
    const a = await page('facebook')
    const b = await page('threads')
    const ca = await running([{ pageId: a, frequency: null }], { name: 'Chiến dịch A' })
    const cb = await running([{ pageId: b, frequency: null }], { name: 'Chiến dịch B', mode: 'auto' })
    await gen(ca.id)
    await handle.sql`update post_targets set status = 'pending_approval', caption = 'Bài B', error_code = 'AI_POLICY_BLOCKED' where campaign_id = ${cb.id} and slot_at = (select min(slot_at) from post_targets where campaign_id = ${cb.id})`
    const preview = await draft([{ pageId: a, frequency: null }], { name: 'Nháp' })
    await runPreview(deps(), preview.id, { finalAttempt: false })

    const all = await api('GET', '/api/v1/campaigns/pending-slots')
    expect(all.statusCode, all.body).toBe(200)
    const items = PendingSlotsResponse.parse(all.json())
    expect(items.truncated).toBe(false)
    expect(items.items).toHaveLength(4)
    expect(items.items.map((s) => s.scheduledAt)).toEqual(items.items.map((s) => s.scheduledAt).sort())
    expect(new Set(items.items.map((s) => s.campaignName))).toEqual(new Set(['Chiến dịch A', 'Chiến dịch B']))
    expect(items.items.find((s) => s.campaignId === cb.id)).toMatchObject({ campaignMode: 'auto', errorCode: 'AI_POLICY_BLOCKED', caption: 'Bài B' })

    const onlyA = PendingSlotsResponse.parse((await api('GET', `/api/v1/campaigns/pending-slots?scope=page:${a}`)).json())
    expect(onlyA.items.map((s) => s.campaignId)).toEqual([ca.id, ca.id, ca.id])
    expect((await api('GET', '/api/v1/campaigns/pending-slots?scope=bad')).statusCode).toBe(400)
    expect((await api('GET', '/api/v1/campaigns/pending-slots?scope=page:00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await api('GET', '/api/v1/campaigns/pending-slots', undefined, false)).statusCode).toBe(401)
    // Trang đã gỡ → bài của trang đó rời hàng đợi (cả phạm vi "Tất cả").
    await handle.sql`update pages set removed_at = now() where id = ${b}`
    const live = PendingSlotsResponse.parse((await api('GET', '/api/v1/campaigns/pending-slots')).json())
    expect(live.items.map((s) => s.campaignId)).toEqual([ca.id, ca.id, ca.id])
  })
})

// Ma trận Story 7.8 — Kế hoạch nội dung theo từng bài (brief từng slot trước khi viết; caption + ảnh từ brief). Qua app thật
// (buildApp) + Postgres nhúng + pg-boss + OpenAI giả; không gọi mạng. Phủ: xem trước (1 lời gọi kế hoạch / trang / lô, brief
// lưu từng slot, DTO có nhãn, caption theo brief + câu mở gần nhất), cuốn chiếu (ngữ cảnh bài cũ + đếm định dạng, 2 trang),
// JSON hỏng / thiếu slot / từ cấm → `failed`, lỗi chưa tính tiền → để trống, có thể đã tính tiền → `failed`, retry không lên
// lại, hai job cùng lúc, chiến dịch thôi chạy, ảnh từ brief, Tạo lại → brief mới, Lịch có tiêu đề / định dạng kế hoạch.
import { randomBytes } from 'node:crypto'
import {
  CONTENT_FORMATS,
  CalendarResponse,
  CampaignDto,
  CampaignPreviewResponse,
  CampaignSlotActionResponse,
  SaveBrandProfileRequest,
  type SaveCampaignRequest,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseRequest, CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { FORMAT_GUIDE, IMAGE_NO_FAKE_UI, setOpenAiKey } from '../src/modules/ai/index.ts'
import { PreviewRetryableError, runGenerate, runPreview } from '../src/modules/campaigns/index.ts'
import { runSlotBatch } from '../src/modules/campaigns/runner.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { captionRequests, fakePlanPost, isPlanRequest, planJsonFor, planRequests } from './helpers/plan.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-PLAN-key-aaaa1111'
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some', industry: 'Đồ gia dụng' } as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)
const START_MIDNIGHT = new Date(`${START}T00:00:00.000+07:00`)

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
let app: FastifyInstance
let cookie: string

async function cleanup() {
  await handle.sql`delete from posts`
  await handle.sql`delete from campaigns`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from knowledge_items`
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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-plan', { background: false })
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
  planned()
  app = buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, ai: { cipher, openai } })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })

/** OpenAI giả: kế hoạch → JSON đủ bài (`plan` đổi được), caption → "Bài số n" (dòng đầu khác nhau theo lần gọi). */
function planned(plan: (req: CreateResponseRequest) => CreateResponseResult = (req) => ok(planJsonFor(req)), caption?: (n: number) => CreateResponseResult) {
  let n = 0
  openai.onResponse((req) => (isPlanRequest(req) ? plan(req) : (caption?.(++n) ?? ok(`Bài số ${++n}\nThân bài viết theo kế hoạch.`))))
}

type Platform = 'facebook' | 'instagram' | 'threads'
async function page(platform: Platform, brand: Record<string, unknown> = {}): Promise<string> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${account}, ${'Trang ' + platform}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse({ ...BRAND, ...brand }))
  return p!.id
}

const body = (pageIds: string[], over: Partial<SaveCampaignRequest> = {}): SaveCampaignRequest => ({
  name: 'Gia dụng – tăng tương tác 30 ngày',
  goal: 'engage',
  startDate: START,
  durationDays: 30,
  groupId: null,
  defaultFrequency: '1_per_day',
  pages: pageIds.map((pageId) => ({ pageId, frequency: null })),
  topics: [{ name: 'Mẹo hay', share: 100 }],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json', cookie }
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function draft(pageIds: string[], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', body(pageIds, over))
  expect(res.statusCode, res.body).toBe(201)
  await handle.sql`delete from pgboss.job where name = 'campaigns.preview'`
  return CampaignDto.parse(res.json())
}
async function start(id: string) {
  const res = await api('POST', `/api/v1/campaigns/${id}/start`, {})
  expect(res.statusCode, res.body).toBe(200)
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate')`
}
async function preview(id: string) {
  const res = await api('GET', `/api/v1/campaigns/${id}/preview`)
  expect(res.statusCode, res.body).toBe(200)
  return CampaignPreviewResponse.parse(res.json())
}

const deps = () => ({ db: handle.db, events, jobs, cipher, openai, log })
const runJob = (id: string, opts: { finalAttempt?: boolean; concurrency?: number } = {}) =>
  runPreview(deps(), id, { finalAttempt: opts.finalAttempt ?? false, concurrency: opts.concurrency ?? 1 })

interface Row {
  id: string
  page_id: string
  status: string
  caption: string
  plan: { status: string; title?: string; format?: string } | null
}
const rows = (campaignId: string) =>
  handle.sql<Row[]>`select id, page_id, status, caption, plan from post_targets where campaign_id = ${campaignId} order by slot_at, id`
const inputOf = (r: CreateResponseRequest) => r.input as string
/** Khối "Các bài gần đây" của input caption ('' khi không có). */
const recentPart = (r: CreateResponseRequest) => inputOf(r).split('\n\n').find((p) => p.startsWith('Các bài gần đây')) ?? ''
/** Số bài một lời gọi kế hoạch hỏi. */
const askedCount = (r: CreateResponseRequest) => Number(/Hãy lên brief cho (\d+) bài/.exec(inputOf(r))?.[1] ?? 0)

/* ---------- Xem trước + cuốn chiếu ---------- */

describe('kế hoạch nội dung theo lô', () => {
  it('xem trước: 1 lời gọi kế hoạch (jsonSchema, `campaign_generate`, ref = chiến dịch) trước 7 caption; brief lưu từng slot; DTO có nhãn; caption theo brief + câu mở gần nhất; Hỏi đáp viết ngắn', async () => {
    const fb = await page('facebook')
    const c = await draft([fb])
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })

    const plans = planRequests(openai)
    expect(plans).toHaveLength(1)
    expect(isPlanRequest(openai.responseRequests[0]!)).toBe(true)
    expect(inputOf(plans[0]!)).toContain('Hãy lên brief cho 7 bài')
    expect(inputOf(plans[0]!)).toContain('chủ đề «Mẹo hay» · không ảnh')
    expect(inputOf(plans[0]!)).toContain(`Chiến dịch: «${c.name}»`)
    expect(inputOf(plans[0]!)).toContain('Các bài đã có: (chưa có)')
    expect(plans[0]!.instructions).toContain('Mục tiêu chiến dịch: tăng tương tác')
    const usage = await handle.sql<{ feature: string; page_id: string }[]>`select feature, page_id from ai_usage where ref = ${c.id}`
    expect(usage).toEqual([{ feature: 'campaign_generate', page_id: fb }])

    const saved = await rows(c.id)
    expect(saved.map((r) => [r.plan?.status, r.plan?.format])).toEqual(CONTENT_FORMATS.slice(0, 7).map((f) => ['ok', f]))
    const p = await preview(c.id)
    expect(p.items.map((s) => s.plan)).toEqual(
      CONTENT_FORMATS.slice(0, 7).map((format, i) => ({ format, funnelStage: 'awareness', title: `Tiêu đề ${i + 1}`, angle: `Góc nội dung số ${i + 1}` })),
    )

    const caps = captionRequests(openai)
    expect(caps).toHaveLength(7)
    expect(inputOf(caps[0]!)).toContain('Ý tưởng bài: «Mẹo hay»')
    expect(inputOf(caps[0]!)).toContain('Kế hoạch bài:\n- Định dạng: Mẹo')
    expect(inputOf(caps[0]!)).toContain('- Góc nội dung: «Góc nội dung số 1»')
    expect(inputOf(caps[0]!)).toContain('- Câu mở gợi ý: «Câu mở số 1?»')
    expect(caps[0]!.instructions).toContain(`Định dạng bài: ${FORMAT_GUIDE.tip}.`)
    // Bài 5 = Hỏi đáp → ngắn; còn lại vừa.
    expect(caps.map((r) => (r.instructions!.includes('Độ dài: ngắn') ? 'short' : 'medium'))).toEqual(['medium', 'medium', 'medium', 'medium', 'short', 'medium', 'medium'])
    // Bài 2 (viết tuần tự): câu mở caption bài 1 đã viết + câu mở brief bài 3 chưa viết; không có câu mở của chính nó.
    const recent = recentPart(caps[1]!)
    expect(recent).toContain('«Bài số 1»')
    expect(recent).toContain('«Câu mở số 3?»')
    expect(recent).not.toContain('Câu mở số 2?')
    expect(recent.split('\n').length - 1).toBeLessThanOrEqual(6)
  })

  it('cuốn chiếu: lô sau có ngữ cảnh brief bài cũ + đếm định dạng của đúng trang; 2 trang → mỗi trang một lời gọi', async () => {
    const fb = await page('facebook')
    const th = await page('threads')
    const c = await draft([fb, th])
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    const previewPlans = planRequests(openai)
    expect(previewPlans.map(askedCount).sort()).toEqual([3, 4])
    await start(c.id)

    // Cửa sổ tới hết ngày 6 (không cận dưới): Facebook ngày 4–6, Threads ngày 3–6 (bài ngày 3 không thuộc 7 bài xem trước).
    const before = planRequests(openai).length
    expect(await runGenerate({ ...deps(), now: () => new Date(START_MIDNIGHT.getTime() + 4 * DAY) }, c.id, { finalAttempt: false, concurrency: 1 })).toMatchObject({
      generated: 7,
      errors: 0,
    })
    const later = planRequests(openai).slice(before)
    expect(later.map(askedCount).sort()).toEqual([3, 4])
    const planUsage = await handle.sql<{ page_id: string }[]>`select page_id from ai_usage where ref = ${c.id}`
    expect(planUsage.filter((u) => u.page_id === fb)).toHaveLength(2)
    expect(planUsage.filter((u) => u.page_id === th)).toHaveLength(2)
    const fbPlan = inputOf(later.find((r) => inputOf(r).includes('(Facebook)'))!)
    // Trang Facebook có 4 bài xem trước (Mẹo, Giới thiệu SP, Hướng dẫn, So sánh) — không lẫn bài của Threads.
    expect(fbPlan).toContain('Các bài đã có của chiến dịch trên trang này')
    expect(fbPlan).toContain('- [Mẹo] «Tiêu đề 1» | góc: «Góc nội dung số 1» | câu mở: «Bài số')
    expect(fbPlan).toContain('Định dạng đã dùng: Mẹo 1, Giới thiệu SP 1, Hướng dẫn 1, So sánh 1')
    expect((await rows(c.id)).filter((r) => r.plan?.status === 'ok')).toHaveLength(14)
  })
})

describe('kho kiến thức', () => {
  it('kho `ready` của trang (Story 5.2) vào ngữ cảnh kế hoạch, trong «»; mục chưa trích xong không vào', async () => {
    const fb = await page('facebook')
    await handle.sql`insert into knowledge_items (owner_type, owner_id, kind, title, text, status, token_count)
      values ('page', ${fb}, 'faq', 'Ưu đãi tháng này', 'Giảm 10% cho đơn đầu tiên', 'ready', 20),
             ('page', ${fb}, 'file', 'Tài liệu đang trích', null, 'processing', 0)`
    const c = await draft([fb])
    await runJob(c.id)
    const input = inputOf(planRequests(openai)[0]!)
    expect(input).toContain('Kho kiến thức của shop:\n- [Hỏi đáp] «Ưu đãi tháng này»: «Giảm 10% cho đơn đầu tiên»')
    expect(input).not.toContain('Tài liệu đang trích')
  })
})

/* ---------- Lỗi kế hoạch ---------- */

describe('kế hoạch lỗi không chặn bài', () => {
  it('JSON hỏng → mọi slot `failed`, viết như cũ (không "Kế hoạch bài", vẫn có câu mở gần nhất); lượt sau không lên lại', async () => {
    planned(() => ok('Kế hoạch đây nè'))
    const fb = await page('facebook')
    const c = await draft([fb])
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    expect((await rows(c.id)).every((r) => r.plan?.status === 'failed' && r.status === 'pending_approval')).toBe(true)
    expect((await preview(c.id)).items.every((s) => s.plan === null)).toBe(true)
    const caps = captionRequests(openai)
    expect(caps.every((r) => !inputOf(r).includes('Kế hoạch bài'))).toBe(true)
    expect(recentPart(caps[1]!)).toContain('«Bài số 1»')

    // Slot chưa viết xong (vd lượt bị dừng) mà đã `failed` → lượt sau viết, không gọi kế hoạch lại.
    const one = (await rows(c.id))[2]!
    await handle.sql`update post_targets set status = 'planned', caption = '', ai_caption = false where id = ${one.id}`
    expect(await runJob(c.id)).toEqual({ generated: 1, errors: 0 })
    expect(planRequests(openai)).toHaveLength(1)
  })

  it('đầu ra thiếu slot / slot lạ / slot trùng / từ cấm → slot đó `failed`, slot khác `ok`', async () => {
    planned((req) =>
      ok(
        JSON.stringify({
          posts: [
            fakePlanPost(1),
            fakePlanPost(1, { title: 'Bản trùng' }),
            fakePlanPost(2, { title: 'Siêu giảm giá sốc' }),
            fakePlanPost(3),
            fakePlanPost(5),
            fakePlanPost(6),
            fakePlanPost(7),
            fakePlanPost(99),
          ].filter(() => askedCount(req) === 7),
        }),
      ),
    )
    const fb = await page('facebook', { bannedWords: ['giảm giá'] })
    const c = await draft([fb])
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    expect((await rows(c.id)).map((r) => (r.plan?.status === 'ok' ? r.plan.title : r.plan?.status))).toEqual([
      'Tiêu đề 1',
      'failed',
      'Tiêu đề 3',
      'failed',
      'Tiêu đề 5',
      'Tiêu đề 6',
      'Tiêu đề 7',
    ])
  })

  it('lỗi chưa tính tiền (429) → `plan` để trống, bài vẫn viết; có thể đã tính tiền (hết giờ sau khi gửi) → `failed`, không gọi lại', async () => {
    planned(() => ({ ok: false, kind: 'RATE_LIMITED', status: 429 }))
    const fb = await page('facebook')
    const c = await draft([fb])
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    expect((await rows(c.id)).every((r) => r.plan === null && r.status === 'pending_approval')).toBe(true)

    planned(() => ({ ok: false, kind: 'TRANSIENT', maybeBilled: true }))
    const th = await page('threads')
    const c2 = await draft([th], { name: 'Chiến dịch 2' })
    expect(await runJob(c2.id)).toEqual({ generated: 7, errors: 0 })
    expect((await rows(c2.id)).every((r) => r.plan?.status === 'failed')).toBe(true)
    const estimated = await handle.sql<{ estimated: boolean }[]>`select estimated from ai_usage where ref = ${c2.id}`
    expect(estimated).toEqual([{ estimated: true }])
  })

  it('retry: lỗi tạm ở caption sau khi đã lưu brief → lượt retry không lên kế hoạch lại', async () => {
    planned(undefined, (n) => (n === 1 ? { ok: false, kind: 'RATE_LIMITED', status: 429 } : ok(`Bài số ${n}`)))
    const fb = await page('facebook')
    const c = await draft([fb])
    await expect(runJob(c.id)).rejects.toBeInstanceOf(PreviewRetryableError)
    expect((await rows(c.id)).every((r) => r.plan?.status === 'ok')).toBe(true)
    expect(await runJob(c.id)).toEqual({ generated: 1, errors: 0 })
    expect(planRequests(openai)).toHaveLength(1)
    expect((await rows(c.id)).every((r) => r.status === 'pending_approval')).toBe(true)
  })

  it('model từ chối lời gọi kế hoạch (đã tính tiền) → `failed`; lượt retry không gọi kế hoạch lại', async () => {
    planned(
      () => ({ ...ok(''), incomplete: 'refusal' }),
      (n) => (n === 1 ? { ok: false, kind: 'RATE_LIMITED', status: 429 } : ok(`Bài số ${n}`)),
    )
    const fb = await page('facebook')
    const c = await draft([fb])
    await expect(runJob(c.id)).rejects.toBeInstanceOf(PreviewRetryableError)
    expect((await rows(c.id)).every((r) => r.plan?.status === 'failed')).toBe(true)
    expect(await runJob(c.id)).toEqual({ generated: 1, errors: 0 })
    expect(planRequests(openai)).toHaveLength(1)
  })
})

/* ---------- Đồng thời / vòng đời ---------- */

describe('lease + vòng đời', () => {
  it('hai job cùng lúc → mỗi slot được lên kế hoạch đúng một lần và viết đúng một lần', async () => {
    const fb = await page('facebook')
    const c = await draft([fb])
    const results = await Promise.all([runJob(c.id, { concurrency: 3 }), runJob(c.id, { concurrency: 3 })])
    const generated = results.reduce((n, r) => n + (typeof r === 'object' ? r.generated : 0), 0)
    expect(generated).toBe(7)
    expect(planRequests(openai).map(askedCount).reduce((a, b) => a + b, 0)).toBe(7)
    expect(captionRequests(openai)).toHaveLength(7)
    expect((await rows(c.id)).every((r) => r.plan?.status === 'ok' && r.status === 'pending_approval')).toBe(true)
  })

  it('chiến dịch thôi chạy trước lô → không gọi kế hoạch, không viết', async () => {
    const fb = await page('facebook')
    const c = await draft([fb])
    const todo = (await rows(c.id)).map((r) => ({ id: r.id, withImage: false }))
    const out = await runSlotBatch(deps(), todo, {
      goal: 'engagement',
      finalAttempt: false,
      onStop: 'halt',
      active: async () => false,
      plan: { campaignId: c.id, campaignName: c.name, campaignGoal: c.goal, withReference: false },
    })
    expect(out).toMatchObject({ inactive: true, generated: 0 })
    expect(openai.responseRequests).toHaveLength(0)
    expect((await rows(c.id)).every((r) => r.plan === null)).toBe(true)
  })

  it('ảnh từ brief: ô ảnh dựng từ ý ảnh + tiêu đề kế hoạch (ad, cấm UI giả, "Shop bán")', async () => {
    const fb = await page('facebook')
    const c = await draft([fb], { imageRatio: 100 })
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    const prompts = await handle.sql<{ prompt: string }[]>`
      select m.prompt from post_targets t join post_target_media l on l.post_target_id = t.id join media_assets m on m.id = l.media_asset_id
      where t.campaign_id = ${c.id} order by t.slot_at`
    expect(prompts).toHaveLength(7)
    expect(prompts[0]!.prompt.startsWith('Bố cục ảnh số 1\nÝ tưởng bài đăng: Tiêu đề 1\nNội dung bài: Bài số')).toBe(true)
    expect(prompts[0]!.prompt).toContain('Shop bán')
    expect(prompts[0]!.prompt).toContain(IMAGE_NO_FAKE_UI)
    expect(new Set(prompts.map((p) => p.prompt.split('\n')[0])).size).toBe(7)
    expect(inputOf(planRequests(openai)[0]!)).toContain('· có ảnh')
  })

  it('Tạo lại → brief bị xoá, lượt sau lên brief MỚI với ngữ cảnh 6 bài còn lại', async () => {
    const fb = await page('facebook')
    const c = await draft([fb])
    await runJob(c.id)
    const target = (await preview(c.id)).items[2]!
    const res = await api('POST', `/api/v1/campaigns/${c.id}/slots/${target.id}/transition`, { action: 'regenerate', version: target.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(CampaignSlotActionResponse.parse(res.json()).slot.plan).toBeNull()
    expect((await rows(c.id))[2]!.plan).toBeNull()
    await handle.sql`delete from pgboss.job where name = 'campaigns.preview'`

    planned((req) => ok(planJsonFor(req, () => ({ title: 'Brief mới', format: 'story' }))))
    const before = planRequests(openai).length
    expect(await runJob(c.id)).toEqual({ generated: 1, errors: 0 })
    const again = planRequests(openai).slice(before)
    expect(again).toHaveLength(1)
    expect(askedCount(again[0]!)).toBe(1)
    const history = inputOf(again[0]!).split('\n\n').find((p) => p.startsWith('Các bài đã có'))!
    expect(history.split('\n').length - 1).toBe(6)
    expect(history).toContain('«Tiêu đề 1»')
    expect((await preview(c.id)).items[2]!.plan).toMatchObject({ title: 'Brief mới', format: 'story' })
  })

  it('Lịch: slot `planned` có brief → `planTitle` / `planFormat`; slot chưa có → null', async () => {
    const fb = await page('facebook')
    const c = await draft([fb])
    await start(c.id)
    const all = await rows(c.id)
    await handle.sql`update post_targets set plan = ${JSON.stringify({ status: 'ok', ...fakePlanPost(1, { title: 'Ba mẹo nồi chiên' }) })}::jsonb where id = ${all[0]!.id}`
    await handle.sql`update post_targets set plan = ${JSON.stringify({ status: 'failed' })}::jsonb where id = ${all[1]!.id}`
    const from = new Date(START_MIDNIGHT.getTime() - DAY).toISOString()
    const to = new Date(START_MIDNIGHT.getTime() + 5 * DAY).toISOString()
    const res = await api('GET', `/api/v1/calendar?from=${from}&to=${to}`)
    expect(res.statusCode, res.body).toBe(200)
    const items = CalendarResponse.parse(res.json()).items
    expect(items.find((i) => i.id === all[0]!.id)).toMatchObject({ status: 'planned', planTitle: 'Ba mẹo nồi chiên', planFormat: 'tip', topic: 'Mẹo hay' })
    expect(items.find((i) => i.id === all[1]!.id)).toMatchObject({ planTitle: null, planFormat: null })
  })
})

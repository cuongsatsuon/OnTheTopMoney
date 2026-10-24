// Ma trận Story 7.6 — Chiến dịch tự tạm dừng khi có sự cố (AD-15, AD-23, AD-5, AD-7). Qua app thật (buildApp) + Postgres
// nhúng + pg-boss + OpenAI giả; consumer `events.campaigns` / `events.content` gọi trực tiếp với envelope vừa phát (như
// worker). Phủ: trang mất kết nối (chỉ chiến dịch có trang, nháp không đụng, sự kiện tới muộn, đè `MANUAL`), hạn mức 100%,
// lượt sinh gặp chặn (hồ sơ, trang, khoá), chuỗi lỗi đăng (idempotent theo target, về 0, mã không đếm), tiếp tục với lý do
// khoá OpenAI / chuỗi lỗi, `page.expiring` không dừng, gỡ trang (bài thủ công + slot), trang rời nhóm nhãn.
import { randomBytes } from 'node:crypto'
import { CampaignActionResponse, CampaignDto, ErrorResponse, SaveBrandProfileRequest, type EventName, type SaveCampaignRequest } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import { PUBLISH_FAILURES_MAX, handleCampaignsEvent, runGenerate } from '../src/modules/campaigns/index.ts'
import { markDisconnected, removePage } from '../src/modules/connections/index.ts'
import { handleContentEvent } from '../src/modules/content/index.ts'
import { assignGroup, createGroup, unassignGroup } from '../src/modules/pages/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { QUEUES, createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-AUTOPAUSE-key-aaaa1111'
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)
const START_MIDNIGHT = new Date(`${START}T00:00:00.000+07:00`)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
let app: FastifyInstance
let cookie: string

const emitted: EventEnvelope[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ event: name, payload } as EventEnvelope)
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.event === name)
const deps = () => ({ db: handle.db, jobs, events, cipher })
/** Như worker: giao mọi sự kiện `name` đã phát (từ vị trí `from`) cho consumer của `campaigns`. */
async function deliver(name: EventName, from = 0) {
  const out = []
  for (const e of emitted.slice(from).filter((x) => x.event === name)) out.push(await handleCampaignsEvent(deps(), e))
  return out
}
const envelope = <N extends EventName>(event: N, payload: Record<string, unknown>) => ({ event, payload }) as unknown as EventEnvelope

async function cleanup() {
  await handle.sql`delete from posts`
  await handle.sql`delete from campaigns`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-auto-pause', { background: false })
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
  app = buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, ai: { cipher, openai } })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

async function page(opts: { brand?: boolean } = {}): Promise<string> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values ('facebook', ${account}, 'Trang FB') returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  if (opts.brand !== false) await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse(BRAND))
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
  topics: [
    { name: 'Mẹo hay', share: 50 },
    { name: 'Hỏi đáp', share: 50 },
  ],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function draft(pageIds: string[], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', body(pageIds, over))
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
/** Chiến dịch đã bắt đầu (30 slot `planned` mỗi trang, 11:30 mỗi ngày từ ngày mai); dọn job do lưu / bắt đầu enqueue. */
async function running(pageIds: string[], over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const c = await draft(pageIds, over)
  const res = await api('POST', `/api/v1/campaigns/${c.id}/start`, {})
  expect(res.statusCode, res.body).toBe(200)
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate')`
  return c
}
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
const gen = (id: string) => runGenerate({ db: handle.db, events, jobs, cipher, openai, log, now: () => START_MIDNIGHT }, id, { finalAttempt: false })

const campaignRow = async (id: string) =>
  (
    await handle.sql<{ status: string; pause_reason: string | null; consecutive_failures: number; failure_target_ids: string[] }[]>`
      select status, pause_reason, consecutive_failures, failure_target_ids from campaigns where id = ${id}`
  )[0]
const slots = (campaignId: string, pageId?: string) =>
  handle.sql<{ id: string; page_id: string; status: string; held: boolean; cancel_reason: string | null }[]>`
    select id, page_id, status, held, cancel_reason from post_targets
    where campaign_id = ${campaignId} and (${pageId ?? null}::uuid is null or page_id = ${pageId ?? null}::uuid) order by slot_at, id`
const campaignPageIds = async (campaignId: string) =>
  (await handle.sql<{ page_id: string }[]>`select page_id from campaign_pages where campaign_id = ${campaignId} order by position`).map((r) => r.page_id)
const pausedEvents = () => emittedOf('campaign.paused').map((e) => e.payload as { id: string; reason: string; pausedAt: string })

async function blockBudget() {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
  await settle(
    { db: handle.db, events },
    { reservationId: null, month: '2026-10', feature: 'compose_caption', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } },
  )
  await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
}
const failed = (targetId: string, campaignId: string | null, errorCode = 'PUBLISH_FAILED') =>
  envelope('post_target.failed', { id: targetId, pageId: randomBytes(4).toString('hex'), campaignId, errorCode })
const published = (targetId: string, campaignId: string) => envelope('post_target.published', { id: targetId, pageId: 'p', campaignId })

/* ---------- Trang mất kết nối ---------- */

describe('trang mất kết nối', () => {
  it('chỉ chiến dịch có trang → `paused PAGE_DISCONNECTED`, slot `held`; chiến dịch khác và nháp giữ nguyên; giao lại không phát thêm', async () => {
    const p1 = await page()
    const p2 = await page()
    const hit = await running([p1])
    const other = await running([p2])
    const d = await draft([p1])
    await markDisconnected({ db: handle.db, events }, p1)
    const lost = emittedOf('page.disconnected')
    expect(lost).toHaveLength(1)
    expect((lost[0]!.payload as { disconnectedAt?: string }).disconnectedAt).toMatch(/^\d{4}-/)

    expect(await deliver('page.disconnected')).toEqual([{ changed: 1 }])
    expect(await campaignRow(hit.id)).toMatchObject({ status: 'paused', pause_reason: 'PAGE_DISCONNECTED' })
    expect((await slots(hit.id)).every((s) => s.held)).toBe(true)
    expect(await campaignRow(other.id)).toMatchObject({ status: 'running', pause_reason: null })
    expect(await campaignRow(d.id)).toMatchObject({ status: 'draft' })
    expect(pausedEvents()).toEqual([{ id: hit.id, reason: 'PAGE_DISCONNECTED', pausedAt: expect.stringMatching(/^\d{4}-/) }])

    // Giao lại (pg-boss giao trùng) → không đổi gì, không phát thêm.
    expect(await deliver('page.disconnected')).toEqual([{ changed: 0 }])
    expect(pausedEvents()).toHaveLength(1)
  })

  it('sự kiện tới muộn (trang đã kết nối lại) → không dừng', async () => {
    const p1 = await page()
    const c = await running([p1])
    await markDisconnected({ db: handle.db, events }, p1)
    await handle.sql`update pages set connection_status = 'active', connection_status_reason = null where id = ${p1}`
    expect(await deliver('page.disconnected')).toEqual([{ changed: 0 }])
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running' })
  })

  it('đã dừng `MANUAL` → lý do thành `PAGE_DISCONNECTED`, phát lại `campaign.paused` (cùng `pausedAt`)', async () => {
    const p1 = await page()
    const c = await running([p1])
    expect(CampaignActionResponse.parse((await api('POST', `/api/v1/campaigns/${c.id}/pause`, {})).json()).changed).toBe(true)
    await markDisconnected({ db: handle.db, events }, p1)
    expect(await deliver('page.disconnected')).toEqual([{ changed: 1 }])
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'PAGE_DISCONNECTED' })
    const [manual, system] = pausedEvents()
    expect([manual!.reason, system!.reason]).toEqual(['MANUAL', 'PAGE_DISCONNECTED'])
    expect(system!.pausedAt).toBe(manual!.pausedAt)
  })

  it('`page.expiring` → chiến dịch vẫn chạy (consumer không nghe, handler bỏ qua)', async () => {
    const p1 = await page()
    const c = await running([p1])
    expect(QUEUES['events.campaigns'].subscribes).not.toContain('page.expiring')
    expect(await handleCampaignsEvent(deps(), envelope('page.expiring', { id: p1, pageId: p1, expiresAt: new Date(Date.now() + 3 * DAY).toISOString() }))).toBe(
      'ignored',
    )
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running' })
  })
})

/* ---------- Hạn mức AI ---------- */

describe('hạn mức AI 100%', () => {
  it('mọi chiến dịch đang chạy → `paused AI_BUDGET_EXCEEDED`; mức 80 / hạn mức đã nâng → không dừng', async () => {
    const p1 = await page()
    const a = await running([p1])
    const b = await running([p1])
    expect(await handleCampaignsEvent(deps(), envelope('ai_budget.threshold_reached', { id: 'm:80', level: 80 }))).toBe('ignored')
    // Chưa `blocked` (sự kiện tới muộn sau khi nâng hạn mức) → không dừng.
    expect(await handleCampaignsEvent(deps(), envelope('ai_budget.threshold_reached', { id: 'm:100', level: 100 }))).toEqual({ changed: 0 })
    await blockBudget()
    const reached = emittedOf('ai_budget.threshold_reached').filter((e) => (e.payload as { level: number }).level === 100)
    expect(reached).toHaveLength(1)
    expect(await handleCampaignsEvent(deps(), reached[0]!)).toEqual({ changed: 2 })
    expect(await campaignRow(a.id)).toMatchObject({ status: 'paused', pause_reason: 'AI_BUDGET_EXCEEDED' })
    expect(await campaignRow(b.id)).toMatchObject({ status: 'paused', pause_reason: 'AI_BUDGET_EXCEEDED' })
  })
})

/* ---------- Lượt sinh gặp chặn ---------- */

describe('lượt sinh cuốn chiếu gặp chặn → tự tạm dừng', () => {
  it('trang thiếu hồ sơ → `CONFIG_MISSING`, 0 lời gọi AI, slot giữ `planned`, lượt sau `skipped`', async () => {
    const p1 = await page()
    const c = await running([p1])
    await handle.sql`delete from brand_profiles`
    expect(await gen(c.id)).toEqual({ stopped: 'CONFIG_MISSING', approved: 0, paused: 'CONFIG_MISSING' })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'CONFIG_MISSING' })
    expect(openai.responseRequests).toHaveLength(0)
    expect((await slots(c.id)).every((s) => s.status === 'planned')).toBe(true)
    expect(await gen(c.id)).toBe('skipped')
  })

  it('trang mất kết nối mà sự kiện bị lỡ → `PAGE_DISCONNECTED`; khoá chưa nhập → `OPENAI_KEY_UNAVAILABLE`', async () => {
    const p1 = await page()
    const p2 = await page()
    const a = await running([p1])
    const b = await running([p2])
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${p1}`
    expect(await gen(a.id)).toMatchObject({ stopped: 'PAGE_DISCONNECTED', paused: 'PAGE_DISCONNECTED' })
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    expect(await gen(b.id)).toMatchObject({ stopped: 'OPENAI_KEY_MISSING', paused: 'OPENAI_KEY_UNAVAILABLE' })
    expect(await campaignRow(b.id)).toMatchObject({ status: 'paused', pause_reason: 'OPENAI_KEY_UNAVAILABLE' })
    expect(openai.responseRequests).toHaveLength(0)
  })

  it('hết hạn mức giữa lô → chiến dịch `paused AI_BUDGET_EXCEEDED` (slot lỗi về "Chờ duyệt")', async () => {
    const p1 = await page()
    const c = await running([p1])
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 1_000_000 })
    let n = 0
    openai.onResponse(async () => {
      if (++n === 1) await handle.sql`update ai_budget_months set spent_vnd = 1000000`
      return ok(`Bài số ${n} cho shop nhé`)
    })
    const result = await runGenerate({ db: handle.db, events, jobs, cipher, openai, log, now: () => START_MIDNIGHT }, c.id, { finalAttempt: false, concurrency: 1 })
    expect(result).toMatchObject({ stopCode: 'AI_BUDGET_EXCEEDED', paused: 'AI_BUDGET_EXCEEDED' })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'AI_BUDGET_EXCEEDED' })
  })
})

/* ---------- Chuỗi bài đăng lỗi ---------- */

describe('bài đăng lỗi liên tiếp', () => {
  it(`${PUBLISH_FAILURES_MAX} target khác nhau lỗi → 1, 2, 3 → \`paused PUBLISH_FAILURES\``, async () => {
    const p1 = await page()
    const c = await running([p1])
    const [t1, t2, t3] = await slots(c.id)
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, c.id))).toEqual({ changed: 1 })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', consecutive_failures: 1 })
    await handleCampaignsEvent(deps(), failed(t2!.id, c.id, 'PUBLISH_REJECTED'))
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', consecutive_failures: 2 })
    await handleCampaignsEvent(deps(), failed(t3!.id, c.id, 'PUBLISH_UNKNOWN'))
    expect(await campaignRow(c.id)).toMatchObject({
      status: 'paused',
      pause_reason: 'PUBLISH_FAILURES',
      consecutive_failures: 3,
      failure_target_ids: [t1!.id, t2!.id, t3!.id],
    })
    expect(pausedEvents().map((e) => e.reason)).toEqual(['PUBLISH_FAILURES'])
  })

  it('idempotent theo target; đăng được → về 0; `PAGE_REMOVED` không đếm; bài thủ công / chiến dịch đã xoá bỏ qua', async () => {
    const p1 = await page()
    const c = await running([p1])
    const [t1, t2, t3] = await slots(c.id)
    await handleCampaignsEvent(deps(), failed(t1!.id, c.id))
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, c.id))).toEqual({ changed: 0 })
    expect(await campaignRow(c.id)).toMatchObject({ consecutive_failures: 1 })
    expect(await handleCampaignsEvent(deps(), failed(t2!.id, c.id, 'PAGE_REMOVED'))).toBe('ignored')
    expect(await campaignRow(c.id)).toMatchObject({ consecutive_failures: 1 })
    expect(await handleCampaignsEvent(deps(), published(t3!.id, c.id))).toEqual({ changed: 1 })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', consecutive_failures: 0, failure_target_ids: [] })
    // Sau khi về 0, bài cũ lỗi lại ("Đăng lại") là lỗi mới của chuỗi mới.
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, c.id))).toEqual({ changed: 1 })
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, null))).toBe('ignored')
    const gone = await running([p1])
    await handle.sql`delete from campaigns where id = ${gone.id}`
    expect(await handleCampaignsEvent(deps(), failed(t2!.id, gone.id))).toEqual({ changed: 0 })
  })

  it('sự kiện tới sai thứ tự → chuỗi theo thứ tự thật của bài (lỗi trước bài đăng được không đếm; reset muộn giữ lỗi sau nó)', async () => {
    const p1 = await page()
    const c = await running([p1])
    const [t1, t2, t3, t4, t5] = await slots(c.id)
    // Thứ tự thật: t1, t2 lỗi → t3 đăng được → t4, t5 lỗi (chuỗi thật = 2). Sự kiện t2 / t3 tới muộn.
    const fail = (id: string, ago: number) =>
      handle.sql`update post_targets set status = 'failed', error_code = 'PUBLISH_FAILED', updated_at = now() - ${ago} * interval '1 minute' where id = ${id}`
    await fail(t1!.id, 5)
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, c.id))).toEqual({ changed: 1 })
    await fail(t2!.id, 4)
    await handle.sql`update post_targets set status = 'published', published_at = now() - interval '3 minutes' where id = ${t3!.id}`
    await fail(t4!.id, 2)
    expect(await handleCampaignsEvent(deps(), failed(t4!.id, c.id))).toEqual({ changed: 1 })
    expect(await campaignRow(c.id)).toMatchObject({ consecutive_failures: 2 })
    // Đăng được tới muộn: bỏ t1 (lỗi trước), giữ t4 (lỗi sau).
    expect(await handleCampaignsEvent(deps(), published(t3!.id, c.id))).toEqual({ changed: 1 })
    expect(await campaignRow(c.id)).toMatchObject({ consecutive_failures: 1, failure_target_ids: [t4!.id] })
    // Lỗi t2 tới muộn (xảy ra trước t3 đăng) → không đếm.
    expect(await handleCampaignsEvent(deps(), failed(t2!.id, c.id))).toEqual({ changed: 0 })
    await fail(t5!.id, 1)
    await handleCampaignsEvent(deps(), failed(t5!.id, c.id))
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', consecutive_failures: 2, failure_target_ids: [t4!.id, t5!.id] })
  })

  it('lỗi `PAGE_DISCONNECTED` → không đếm, `paused PAGE_DISCONNECTED`', async () => {
    const p1 = await page()
    const c = await running([p1])
    const [t1] = await slots(c.id)
    expect(await handleCampaignsEvent(deps(), failed(t1!.id, c.id, 'PAGE_DISCONNECTED'))).toEqual({ changed: 1 })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'PAGE_DISCONNECTED', consecutive_failures: 0 })
  })
})

/* ---------- Tiếp tục ---------- */

describe('tiếp tục sau khi tự dừng', () => {
  it('`OPENAI_KEY_UNAVAILABLE`: khoá chưa nhập → 409 `OPENAI_KEY_MISSING`; nhập khoá → 200', async () => {
    const p1 = await page()
    const c = await running([p1])
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    await gen(c.id)
    const refused = await api('POST', `/api/v1/campaigns/${c.id}/resume`, {})
    expect(refused.statusCode).toBe(409)
    expect(errorOf(refused).code).toBe('OPENAI_KEY_MISSING')
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'OPENAI_KEY_UNAVAILABLE' })
    await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
    const res = await api('POST', `/api/v1/campaigns/${c.id}/resume`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', pause_reason: null })
  })

  it('`PUBLISH_FAILURES` → 200, chuỗi lỗi về 0 và danh sách target rỗng', async () => {
    const p1 = await page()
    const c = await running([p1])
    for (const t of (await slots(c.id)).slice(0, PUBLISH_FAILURES_MAX)) await handleCampaignsEvent(deps(), failed(t.id, c.id))
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'PUBLISH_FAILURES' })
    expect((await api('POST', `/api/v1/campaigns/${c.id}/resume`, {})).statusCode).toBe(200)
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', consecutive_failures: 0, failure_target_ids: [] })
  })
})

/* ---------- Gỡ trang / rời nhóm nhãn ---------- */

describe('gỡ trang', () => {
  it('`content` huỷ bài chưa đăng của trang (cả bài thủ công đã lên lịch, giữ nháp / đã đăng); `campaigns` bỏ trang, chiến dịch chạy tiếp', async () => {
    const p1 = await page()
    const p2 = await page()
    const c = await running([p1, p2])
    const mine = await slots(c.id, p1)
    await handle.sql`update post_targets set status = 'scheduled', caption = 'x', scheduled_at = slot_at where id = ${mine[0]!.id}`
    await handle.sql`update post_targets set status = 'failed', caption = 'x', error_code = 'PUBLISH_FAILED' where id = ${mine[1]!.id}`
    await handle.sql`update post_targets set status = 'published', caption = 'x', published_at = now() where id = ${mine[2]!.id}`
    const [post] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
    const [post2] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
    const [manualDraft] = await handle.sql<{ id: string }[]>`
      insert into post_targets (post_id, page_id, position, status, caption) values (${post!.id}, ${p1}, 0, 'draft', 'nháp') returning id`
    const [manualScheduled] = await handle.sql<{ id: string }[]>`
      insert into post_targets (post_id, page_id, position, status, caption, scheduled_at)
      values (${post2!.id}, ${p1}, 0, 'scheduled', 'lịch', now() + interval '1 day') returning id`

    expect(await removePage({ db: handle.db, events }, p1)).toBe(true)
    const removed = emittedOf('page.removed')
    expect(removed).toHaveLength(1)
    expect(await handleContentEvent({ db: handle.db }, removed[0]!)).toEqual({ cancelled: 30 })
    expect(await deliver('page.removed')).toEqual([{ changed: 1 }])

    const after = await slots(c.id, p1)
    expect(after[2]!.status).toBe('published')
    expect(after.filter((s) => s.status === 'cancelled').every((s) => s.cancel_reason === 'PAGE_REMOVED')).toBe(true)
    expect(after.filter((s) => s.status === 'cancelled')).toHaveLength(29)
    const manual = await handle.sql<{ id: string; status: string; cancel_reason: string | null }[]>`
      select id, status, cancel_reason from post_targets where post_id in (${post!.id}, ${post2!.id}) order by created_at, id`
    expect(manual).toEqual([
      { id: manualDraft!.id, status: 'draft', cancel_reason: null },
      { id: manualScheduled!.id, status: 'cancelled', cancel_reason: 'PAGE_REMOVED' },
    ])
    expect(await campaignPageIds(c.id)).toEqual([p2])
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running' })
    expect((await slots(c.id, p2)).every((s) => s.status === 'planned')).toBe(true)

    // Giao lại → không đổi gì.
    expect(await handleContentEvent({ db: handle.db }, removed[0]!)).toEqual({ cancelled: 0 })
    expect(await deliver('page.removed')).toEqual([{ changed: 0 }])
  })
})

describe('trang rời nhóm nhãn', () => {
  it('huỷ slot chưa đăng của trang (`PAGE_LEFT_GROUP`) + bỏ trang; chiến dịch không gắn nhãn / trang đã quay lại nhóm → không đổi', async () => {
    const p1 = await page()
    const p2 = await page()
    const g = await handle.db.transaction((tx) => createGroup(tx, { name: 'Mỹ phẩm', color: 'group-1' }))
    await upsertProfile(handle.db, { ownerType: 'group', ownerId: g.id }, SaveBrandProfileRequest.parse(BRAND))
    await handle.db.transaction(async (tx) => {
      await assignGroup(tx, events, p1, g.id)
      await assignGroup(tx, events, p2, g.id)
    })
    const labelled = await running([p1, p2], { groupId: g.id })
    const plain = await running([p1])
    const mark = emitted.length

    await handle.db.transaction((tx) => unassignGroup(tx, events, p1))
    expect(await deliver('page.group_changed', mark)).toEqual([{ changed: 1 }])
    const left = await slots(labelled.id, p1)
    expect(left.every((s) => s.status === 'cancelled' && s.cancel_reason === 'PAGE_LEFT_GROUP')).toBe(true)
    expect(await campaignPageIds(labelled.id)).toEqual([p2])
    expect(await campaignRow(labelled.id)).toMatchObject({ status: 'running' })
    expect((await slots(labelled.id, p2)).every((s) => s.status === 'planned')).toBe(true)
    expect((await slots(plain.id)).every((s) => s.status === 'planned')).toBe(true)

    // p2 rời rồi quay lại trước khi consumer chạy (sự kiện tới muộn) → không huỷ.
    const mark2 = emitted.length
    await handle.db.transaction(async (tx) => {
      await unassignGroup(tx, events, p2)
      await assignGroup(tx, events, p2, g.id)
    })
    expect(await deliver('page.group_changed', mark2)).toEqual([{ changed: 0 }, 'ignored'])
    expect((await slots(labelled.id, p2)).every((s) => s.status === 'planned')).toBe(true)
  })
})

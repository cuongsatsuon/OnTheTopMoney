// Ma trận Story 7.5 — Tạm dừng, tiếp tục, xoá và hoàn tất chiến dịch (AD-15, AD-13). Qua app thật (buildApp) + Postgres
// nhúng + pg-boss + OpenAI giả + Meta giả (job đăng); không gọi mạng. Phủ: tạm dừng giữ mọi bài chưa đăng (job đăng tới
// giờ bỏ qua, cron vá job không enqueue lại), 2 race với job đăng (Meta đang xử lý → đăng xong; lỗi tạm sau khi dừng → bài
// về `scheduled` vẫn `held`, lần retry bỏ qua), cron / lô sinh dừng, bấm lại / sai trạng thái, lý do hệ thống đè `MANUAL`,
// tiếp tục (bài lỡ giờ → `MISSED_WHILE_PAUSED`, bài tương lai enqueue lại, `consecutive_failures` về 0), lý do còn → 409,
// xoá (bài đã đăng / đang đăng giữ nguyên) cả nháp, cron hoàn tất, `held` trên Lịch.
import { randomBytes } from 'node:crypto'
import {
  CalendarResponse,
  CampaignActionResponse,
  CampaignDto,
  CampaignListResponse,
  DeleteCampaignResponse,
  ErrorResponse,
  SaveBrandProfileRequest,
  type EventName,
  type SaveCampaignRequest,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import { pauseCampaign, runCompleteCheck, runGenerate, runGenerateWindow, runPreview } from '../src/modules/campaigns/index.ts'
import { PublishRetryableError, publishTarget, requeueTargets, type PublishDeps } from '../src/modules/content/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { isPlanRequest } from './helpers/plan.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-LIFECYCLE-key-aaaa1111'
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)
/** 00:00 giờ VN ngày bắt đầu — mốc cửa sổ sinh cuốn chiếu: 3 ngày tới = bài 11:30 của ngày 0, 1, 2. */
const START_MIDNIGHT = new Date(`${START}T00:00:00.000+07:00`)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
let graph: FakeMetaClient
let app: FastifyInstance
let cookie: string
/** Đồng hồ của app (`null` = giờ thật) — tiếp tục "sau khi đã lỡ vài bài". */
let clockAt: Date | null = null

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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-lifecycle', { background: false })
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
  clockAt = null
  openai = createFakeOpenAiAdapter()
  openai.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai }, GOOD)
  let n = 0
  openai.onResponse(() => ok(`Bài số ${++n} cho shop nhé`))
  graph = createFakeMetaClient()
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: log,
    http: { allowedOrigins: [ORIGIN] },
    events,
    jobs,
    ai: { cipher, openai },
    clock: () => clockAt ?? new Date(),
  })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

async function page(): Promise<{ id: string; account: string }> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values ('facebook', ${account}, 'Trang FB') returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse(BRAND))
  return { id: p!.id, account }
}

const body = (pageId: string, over: Partial<SaveCampaignRequest> = {}): SaveCampaignRequest => ({
  name: 'Gia dụng – tăng tương tác 30 ngày',
  goal: 'engage',
  startDate: START,
  durationDays: 30,
  groupId: null,
  defaultFrequency: '1_per_day',
  pages: [{ pageId, frequency: null }],
  topics: [
    { name: 'Mẹo hay', share: 50 },
    { name: 'Hỏi đáp', share: 50 },
  ],
  postTimes: ['11:30'],
  imageRatio: 0,
  ...over,
})

function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, auth = true) {
  const headers: Record<string, string> = { origin: ORIGIN }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  if (auth) headers.cookie = cookie
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function draft(pageId: string, over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', body(pageId, over))
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
/** Chiến dịch đã bắt đầu (30 slot `planned` trên Lịch, 11:30 mỗi ngày từ ngày mai); dọn job do lưu / bắt đầu enqueue. */
async function running(pageId: string, over: Partial<SaveCampaignRequest> = {}): Promise<CampaignDto> {
  const c = await draft(pageId, over)
  const res = await api('POST', `/api/v1/campaigns/${c.id}/start`, {})
  expect(res.statusCode, res.body).toBe(200)
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate')`
  return c
}
const pause = (id: string, auth = true) => api('POST', `/api/v1/campaigns/${id}/pause`, {}, auth)
const resume = (id: string, auth = true) => api('POST', `/api/v1/campaigns/${id}/resume`, {}, auth)
const remove = (id: string, auth = true) => api('DELETE', `/api/v1/campaigns/${id}`, undefined, auth)
const actionOf = (res: { statusCode: number; body: string; json(): unknown }) => {
  expect(res.statusCode, res.body).toBe(200)
  return CampaignActionResponse.parse(res.json())
}
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
const aiDeps = (now?: Date) => ({ db: handle.db, events, jobs, cipher, openai, log, ...(now ? { now: () => now } : {}) })
const publishDeps = (): PublishDeps => ({ db: handle.db, events, jobs, cipher, graph, threads: createFakeMetaClient('https://graph.threads.com/v1.0'), sleep: async () => {}, pollMax: 3 })

interface SlotRow {
  id: string
  status: string
  held: boolean
  scheduled_at: string | null
  slot_at: string
  error_code: string | null
  cancel_reason: string | null
  version: number
  schedule_version: number
}
const slotRows = (campaignId: string) =>
  handle.sql<SlotRow[]>`
    select id, status, held, scheduled_at, slot_at, error_code, cancel_reason, version, schedule_version
    from post_targets where campaign_id = ${campaignId} order by slot_at, id`
const slot = async (id: string) => (await handle.sql<SlotRow[]>`select id, status, held, scheduled_at, slot_at, error_code, cancel_reason, version, schedule_version from post_targets where id = ${id}`)[0]!
const campaignRow = async (id: string) =>
  (
    await handle.sql<{ status: string; pause_reason: string | null; paused_at: Date | null; consecutive_failures: number }[]>`
      select status, pause_reason, paused_at, consecutive_failures from campaigns where id = ${id}`
  )[0]
const jobsOf = <T>(name: string) =>
  handle.sql<{ data: T; start_after: string }[]>`select data, start_after from pgboss.job where name = ${name} and state in ('created', 'retry') order by start_after`

/** Đặt slot `pending_approval` có nội dung (như AI vừa viết xong). */
async function written(targetId: string) {
  await handle.sql`update post_targets set status = 'pending_approval', caption = 'Bài AI viết', ai_caption = true, version = version + 1 where id = ${targetId}`
}
/** Slot đã duyệt qua route chung (`scheduled` + job `publish.target` đúng giờ). */
async function approved(campaignId: string, targetId: string) {
  await written(targetId)
  const res = await api('POST', `/api/v1/campaigns/${campaignId}/slots/${targetId}/transition`, { action: 'approve', version: (await slot(targetId)).version })
  expect(res.statusCode, res.body).toBe(200)
  return slot(targetId)
}
async function setStatus(targetId: string, status: 'failed' | 'published' | 'publishing') {
  if (status === 'failed') await handle.sql`update post_targets set status = 'failed', error_code = 'PUBLISH_FAILED' where id = ${targetId}`
  else if (status === 'published') await handle.sql`update post_targets set status = 'published', caption = 'Đã đăng', published_at = now() where id = ${targetId}`
  else await handle.sql`update post_targets set status = 'publishing', caption = 'Đang đăng', publishing_at = now() where id = ${targetId}`
}
async function blockBudget() {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
  await settle(
    { db: handle.db, events },
    { reservationId: null, month: '2026-10', feature: 'compose_caption', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } },
  )
  await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
}
const systemPause = (id: string, reason: 'PAGE_DISCONNECTED' | 'AI_BUDGET_EXCEEDED' | 'CONFIG_MISSING' | 'PUBLISH_FAILURES' | 'MANUAL') =>
  handle.db.transaction((tx) => pauseCampaign(tx, { jobs, events }, id, reason, new Date()))

/* ---------- Tạm dừng ---------- */

describe('tạm dừng', () => {
  it('giữ mọi bài chưa đăng (`held`), bài đã đăng giữ nguyên; `paused MANUAL`; job đăng tới giờ bỏ qua, cron vá không enqueue lại', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const rows = await slotRows(c.id)
    const scheduled = await approved(c.id, rows[0]!.id)
    await written(rows[1]!.id)
    await setStatus(rows[2]!.id, 'failed')
    await setStatus(rows[3]!.id, 'published')

    const res = actionOf(await pause(c.id))
    expect(res).toMatchObject({ changed: true, missed: 0, campaign: { status: 'paused', pauseReason: 'MANUAL', nextPost: null, postsPending: 0 } })
    expect(res.campaign.pausedAt).not.toBeNull()
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'MANUAL' })
    const after = await slotRows(c.id)
    expect(after.filter((r) => r.held).map((r) => r.id)).toEqual(after.filter((r) => r.status !== 'published').map((r) => r.id))
    expect(after.find((r) => r.status === 'published')!.held).toBe(false)
    // Trạng thái / giờ / `schedule_version` không đổi (job cũ vẫn khớp phiên bản — chỉ `held` chặn).
    expect(after.map((r) => r.status)).toEqual(['scheduled', 'pending_approval', 'failed', 'published', ...Array(26).fill('planned')])
    expect(after[0]!.schedule_version).toBe(scheduled.schedule_version)
    expect(emittedOf('campaign.paused')).toEqual([expect.objectContaining({ id: c.id, reason: 'MANUAL' })])

    // Job đăng tới giờ: `held` → bỏ qua, không gọi Meta.
    expect(await publishTarget(publishDeps(), { targetId: scheduled.id, scheduleVersion: scheduled.schedule_version }, { finalAttempt: false })).toBe('skipped')
    expect(graph.calls).toHaveLength(0)
    expect((await slot(scheduled.id)).status).toBe('scheduled')
    // Cron vá job (quá giờ 10 phút, không còn job sống) không enqueue lại bài `held`.
    await handle.sql`delete from pgboss.job where name = 'publish.target'`
    expect(await requeueTargets({ db: handle.db, events, jobs, now: () => new Date(new Date(scheduled.scheduled_at!).getTime() + 30 * MIN) })).toMatchObject({ requeued: 0 })

    // Bấm lại → không đổi gì.
    expect(actionOf(await pause(c.id))).toMatchObject({ changed: false })
    expect(emittedOf('campaign.paused')).toHaveLength(1)
  })

  it('race: Meta đang xử lý lời gọi đăng thì bấm tạm dừng → bài đó đăng xong', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const target = await approved(c.id, (await slotRows(c.id))[0]!.id)
    let pausedDuringCall = 0
    graph.on('POST', `/${fb.account}/feed`, async () => {
      pausedDuringCall = (await pause(c.id)).statusCode
      return { ok: true, data: { id: `${fb.account}_1` } }
    })
    expect(await publishTarget(publishDeps(), { targetId: target.id, scheduleVersion: target.schedule_version }, { finalAttempt: false })).toBe('published')
    expect(pausedDuringCall).toBe(200)
    expect((await slot(target.id)).status).toBe('published')
    expect((await campaignRow(c.id))!.status).toBe('paused')
  })

  it('race: lỗi tạm sau khi dừng → bài về `scheduled` vẫn `held`, lần retry bỏ qua; tiếp tục → enqueue lại đúng giờ', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const target = await approved(c.id, (await slotRows(c.id))[0]!.id)
    graph.on('POST', `/${fb.account}/feed`, async () => {
      await pause(c.id)
      return { ok: false, kind: 'TRANSIENT', notSent: true }
    })
    const data = { targetId: target.id, scheduleVersion: target.schedule_version }
    await expect(publishTarget(publishDeps(), data, { finalAttempt: false })).rejects.toBeInstanceOf(PublishRetryableError)
    expect(await slot(target.id)).toMatchObject({ status: 'scheduled', held: true, schedule_version: target.schedule_version })
    // Lần retry (cùng phiên bản lịch) → bỏ qua, không gọi Meta lần nữa.
    expect(await publishTarget(publishDeps(), data, { finalAttempt: false })).toBe('skipped')
    expect(graph.calls.filter((x) => x.method === 'POST')).toHaveLength(1)

    await handle.sql`delete from pgboss.job where name = 'publish.target'`
    actionOf(await resume(c.id))
    const after = await slot(target.id)
    expect(after).toMatchObject({ status: 'scheduled', held: false, schedule_version: target.schedule_version + 1 })
    expect(await jobsOf('publish.target')).toEqual([
      expect.objectContaining({ data: { targetId: target.id, scheduleVersion: after.schedule_version }, start_after: expect.anything() }),
    ])
    expect(new Date((await jobsOf('publish.target'))[0]!.start_after).getTime()).toBe(new Date(after.scheduled_at!).getTime())
  })

  it('bài `held`: đổi giờ / đăng lại / duyệt → 409 `CAMPAIGN_PAUSED`, không đổi gì; sửa / xoá vẫn được', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const rows = await slotRows(c.id)
    const scheduled = await approved(c.id, rows[0]!.id)
    await written(rows[1]!.id)
    await setStatus(rows[2]!.id, 'failed')
    actionOf(await pause(c.id))
    const postOf = async (id: string) => (await handle.sql<{ post_id: string }[]>`select post_id from post_targets where id = ${id}`)[0]!.post_id
    const later = new Date(Date.parse(scheduled.scheduled_at!) + 60 * MIN).toISOString()

    const approve = await api('POST', `/api/v1/campaigns/${c.id}/slots/${rows[1]!.id}/transition`, { action: 'approve', version: (await slot(rows[1]!.id)).version, scheduledAt: later })
    expect(approve.statusCode, approve.body).toBe(409)
    expect(errorOf(approve)).toMatchObject({ code: 'CAMPAIGN_PAUSED' })
    for (const [t, action, at] of [
      [rows[2]!, 'retry', null],
      [scheduled, 'reschedule', later],
    ] as const) {
      const res = await api('POST', `/api/v1/posts/${await postOf(t.id)}/targets/transition`, { action, scheduledAt: at, targets: [{ id: t.id, version: (await slot(t.id)).version }] })
      expect(res.statusCode, res.body).toBe(409)
      expect(errorOf(res)).toMatchObject({ code: 'CAMPAIGN_PAUSED' })
    }
    expect((await slotRows(c.id)).slice(0, 3).map((r) => [r.status, r.held])).toEqual([
      ['scheduled', true],
      ['pending_approval', true],
      ['failed', true],
    ])
    const edit = await api('POST', `/api/v1/campaigns/${c.id}/slots/${rows[1]!.id}/transition`, { action: 'edit', caption: 'Sửa lúc dừng', version: (await slot(rows[1]!.id)).version })
    expect(edit.statusCode, edit.body).toBe(200)
  })

  it('cron sinh bỏ qua chiến dịch tạm dừng; tạm dừng giữa lô → dừng trước slot kế, không enqueue lượt tiếp', async () => {
    const fb = await page()
    const c = await running(fb.id)
    let calls = 0
    openai.onResponse(async (req) => {
      // Story 7.8: lời gọi kế hoạch của lô đi trước (chiến dịch còn chạy) — đếm caption.
      if (isPlanRequest(req)) return ok('{"posts":[]}')
      if (++calls === 1) await systemPause(c.id, 'MANUAL')
      return ok(`Bài ${calls}`)
    })
    expect(await runGenerate(aiDeps(START_MIDNIGHT), c.id, { finalAttempt: false, concurrency: 1 })).toMatchObject({ generated: 1, more: false })
    // Slot đang viết dở viết xong (giữ `held`); 2 slot còn lại trong cửa sổ giữ `planned`, không gọi AI thêm.
    const rows = await slotRows(c.id)
    expect(rows.slice(0, 3).map((r) => [r.status, r.held])).toEqual([
      ['pending_approval', true],
      ['planned', true],
      ['planned', true],
    ])
    expect(calls).toBe(1)
    expect(await jobsOf('campaigns.generate')).toHaveLength(0)

    expect(await runGenerate(aiDeps(START_MIDNIGHT), c.id, { finalAttempt: false })).toBe('skipped')
    expect(await runGenerateWindow({ db: handle.db, events, jobs, now: () => START_MIDNIGHT })).toMatchObject({ generate: 0 })
    expect(await jobsOf('campaigns.generate')).toHaveLength(0)
  })

  it('nháp / đã xong → 409; chiến dịch lạ 404; chưa đăng nhập 401', async () => {
    const fb = await page()
    const d = await draft(fb.id)
    expect(errorOf(await pause(d.id))).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(errorOf(await resume(d.id))).toMatchObject({ code: 'VERSION_CONFLICT' })
    const c = await running(fb.id, { name: 'Đã xong' })
    await handle.sql`update campaigns set status = 'done' where id = ${c.id}`
    expect((await pause(c.id)).statusCode).toBe(409)
    expect((await resume(c.id)).statusCode).toBe(409)
    expect((await pause('00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await resume('00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await pause(c.id, false)).statusCode).toBe(401)
    expect((await resume(c.id, false)).statusCode).toBe(401)
    expect((await api('POST', `/api/v1/campaigns/${c.id}/pause`, { reason: 'MANUAL' })).statusCode).toBe(400)
  })

  it('lý do hệ thống đè `MANUAL` (phát lại `campaign.paused`); `MANUAL` không đè lý do hệ thống', async () => {
    const fb = await page()
    const c = await running(fb.id)
    actionOf(await pause(c.id))
    expect(await systemPause(c.id, 'PAGE_DISCONNECTED')).toEqual({ changed: true, missed: 0 })
    expect((await campaignRow(c.id))!.pause_reason).toBe('PAGE_DISCONNECTED')
    expect(await systemPause(c.id, 'MANUAL')).toEqual({ changed: false, missed: 0 })
    expect(await systemPause(c.id, 'AI_BUDGET_EXCEEDED')).toEqual({ changed: false, missed: 0 })
    expect(actionOf(await pause(c.id))).toMatchObject({ changed: false, campaign: { pauseReason: 'PAGE_DISCONNECTED' } })
    expect(emittedOf('campaign.paused').map((e) => e.reason)).toEqual(['MANUAL', 'PAGE_DISCONNECTED'])
  })
})

/* ---------- Tiếp tục ---------- */

describe('tiếp tục', () => {
  it('bài lỡ giờ trong lúc dừng → `cancelled MISSED_WHILE_PAUSED`; bài tương lai bỏ `held` + enqueue lại; `consecutive_failures` về 0', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const rows = await slotRows(c.id)
    const lateScheduled = await approved(c.id, rows[0]!.id)
    await written(rows[1]!.id) // chờ duyệt, sẽ lỡ giờ
    // rows[2]: planned, sẽ lỡ giờ
    const futureScheduled = await approved(c.id, rows[3]!.id)
    await setStatus(rows[4]!.id, 'failed')
    await written(rows[5]!.id) // chờ duyệt, còn tương lai
    await handle.sql`update campaigns set consecutive_failures = 2, failure_target_ids = array['t1', 't2'] where id = ${c.id}`
    actionOf(await pause(c.id))
    await handle.sql`delete from pgboss.job where name in ('publish.target', 'campaigns.generate')`

    // Tiếp tục 1 phút sau giờ bài thứ 3 (ngày 2): 3 bài đầu đã lỡ.
    clockAt = new Date(new Date(rows[2]!.slot_at).getTime() + MIN)
    const res = actionOf(await resume(c.id))
    expect(res).toMatchObject({ changed: true, missed: 3, campaign: { status: 'running', pauseReason: null, pausedAt: null } })
    const after = await slotRows(c.id)
    expect(after.slice(0, 3).map((r) => [r.status, r.cancel_reason, r.held])).toEqual(Array(3).fill(['cancelled', 'MISSED_WHILE_PAUSED', false]))
    expect(after[0]!.schedule_version).toBe(lateScheduled.schedule_version + 1)
    expect(after[3]).toMatchObject({ status: 'scheduled', held: false, schedule_version: futureScheduled.schedule_version + 1 })
    expect(after[4]).toMatchObject({ status: 'failed', held: false })
    expect(after[5]).toMatchObject({ status: 'pending_approval', held: false })
    expect(after.slice(6).every((r) => r.status === 'planned' && !r.held)).toBe(true)
    // Đúng một job mới cho bài tương lai, giờ đăng giữ nguyên; job cũ (phiên bản cũ) bỏ qua.
    const publishJobs = await jobsOf<{ targetId: string; scheduleVersion: number }>('publish.target')
    expect(publishJobs.map((j) => j.data)).toEqual([{ targetId: futureScheduled.id, scheduleVersion: futureScheduled.schedule_version + 1 }])
    expect(new Date(publishJobs[0]!.start_after).getTime()).toBe(new Date(futureScheduled.scheduled_at!).getTime())
    expect(await publishTarget(publishDeps(), { targetId: futureScheduled.id, scheduleVersion: futureScheduled.schedule_version }, { finalAttempt: false })).toBe('skipped')
    expect(await publishTarget(publishDeps(), { targetId: lateScheduled.id, scheduleVersion: lateScheduled.schedule_version }, { finalAttempt: false })).toBe('skipped')
    expect(graph.calls).toHaveLength(0)

    expect(await campaignRow(c.id)).toMatchObject({ status: 'running', pause_reason: null, paused_at: null, consecutive_failures: 0 })
    expect(emittedOf('campaign.resumed')).toEqual([expect.objectContaining({ id: c.id })])
    expect(await jobsOf('campaigns.generate')).toHaveLength(1)
    // Đang chạy rồi → không đổi gì.
    expect(actionOf(await resume(c.id))).toMatchObject({ changed: false, missed: 0 })
    expect(emittedOf('campaign.resumed')).toHaveLength(1)
  })

  it('lý do tự dừng còn → 409 mã tương ứng, không đổi gì; lý do đã hết → tiếp tục', async () => {
    const fb = await page()
    const c = await running(fb.id)
    await systemPause(c.id, 'PAGE_DISCONNECTED')
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${fb.id}`
    const refused = await resume(c.id)
    expect(refused.statusCode).toBe(409)
    expect(errorOf(refused)).toMatchObject({ code: 'PAGE_DISCONNECTED', details: { campaignId: c.id, pageId: fb.id } })
    expect(await campaignRow(c.id)).toMatchObject({ status: 'paused', pause_reason: 'PAGE_DISCONNECTED' })
    expect((await slotRows(c.id)).every((r) => r.held)).toBe(true)
    await handle.sql`update pages set connection_status = 'active' where id = ${fb.id}`
    expect(actionOf(await resume(c.id))).toMatchObject({ changed: true })

    await systemPause(c.id, 'CONFIG_MISSING')
    await handle.sql`delete from brand_profiles where owner_id = ${fb.id}`
    expect(errorOf(await resume(c.id))).toMatchObject({ code: 'CONFIG_MISSING' })
    await upsertProfile(handle.db, { ownerType: 'page', ownerId: fb.id }, SaveBrandProfileRequest.parse(BRAND))
    expect(actionOf(await resume(c.id))).toMatchObject({ changed: true })

    await systemPause(c.id, 'AI_BUDGET_EXCEEDED')
    await blockBudget()
    expect(errorOf(await resume(c.id))).toMatchObject({ code: 'AI_BUDGET_EXCEEDED' })
    expect((await campaignRow(c.id))!.status).toBe('paused')
  })

  it('không kiểm: `MANUAL` (kể cả hạn mức đang hết), `PUBLISH_FAILURES`', async () => {
    const fb = await page()
    const c = await running(fb.id)
    await blockBudget()
    actionOf(await pause(c.id))
    expect(actionOf(await resume(c.id))).toMatchObject({ changed: true })
    await systemPause(c.id, 'PUBLISH_FAILURES')
    expect(actionOf(await resume(c.id))).toMatchObject({ changed: true, campaign: { status: 'running' } })
  })
})

/* ---------- Xoá ---------- */

describe('xoá', () => {
  it('huỷ bài chưa đăng (`CAMPAIGN_DELETED`), giữ bài đã đăng / đang đăng; chiến dịch biến mất; job cũ bỏ qua', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const rows = await slotRows(c.id)
    const scheduled = await approved(c.id, rows[0]!.id)
    await written(rows[1]!.id)
    await setStatus(rows[2]!.id, 'failed')
    await setStatus(rows[3]!.id, 'publishing')
    await setStatus(rows[4]!.id, 'published')

    const res = await remove(c.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(DeleteCampaignResponse.parse(res.json())).toEqual({ cancelled: 28, kept: 2 })
    const after = await slotRows(c.id)
    expect(after.filter((r) => r.status === 'cancelled').every((r) => r.cancel_reason === 'CAMPAIGN_DELETED' && !r.held && r.error_code === null)).toBe(true)
    expect(after.filter((r) => r.status !== 'cancelled').map((r) => r.status)).toEqual(['publishing', 'published'])
    expect(after[0]!.schedule_version).toBe(scheduled.schedule_version + 1)
    expect(await campaignRow(c.id)).toBeUndefined()
    expect((await api('GET', `/api/v1/campaigns/${c.id}`)).statusCode).toBe(404)
    expect(CampaignListResponse.parse((await api('GET', '/api/v1/campaigns')).json()).items).toEqual([])
    expect(emittedOf('campaign.deleted')).toEqual([expect.objectContaining({ id: c.id })])

    expect(await publishTarget(publishDeps(), { targetId: scheduled.id, scheduleVersion: scheduled.schedule_version }, { finalAttempt: false })).toBe('skipped')
    expect(await runGenerate(aiDeps(START_MIDNIGHT), c.id, { finalAttempt: false })).toBe('skipped')
    expect(graph.calls).toHaveLength(0)
    expect(openai.responseRequests).toHaveLength(0)
    expect((await remove(c.id)).statusCode).toBe(404)
  })

  it('race: xoá lúc bài đang `publishing`, Meta trả lỗi tạm → bài `held`, lần retry bỏ qua; cron hoàn tất huỷ `CAMPAIGN_DELETED`', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const target = await approved(c.id, (await slotRows(c.id))[0]!.id)
    let deleted = 0
    graph.on('POST', `/${fb.account}/feed`, async () => {
      deleted = (await remove(c.id)).statusCode
      return { ok: false, kind: 'TRANSIENT', notSent: true }
    })
    const data = { targetId: target.id, scheduleVersion: target.schedule_version }
    await expect(publishTarget(publishDeps(), data, { finalAttempt: false })).rejects.toBeInstanceOf(PublishRetryableError)
    expect(deleted).toBe(200)
    expect(await slot(target.id)).toMatchObject({ status: 'scheduled', held: true })
    expect(await publishTarget(publishDeps(), data, { finalAttempt: false })).toBe('skipped')
    expect(graph.calls.filter((x) => x.method === 'POST')).toHaveLength(1)

    expect(await runCompleteCheck({ db: handle.db, events })).toBe(0)
    expect(await slot(target.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'CAMPAIGN_DELETED', held: false })
  })

  it('xoá nháp: bài xem trước `held` → `cancelled`; job xem trước sau đó bỏ qua; 401', async () => {
    const fb = await page()
    const d = await draft(fb.id)
    expect((await remove(d.id, false)).statusCode).toBe(401)
    const res = await remove(d.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(DeleteCampaignResponse.parse(res.json())).toEqual({ cancelled: 7, kept: 0 })
    expect((await slotRows(d.id)).map((r) => [r.status, r.held])).toEqual(Array(7).fill(['cancelled', false]))
    expect(await runPreview(aiDeps(), d.id, { finalAttempt: false })).toBe('skipped')
    expect(openai.responseRequests).toHaveLength(0)
  })
})

/* ---------- Hoàn tất + Lịch ---------- */

describe('cron campaigns.complete_check + Lịch', () => {
  it('không còn slot mở → `done` + `campaign.completed` (cả khi đang tạm dừng); còn slot `scheduled` → giữ', async () => {
    const fb = await page()
    const finished = await running(fb.id, { name: 'Hết bài' })
    const pausedEmpty = await running(fb.id, { name: 'Tạm dừng hết bài', postTimes: ['15:00'] })
    const busy = await running(fb.id, { name: 'Còn bài', postTimes: ['19:00'] })
    const [a, b] = await slotRows(finished.id)
    await setStatus(a!.id, 'published')
    await setStatus(b!.id, 'failed')
    await handle.sql`update post_targets set status = 'cancelled', cancel_reason = 'USER_DELETED' where campaign_id = ${finished.id} and status = 'planned'`
    actionOf(await pause(pausedEmpty.id))
    await handle.sql`update post_targets set status = 'cancelled', cancel_reason = 'USER_DELETED', held = false where campaign_id = ${pausedEmpty.id}`
    const keep = (await slotRows(busy.id))[0]!
    await approved(busy.id, keep.id)
    await handle.sql`update post_targets set status = 'cancelled', cancel_reason = 'USER_DELETED' where campaign_id = ${busy.id} and status = 'planned'`

    expect(await runCompleteCheck({ db: handle.db, events })).toBe(2)
    expect(await campaignRow(finished.id)).toMatchObject({ status: 'done', pause_reason: null })
    expect(await campaignRow(pausedEmpty.id)).toMatchObject({ status: 'done', pause_reason: null, paused_at: null })
    expect((await campaignRow(busy.id))!.status).toBe('running')
    expect(emittedOf('campaign.completed').map((e) => e.id).sort()).toEqual([finished.id, pausedEmpty.id].sort())
    // Lần sau không làm gì.
    expect(await runCompleteCheck({ db: handle.db, events })).toBe(0)
  })

  it('chiến dịch tạm dừng chỉ còn bài lỗi → `done` và bỏ `held` (đăng lại được)', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const [first] = await slotRows(c.id)
    await setStatus(first!.id, 'failed')
    actionOf(await pause(c.id))
    await handle.sql`update post_targets set status = 'cancelled', cancel_reason = 'USER_DELETED', held = false where campaign_id = ${c.id} and status = 'planned'`
    expect(await runCompleteCheck({ db: handle.db, events })).toBe(1)
    expect(await slot(first!.id)).toMatchObject({ status: 'failed', held: false })
  })

  it('Lịch: bài của chiến dịch tạm dừng có `held`', async () => {
    const fb = await page()
    const c = await running(fb.id)
    const from = new Date(`${START}T00:00:00.000+07:00`).toISOString()
    const to = new Date(Date.parse(from) + 7 * DAY).toISOString()
    const calendar = async () => CalendarResponse.parse((await api('GET', `/api/v1/calendar?${new URLSearchParams({ from, to })}`)).json()).items
    expect((await calendar()).every((i) => !i.held)).toBe(true)
    actionOf(await pause(c.id))
    const items = await calendar()
    expect(items).toHaveLength(7)
    expect(items.every((i) => i.held && i.campaignId === c.id)).toBe(true)
  })
})

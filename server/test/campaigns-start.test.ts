// Ma trận Story 7.3 — Bắt đầu chiến dịch (AD-15, AD-13, AD-18). Qua app thật (buildApp) + Postgres nhúng + pg-boss +
// OpenAI giả (sinh bài xem trước) + Meta giả (job đăng); không gọi mạng. Phủ: bắt đầu ở chế độ duyệt / tự đăng (slot còn
// lại `planned` trên Lịch, bài xem trước giữ nguyên + bỏ `held`, bài lỗi về "Chờ duyệt"), bài xem trước đã qua giờ, bấm
// hai lần / song song, trang không dùng được / ngày đã qua (kiểm lại như lúc lưu), hai tab, 404 / 401, job đăng sau bắt
// đầu, duyệt nội bộ (`approve` < 2 phút), bỏ lịch slot (409), danh sách theo phạm vi + tiến độ, Lịch (`topic`), race preview.
import { randomBytes } from 'node:crypto'
import {
  CalendarResponse,
  CampaignDto,
  CampaignListResponse,
  ErrorResponse,
  SaveBrandProfileRequest,
  StartCampaignResponse,
  type EventName,
  type SaveCampaignRequest,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey } from '../src/modules/ai/index.ts'
import { handlePreviewJob } from '../src/modules/campaigns/index.ts'
import { publishTarget, transitionTarget, type PublishDeps } from '../src/modules/content/index.ts'
import { upsertProfile } from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-START-key-aaaa1111'
const BRAND = { name: 'Gia dụng Minh Phát', tones: ['Vui vẻ'], pronoun: 'Shop – bạn', emoji: 'some' } as const
const MIN = 60_000
const DAY = 24 * 60 * MIN
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })
/** Ngày mai theo lịch VN (route kiểm ngày bắt đầu theo giờ hệ thống). */
const START = new Date(Date.now() + 7 * 60 * MIN + DAY).toISOString().slice(0, 10)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let openai: FakeOpenAiAdapter
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
  await handle.sql`delete from groups`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('campaigns.preview', 'campaigns.generate', 'content.image.generate', 'publish.target')`
}

const buildWith = (clock?: () => Date) =>
  buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, ai: { cipher, openai }, ...(clock ? { clock } : {}) })

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-campaigns-start', { background: false })
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
  app = buildWith()
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

type Platform = 'facebook' | 'instagram' | 'threads'

async function page(platform: Platform, opts: { brand?: boolean; groupId?: string } = {}): Promise<{ id: string; account: string }> {
  const account = randomBytes(6).toString('hex')
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values (${platform}, ${account}, ${'Trang ' + platform}, ${opts.groupId ?? null}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  if (opts.brand !== false) await upsertProfile(handle.db, { ownerType: 'page', ownerId: p!.id }, SaveBrandProfileRequest.parse(BRAND))
  return { id: p!.id, account }
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

function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, opts: { auth?: boolean; on?: FastifyInstance } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }
  if (opts.auth !== false) headers.cookie = cookie
  return (opts.on ?? app).inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
}
async function created(payload: SaveCampaignRequest, on?: FastifyInstance): Promise<CampaignDto> {
  const res = await api('POST', '/api/v1/campaigns', payload, on ? { on } : {})
  expect(res.statusCode, res.body).toBe(201)
  return CampaignDto.parse(res.json())
}
const start = (id: string, payload: unknown = {}, opts: { auth?: boolean; on?: FastifyInstance } = {}) => api('POST', `/api/v1/campaigns/${id}/start`, payload, opts)
async function started(id: string, on?: FastifyInstance) {
  const res = await start(id, {}, on ? { on } : {})
  expect(res.statusCode, res.body).toBe(200)
  return StartCampaignResponse.parse(res.json())
}
const errorOf = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error

const deps = () => ({ db: handle.db, events, jobs, cipher, openai, log })
const runJob = (campaignId: string) => handlePreviewJob(deps(), { data: { campaignId }, retryCount: 0, retryLimit: 2 })
const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })

interface SlotRow {
  id: string
  post_id: string
  page_id: string
  status: string
  held: boolean
  scheduled_at: Date | null
  slot_at: Date
  caption: string
  error_code: string | null
  version: number
  schedule_version: number
  topic: string | null
}
/** Dòng slot (giờ đổi sang `Date` — driver trả chuỗi). */
const slotRows = async (campaignId: string): Promise<SlotRow[]> =>
  (
    await handle.sql<(Omit<SlotRow, 'scheduled_at' | 'slot_at'> & { scheduled_at: string | null; slot_at: string })[]>`
      select t.id, t.post_id, t.page_id, t.status, t.held, t.scheduled_at, t.slot_at, t.caption, t.error_code, t.version, t.schedule_version, p.topic
      from post_targets t join posts p on p.id = t.post_id where t.campaign_id = ${campaignId} order by t.slot_at, t.id`
  ).map((r) => ({ ...r, scheduled_at: r.scheduled_at === null ? null : new Date(r.scheduled_at), slot_at: new Date(r.slot_at) }))
const publishJobs = async () =>
  (
    await handle.sql<{ data: { targetId: string; scheduleVersion: number }; start_after: string }[]>`
      select data, start_after from pgboss.job where name = 'publish.target' and state in ('created', 'retry') order by start_after`
  ).map((j) => ({ ...j, start_after: new Date(j.start_after) }))
const campaignRow = async (id: string) =>
  (await handle.sql<{ status: string; started_at: Date | null }[]>`select status, started_at from campaigns where id = ${id}`)[0]!

/** Nháp có bài xem trước đã viết xong (job `campaigns.preview` chạy một lượt). */
async function previewed(pages: SaveCampaignRequest['pages'], over: Partial<SaveCampaignRequest> = {}, on?: FastifyInstance) {
  const c = await created(body(pages, over), on)
  await runJob(c.id)
  return c
}

/* ---------- Bắt đầu ---------- */

describe('POST /campaigns/:id/start', () => {
  it('chế độ duyệt: running + started_at; 30 slot (23 mới `planned` trên Lịch); 7 bài xem trước giữ id / caption, bỏ held, có giờ; bài đã xoá vẫn cancelled; không job đăng; chụp tần suất; 1 sự kiện', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }])
    const before = await slotRows(c.id)
    expect(before).toHaveLength(7)
    const del = await api('POST', `/api/v1/campaigns/${c.id}/slots/${before[6]!.id}/transition`, { action: 'cancel', version: before[6]!.version })
    expect(del.statusCode, del.body).toBe(200)

    const res = await started(c.id)
    expect(res.alreadyStarted).toBe(false)
    expect(res.campaign).toMatchObject({ status: 'running', postsTotal: 29, postsDone: 0, postsPending: 6, daysDone: 0, trend: [0, 0, 0, 0, 0, 0, 0] })
    expect(res.campaign.startedAt).not.toBeNull()
    expect(res.campaign.pages).toEqual([{ pageId: fb.id, frequency: '1_per_day' }])
    expect(res.campaign.nextPost).toBe(before[0]!.slot_at.toISOString())
    expect(await campaignRow(c.id)).toMatchObject({ status: 'running' })

    const rows = await slotRows(c.id)
    expect(rows).toHaveLength(30)
    expect(rows.every((r) => !r.held)).toBe(true)
    for (const b of before.slice(0, 6)) {
      const r = rows.find((x) => x.id === b.id)!
      expect(r).toMatchObject({ status: 'pending_approval', caption: b.caption, version: b.version + 1 })
      expect(r.scheduled_at?.toISOString()).toBe(b.slot_at.toISOString())
    }
    expect(rows.find((r) => r.id === before[6]!.id)!.status).toBe('cancelled')
    const fresh = rows.filter((r) => !before.some((b) => b.id === r.id))
    expect(fresh).toHaveLength(23)
    expect(fresh.every((r) => r.status === 'planned' && r.caption === '' && r.scheduled_at?.getTime() === r.slot_at.getTime())).toBe(true)
    expect(await publishJobs()).toHaveLength(0)
    expect(emittedOf('campaign.started')).toEqual([{ id: c.id }])
    // Bắt đầu không gọi AI thêm (7 lời gọi là của bài xem trước).
    expect(openai.responseRequests).toHaveLength(7)
  })

  it('chế độ tự đăng: bài xem trước không lỗi → scheduled + job `publish.target` startAfter = slot_at; bài có mã giữ chờ duyệt; IG mất ảnh → MEDIA_REQUIRED; bài đang tạo ảnh vẫn planned; slot mới planned', async () => {
    const fb = await page('facebook')
    const ig = await page('instagram')
    const c = await previewed(
      [
        { pageId: fb.id, frequency: null },
        { pageId: ig.id, frequency: '3_per_week' },
      ],
      { mode: 'auto' },
    )
    const before = await slotRows(c.id)
    const fbRows = before.filter((r) => r.page_id === fb.id)
    const igRows = before.filter((r) => r.page_id === ig.id)
    expect(fbRows.map((r) => r.status)).toEqual(Array(5).fill('pending_approval'))
    expect(igRows.map((r) => r.status)).toEqual(['planned', 'planned'])
    await handle.sql`update post_targets set error_code = 'AI_POLICY_BLOCKED' where id = ${fbRows[1]!.id}`
    // IG: ảnh đã bị gỡ khỏi bài (vd ảnh lỗi rồi bài được sửa) → không đăng được.
    await handle.sql`delete from post_target_media where post_target_id = ${igRows[0]!.id}`
    await handle.sql`update post_targets set status = 'pending_approval', caption = 'Bài IG' where id = ${igRows[0]!.id}`

    const res = await started(c.id)
    expect(res.alreadyStarted).toBe(false)
    const rows = await slotRows(c.id)
    expect(rows).toHaveLength(43)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const scheduled = [fbRows[0]!, fbRows[2]!, fbRows[3]!, fbRows[4]!]
    for (const s of scheduled) expect(byId.get(s.id)).toMatchObject({ status: 'scheduled', schedule_version: 1, error_code: null })
    const jobsNow = await publishJobs()
    expect(jobsNow.map((j) => j.data.targetId).sort()).toEqual(scheduled.map((s) => s.id).sort())
    for (const j of jobsNow) expect(j.start_after.getTime()).toBe(byId.get(j.data.targetId)!.slot_at.getTime())
    expect(byId.get(fbRows[1]!.id)).toMatchObject({ status: 'pending_approval', error_code: 'AI_POLICY_BLOCKED' })
    expect(byId.get(igRows[0]!.id)).toMatchObject({ status: 'pending_approval', error_code: 'MEDIA_REQUIRED' })
    expect(byId.get(igRows[1]!.id)).toMatchObject({ status: 'planned', held: false })
    expect(byId.get(igRows[1]!.id)!.scheduled_at?.getTime()).toBe(igRows[1]!.slot_at.getTime())
    expect(rows.filter((r) => !before.some((b) => b.id === r.id)).every((r) => r.status === 'planned')).toBe(true)
    expect(res.campaign).toMatchObject({ status: 'running', postsTotal: 43, postsPending: 2 })
  })

  it('bài xem trước đã qua giờ (bắt đầu ngày đầu, sau giờ bài đầu): giữ chờ duyệt có giờ cũ (tự đăng: + SCHEDULE_IN_PAST); slot kế hoạch đã qua mà chưa có thì không tạo', async () => {
    // 12:00 giờ VN của ngày bắt đầu — bài 11:30 hôm đó đã qua.
    const at = new Date(`${START}T05:00:00.000Z`)
    const clocked = buildWith(() => at)
    try {
      const fb = await page('facebook')
      const review = await previewed([{ pageId: fb.id, frequency: null }], {}, clocked)
      const auto = await previewed([{ pageId: fb.id, frequency: null }], { mode: 'auto', name: 'Tự đăng' }, clocked)
      // Slot đầu của chiến dịch duyệt bị xoá cứng (giả lập "chưa có") → bắt đầu không dựng lại vì đã qua giờ.
      const reviewBefore = await slotRows(review.id)
      await handle.sql`delete from posts where id = ${reviewBefore[0]!.post_id}`

      await started(review.id, clocked)
      const reviewRows = await slotRows(review.id)
      expect(reviewRows).toHaveLength(29)
      expect(reviewRows.some((r) => r.slot_at.getTime() === reviewBefore[0]!.slot_at.getTime())).toBe(false)

      const autoBefore = await slotRows(auto.id)
      await started(auto.id, clocked)
      const autoRows = await slotRows(auto.id)
      expect(autoRows).toHaveLength(30)
      expect(autoRows[0]).toMatchObject({ id: autoBefore[0]!.id, status: 'pending_approval', error_code: 'SCHEDULE_IN_PAST' })
      expect(autoRows[0]!.scheduled_at?.getTime()).toBe(autoBefore[0]!.slot_at.getTime())
      expect(autoRows[1]).toMatchObject({ status: 'scheduled' })
    } finally {
      await clocked.close()
    }
  })

  it('bấm hai lần → lần sau 200 `alreadyStarted`, không đổi gì; hai request song song → đúng một lần bắt đầu', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }], { mode: 'auto' })
    await started(c.id)
    const rows = await slotRows(c.id)
    const jobsBefore = (await publishJobs()).length
    const again = await started(c.id)
    expect(again.alreadyStarted).toBe(true)
    expect(again.campaign.status).toBe('running')
    expect(await slotRows(c.id)).toEqual(rows)
    expect((await publishJobs()).length).toBe(jobsBefore)
    expect(emittedOf('campaign.started')).toHaveLength(1)

    const d = await previewed([{ pageId: fb.id, frequency: null }], { name: 'Song song' })
    const [a, b] = await Promise.all([start(d.id), start(d.id)])
    const results = [a, b].map((r) => {
      expect(r.statusCode, r.body).toBe(200)
      return StartCampaignResponse.parse(r.json()).alreadyStarted
    })
    expect(results.sort()).toEqual([false, true])
    expect(await slotRows(d.id)).toHaveLength(30)
    expect(emittedOf('campaign.started')).toHaveLength(2)
  })

  it('trang không dùng được (mất kết nối / thiếu hồ sơ / đã gỡ / rời nhóm nhãn) hoặc ngày bắt đầu đã qua → 400 theo ô, không đổi gì', async () => {
    const a = await page('facebook')
    const b = await page('threads')
    const c = await previewed([{ pageId: a.id, frequency: null }, { pageId: b.id, frequency: null }])
    const rowsBefore = await slotRows(c.id)
    const expectIssue = async (id: string, code: string | undefined, message: RegExp) => {
      const res = await start(id)
      expect(res.statusCode, res.body).toBe(400)
      const err = errorOf(res)
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details).toEqual([expect.objectContaining({ path: ['pages', 1, 'pageId'], message: expect.stringMatching(message), ...(code ? { code } : {}) })])
    }
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${b.id}`
    await expectIssue(c.id, 'PAGE_DISCONNECTED', /mất kết nối/)
    await handle.sql`update pages set connection_status = 'active' where id = ${b.id}`
    await handle.sql`delete from brand_profiles where owner_id = ${b.id}`
    await expectIssue(c.id, 'CONFIG_MISSING', /hồ sơ/)
    await upsertProfile(handle.db, { ownerType: 'page', ownerId: b.id }, SaveBrandProfileRequest.parse(BRAND))
    await handle.sql`update pages set removed_at = now() where id = ${b.id}`
    await expectIssue(c.id, undefined, /đã gỡ/)

    expect(await campaignRow(c.id)).toMatchObject({ status: 'draft', started_at: null })
    expect(await slotRows(c.id)).toEqual(rowsBefore)
    expect(emittedOf('campaign.started')).toHaveLength(0)

    // Nhóm nhãn: trang rời nhóm sau khi lưu.
    const [g] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values ('Nhóm Gia dụng', 'group-1') returning id`
    await upsertProfile(handle.db, { ownerType: 'group', ownerId: g!.id }, SaveBrandProfileRequest.parse(BRAND))
    const x = await page('facebook', { groupId: g!.id, brand: false })
    const y = await page('facebook', { groupId: g!.id, brand: false })
    const grouped = await created(body([{ pageId: x.id, frequency: null }, { pageId: y.id, frequency: null }], { groupId: g!.id, name: 'Theo nhóm' }))
    await handle.sql`update pages set group_id = null where id = ${y.id}`
    await upsertProfile(handle.db, { ownerType: 'page', ownerId: y.id }, SaveBrandProfileRequest.parse(BRAND))
    await expectIssue(grouped.id, undefined, /không thuộc nhóm/)

    const later = buildWith(() => new Date(Date.parse(`${START}T05:00:00.000Z`) + 2 * DAY))
    try {
      const d = await created(body([{ pageId: a.id, frequency: null }], { name: 'Ngày đã qua' }))
      const res = await start(d.id, {}, { on: later })
      expect(res.statusCode, res.body).toBe(400)
      expect(errorOf(res).details).toEqual([expect.objectContaining({ path: ['startDate'] })])
    } finally {
      await later.close()
    }
  })

  it('`baseUpdatedAt` cũ → 409, không đổi gì; đúng bản hiện tại → 200; chiến dịch lạ 404; body lạ 400; chưa đăng nhập 401', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }])
    const stale = await start(c.id, { baseUpdatedAt: '2020-01-01T00:00:00.000Z' })
    expect(stale.statusCode).toBe(409)
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT')
    expect((await campaignRow(c.id)).status).toBe('draft')
    expect((await start(c.id, { baseUpdatedAt: c.updatedAt })).statusCode).toBe(200)

    expect((await start('00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await start(c.id, { mode: 'auto' })).statusCode).toBe(400)
    expect((await start(c.id, {}, { auth: false })).statusCode).toBe(401)
  })
})

/* ---------- Sau khi bắt đầu ---------- */

describe('sau khi bắt đầu', () => {
  it('job `publish.target` đăng bài đã lên lịch (không còn held)', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }], { mode: 'auto' })
    await started(c.id)
    const [first] = await slotRows(c.id)
    const graph = createFakeMetaClient()
    graph.on('POST', `/${fb.account}/feed`, { ok: true, data: { id: `${fb.account}_1` } })
    const publishDeps: PublishDeps = { db: handle.db, events, jobs, cipher, graph, threads: createFakeMetaClient('https://graph.threads.com/v1.0'), sleep: async () => {}, pollMax: 3 }
    expect(await publishTarget(publishDeps, { targetId: first!.id, scheduleVersion: first!.schedule_version }, { finalAttempt: false })).toBe('published')
    expect((await slotRows(c.id))[0]!.status).toBe('published')
    expect(emittedOf('post_target.published')).toEqual([expect.objectContaining({ id: first!.id, campaignId: c.id })])
  })

  it('duyệt nội bộ (`approve`): giờ còn dưới 2 phút / đã qua → 422 SCHEDULE_IN_PAST; bỏ lịch slot chiến dịch → 409', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }])
    await started(c.id)
    const [slot] = await slotRows(c.id)
    const now = new Date()
    for (const at of [new Date(now.getTime() + MIN), new Date(now.getTime() - MIN)]) {
      await expect(
        handle.db.transaction((tx) => transitionTarget(tx, { jobs, events, now: () => now }, slot!.id, { action: 'approve', at }, slot!.version)),
      ).rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST', statusCode: 422 })
    }
    await handle.db.transaction((tx) => transitionTarget(tx, { jobs, events }, slot!.id, { action: 'approve', at: slot!.slot_at }, slot!.version))
    const [scheduled] = await slotRows(c.id)
    expect(scheduled!.status).toBe('scheduled')
    const res = await api('POST', `/api/v1/posts/${scheduled!.post_id}/targets/transition`, { action: 'unschedule', targets: [{ id: scheduled!.id, version: scheduled!.version }] })
    expect(res.statusCode, res.body).toBe(409)
    expect((await slotRows(c.id))[0]!.status).toBe('scheduled')
  })

  it('Lịch: slot `planned` có `ai`, `campaignId`, `topic`, `title` null; bài xem trước có tiêu đề', async () => {
    const fb = await page('facebook')
    const c = await previewed([{ pageId: fb.id, frequency: null }])
    await started(c.id)
    const from = new Date(`${START}T00:00:00.000+07:00`)
    const qs = new URLSearchParams({ from: from.toISOString(), to: new Date(from.getTime() + 14 * DAY).toISOString() })
    const res = await api('GET', `/api/v1/calendar?${qs}`)
    expect(res.statusCode, res.body).toBe(200)
    const items = CalendarResponse.parse(res.json()).items
    expect(items).toHaveLength(14)
    expect(items.every((i) => i.ai && i.campaignId === c.id && i.source === 'campaign' && i.topic !== null)).toBe(true)
    expect(items.slice(0, 7).every((i) => i.status === 'pending_approval' && i.title !== null)).toBe(true)
    expect(items.slice(7).every((i) => i.status === 'planned' && i.title === null)).toBe(true)
    expect(items[7]!.topic).toBe((await slotRows(c.id))[7]!.topic)
  })
})

/* ---------- Danh sách ---------- */

describe('GET /campaigns', () => {
  it('theo phạm vi: nháp (tổng bài theo kế hoạch) + đang chạy (đã đăng, chờ duyệt, bài kế, tương tác 7 ngày, số ngày); scope sai 400, lạ 404', async () => {
    const a = await page('facebook')
    const b = await page('threads')
    const run = await previewed([{ pageId: a.id, frequency: null }], { name: 'Đang chạy' })
    await started(run.id)
    const draft = await created(body([{ pageId: b.id, frequency: '2_per_day' }], { name: 'Nháp', postTimes: ['08:00', '20:00'], durationDays: 7 }))
    // Story 8.5: một bài đã đăng hôm qua (giờ VN), snapshot tương tác hôm qua 5 → hôm nay 12 → trend [.., 5, 7]; chiến dịch
    // mới chạy (chưa đủ 14 ngày) → không so kỳ trước.
    const [first] = await slotRows(run.id)
    await handle.sql`update post_targets set status = 'published', published_at = ${new Date(Date.now() - DAY).toISOString()} where id = ${first!.id}`
    const vnDay = (back: number) => new Date(Date.now() + 7 * 3_600_000 - back * DAY).toISOString().slice(0, 10)
    await handle.sql`insert into post_metrics (post_target_id, page_id, metric_date, engagement, fetched_at)
      values (${first!.id}, ${a.id}, ${vnDay(1)}, 5, now()), (${first!.id}, ${a.id}, ${vnDay(0)}, 12, now())`

    const list = async (qs = '') => {
      const res = await api('GET', `/api/v1/campaigns${qs}`)
      expect(res.statusCode, res.body).toBe(200)
      return CampaignListResponse.parse(res.json()).items
    }
    const all = await list()
    expect(all.map((c) => c.name)).toEqual(['Nháp', 'Đang chạy'])
    expect(all[0]).toMatchObject({ status: 'draft', postsTotal: 14, postsDone: 0, postsPending: 0, nextPost: null, daysDone: 0, startedAt: null })
    const running = all[1]!
    expect(running).toMatchObject({ status: 'running', postsTotal: 30, postsDone: 1, postsPending: 6, daysDone: 0 })
    expect(running.trend).toEqual([0, 0, 0, 0, 0, 5, 7])
    expect(running.engagement7d).toEqual({ current: 12, previous: null })
    expect(all[0]!.engagement7d).toEqual({ current: null, previous: null })
    expect(running.nextPost).toBe((await slotRows(run.id))[1]!.slot_at.toISOString())

    expect((await list(`?scope=page:${a.id}`)).map((c) => c.id)).toEqual([run.id])
    expect((await list(`?scope=page:${b.id}`)).map((c) => c.id)).toEqual([draft.id])
    expect((await list('?scope=all')).length).toBe(2)
    expect((await api('GET', '/api/v1/campaigns?scope=bad')).statusCode).toBe(400)
    expect((await api('GET', '/api/v1/campaigns?scope=page:00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await api('GET', '/api/v1/campaigns', undefined, { auth: false })).statusCode).toBe(401)
  })
})

/* ---------- Race bài xem trước ---------- */

describe('campaigns.preview', () => {
  it('slot không có trong kế hoạch vừa đọc → lượt job không sinh (không đoán luật ảnh)', async () => {
    const fb = await page('facebook')
    const c = await created(body([{ pageId: fb.id, frequency: null }]))
    const [post] = await handle.sql<{ id: string }[]>`insert into posts (source, topic) values ('campaign', 'Lạ') returning id`
    const stray = new Date(Date.parse(`${START}T12:00:00.000Z`) + 40 * DAY)
    await handle.sql`insert into post_targets (post_id, page_id, position, status, campaign_id, slot_at, held)
      values (${post!.id}, ${fb.id}, 0, 'planned', ${c.id}, ${stray.toISOString()}, true)`
    expect(await runJob(c.id)).toEqual({ generated: 7, errors: 0 })
    const rows = await slotRows(c.id)
    expect(rows.find((r) => r.post_id === post!.id)).toMatchObject({ status: 'planned', caption: '' })
  })
})

// Ma trận Story 5.6 — AI dừng và chạy lại đúng lúc khi hết hạn mức hoặc khoá lỗi (AD-7, AD-9, AD-16). Postgres nhúng +
// pg-boss (không chạy worker: gọi thẳng consumer `autoreply.triage` và handler `autoreply.run`) + OpenAI giả + Meta giả.
// Phủ: lỗi gateway lúc chạy → lý do tạm đóng (hạn mức, khoá 401, quota); khôi phục `handoff → ai` khi khách nhắn tiếp
// sau khi tăng hạn mức / sửa khoá; chưa khắc phục / vẫn lỗi thì giữ nguyên; khắc phục mà khách không nhắn thì không quét;
// đã tiếp quản / Tiếp quản giữa chừng; lý do chủ ý không khôi phục; khôi phục rồi chuyển chủ ý / quá 24 giờ / AI đã tắt;
// không trả lời trùng tin cũ; người khác trong luồng bình luận; hết hạn ở lần thử cuối (`job.signal`); kho vượt giới hạn
// lúc chạy; `inbound_at` của lượt khôi phục (NFR1). Tin AI gửi lỗi → `AI_SEND_FAILED`: `autoreply-run.test.ts`.
import { randomBytes } from 'node:crypto'
import { SaveAutoreplyConfigRequest, SaveBrandProfileRequest, type EventName } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { getOpenAiKeyStatus, handleAiEvent, setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import { handleRunJob, handleTriageEvent, runAutoreply, type RunDeps } from '../src/modules/autoreply/index.ts'
import { applyUserAction, deliverMessage, ingestComment, ingestDm, readAutoreplyTurn } from '../src/modules/inbox/index.ts'
import { capKnowledge, saveAutoreplyConfig, upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const GOOD = 'sk-proj-AUTOREPLY-resume-aaaa1111'
const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms)
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let fake: FakeOpenAiAdapter
let graph: FakeMetaClient

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name).map((e) => e.payload)

const raw = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
const REPLY = 'Dạ nồi chiên bảo hành 12 tháng ạ.'
const decision = (patch: Record<string, unknown> = {}) =>
  raw(JSON.stringify({ action: 'reply', reply: REPLY, mode: 'dm', reasonCode: null, confidence: 0.9, ...patch }))

const deps = (): RunDeps => ({ db: handle.db, events, jobs, cipher, openai: fake, log })
const triageDeps = () => ({ db: handle.db, events, jobs, cipher })

async function cleanup() {
  await handle.sql`delete from autoreply_runs`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from knowledge_items`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from autoreply_configs`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from contacts`
  await handle.sql`delete from page_credentials`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from pgboss.job where name in ('autoreply.run', 'inbox.send', 'inbox.fetch_profile', 'inbox.fetch_post_text')`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-autoreply-resume', { background: false })
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
  fake = createFakeOpenAiAdapter()
  fake.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
  fake.onResponse(decision())
  graph = createFakeMetaClient()
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

const HANDOFF = 'Dạ shop sẽ kiểm tra và phản hồi ngay ạ'

async function group(): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values ('Gia dụng', 'group-2') returning id`
  await upsertProfile(handle.db, { ownerType: 'group', ownerId: row!.id }, SaveBrandProfileRequest.parse({ name: 'Minh Phát' }))
  return row!.id
}

async function config(groupId: string, patch: Record<string, unknown> = {}) {
  await saveAutoreplyConfig(
    handle.db,
    { ownerType: 'group', ownerId: groupId },
    SaveAutoreplyConfigRequest.parse({
      enabled: true,
      script: 'Bạn là nhân viên Minh Phát.',
      channels: ['messenger', 'ig_direct', 'comment_public'],
      handoffKeywords: ['đổi trả'],
      handoffMessage: HANDOFF,
      ...patch,
    }),
  )
}

let seq = 0
async function page(groupId: string): Promise<string> {
  seq += 1
  const account = `ACC_${seq}_${randomBytes(3).toString('hex')}`
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values ('facebook', ${account}, ${'Trang ' + account}, ${groupId}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  return p!.id
}

/** Tin DM của khách; trả id hội thoại. */
async function dm(pageId: string, sender: string, opts: { text?: string; ts?: Date } = {}): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events, jobs },
    {
      pageId,
      message: {
        kind: 'dm',
        senderId: sender,
        recipientId: 'PAGE',
        mid: `mid_${seq}`,
        timestamp: opts.ts ?? ago(1000),
        text: opts.text ?? 'Nồi chiên bảo hành bao lâu?',
        attachments: [],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

/** `message.received` với id tin thật mới nhất của hội thoại (để biết người viết). */
async function triage(conversationId: string, pageId: string) {
  const [m] = await handle.sql<{ id: string }[]>`
    select id from messages where conversation_id = ${conversationId} and origin = 'customer' order by id desc limit 1`
  return handleTriageEvent(triageDeps(), { event: 'message.received', payload: { id: m!.id, pageId, conversationId } } as EventEnvelope)
}

/** Khách nhắn rồi triage. */
async function say(pageId: string, sender: string, text: string, ts?: Date) {
  const id = await dm(pageId, sender, { text, ...(ts ? { ts } : {}) })
  return { id, triage: await triage(id, pageId) }
}

/** Hết hạn mức tháng này (đã tiêu = hạn mức) → cổng hạn mức đóng. */
async function exhaustBudget() {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
  await settle(
    { db: handle.db, events },
    { reservationId: null, month: '2026-10', feature: 'autoreply', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } },
  )
  await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
}
/** Chủ shop tăng hạn mức. */
const raiseBudget = () => setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 10_000_000 })

/** Hội thoại vào `handoff` `AI_BUDGET_EXCEEDED` ở triage (khách nhắn khi hạn mức đã hết). */
async function budgetHandoff(pageId: string, sender: string, text = 'Nồi chiên bảo hành bao lâu?'): Promise<string> {
  await exhaustBudget()
  const { id, triage: t } = await say(pageId, sender, text)
  expect(t).toBe('applied')
  expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
  return id
}

const conv = async (id: string) =>
  (await handle.sql<{ state: string; state_reason: string | null; ai_enabled: boolean; waiting_since: Date | null }[]>`
    select state, state_reason, ai_enabled, waiting_since from conversations where id = ${id}`)[0]!
const messagesOf = (id: string) =>
  handle.sql<{ id: string; origin: string; text: string | null; status: string | null; reason_code: string | null; created_at: Date }[]>`
    select id, origin, text, status, reason_code, created_at from messages where conversation_id = ${id} order by id`
const trail = async (id: string) => (await messagesOf(id)).map((m) => [m.origin, m.origin === 'system' ? m.reason_code : m.text])
const runsOf = (id: string) =>
  handle.sql<{ outcome: string | null; reason_code: string | null; llm_calls: number; message_ids: string[]; inbound_at: Date }[]>`
    select * from autoreply_runs where conversation_id = ${id} order by started_at`
const runJobs = (id: string) => handle.sql`select 1 from pgboss.job where name = 'autoreply.run' and data->>'conversationId' = ${id}`
const clearRunJobs = () => handle.sql`delete from pgboss.job where name = 'autoreply.run'`

// ---------------------------------------------------------------------------------------------------------
// AC1: lỗi gateway lúc chạy → lý do tạm đóng, không câu chuyển tiếp
// ---------------------------------------------------------------------------------------------------------

describe('lỗi gateway lúc chạy → handoff tạm đóng', () => {
  it('hạn mức đủ qua cổng nhưng không đủ ước tính lời gọi → AI_BUDGET_EXCEEDED, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_B', 'Cho hỏi giá')
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 1 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
    expect(await trail(id)).toEqual([
      ['customer', 'Cho hỏi giá'],
      ['system', 'GATE_OPEN'],
      ['system', 'AI_BUDGET_EXCEEDED'],
    ])
  })

  it('OpenAI 401 lúc chạy → OPENAI_KEY_UNAVAILABLE, khoá thành invalid, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_K', 'Cho hỏi giá')
    fake.onResponse({ ok: false, kind: 'KEY_INVALID', status: 401 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'OPENAI_KEY_UNAVAILABLE' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect((await getOpenAiKeyStatus({ db: handle.db, cipher })).status).toBe('invalid')
    expect(emittedOf('openai_key.invalidated')).toHaveLength(1)
  })

  it('OpenAI hết quota (PROVIDER_QUOTA) → AI_PROVIDER_ERROR, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_Q', 'Cho hỏi giá')
    fake.onResponse({ ok: false, kind: 'PROVIDER_QUOTA', status: 429 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// AC2: khắc phục rồi khách nhắn tiếp → về ai
// ---------------------------------------------------------------------------------------------------------

describe('khôi phục khi khách nhắn tiếp', () => {
  it('tăng hạn mức rồi khách nhắn → triage queued; run: GATE_OPEN rồi tin AI, về ai; prompt có cả tin đang chờ', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_R1', 'Nồi chiên còn hàng không')
    await raiseBudget()
    const { triage: t } = await say(p, 'PSID_R1', 'Shop ơi trả lời giúp')
    expect(t).toBe('queued')
    expect(await runJobs(id)).toHaveLength(1)
    // Triage không đổi trạng thái: lượt chạy mới đưa về `ai` khi có gì để gửi.
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })

    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect(await trail(id)).toEqual([
      ['customer', 'Nồi chiên còn hàng không'],
      ['system', 'AI_BUDGET_EXCEEDED'],
      ['customer', 'Shop ơi trả lời giúp'],
      ['system', 'GATE_OPEN'],
      ['app_ai', REPLY],
    ])
    expect(await conv(id)).toMatchObject({ state: 'ai', state_reason: 'GATE_OPEN', waiting_since: null })
    const input = fake.responseRequests[0]!.input as string
    expect(input).toContain('Nồi chiên còn hàng không')
    expect(input).toContain('Shop ơi trả lời giúp')
    expect(await runsOf(id)).toMatchObject([{ outcome: 'replied', reason_code: null, llm_calls: 1 }])
    expect(emittedOf('conversation.state_changed').at(-1)).toMatchObject({ id, from: 'handoff', to: 'ai', reasonCode: 'GATE_OPEN' })
  })

  it('sửa khoá rồi khách nhắn → AI trả lời lại', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    const { id } = await say(p, 'PSID_R2', 'Cho hỏi giá')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'OPENAI_KEY_UNAVAILABLE' })
    await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
    expect((await say(p, 'PSID_R2', 'Alo shop')).triage).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect(await conv(id)).toMatchObject({ state: 'ai' })
    expect((await messagesOf(id)).at(-1)).toMatchObject({ origin: 'app_ai', status: 'pending' })
  })

  it('chưa khắc phục → triage skipped: không job, không tin system mới', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_N')
    await clearRunJobs()
    const before = emittedOf('conversation.state_changed').length
    expect((await say(p, 'PSID_N', 'Alo')).triage).toBe('skipped')
    expect(await runJobs(id)).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'system')).toHaveLength(1)
    expect(emittedOf('conversation.state_changed')).toHaveLength(before)
  })

  it('lượt khôi phục vẫn lỗi nhà cung cấp → giữ handoff như cũ, không tin system / sự kiện mới', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_P', 'Tin một')
    fake.onResponse({ ok: false, kind: 'TRANSIENT', status: 503 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })
    const systems = (await messagesOf(id)).filter((m) => m.origin === 'system').length
    const changes = emittedOf('conversation.state_changed').length

    expect((await say(p, 'PSID_P', 'Tin hai')).triage).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'system')).toHaveLength(systems)
    expect(emittedOf('conversation.state_changed')).toHaveLength(changes)
    expect((await runsOf(id)).at(-1)).toMatchObject({ outcome: 'handoff', reason_code: 'AI_PROVIDER_ERROR', message_ids: [] })

    // Lỗi bất ngờ ở lần thử cuối khi đang khôi phục: không fallback, vẫn `handoff` như cũ.
    fake.onResponse(() => {
      throw new Error('boom')
    })
    await expect(handleRunJob(deps(), { data: { conversationId: id }, retryCount: 2, retryLimit: 2 })).rejects.toThrow('boom')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })
    expect(emittedOf('conversation.state_changed')).toHaveLength(changes)
  })

  it('khắc phục mà khách không nhắn → không quét: settings.updated / ai_budget.restored không tạo lượt, giữ handoff', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_S')
    await clearRunJobs()
    emitted.length = 0
    await raiseBudget()
    for (const e of emittedOf('settings.updated')) await handleAiEvent({ db: handle.db, events }, { event: 'settings.updated', payload: e } as EventEnvelope)
    expect(emittedOf('ai_budget.restored')).toHaveLength(1)
    for (const e of emitted.slice()) {
      expect(await handleTriageEvent(triageDeps(), { event: e.name, payload: e.payload } as EventEnvelope)).toBe('ignored')
    }
    expect(await runJobs(id)).toHaveLength(0)
    // Job sót lại (không có tin khách mới sau lúc vào handoff) cũng không khôi phục.
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
  })
})

describe('khôi phục không chen vào việc của chủ shop', () => {
  it('đã tiếp quản → khắc phục + khách nhắn: vẫn human, không job, không lời gọi', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_T')
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    await clearRunJobs()
    await raiseBudget()
    expect((await say(p, 'PSID_T', 'Alo')).triage).toBe('skipped')
    expect(await runJobs(id)).toHaveLength(0)
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'TAKEOVER', ai_enabled: false })
  })

  it('Tiếp quản giữa lúc lượt khôi phục đang nghĩ → superseded, không tin AI; human', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_T2')
    await raiseBudget()
    await say(p, 'PSID_T2', 'Alo')
    fake.onResponse(async () => {
      await applyUserAction({ db: handle.db, events }, id, 'takeover')
      return decision()
    })
    expect(await runAutoreply(deps(), id)).toBe('superseded')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'TAKEOVER' })
  })

  it('lý do chủ ý (KEYWORD, AI_SEND_FAILED) → khách nhắn tiếp: triage skipped, giữ handoff', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id: k } = await say(p, 'PSID_KW', 'muốn đổi trả')
    expect(await runAutoreply(deps(), k)).toBe('handoff')
    expect(await conv(k)).toMatchObject({ state: 'handoff', state_reason: 'KEYWORD' })
    await clearRunJobs()
    expect((await say(p, 'PSID_KW', 'Shop ơi')).triage).toBe('skipped')
    expect(await runAutoreply(deps(), k)).toBe('skipped')
    expect(await conv(k)).toMatchObject({ state: 'handoff', state_reason: 'KEYWORD' })

    const { id: s } = await say(p, 'PSID_SF', 'Cho hỏi giá')
    expect(await runAutoreply(deps(), s)).toBe('replied')
    const [ai] = (await messagesOf(s)).filter((m) => m.origin === 'app_ai')
    graph.on('POST', '/me/messages', { ok: false, kind: 'RECIPIENT_UNAVAILABLE', status: 400 } as never)
    expect(await deliverMessage({ db: handle.db, events, jobs, cipher, graph }, ai!.id, { finalAttempt: false })).toBe('failed')
    expect(await conv(s)).toMatchObject({ state: 'handoff', state_reason: 'AI_SEND_FAILED' })
    await clearRunJobs()
    expect((await say(p, 'PSID_SF', 'Alo')).triage).toBe('skipped')
    expect(await runJobs(s)).toHaveLength(0)
    expect(fake.responseRequests).toHaveLength(1)
  })
})

describe('khôi phục rồi quyết định khác', () => {
  it('khôi phục rồi từ khoá → GATE_OPEN, câu chuyển tiếp, KEYWORD; handoff chủ ý', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_RK', 'Chào shop')
    await raiseBudget()
    await say(p, 'PSID_RK', 'muốn đổi trả hàng')
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect((await trail(id)).slice(2)).toEqual([
      ['customer', 'muốn đổi trả hàng'],
      ['system', 'GATE_OPEN'],
      ['app_ai', HANDOFF],
      ['system', 'KEYWORD'],
    ])
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'KEYWORD' })
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('khôi phục mà ngoài cửa sổ gửi (tin khách 25 giờ trước) → OUTSIDE_24H thẳng từ handoff, không GATE_OPEN, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    await exhaustBudget()
    const { id } = await say(p, 'PSID_OLD', 'Tin cũ', ago(26 * HOUR))
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
    await raiseBudget()
    // Webhook tới muộn: mốc Meta của tin mới cũng đã quá 24 giờ.
    expect((await say(p, 'PSID_OLD', 'Tin tới muộn', ago(25 * HOUR))).triage).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await trail(id)).toEqual([
      ['customer', 'Tin cũ'],
      ['system', 'AI_BUDGET_EXCEEDED'],
      ['customer', 'Tin tới muộn'],
      ['system', 'OUTSIDE_24H'],
    ])
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('khôi phục mà AI của trang đã tắt → human AI_OFF (AD-9), không lời gọi', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_OFF')
    await raiseBudget()
    await config(g, { enabled: false })
    expect((await say(p, 'PSID_OFF', 'Alo')).triage).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('not_applicable')
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'AI_OFF' })
    expect((await trail(id)).slice(-1)).toEqual([['system', 'AI_OFF']])
    expect(fake.responseRequests).toHaveLength(0)
  })
})

describe('không trả lời trùng, đúng người, đúng mốc', () => {
  it('AI đã trả lời tin 1; tin 2 → handoff; khắc phục; tin 3 → MỘT lời gọi, MỘT tin AI cho tin 2+3; job chạy lại skipped', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_D', 'Tin một')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    await say(p, 'PSID_D', 'Tin hai')
    fake.onResponse({ ok: false, kind: 'TRANSIENT', status: 503 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })

    fake.onResponse(decision())
    await say(p, 'PSID_D', 'Tin ba')
    const turn = (await readAutoreplyTurn(handle.db, id))!
    expect(turn.pending.map((m) => m.text)).toEqual(['Tin hai', 'Tin ba'])
    const calls = fake.responseRequests.length
    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect(fake.responseRequests).toHaveLength(calls + 1)
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(2)
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(calls + 1)
  })

  it('NFR1: inbound_at của lượt khôi phục = tin khách mới, không phải tin chờ cũ', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const id = await budgetHandoff(p, 'PSID_NFR', 'Tin chờ')
    await handle.sql`update messages set created_at = now() - interval '2 hours' where conversation_id = ${id} and origin = 'customer'`
    await handle.sql`update messages set created_at = now() - interval '1 hour' where conversation_id = ${id} and origin = 'system'`
    await raiseBudget()
    await say(p, 'PSID_NFR', 'Tin mới')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    const fresh = (await messagesOf(id)).find((m) => m.text === 'Tin mới')!
    const [run] = await runsOf(id)
    expect(new Date(run!.inbound_at).getTime()).toBe(new Date(fresh.created_at).getTime())
  })

  it('bình luận: người khác trong luồng khi đang handoff tạm đóng → triage skipped, run skipped', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    await exhaustBudget()
    const ingest = async (author: string, commentId: string, parentId: string | null, text: string) => {
      const res = await ingestComment(
        { db: handle.db, events, jobs },
        {
          pageId: p,
          comment: { kind: 'comment', commentId, parentId, platformPostId: `POST_${p}`, author: { id: author, name: author, username: null }, text, timestamp: ago(1000), attachments: [] },
        },
      )
      if (res.status !== 'created') throw new Error('ingest trùng')
      return res.conversationId
    }
    const id = await ingest('UA', 'C_A', null, 'Giá bao nhiêu?')
    expect(await triage(id, p)).toBe('applied')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
    await raiseBudget()
    await clearRunJobs()
    expect(await ingest('UX', 'C_X', 'C_A', 'Mình cũng hỏi')).toBe(id)
    expect(await triage(id, p)).toBe('skipped')
    expect(await runJobs(id)).toHaveLength(0)
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
  })

  it('bình luận: người khác bình luận lúc lượt khôi phục đang nghĩ → superseded, không tin AI, giữ handoff', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    await exhaustBudget()
    const ingest = async (author: string, commentId: string, parentId: string | null, text: string) => {
      const res = await ingestComment(
        { db: handle.db, events, jobs },
        {
          pageId: p,
          comment: { kind: 'comment', commentId, parentId, platformPostId: `POST_${p}`, author: { id: author, name: author, username: null }, text, timestamp: ago(1000), attachments: [] },
        },
      )
      if (res.status !== 'created') throw new Error('ingest trùng')
      return res.conversationId
    }
    const id = await ingest('UA', 'C_A1', null, 'Giá bao nhiêu?')
    expect(await triage(id, p)).toBe('applied')
    await handle.sql`update conversations set post_text_fetched_at = now() where id = ${id}`
    await raiseBudget()
    await ingest('UA', 'C_A2', 'C_A1', 'Shop ơi')
    expect(await triage(id, p)).toBe('queued')
    fake.onResponse(async () => {
      await ingest('UX', 'C_X1', 'C_A1', 'Mình cũng hỏi')
      return decision({ mode: 'public_reply' })
    })
    expect(await runAutoreply(deps(), id)).toBe('superseded')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
  })
})

describe('việc hoãn thuộc phạm vi', () => {
  it('hết hạn ở lần thử cuối (job.signal huỷ) → handoff AI_PROVIDER_ERROR, run failed; lần chưa cuối giữ ai', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const { id } = await say(p, 'PSID_X', 'Cho hỏi giá')
    const aborted = AbortSignal.abort(new DOMException('job quá hạn', 'AbortError'))
    await expect(handleRunJob(deps(), { data: { conversationId: id }, retryCount: 0, retryLimit: 2, signal: aborted })).rejects.toThrow()
    expect(await conv(id)).toMatchObject({ state: 'ai' })
    await expect(handleRunJob(deps(), { data: { conversationId: id }, retryCount: 2, retryLimit: 2, signal: aborted })).rejects.toThrow()
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR' })
    expect((await runsOf(id)).at(-1)).toMatchObject({ outcome: 'failed', reason_code: 'AI_PROVIDER_ERROR' })
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('kho vượt 40k token lúc chạy → prompt chỉ gồm các mục đầu trong giới hạn, AI vẫn trả lời', async () => {
    const g = await group()
    await config(g)
    const p = await page(g)
    const big = (tag: string) => `${tag} ${'a'.repeat(50_000)}`
    for (const tag of ['KHO_MOT', 'KHO_HAI']) {
      await handle.sql`
        insert into knowledge_items (owner_type, owner_id, kind, title, text, status, token_count)
        values ('group', ${g}, 'faq', ${tag}, ${big(tag)}, 'ready', 25010)`
    }
    const { id } = await say(p, 'PSID_KB', 'Cho hỏi giá')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    const req = fake.responseRequests[0]!
    const prompt = `${req.instructions}\n${req.input as string}`
    expect(prompt).toContain('KHO_MOT')
    expect(prompt).not.toContain('KHO_HAI')
  })

  it('capKnowledge: giữ theo thứ tự tới giới hạn, mục sau vừa thì vẫn giữ', () => {
    const e = (title: string, chars: number) => ({ kind: 'faq' as const, title, text: 'x'.repeat(chars) })
    // token ≈ (title + text) / 2.
    const { kept, dropped } = capKnowledge([e('a', 99), e('b', 199), e('c', 49)], 100)
    expect(kept.map((k) => k.title)).toEqual(['a', 'c'])
    expect(dropped).toBe(1)
  })
})

// Ma trận Story 5.4 — AI tự trả lời tin nhắn và chuyển cho bạn (AD-9, AD-16, AD-21, AD-24). Postgres nhúng + pg-boss
// (không chạy worker: gọi thẳng consumer `autoreply.triage` và handler `autoreply.run`) + OpenAI giả + Meta giả.
// Phủ: chuỗi cổng ở triage (mở / không áp dụng / tạm đóng, giờ hoạt động), trả lời (tin `app_ai` + `inbox.send`, nhật ký
// `autoreply_runs`, chấm "đang gõ"), gộp tin (stately), từ khoá, LLM chuyển / không chắc / vi phạm (sinh lại kèm vi
// phạm), tin không chữ, quá 24 giờ, lỗi nhà cung cấp, đua (khách nhắn giữa lúc AI nghĩ, Tiếp quản giữa chừng / sau khi
// áp, job chạy trùng), tin AI gửi lỗi → handoff, Gửi lại tin AI, bật lại AI khi khách chờ / đã trả lời, lỗi bất ngờ ở
// lần thử cuối, `aiTyping` của Hộp thư, `sent_at` cho NFR1. Cuối file: giờ hoạt động (thuần).
import { randomBytes } from 'node:crypto'
import { SaveAutoreplyConfigRequest, SaveBrandProfileRequest, defaultAutoreplyHours, type EventName } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import type { MetaResult } from '../src/adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import {
  AUTOREPLY_RUN_DELAY_MS,
  handleRunJob,
  handleTriageEvent,
  runAutoreply,
  withinActiveHours,
  type RunDeps,
} from '../src/modules/autoreply/index.ts'
import {
  applyAutoreplyDecision,
  applyUserAction,
  deliverMessage,
  getConversation,
  ingestComment,
  ingestDm,
  readAutoreplyTurn,
  resendMessage,
  setAiTyping,
  sweepStuckSending,
} from '../src/modules/inbox/index.ts'
import { saveAutoreplyConfig, upsertProfile } from '../src/modules/profiles/index.ts'
import { DEFAULT_OPENAI_PREFS, setOpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const GOOD = 'sk-proj-AUTOREPLY-run-aaaa1111'
const MIN = 60_000
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
const decision = (patch: Record<string, unknown> = {}) =>
  raw(JSON.stringify({ action: 'reply', reply: 'Dạ nồi chiên bảo hành 12 tháng ạ.', mode: 'dm', reasonCode: null, confidence: 0.9, ...patch }))

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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-autoreply-run', { background: false })
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
  await upsertProfile(handle.db, { ownerType: 'group', ownerId: row!.id }, SaveBrandProfileRequest.parse({ name: 'Minh Phát', bannedWords: ['rẻ nhất'] }))
  return row!.id
}

/** Lưu cấu hình AI của nhóm (mặc định: bật, Messenger + IG, luôn trả lời, từ khoá "đổi trả"). */
async function config(groupId: string, patch: Record<string, unknown> = {}) {
  await saveAutoreplyConfig(
    handle.db,
    { ownerType: 'group', ownerId: groupId },
    SaveAutoreplyConfigRequest.parse({
      enabled: true,
      script: 'Bạn là nhân viên Minh Phát.',
      channels: ['messenger', 'ig_direct'],
      handoffKeywords: ['đổi trả'],
      handoffMessage: HANDOFF,
      ...patch,
    }),
  )
}

let seq = 0
/** Trang thuộc nhóm + token (gửi được qua Meta giả). */
async function page(platform: 'facebook' | 'instagram', groupId: string | null): Promise<string> {
  seq += 1
  const account = `ACC_${seq}_${randomBytes(3).toString('hex')}`
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values (${platform}, ${account}, ${'Trang ' + account}, ${groupId}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  return p!.id
}

/** Tin DM của khách; trả id hội thoại. */
async function dm(pageId: string, sender: string, opts: { text?: string | null; ts?: Date; image?: boolean } = {}): Promise<string> {
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
        text: opts.text === undefined ? 'Nồi chiên bảo hành bao lâu?' : opts.text,
        attachments: opts.image ? [{ kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' }] : [],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

const triage = (conversationId: string, pageId: string) =>
  handleTriageEvent(triageDeps(), { event: 'message.received', payload: { id: 'm', pageId, conversationId } } as EventEnvelope)

/** Đẩy mọi `conversation.state_changed` chưa xử lý qua consumer triage (như pg-boss fan-out). */
let fedChanges = 0
async function feedStateChanges() {
  const out = []
  for (const payload of emittedOf('conversation.state_changed').slice(fedChanges)) {
    out.push(await handleTriageEvent(triageDeps(), { event: 'conversation.state_changed', payload } as EventEnvelope))
  }
  fedChanges = emittedOf('conversation.state_changed').length
  return out
}
beforeEach(() => {
  fedChanges = 0
})

/** Khách nhắn, triage đưa về `ai`. */
async function aiConversation(pageId: string, sender = 'PSID_1', text?: string): Promise<string> {
  const id = await dm(pageId, sender, { text: text ?? 'Nồi chiên bảo hành bao lâu?' })
  expect(await triage(id, pageId)).toBe('queued')
  return id
}

const conv = async (id: string) =>
  (await handle.sql<{ state: string; state_reason: string | null; ai_enabled: boolean; ai_typing_at: Date | null; waiting_since: Date | null }[]>`
    select state, state_reason, ai_enabled, ai_typing_at, waiting_since from conversations where id = ${id}`)[0]!
const messagesOf = (id: string) =>
  handle.sql<{ id: string; origin: string; text: string | null; status: string | null; reason_code: string | null; error_code: string | null; sent_at: Date | null }[]>`
    select id, origin, text, status, reason_code, error_code, sent_at from messages where conversation_id = ${id} order by platform_timestamp, id`
const runsOf = (id: string) =>
  handle.sql<
    { outcome: string | null; reason_code: string | null; config_source_type: string | null; config_source_id: string | null; llm_calls: number; confidence: number | null; message_ids: string[]; finished_at: Date | null; inbound_at: Date }[]
  >`select * from autoreply_runs where conversation_id = ${id} order by started_at`
const runJobs = (id: string) =>
  handle.sql<{ state: string; delay_ms: number; singleton_key: string }[]>`
    select state, singleton_key, (extract(epoch from start_after - created_on) * 1000)::float as delay_ms
    from pgboss.job where name = 'autoreply.run' and data->>'conversationId' = ${id}`
const sendJobs = () => handle.sql<{ data: { messageId: string } }[]>`select data from pgboss.job where name = 'inbox.send' order by created_on`
const fail = (kind: string): MetaResult => ({ ok: false, kind, status: 400 }) as MetaResult
const deliverDeps = () => ({ db: handle.db, events, jobs, cipher, graph })

// ---------------------------------------------------------------------------------------------------------
// Triage — chuỗi cổng
// ---------------------------------------------------------------------------------------------------------

describe('triage: cổng AD-16', () => {
  it('cổng mở → ai GATE_OPEN + autoreply.run trễ 4 giây (stately theo hội thoại)', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await dm(p, 'PSID_1')
    expect(await triage(id, p)).toBe('queued')
    expect(await conv(id)).toMatchObject({ state: 'ai', state_reason: 'GATE_OPEN' })
    const [job] = await runJobs(id)
    expect(job).toMatchObject({ state: 'created', singleton_key: id })
    expect(job!.delay_ms).toBeGreaterThanOrEqual(AUTOREPLY_RUN_DELAY_MS - 1000)
  })

  it('không áp dụng → human: CONFIG_MISSING / AI_OFF / CHANNEL_OFF (IG tắt, bình luận tắt); không job', async () => {
    const p0 = await page('facebook', null)
    const c0 = await dm(p0, 'U0')
    expect(await triage(c0, p0)).toBe('applied')
    expect(await conv(c0)).toMatchObject({ state: 'human', state_reason: 'CONFIG_MISSING' })

    const off = await group()
    await config(off, { enabled: false })
    const p1 = await page('facebook', off)
    const c1 = await dm(p1, 'U1')
    await triage(c1, p1)
    expect(await conv(c1)).toMatchObject({ state: 'human', state_reason: 'AI_OFF' })

    const g = await group()
    // Chỉ Messenger: DM Instagram và bình luận (Story 5.5 mở kênh bình luận khi bật) đều không áp dụng.
    await config(g, { channels: ['messenger'] })
    const ig = await page('instagram', g)
    const c2 = await dm(ig, 'U2')
    await triage(c2, ig)
    expect(await conv(c2)).toMatchObject({ state: 'human', state_reason: 'CHANNEL_OFF' })

    const fb = await page('facebook', g)
    const res = await ingestComment(
      { db: handle.db, events, jobs },
      {
        pageId: fb,
        comment: { kind: 'comment', commentId: 'C_1', parentId: null, platformPostId: 'POST_1', author: { id: 'U3', name: 'Khách', username: null }, text: 'Giá bao nhiêu?', timestamp: ago(1000), attachments: [] },
      },
    )
    const c3 = res.status === 'created' ? res.conversationId : ''
    await triage(c3, fb)
    expect(await conv(c3)).toMatchObject({ state: 'human', state_reason: 'CHANNEL_OFF' })
    expect(await handle.sql`select 1 from pgboss.job where name = 'autoreply.run'`).toHaveLength(0)
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('tạm đóng → handoff: OUTSIDE_HOURS / OPENAI_KEY_UNAVAILABLE / AI_BUDGET_EXCEEDED; không tin AI', async () => {
    const g = await group()
    // Không ngày nào bật khung → "tuỳ chỉnh" luôn đóng (lưu ở trạng thái tắt rồi bật thẳng trong DB để qua luật bật).
    await config(g, { enabled: false, schedule: 'custom', hours: defaultAutoreplyHours().map((h) => ({ ...h, on: false })) })
    await handle.sql`update autoreply_configs set enabled = true`
    const p = await page('facebook', g)
    const c1 = await dm(p, 'U1')
    await triage(c1, p)
    expect(await conv(c1)).toMatchObject({ state: 'handoff', state_reason: 'OUTSIDE_HOURS' })

    await config(g)
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    const c2 = await dm(p, 'U2')
    await triage(c2, p)
    expect(await conv(c2)).toMatchObject({ state: 'handoff', state_reason: 'OPENAI_KEY_UNAVAILABLE' })

    await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
    await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, monthlyLimitVnd: 100 })
    await settle({ db: handle.db, events }, { reservationId: null, month: '2026-10', feature: 'autoreply', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } })
    await handle.sql`update ai_budget_months set month = to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM')`
    const c3 = await dm(p, 'U3')
    await triage(c3, p)
    expect(await conv(c3)).toMatchObject({ state: 'handoff', state_reason: 'AI_BUDGET_EXCEEDED' })
    for (const c of [c1, c2, c3]) expect((await messagesOf(c)).map((m) => m.origin)).toEqual(['customer', 'system'])
    expect(fake.responseRequests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Lượt chạy
// ---------------------------------------------------------------------------------------------------------

describe('lượt chạy: trả lời', () => {
  it('reply → tin app_ai pending + inbox.send; giữ ai; autoreply_runs đủ id; typing bật rồi tắt; gửi xong có sent_at', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p)
    emitted.length = 0

    expect(await runAutoreply(deps(), id)).toBe('replied')
    const msgs = await messagesOf(id)
    expect(msgs.map((m) => [m.origin, m.status ?? m.reason_code])).toEqual([
      ['customer', null],
      ['system', 'GATE_OPEN'],
      ['app_ai', 'pending'],
    ])
    const ai = msgs[2]!
    expect(ai.text).toBe('Dạ nồi chiên bảo hành 12 tháng ạ.')
    expect((await sendJobs()).map((j) => j.data.messageId)).toEqual([ai.id])
    expect(await conv(id)).toMatchObject({ state: 'ai', ai_typing_at: null })
    const [run] = await runsOf(id)
    expect(run).toMatchObject({ outcome: 'replied', reason_code: null, config_source_type: 'group', config_source_id: g, llm_calls: 1, message_ids: [ai.id] })
    expect(run!.confidence).toBeCloseTo(0.9)
    expect(run!.finished_at).not.toBeNull()
    // Bật (trước LLM) rồi tắt (cùng transaction áp).
    expect(emittedOf('conversation.ai_typing')).toHaveLength(2)
    const [usage] = await handle.sql<{ feature: string; ref: string; page_id: string }[]>`select feature, ref, page_id from ai_usage`
    expect(usage).toEqual({ feature: 'autoreply', ref: id, page_id: p })
    // Prompt: kịch bản + hồ sơ nhóm + tin khách.
    expect(fake.responseRequests[0]!.instructions).toContain('Bạn là nhân viên Minh Phát.')
    expect(fake.responseRequests[0]!.input).toContain('Nồi chiên bảo hành bao lâu?')

    graph.on('POST', '/me/messages', { ok: true, data: { recipient_id: 'PSID_1', message_id: 'm_AI_1' } })
    expect(await deliverMessage(deliverDeps(), ai.id, { finalAttempt: false })).toBe('sent')
    const sent = (await messagesOf(id)).find((m) => m.id === ai.id)
    expect(sent).toMatchObject({ status: 'sent' })
    expect(sent!.sent_at).not.toBeNull()
    // NFR1: độ trễ webhook → đã gửi đo được từ autoreply_runs + messages.sent_at.
    const [lat] = await handle.sql<{ s: number }[]>`
      select extract(epoch from m.sent_at - r.inbound_at)::float as s from autoreply_runs r join messages m on m.id = r.message_ids[1]`
    expect(lat!.s).toBeGreaterThanOrEqual(0)
    expect(lat!.s).toBeLessThan(15)
  })

  it('gộp tin: 3 tin + 3 lần triage → MỘT job, MỘT lời gọi LLM, prompt có cả 3 tin', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_M', 'Chào shop')
    for (const text of ['Nồi chiên còn hàng không', 'Bảo hành bao lâu ạ']) {
      await dm(p, 'PSID_M', { text })
      expect(await triage(id, p)).toBe('queued')
    }
    expect(await runJobs(id)).toHaveLength(1)
    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect(fake.responseRequests).toHaveLength(1)
    const input = fake.responseRequests[0]!.input as string
    for (const t of ['Chào shop', 'Nồi chiên còn hàng không', 'Bảo hành bao lâu ạ']) expect(input).toContain(t)
    // Job chạy lại (retry / trùng) sau khi đã trả lời → bỏ qua, không gọi thêm, không ghi run.
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(1)
    expect(await runsOf(id)).toHaveLength(1)
  })
})

describe('lượt chạy: chuyển cho người', () => {
  it('từ khoá → 0 lời gọi; câu chuyển tiếp rồi tin system KEYWORD; handoff, Cần xử lý', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_K', 'muốn DOI TRA hàng')
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(fake.responseRequests).toHaveLength(0)
    expect((await messagesOf(id)).map((m) => [m.origin, m.text ?? m.reason_code])).toEqual([
      ['customer', 'muốn DOI TRA hàng'],
      ['system', 'GATE_OPEN'],
      ['app_ai', HANDOFF],
      ['system', 'KEYWORD'],
    ])
    const c = await conv(id)
    expect(c).toMatchObject({ state: 'handoff', state_reason: 'KEYWORD', ai_enabled: true })
    expect(c.waiting_since).not.toBeNull()
    expect(await runsOf(id)).toMatchObject([{ outcome: 'handoff', reason_code: 'KEYWORD', llm_calls: 0 }])
    expect(await getConversation(handle.db, id)).toMatchObject({ needsAttention: true, aiTyping: false })
  })

  it.each([
    ['LLM chuyển', decision({ action: 'handoff', reply: '', reasonCode: 'CUSTOMER_ASKED_HUMAN', confidence: 0.95 }), 'CUSTOMER_ASKED_HUMAN'],
    ['không chắc', decision({ confidence: 0.3 }), 'AI_UNCERTAIN'],
  ] as const)('%s → handoff lý do tương ứng + câu chuyển tiếp', async (_name, out, reason) => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_L', 'Cho hỏi chút')
    fake.onResponse(out)
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect((await messagesOf(id)).slice(-2).map((m) => [m.origin, m.text ?? m.reason_code])).toEqual([
      ['app_ai', HANDOFF],
      ['system', reason],
    ])
    expect(await runsOf(id)).toMatchObject([{ outcome: 'handoff', reason_code: reason, llm_calls: 1 }])
  })

  it('vi phạm 2 lần → AI_POLICY_BLOCKED; lần sinh lại kèm ghi chú vi phạm', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_V', 'Giá sao ạ')
    fake.onResponse(decision({ reply: 'Shop bán rẻ nhất thị trường ạ' }))
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(fake.responseRequests).toHaveLength(2)
    expect(fake.responseRequests[0]!.input).not.toContain('Bản trả lời trước bị chặn')
    expect(fake.responseRequests[1]!.input).toContain('Bản trả lời trước bị chặn')
    expect(fake.responseRequests[1]!.input).toContain('"rẻ nhất"')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_POLICY_BLOCKED' })
    expect(await runsOf(id)).toMatchObject([{ outcome: 'handoff', reason_code: 'AI_POLICY_BLOCKED', llm_calls: 2 }])
  })

  it('tin không chữ (ảnh) → NON_TEXT_MESSAGE + câu chuyển tiếp, 0 lời gọi', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await dm(p, 'PSID_IMG', { text: null, image: true })
    await triage(id, p)
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(fake.responseRequests).toHaveLength(0)
    expect((await messagesOf(id)).slice(-2).map((m) => [m.origin, m.text ?? m.reason_code])).toEqual([
      ['app_ai', HANDOFF],
      ['system', 'NON_TEXT_MESSAGE'],
    ])
  })

  it('lỗi nhà cung cấp (5xx) → handoff AI_PROVIDER_ERROR, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_5')
    fake.onResponse({ ok: false, kind: 'TRANSIENT', status: 503 })
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect((await messagesOf(id)).map((m) => m.origin)).toEqual(['customer', 'system', 'system'])
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR', ai_typing_at: null })
  })

  it('cổng đóng giữa chừng (chủ shop tắt AI khi hội thoại đang ai) → human AI_OFF, không gọi LLM', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_OFF')
    await config(g, { enabled: false })
    expect(await runAutoreply(deps(), id)).toBe('not_applicable')
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'AI_OFF' })
    expect(fake.responseRequests).toHaveLength(0)
  })
})

describe('lượt chạy: đua', () => {
  it('khách nhắn giữa lúc AI nghĩ → superseded, không gửi gì; lượt sau trả lời gộp cả hai tin', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_R', 'Tin thứ nhất')
    fake.onResponse(async () => {
      fake.onResponse(decision())
      await dm(p, 'PSID_R', { text: 'Tin thứ hai' })
      return decision()
    })
    expect(await runAutoreply(deps(), id)).toBe('superseded')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'ai', ai_typing_at: null })
    expect(await runsOf(id)).toMatchObject([{ outcome: 'superseded', llm_calls: 1, message_ids: [] }])

    expect(await triage(id, p)).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    const input = fake.responseRequests[1]!.input as string
    expect(input).toContain('Tin thứ nhất')
    expect(input).toContain('Tin thứ hai')
  })

  it('tin khách gửi trước lúc AI áp nhưng webhook tới sau (mốc Meta cũ hơn tin AI) → lượt sau vẫn trả lời, không mất tin', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_LATE', 'Tin thứ nhất')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    // Mốc Meta 5 giây trước, tức trước tin AI vừa ghi — nhưng vào hệ thống sau.
    await dm(p, 'PSID_LATE', { text: 'Còn màu đen không?', ts: ago(5000) })
    expect(await triage(id, p)).toBe('queued')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(2)
    expect(fake.responseRequests[1]!.input as string).toContain('Còn màu đen không?')
  })

  it('hai lượt chồng nhau cùng ảnh chụp (job quá hạn chạy lại) → lượt áp sau superseded, không trả lời hai lần', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_DUP')
    const turn = (await readAutoreplyTurn(handle.db, id))!
    const expected = { stateVersion: turn.stateVersion, lastInboundId: turn.lastInboundId! }
    const input = { messages: [{ mode: 'dm' as const, text: 'Dạ có ạ' }], transition: null }
    expect(await applyAutoreplyDecision(deps(), id, expected, input)).toMatchObject({ applied: true })
    expect(await applyAutoreplyDecision(deps(), id, expected, input)).toEqual({ applied: false, reason: 'superseded' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(1)
  })

  it('Tiếp quản khi AI đang nghĩ → superseded, không gửi gì; hội thoại human', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_T')
    fake.onResponse(async () => {
      await applyUserAction({ db: handle.db, events }, id, 'takeover')
      return decision()
    })
    expect(await runAutoreply(deps(), id)).toBe('superseded')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'TAKEOVER', ai_enabled: false })
    expect(await sendJobs()).toHaveLength(0)
    expect(await getConversation(handle.db, id)).toMatchObject({ aiTyping: false })
  })

  it('Tiếp quản sau khi áp (tin AI còn pending) → tin bị xoá, job gửi cancelled', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_T2')
    expect(await runAutoreply(deps(), id)).toBe('replied')
    const [job] = await sendJobs()
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(await deliverMessage(deliverDeps(), job!.data.messageId, { finalAttempt: false })).toBe('cancelled')
    expect(graph.calls).toHaveLength(0)
  })

  it('lỗi bất ngờ: lần chưa cuối ném để retry (giữ ai); lần cuối → handoff AI_PROVIDER_ERROR, run failed', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_E')
    fake.onResponse(() => {
      throw new Error('boom')
    })
    await expect(handleRunJob(deps(), { data: { conversationId: id }, retryCount: 0, retryLimit: 2 })).rejects.toThrow('boom')
    expect(await conv(id)).toMatchObject({ state: 'ai', ai_typing_at: null })
    await expect(handleRunJob(deps(), { data: { conversationId: id }, retryCount: 2, retryLimit: 2 })).rejects.toThrow('boom')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_PROVIDER_ERROR', ai_typing_at: null })
    expect(await runsOf(id)).toMatchObject([
      { outcome: 'failed', reason_code: null },
      { outcome: 'failed', reason_code: 'AI_PROVIDER_ERROR' },
    ])
  })
})

describe('tin AI gửi lỗi, Gửi lại', () => {
  it.each([
    ['RECIPIENT_UNAVAILABLE', 'AI_SEND_FAILED'],
    ['OUTSIDE_WINDOW', 'OUTSIDE_24H'],
  ] as const)('Meta %s → tin failed, hội thoại handoff %s', async (kind, reason) => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, `PSID_${kind}`)
    await runAutoreply(deps(), id)
    const [job] = await sendJobs()
    graph.on('POST', '/me/messages', fail(kind))
    expect(await deliverMessage(deliverDeps(), job!.data.messageId, { finalAttempt: false })).toBe('failed')
    expect((await messagesOf(id)).find((m) => m.origin === 'app_ai')).toMatchObject({ status: 'failed' })
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: reason })
    expect(await getConversation(handle.db, id)).toMatchObject({ needsAttention: true })
  })

  it('tin AI kẹt sending → cron SEND_UNKNOWN → handoff', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_STUCK')
    await runAutoreply(deps(), id)
    await handle.sql`update messages set status = 'sending', sending_at = now() - interval '20 minutes' where origin = 'app_ai'`
    expect(await sweepStuckSending({ db: handle.db, events })).toBe(1)
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'AI_SEND_FAILED' })
  })

  it('Gửi lại tin AI lỗi → pending + job mới; chủ shop gửi = human HUMAN_REPLIED, tắt AI', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_RS')
    await runAutoreply(deps(), id)
    const [job] = await sendJobs()
    graph.on('POST', '/me/messages', fail('RECIPIENT_UNAVAILABLE'))
    await deliverMessage(deliverDeps(), job!.data.messageId, { finalAttempt: false })
    const res = await resendMessage({ db: handle.db, events, jobs }, job!.data.messageId)
    expect(res).toEqual({ status: 'queued', messageId: job!.data.messageId })
    expect((await messagesOf(id)).find((m) => m.origin === 'app_ai')).toMatchObject({ status: 'pending', error_code: null })
    expect(await conv(id)).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', ai_enabled: false })
    expect(await sendJobs()).toHaveLength(2)
  })
})

describe('bật lại AI', () => {
  it('khách đang chờ → enable-ai → run ngay → AI trả lời tin chờ sẵn', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_RE')
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    // Job trễ 4 giây của tin đầu đã chạy xong (skipped vì `human`) — không còn job chờ chặn lượt bật lại.
    await handle.sql`delete from pgboss.job where name = 'autoreply.run'`
    fedChanges = emittedOf('conversation.state_changed').length
    await applyUserAction({ db: handle.db, events }, id, 'enable-ai')
    expect(await feedStateChanges()).toEqual(['queued'])
    const [job] = await runJobs(id)
    expect(job!.delay_ms).toBeLessThan(1000)
    expect(await runAutoreply(deps(), id)).toBe('replied')
    expect((await messagesOf(id)).at(-1)).toMatchObject({ origin: 'app_ai', status: 'pending' })
  })

  it('đã trả lời (tin cuối của chủ shop) → run skipped, không gọi LLM', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_RE2')
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    await handle.sql`insert into messages (conversation_id, page_id, direction, origin, status, delivery, text, platform_timestamp)
      values (${id}, ${p}, 'outbound', 'app_human', 'sent', 'dm', 'Dạ có ạ', now())`
    await applyUserAction({ db: handle.db, events }, id, 'enable-ai')
    expect(await runAutoreply(deps(), id)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await runsOf(id)).toHaveLength(0)
  })

  it('tin khách cuối 25 giờ trước → canSend từ chối → handoff OUTSIDE_24H, không tin AI', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await dm(p, 'PSID_OLD', { ts: ago(25 * 60 * MIN) })
    await triage(id, p)
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    await applyUserAction({ db: handle.db, events }, id, 'enable-ai')
    expect(await runAutoreply(deps(), id)).toBe('handoff')
    expect(await conv(id)).toMatchObject({ state: 'handoff', state_reason: 'OUTSIDE_24H' })
    expect((await messagesOf(id)).filter((m) => m.origin === 'app_ai')).toHaveLength(0)
    expect(fake.responseRequests).toHaveLength(0)
  })
})

describe('Hộp thư: aiTyping', () => {
  it('đang gõ khi ai + mốc còn hạn; quá 120 giây hoặc không ai → false', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const id = await aiConversation(p, 'PSID_TY')
    await setAiTyping({ db: handle.db, events }, id, true)
    expect(await getConversation(handle.db, id)).toMatchObject({ aiTyping: true })
    expect(emittedOf('conversation.ai_typing').at(-1)).toEqual({ id, pageId: p })
    await handle.sql`update conversations set ai_typing_at = now() - interval '121 seconds' where id = ${id}`
    expect(await getConversation(handle.db, id)).toMatchObject({ aiTyping: false })
    await handle.sql`update conversations set ai_typing_at = now() where id = ${id}`
    await applyUserAction({ db: handle.db, events }, id, 'takeover')
    expect(await getConversation(handle.db, id)).toMatchObject({ aiTyping: false })
    // Bật khi không còn `ai` → không ghi.
    await handle.sql`update conversations set ai_typing_at = null where id = ${id}`
    await setAiTyping({ db: handle.db, events }, id, true)
    expect((await conv(id)).ai_typing_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// Giờ hoạt động (thuần) — 2026-10-26 là Thứ Hai; giờ Việt Nam = UTC+7.
// ---------------------------------------------------------------------------------------------------------

describe('withinActiveHours', () => {
  const week = (mon: { on: boolean; from: string; to: string }) => [mon, ...defaultAutoreplyHours().slice(1).map((h) => ({ ...h, on: false }))]
  const vn = (iso: string) => new Date(`${iso}+07:00`)

  it('always luôn mở', () => {
    expect(withinActiveHours({ schedule: 'always', hours: week({ on: false, from: '08:00', to: '18:00' }) }, vn('2026-10-26T03:00:00'))).toBe(true)
  })

  it('offhours: ngoài giờ làm việc mở, trong giờ đóng, ngày nghỉ mở cả ngày', () => {
    const hours = week({ on: true, from: '08:00', to: '18:00' })
    expect(withinActiveHours({ schedule: 'offhours', hours }, vn('2026-10-26T20:00:00'))).toBe(true)
    expect(withinActiveHours({ schedule: 'offhours', hours }, vn('2026-10-26T10:00:00'))).toBe(false)
    expect(withinActiveHours({ schedule: 'offhours', hours }, vn('2026-10-27T10:00:00'))).toBe(true)
  })

  it('custom: khung qua đêm thuộc ngày bắt đầu; ngày nghỉ đóng', () => {
    const hours = week({ on: true, from: '22:00', to: '06:00' })
    expect(withinActiveHours({ schedule: 'custom', hours }, vn('2026-10-26T23:00:00'))).toBe(true)
    expect(withinActiveHours({ schedule: 'custom', hours }, vn('2026-10-27T03:00:00'))).toBe(true)
    expect(withinActiveHours({ schedule: 'custom', hours }, vn('2026-10-27T07:00:00'))).toBe(false)
    expect(withinActiveHours({ schedule: 'custom', hours }, vn('2026-10-26T03:00:00'))).toBe(false)
    expect(withinActiveHours({ schedule: 'custom', hours }, vn('2026-10-28T23:00:00'))).toBe(false)
  })
})

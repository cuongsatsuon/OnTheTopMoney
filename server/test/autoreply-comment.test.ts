// Ma trận Story 5.5 — AI trả lời bình luận công khai và nhắn riêng (AD-16, AD-10, AD-6, AD-9). Postgres nhúng + pg-boss
// (không chạy worker: gọi thẳng consumer `autoreply.triage`, handler `autoreply.run`, job gửi) + OpenAI giả + Meta giả.
// Phủ: trả lời công khai có caption, quyết định hai tin (công khai + nhắn riêng), một phần rỗng, vi phạm ở tin riêng,
// nhắn riêng đã dùng / quá 7 ngày (chỉ công khai; chỉ nhắn riêng → `OUTSIDE_24H`), Threads chỉ công khai, kênh bình
// luận tắt (`CHANNEL_OFF` + "Cần xử lý"), người khác trong luồng, bình luận của chính trang, chờ caption, bình luận bị
// xoá/ẩn trước lượt / giữa lúc AI nghĩ / trước khi gửi, gốc ẩn mà nhắn riêng còn, "Thử AI" hai tin.
import { randomBytes } from 'node:crypto'
import { AutoreplyTestRequest, SaveAutoreplyConfigRequest, SaveBrandProfileRequest, type EventName } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import type { MetaPostOptions } from '../src/adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { setOpenAiKey } from '../src/modules/ai/index.ts'
import { POST_TEXT_RETRY_MS, POST_TEXT_WAIT_MS, handleTriageEvent, runAutoreply, runAutoreplyTest, type RunDeps } from '../src/modules/autoreply/index.ts'
import {
  countConversations,
  deliverMessage,
  echoFromComment,
  fetchPostText,
  ingestComment,
  ingestEcho,
  markMessageRemoved,
} from '../src/modules/inbox/index.ts'
import { saveAutoreplyConfig, upsertProfile } from '../src/modules/profiles/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const GOOD = 'sk-proj-AUTOREPLY-comment-aaaa1111'
const DAY = 24 * 60 * 60_000
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
/** Một cách gửi (schema 5.4). */
const single = (mode: string, patch: Record<string, unknown> = {}) =>
  raw(JSON.stringify({ action: 'reply', reply: 'Dạ nồi chiên 5L giá 1.290.000đ ạ', mode, reasonCode: null, confidence: 0.9, ...patch }))
/** Hai tin (Story 5.5): không `mode`, có `privateReply`. */
const dual = (patch: Record<string, unknown> = {}) =>
  raw(
    JSON.stringify({
      action: 'reply',
      reply: 'Shop đã nhắn riêng cho bạn ạ',
      privateReply: 'Dạ nồi chiên 5L giá 1.290.000đ, bảo hành 12 tháng ạ',
      reasonCode: null,
      confidence: 0.9,
      ...patch,
    }),
  )

const deps = (now?: Date): RunDeps => ({ db: handle.db, events, jobs, cipher, openai: fake, log, ...(now ? { now: () => now } : {}) })
const triageDeps = () => ({ db: handle.db, events, jobs, cipher })
const deliverDeps = () => ({ db: handle.db, events, jobs, cipher, graph })

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
  await handle.sql`delete from pgboss.job where name in ('autoreply.run', 'inbox.send', 'inbox.fetch_profile', 'inbox.fetch_post_text', 'inbox.echo_match')`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-autoreply-comment', { background: false })
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
  fake.onResponse(single('public_reply'))
  graph = createFakeMetaClient()
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

const HANDOFF = 'Dạ shop sẽ kiểm tra và phản hồi ngay ạ'
const CAPTION = 'Nồi chiên không dầu 5L — giảm 20% tuần này'

async function group(): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values ('Gia dụng', 'group-2') returning id`
  await upsertProfile(handle.db, { ownerType: 'group', ownerId: row!.id }, SaveBrandProfileRequest.parse({ name: 'Minh Phát', bannedWords: ['rẻ nhất'] }))
  return row!.id
}

/** Cấu hình AI của nhóm: bật, mặc định cả hai kênh bình luận. */
async function config(groupId: string, channels: string[] = ['comment_public', 'comment_private']) {
  await saveAutoreplyConfig(
    handle.db,
    { ownerType: 'group', ownerId: groupId },
    SaveAutoreplyConfigRequest.parse({ enabled: true, script: 'Bạn là nhân viên Minh Phát.', channels, handoffKeywords: ['đổi trả'], handoffMessage: HANDOFF }),
  )
}

let seq = 0
async function page(platform: 'facebook' | 'instagram' | 'threads', groupId: string | null): Promise<string> {
  seq += 1
  const account = `ACC_${seq}_${randomBytes(3).toString('hex')}`
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values (${platform}, ${account}, ${'Trang ' + account}, ${groupId}) returning id`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p!.id}, ${cipher.encrypt(`TOKEN_${account}`)})`
  return p!.id
}

/** Bình luận của khách (hoặc người khác) trên bài `POST_<pageId>`; trả `{conversationId, commentId}`. */
async function comment(
  pageId: string,
  author: string,
  opts: { text?: string | null; parentId?: string | null; ts?: Date; image?: boolean } = {},
): Promise<{ conversationId: string; commentId: string }> {
  seq += 1
  const commentId = `C_${seq}`
  const res = await ingestComment(
    { db: handle.db, events, jobs },
    {
      pageId,
      comment: {
        kind: 'comment',
        commentId,
        parentId: opts.parentId ?? null,
        platformPostId: `POST_${pageId}`,
        author: { id: author, name: `Khách ${author}`, username: null },
        text: opts.text === undefined ? 'Giá bao nhiêu shop?' : opts.text,
        timestamp: opts.ts ?? ago(1000),
        attachments: opts.image ? [{ kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' }] : [],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return { conversationId: res.conversationId, commentId }
}

/** Lấy caption bài qua Meta giả (job `inbox.fetch_post_text`). */
async function caption(pageId: string, conversationId: string, text: string | null = CAPTION) {
  graph.on('GET', `/POST_${pageId}`, { ok: true, data: text === null ? {} : { message: text, caption: text, text } })
  await fetchPostText({ db: handle.db, events, cipher, graph, threads: graph }, conversationId, { finalAttempt: false })
}

const triage = (conversationId: string, pageId: string) =>
  handleTriageEvent(triageDeps(), { event: 'message.received', payload: { id: 'm', pageId, conversationId } } as EventEnvelope)
/** Triage với id tin thật của bình luận (để biết người viết). */
async function triageOf(c: { conversationId: string; commentId: string }, pageId: string) {
  const [m] = await handle.sql<{ id: string }[]>`select id from messages where page_id = ${pageId} and platform_message_id = ${c.commentId}`
  return handleTriageEvent(triageDeps(), { event: 'message.received', payload: { id: m!.id, pageId, conversationId: c.conversationId } } as EventEnvelope)
}

/** Khách bình luận, caption đã lấy, triage đưa về `ai`. */
async function aiComment(pageId: string, author = 'U1', text?: string, ts?: Date): Promise<{ conversationId: string; commentId: string }> {
  const c = await comment(pageId, author, { ...(text !== undefined ? { text } : {}), ...(ts ? { ts } : {}) })
  await caption(pageId, c.conversationId)
  expect(await triage(c.conversationId, pageId)).toBe('queued')
  return c
}

const conv = async (id: string) =>
  (await handle.sql<{ state: string; state_reason: string | null; ai_typing_at: Date | null }[]>`
    select state, state_reason, ai_typing_at from conversations where id = ${id}`)[0]!
const aiMessagesOf = (id: string) =>
  handle.sql<{ id: string; text: string | null; status: string | null; delivery: string | null; reply_to_platform_id: string | null; error_code: string | null }[]>`
    select id, text, status, delivery, reply_to_platform_id, error_code from messages where conversation_id = ${id} and origin = 'app_ai' order by id`
const runsOf = (id: string) =>
  handle.sql<{ outcome: string | null; reason_code: string | null; llm_calls: number; message_ids: string[] }[]>`
    select outcome, reason_code, llm_calls, message_ids from autoreply_runs where conversation_id = ${id} order by started_at`
const sendJobs = () => handle.sql<{ data: { messageId: string } }[]>`select data from pgboss.job where name = 'inbox.send' order by created_on`
const lastRequest = () => fake.responseRequests.at(-1)!
const inputOf = (i: number) => fake.responseRequests[i]!.input as string
const removeComment = (pageId: string, commentId: string, removal: 'deleted' | 'hidden') =>
  markMessageRemoved({ db: handle.db, events }, { pageId, platformMessageId: commentId, removal, at: new Date() })

// ---------------------------------------------------------------------------------------------------------
// Trả lời công khai / nhắn riêng
// ---------------------------------------------------------------------------------------------------------

describe('trả lời bình luận', () => {
  it('công khai: triage ai GATE_OPEN; prompt có caption + kênh công khai; tin public_reply nhắm bình luận gốc; gửi qua /{gốc}/comments', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p)
    expect(await conv(c.conversationId)).toMatchObject({ state: 'ai', state_reason: 'GATE_OPEN' })

    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    const req = lastRequest()
    expect(inputOf(0)).toContain(`Bài viết khách bình luận: «${CAPTION}»`)
    expect(req.instructions).toContain('trả lời CÔNG KHAI dưới bình luận Facebook')
    expect(req.jsonSchema?.schema).toMatchObject({ required: ['action', 'reply', 'mode', 'reasonCode', 'confidence'], properties: { mode: { enum: ['public_reply'] } } })
    const [ai] = await aiMessagesOf(c.conversationId)
    expect(ai).toMatchObject({ status: 'pending', delivery: 'public_reply', reply_to_platform_id: c.commentId, text: 'Dạ nồi chiên 5L giá 1.290.000đ ạ' })
    expect(await runsOf(c.conversationId)).toMatchObject([{ outcome: 'replied', llm_calls: 1, message_ids: [ai!.id] }])
    expect(await conv(c.conversationId)).toMatchObject({ state: 'ai', ai_typing_at: null })

    graph.on('POST', `/${c.commentId}/comments`, { ok: true, data: { id: 'C_AI_1' } })
    expect(await deliverMessage(deliverDeps(), ai!.id, { finalAttempt: false })).toBe('sent')
    expect(graph.calls.filter((x) => x.method === 'POST').map((x) => x.path)).toEqual([`/${c.commentId}/comments`])
  })

  it.each(['facebook', 'instagram'] as const)('hai tin (%s): công khai rồi nhắn riêng (đích = bình luận của khách), 2 job gửi, 1 lời gọi; schema có privateReply', async (platform) => {
    const g = await group()
    await config(g)
    const p = await page(platform, g)
    fake.onResponse(dual())
    const c = await aiComment(p)

    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    expect(fake.responseRequests).toHaveLength(1)
    const schema = lastRequest().jsonSchema?.schema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toEqual(['action', 'reply', 'privateReply', 'reasonCode', 'confidence'])
    expect(schema.properties).not.toHaveProperty('mode')
    expect(lastRequest().instructions).toContain('privateReply = tin NHẮN RIÊNG chi tiết')
    const msgs = await aiMessagesOf(c.conversationId)
    expect(msgs.map((m) => [m.delivery, m.reply_to_platform_id, m.status, m.text])).toEqual([
      ['public_reply', c.commentId, 'pending', 'Shop đã nhắn riêng cho bạn ạ'],
      ['private_reply', c.commentId, 'pending', 'Dạ nồi chiên 5L giá 1.290.000đ, bảo hành 12 tháng ạ'],
    ])
    expect((await sendJobs()).map((j) => j.data.messageId)).toEqual(msgs.map((m) => m.id))
    expect(await runsOf(c.conversationId)).toMatchObject([{ outcome: 'replied', message_ids: msgs.map((m) => m.id) }])

    if (platform !== 'facebook') return
    // Nhắn riêng đi Send API theo comment_id.
    graph.on('POST', '/me/messages', { ok: true, data: { message_id: 'm_PR', recipient_id: 'PSID_U1' } })
    expect(await deliverMessage(deliverDeps(), msgs[1]!.id, { finalAttempt: false })).toBe('sent')
    const call = graph.calls.find((x) => x.path === '/me/messages')!
    expect((call.options as MetaPostOptions).body?.recipient).toEqual({ comment_id: c.commentId })
  })

  it('một phần rỗng: privateReply rỗng → chỉ công khai; reply rỗng → chỉ nhắn riêng; cả hai rỗng → AI_UNCERTAIN + câu chuyển tiếp công khai', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)

    fake.onResponse(dual({ privateReply: '' }))
    const a = await aiComment(p, 'UA')
    expect(await runAutoreply(deps(), a.conversationId)).toBe('replied')
    expect((await aiMessagesOf(a.conversationId)).map((m) => m.delivery)).toEqual(['public_reply'])

    fake.onResponse(dual({ reply: '' }))
    const b = await aiComment(p, 'UB')
    expect(await runAutoreply(deps(), b.conversationId)).toBe('replied')
    expect((await aiMessagesOf(b.conversationId)).map((m) => m.delivery)).toEqual(['private_reply'])

    fake.onResponse(dual({ reply: ' ', privateReply: '' }))
    const c = await aiComment(p, 'UC')
    expect(await runAutoreply(deps(), c.conversationId)).toBe('handoff')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'AI_UNCERTAIN' })
    expect((await aiMessagesOf(c.conversationId)).map((m) => [m.delivery, m.text])).toEqual([['public_reply', HANDOFF]])
  })

  it('vi phạm ở tin riêng: lần 2 sạch → gửi lần 2 (2 lời gọi, ghi chú vi phạm); 2 lần vi phạm → AI_POLICY_BLOCKED + câu chuyển tiếp công khai', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)

    let n = 0
    fake.onResponse(async () => (++n === 1 ? dual({ privateReply: 'Giá rẻ nhất thị trường ạ' }) : dual()))
    const a = await aiComment(p, 'UA')
    expect(await runAutoreply(deps(), a.conversationId)).toBe('replied')
    expect(fake.responseRequests).toHaveLength(2)
    expect(inputOf(1)).toContain('"rẻ nhất"')
    expect((await aiMessagesOf(a.conversationId)).map((m) => m.text)).toEqual(['Shop đã nhắn riêng cho bạn ạ', 'Dạ nồi chiên 5L giá 1.290.000đ, bảo hành 12 tháng ạ'])

    fake.onResponse(dual({ privateReply: 'Giá rẻ nhất thị trường ạ' }))
    const b = await aiComment(p, 'UB')
    expect(await runAutoreply(deps(), b.conversationId)).toBe('handoff')
    expect(await conv(b.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'AI_POLICY_BLOCKED' })
    expect((await aiMessagesOf(b.conversationId)).map((m) => [m.delivery, m.text])).toEqual([['public_reply', HANDOFF]])
    expect(await runsOf(b.conversationId)).toMatchObject([{ outcome: 'handoff', reason_code: 'AI_POLICY_BLOCKED', llm_calls: 2 }])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Nhắn riêng không gửi được, Threads, kênh tắt
// ---------------------------------------------------------------------------------------------------------

describe('cách gửi theo canSend và nền tảng', () => {
  it('nhắn riêng đã dùng / bình luận quá 7 ngày → chỉ trả lời công khai, schema không có privateReply', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)

    const a = await aiComment(p, 'UA')
    // Bình luận này đã được nhắn riêng (id ghi trước tin khách → lượt vẫn thấy khách đang chờ trả lời công khai).
    await handle.sql`
      insert into messages (id, conversation_id, page_id, direction, origin, text, delivery, status, reply_to_platform_id, platform_timestamp)
      select '00000000-0000-7000-8000-000000000001', id, page_id, 'outbound', 'app_human', 'Inbox giá ạ', 'private_reply', 'sent', ${a.commentId},
        ${ago(5 * DAY).toISOString()}::timestamptz
      from conversations where id = ${a.conversationId}`
    expect(await runAutoreply(deps(), a.conversationId)).toBe('replied')
    expect(lastRequest().jsonSchema?.schema).toMatchObject({ properties: { mode: { enum: ['public_reply'] } } })
    expect((await aiMessagesOf(a.conversationId)).map((m) => m.delivery)).toEqual(['public_reply'])

    const b = await aiComment(p, 'UB', 'Còn hàng không?', ago(8 * DAY))
    expect(await runAutoreply(deps(), b.conversationId)).toBe('replied')
    expect(lastRequest().jsonSchema?.schema).toMatchObject({ properties: { mode: { enum: ['public_reply'] } } })
    expect((await aiMessagesOf(b.conversationId)).map((m) => m.delivery)).toEqual(['public_reply'])
  })

  it('chỉ bật nhắn riêng mà không gửi được (quá 7 ngày) → handoff OUTSIDE_24H, không tin, 0 lời gọi', async () => {
    const g = await group()
    await config(g, ['comment_private'])
    const p = await page('instagram', g)
    const c = await aiComment(p, 'UA', 'Giá sao?', ago(8 * DAY))
    expect(await runAutoreply(deps(), c.conversationId)).toBe('handoff')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'OUTSIDE_24H' })
    expect(await aiMessagesOf(c.conversationId)).toEqual([])
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('Threads: bật cả hai kênh → chỉ trả lời công khai; chỉ bật nhắn riêng → human CHANNEL_OFF', async () => {
    const g = await group()
    await config(g)
    const t = await page('threads', g)
    fake.onResponse(single('public_reply', { reply: 'Dạ 1.290.000đ ạ' }))
    const c = await aiComment(t)
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    expect(lastRequest().jsonSchema?.schema).toMatchObject({ properties: { mode: { enum: ['public_reply'] } } })
    expect(lastRequest().instructions).toContain('KHÔNG quá 500 ký tự')
    expect((await aiMessagesOf(c.conversationId)).map((m) => m.delivery)).toEqual(['public_reply'])

    const g2 = await group()
    await config(g2, ['comment_private'])
    const t2 = await page('threads', g2)
    const d = await comment(t2, 'UT')
    expect(await triage(d.conversationId, t2)).toBe('applied')
    expect(await conv(d.conversationId)).toMatchObject({ state: 'human', state_reason: 'CHANNEL_OFF' })
  })

  it('kênh bình luận tắt (chỉ Messenger) → human CHANNEL_OFF, không job; vẫn nằm trong "Cần xử lý"', async () => {
    const g = await group()
    await config(g, ['messenger'])
    const p = await page('facebook', g)
    const c = await comment(p, 'UA')
    expect(await triage(c.conversationId, p)).toBe('applied')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'human', state_reason: 'CHANNEL_OFF' })
    expect(await handle.sql`select 1 from pgboss.job where name = 'autoreply.run'`).toHaveLength(0)
    expect(await countConversations(handle.db, [p], 'needs_human')).toBe(1)
    expect(fake.responseRequests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Ai được trả lời
// ---------------------------------------------------------------------------------------------------------

describe('chỉ trả lời khách của hội thoại', () => {
  it('người khác trả lời trong luồng sau khi AI đã trả lời → handoff OTHER_COMMENTER (vào "Cần xử lý"), AI không trả lời họ', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p, 'UA')
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')

    const other = await comment(p, 'UX', { parentId: c.commentId, text: 'Mình cũng muốn hỏi' })
    expect(other.conversationId).toBe(c.conversationId)
    expect(await triageOf(other, p)).toBe('applied')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'OTHER_COMMENTER' })
    const [sys] = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from messages where conversation_id = ${c.conversationId} and origin = 'system' and reason_code = 'OTHER_COMMENTER'`
    expect(sys!.n).toBe(1)
    expect(await runAutoreply(deps(), c.conversationId)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(1)
    expect(await aiMessagesOf(c.conversationId)).toHaveLength(1)
  })

  it('người khác chen vào trước lượt → AI vẫn chỉ trả lời khách (prompt có "Người khác"); triage tin người khác → handoff', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p, 'UA')
    const other = await comment(p, 'UX', { parentId: c.commentId, text: 'Hóng' })
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    expect(await aiMessagesOf(c.conversationId)).toHaveLength(1)
    expect(inputOf(0)).toContain('Người khác: Hóng')
    expect(lastRequest().instructions).toContain('dòng "Người khác" chỉ để hiểu ngữ cảnh')

    expect(await triageOf(other, p)).toBe('applied')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'OTHER_COMMENTER' })
  })

  it('tin người khác được triage khi hội thoại còn triage → handoff OTHER_COMMENTER, không job AI; cổng đóng thì theo cổng', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await comment(p, 'UA')
    const other = await comment(p, 'UX', { parentId: c.commentId, text: 'Giá sao bạn?' })
    expect(await triageOf(other, p)).toBe('applied')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'handoff', state_reason: 'OTHER_COMMENTER' })
    expect(await triage(c.conversationId, p)).toBe('skipped')
    expect(await runAutoreply(deps(), c.conversationId)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)

    // Kênh bình luận tắt: tin người khác theo quyết định cổng (`human` `CHANNEL_OFF`), không OTHER_COMMENTER.
    await config(g, ['messenger'])
    const c2 = await comment(p, 'UB')
    const other2 = await comment(p, 'UY', { parentId: c2.commentId, text: 'Hóng' })
    expect(await triageOf(other2, p)).toBe('applied')
    expect(await conv(c2.conversationId)).toMatchObject({ state: 'human', state_reason: 'CHANNEL_OFF' })
  })

  it('bình luận của chính trang trong luồng (echo) → không message.received, lượt AI skipped', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p, 'UA')
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    emitted.length = 0

    const res = await ingestEcho(
      { db: handle.db, events, jobs, appIds: [] },
      {
        pageId: p,
        echo: echoFromComment({ kind: 'page_comment', commentId: 'C_PAGE', parentId: c.commentId, platformPostId: `POST_${p}`, text: 'Shop chào bạn', timestamp: new Date(), attachments: [] }),
      },
    )
    expect(res.status).not.toBe('no_conversation')
    expect(emittedOf('message.received')).toEqual([])
    expect(await runAutoreply(deps(), c.conversationId)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------------------------------------

describe('chờ caption bài', () => {
  it('caption chưa lấy, bình luận vừa tới → deferred + job run trễ 2 giây, không run; quá 10 giây → chạy với caption null', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await comment(p, 'UA')
    expect(await triage(c.conversationId, p)).toBe('queued')
    await handle.sql`delete from pgboss.job where name = 'autoreply.run'`

    expect(await runAutoreply(deps(), c.conversationId)).toBe('deferred')
    expect(await runsOf(c.conversationId)).toEqual([])
    expect(fake.responseRequests).toHaveLength(0)
    const [job] = await handle.sql<{ delay_ms: number }[]>`
      select (extract(epoch from start_after - created_on) * 1000)::float as delay_ms from pgboss.job where name = 'autoreply.run' and data->>'conversationId' = ${c.conversationId}`
    expect(job!.delay_ms).toBeGreaterThanOrEqual(POST_TEXT_RETRY_MS - 1000)

    const late = new Date(Date.now() + POST_TEXT_WAIT_MS + 1000)
    expect(await runAutoreply(deps(late), c.conversationId)).toBe('replied')
    expect(inputOf(0)).not.toContain('Bài viết khách bình luận')
  })

  it('caption đã lấy (kể cả bài không chữ) → chạy ngay', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await comment(p, 'UA')
    await caption(p, c.conversationId, null)
    await triage(c.conversationId, p)
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Bình luận bị xoá / ẩn
// ---------------------------------------------------------------------------------------------------------

describe('bình luận bị xoá / ẩn', () => {
  it.each(['deleted', 'hidden'] as const)('%s trước lượt → skipped, 0 lời gọi, không tin', async (removal) => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const c = await aiComment(p)
    await removeComment(p, c.commentId, removal)
    expect(await runAutoreply(deps(), c.conversationId)).toBe('skipped')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await aiMessagesOf(c.conversationId)).toEqual([])
  })

  it.each(['deleted', 'hidden'] as const)('%s giữa lúc AI nghĩ → superseded, không tin, giữ ai', async (removal) => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const c = await aiComment(p)
    fake.onResponse(async () => {
      await removeComment(p, c.commentId, removal)
      return dual()
    })
    expect(await runAutoreply(deps(), c.conversationId)).toBe('superseded')
    expect(await aiMessagesOf(c.conversationId)).toEqual([])
    expect(await sendJobs()).toEqual([])
    expect(await conv(c.conversationId)).toMatchObject({ state: 'ai', ai_typing_at: null })
    expect(await runsOf(c.conversationId)).toMatchObject([{ outcome: 'superseded', reason_code: null, message_ids: [] }])
  })

  it('gốc bị ẩn, khách trả lời trong luồng, cả hai kênh → chỉ nhắn riêng tới bình luận mới', async () => {
    const g = await group()
    await config(g)
    const p = await page('facebook', g)
    const c = await aiComment(p)
    await removeComment(p, c.commentId, 'hidden')
    const reply = await comment(p, 'U1', { parentId: c.commentId, text: 'Shop ơi giá sao?' })
    fake.onResponse(single('private_reply', { reply: 'Dạ giá 1.290.000đ ạ' }))
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    expect(lastRequest().jsonSchema?.schema).toMatchObject({ properties: { mode: { enum: ['private_reply'] } } })
    expect((await aiMessagesOf(c.conversationId)).map((m) => [m.delivery, m.reply_to_platform_id])).toEqual([['private_reply', reply.commentId]])
  })

  it('gốc bị xoá mà chỉ còn trả lời công khai → superseded, không chuyển người', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p)
    await removeComment(p, c.commentId, 'deleted')
    // Khách trả lời trong luồng của bình luận đã xoá (webhook tới lệch) — không còn chỗ trả lời công khai.
    await comment(p, 'U1', { parentId: c.commentId, text: 'Alo shop' })
    expect(await runAutoreply(deps(), c.conversationId)).toBe('superseded')
    expect(await conv(c.conversationId)).toMatchObject({ state: 'ai' })
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('gốc bị ẩn sau khi áp, trước khi job gửi → tin AI bị huỷ, không gọi Meta, conversation.updated, giữ ai', async () => {
    const g = await group()
    await config(g, ['comment_public'])
    const p = await page('facebook', g)
    const c = await aiComment(p)
    expect(await runAutoreply(deps(), c.conversationId)).toBe('replied')
    const [ai] = await aiMessagesOf(c.conversationId)
    await removeComment(p, c.commentId, 'hidden')
    emitted.length = 0

    expect(await deliverMessage(deliverDeps(), ai!.id, { finalAttempt: false })).toBe('cancelled')
    expect(graph.calls.filter((x) => x.method === 'POST')).toEqual([])
    expect(await aiMessagesOf(c.conversationId)).toEqual([])
    expect(emittedOf('conversation.updated')).toEqual([{ id: c.conversationId, pageId: p }])
    expect(await conv(c.conversationId)).toMatchObject({ state: 'ai' })
  })

  it('chủ shop trả lời bình luận đã ẩn vẫn gửi được (luật "đã gỡ" chỉ áp cho AI)', async () => {
    const g = await group()
    await config(g, ['messenger'])
    const p = await page('facebook', g)
    const c = await comment(p, 'UA')
    await removeComment(p, c.commentId, 'hidden')
    const [row] = await handle.sql<{ id: string }[]>`
      insert into messages (conversation_id, page_id, direction, origin, text, delivery, status, reply_to_platform_id, platform_timestamp, queued_at)
      select id, page_id, 'outbound', 'app_human', 'Dạ shop inbox ạ', 'public_reply', 'pending', ${c.commentId}, now(), now() from conversations where id = ${c.conversationId}
      returning id`
    graph.on('POST', `/${c.commentId}/comments`, { ok: true, data: { id: 'C_H' } })
    expect(await deliverMessage(deliverDeps(), row!.id, { finalAttempt: false })).toBe('sent')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Thử AI
// ---------------------------------------------------------------------------------------------------------

describe('Thử AI cho bình luận', () => {
  it('nháp FB bật cả hai kênh, thử comment_public → hai tin public_reply + private_reply; chỉ công khai → một tin', async () => {
    const g = await group()
    const p = await page('facebook', g)
    const draft = { enabled: false, script: 'Bạn là nhân viên Minh Phát.', channels: ['comment_public', 'comment_private'], handoffMessage: HANDOFF }
    fake.onResponse(dual())
    const res = await runAutoreplyTest(
      { db: handle.db, events, cipher, openai: fake, log },
      AutoreplyTestRequest.parse({ ownerType: 'page', ownerId: p, config: draft, channel: 'comment_public', message: 'Giá bao nhiêu?' }),
    )
    expect(res).toMatchObject({
      action: 'reply',
      messages: [
        { mode: 'public_reply', text: 'Shop đã nhắn riêng cho bạn ạ' },
        { mode: 'private_reply', text: 'Dạ nồi chiên 5L giá 1.290.000đ, bảo hành 12 tháng ạ' },
      ],
    })
    expect(await handle.sql`select 1 from messages`).toHaveLength(0)

    fake.onResponse(single('public_reply'))
    const one = await runAutoreplyTest(
      { db: handle.db, events, cipher, openai: fake, log },
      AutoreplyTestRequest.parse({ ownerType: 'page', ownerId: p, config: { ...draft, channels: ['comment_public'] }, channel: 'comment_public', message: 'Giá bao nhiêu?' }),
    )
    expect(one.messages).toEqual([{ mode: 'public_reply', text: 'Dạ nồi chiên 5L giá 1.290.000đ ạ' }])
  })
})

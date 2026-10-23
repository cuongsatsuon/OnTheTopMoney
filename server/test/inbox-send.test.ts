// Story 4.7 — gửi tin từ Hộp thư đúng luật 24 giờ (AD-10, AD-9, AD-11, AD-20, AD-24): `canSend` (DM 24 giờ, trả lời
// công khai trừ bình luận gốc đã xoá, nhắn riêng một lần mỗi bình luận ≤7 ngày, Threads chỉ công khai); gửi / gửi lại
// qua REST (tin `pending` + job `inbox.send` cùng transaction, từ chối sớm vẫn lưu `failed`, `HUMAN_REPLIED`); job
// gửi theo nền tảng (metadata, recipient_id gắn cùng khách), ánh xạ lỗi Meta, `TOKEN_INVALID` → mất kết nối, retry /
// hoãn `RATE_LIMITED`, tin bị huỷ, chạy trùng; cron tin kẹt `sending` → `SEND_UNKNOWN`; `TOKEN_INVALID` ở job tên khách
// và caption.
import { randomBytes } from 'node:crypto'
import { MessageDto, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { MetaResult } from '../src/adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import {
  RATE_LIMIT_DEFER_MAX_MS,
  SendRetryableError,
  applyUserAction,
  canSend,
  deliverMessage,
  fetchPostText,
  fetchProfile,
  handleSendJob,
  ingestComment,
  ingestDm,
  sendErrorOf,
  sweepStuckSending,
  type DeliverDeps,
} from '../src/modules/inbox/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { QUEUES, createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms)
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance
let cookie: string
let graph: FakeMetaClient
let threads: FakeMetaClient

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name).map((e) => e.payload)

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-inbox-send', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, events, jobs })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name = 'inbox.send'`
  emitted.length = 0
  graph = createFakeMetaClient()
  threads = createFakeMetaClient('https://graph.threads.com/v1.0')
  const { token } = await createSession(handle.db)
  cookie = `${SESSION_COOKIE}=${token}`
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

/** Trang + token (rõ = `TOKEN_<accountId>`); IG có thể lấy token của Fanpage nguồn. */
async function page(
  platform: 'facebook' | 'instagram' | 'threads',
  accountId: string,
  opts: { tokenSourcePageId?: string; status?: 'active' | 'disconnected' } = {},
): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, ${opts.status ?? 'active'}) returning id`
  const accessToken = opts.tokenSourcePageId ? null : cipher.encrypt(`TOKEN_${accountId}`)
  await handle.sql`insert into page_credentials (page_id, access_token, token_source_page_id)
    values (${p!.id}, ${accessToken}, ${opts.tokenSourcePageId ?? null})`
  return p!.id
}

let seq = 0
/** Tin DM của khách lúc `ts`; trả id hội thoại. */
async function dm(pageId: string, sender: string, ts: Date): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events, jobs },
    { pageId, message: { kind: 'dm', senderId: sender, recipientId: 'PAGE', mid: `mid_${seq}`, timestamp: ts, text: `tin ${seq}`, attachments: [] } },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

/** Bình luận của khách (`parentId` → trả lời trong luồng); trả id hội thoại. */
async function comment(pageId: string, commentId: string, author: string, ts: Date, parentId: string | null = null): Promise<string> {
  const res = await ingestComment(
    { db: handle.db, events, jobs },
    {
      pageId,
      comment: {
        kind: 'comment',
        commentId,
        parentId,
        platformPostId: 'POST_1',
        author: { id: author, name: `Khách ${author}`, username: null },
        text: `bình luận ${commentId}`,
        timestamp: ts,
        attachments: [],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

const setState = (id: string, state: string, waitingSince: Date | null = null) =>
  handle.sql`update conversations set state = ${state}, waiting_since = ${waitingSince?.toISOString() ?? null}::timestamptz where id = ${id}`

const conv = async (id: string) =>
  (
    await handle.sql<{ state: string; state_version: number; state_reason: string | null; ai_enabled: boolean; waiting_since: Date | null }[]>`
      select state, state_version, state_reason, ai_enabled, waiting_since from conversations where id = ${id}`
  )[0]!
const msgRow = async (id: string) =>
  (
    await handle.sql<
      { status: string | null; error_code: string | null; platform_message_id: string | null; delivery: string | null; reply_to_platform_id: string | null; origin: string }[]
    >`select status, error_code, platform_message_id, delivery, reply_to_platform_id, origin from messages where id = ${id}`
  )[0]
const messagesOf = (conversationId: string) =>
  handle.sql<{ id: string; origin: string; status: string | null; reason_code: string | null }[]>`
    select id, origin, status, reason_code from messages where conversation_id = ${conversationId} order by platform_timestamp, id`
const sendJobs = async () =>
  (await handle.sql<{ data: { messageId: string }; start_after: Date }[]>`select data, start_after from pgboss.job where name = 'inbox.send' order by created_on`).map(
    (r) => ({ messageId: r.data.messageId, startAfter: new Date(r.start_after) }),
  )
const pageStatus = async (id: string) => (await handle.sql<{ connection_status: string }[]>`select connection_status from pages where id = ${id}`)[0]!.connection_status

const post = (url: string, body?: unknown, headers: Record<string, string> = { cookie, origin: ORIGIN }) =>
  app.inject({ method: 'POST', url, headers, ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) })
const send = (conversationId: string, body: unknown) => post(`/api/v1/conversations/${conversationId}/messages`, body)
const countNeeds = async () => (await app.inject({ method: 'GET', url: '/api/v1/conversations/count?tab=needs_human', headers: { cookie } })).json<{ count: number }>().count

/** Gửi qua API (phải 201) → id tin. */
async function queued(conversationId: string, body: unknown): Promise<string> {
  const res = await send(conversationId, body)
  expect(res.statusCode, res.body).toBe(201)
  return MessageDto.parse(res.json()).id
}

const deliverDeps = (): DeliverDeps => ({ db: handle.db, events, jobs, cipher, graph, threads })
const deliver = (messageId: string, finalAttempt = false) => deliverMessage(deliverDeps(), messageId, { finalAttempt })
const fail = (kind: string, extra: Record<string, unknown> = {}): MetaResult => ({ ok: false, kind, status: 400, ...extra }) as MetaResult

// ---------------------------------------------------------------------------------------------------------
// Gửi DM
// ---------------------------------------------------------------------------------------------------------

describe('gửi DM trong 24 giờ', () => {
  it('ai → 201 pending + job cùng transaction; human HUMAN_REPLIED, tắt AI, huỷ tin AI pending; job gửi kèm metadata → sent', async () => {
    const p = await page('facebook', 'FB_1')
    const c = await dm(p, 'PSID_1', ago(HOUR))
    await setState(c, 'ai')
    await handle.sql`insert into messages (conversation_id, page_id, direction, origin, status, text, platform_timestamp)
      values (${c}, ${p}, 'outbound', 'app_ai', 'pending', 'AI nháp', now())`
    const before = await conv(c)

    const res = await send(c, { text: '  Dạ shop chào chị  ' })
    expect(res.statusCode).toBe(201)
    const dto = MessageDto.parse(res.json())
    expect(dto).toMatchObject({ origin: 'app_human', direction: 'outbound', status: 'pending', delivery: 'dm', errorCode: null, text: 'Dạ shop chào chị' })
    expect(await sendJobs()).toEqual([expect.objectContaining({ messageId: dto.id })])

    const after = await conv(c)
    expect(after).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', ai_enabled: false, waiting_since: null, state_version: before.state_version + 1 })
    const rows = await messagesOf(c)
    expect(rows.map((r) => r.origin)).toEqual(['customer', 'app_human', 'system'])
    expect(rows.at(-1)!.reason_code).toBe('HUMAN_REPLIED')
    expect(emittedOf('conversation.state_changed')).toEqual([expect.objectContaining({ id: c, from: 'ai', to: 'human', reasonCode: 'HUMAN_REPLIED' })])

    graph.on('POST', '/me/messages', { ok: true, data: { recipient_id: 'PSID_1', message_id: 'm_OUT_1' } })
    expect(await deliver(dto.id)).toBe('sent')
    const call = graph.calls[0]!
    expect(call.options.token).toBe('TOKEN_FB_1')
    expect(call.options.tier).toBe('interactive')
    expect(call.options.scope).toBe('page:FB_1')
    expect(call.options.body).toEqual({ recipient: { id: 'PSID_1' }, messaging_type: 'RESPONSE', message: { text: 'Dạ shop chào chị', metadata: dto.id } })
    expect(await msgRow(dto.id)).toMatchObject({ status: 'sent', platform_message_id: 'm_OUT_1', error_code: null })
    expect(emittedOf('message.sent')).toEqual([{ id: dto.id, pageId: p, conversationId: c }])
  })

  it('Instagram DM: không gửi metadata; triage và handoff cũng → human', async () => {
    const fb = await page('facebook', 'FB_SRC')
    const ig = await page('instagram', 'IG_1', { tokenSourcePageId: fb })
    const c = await dm(ig, 'IGSID_1', ago(HOUR))
    expect((await conv(c)).state).toBe('triage')
    const id = await queued(c, { text: 'hi' })
    expect((await conv(c)).state).toBe('human')
    graph.on('POST', '/me/messages', { ok: true, data: { recipient_id: 'IGSID_1', message_id: 'm_IG' } })
    expect(await deliver(id)).toBe('sent')
    expect(graph.calls[0]!.options.token).toBe('TOKEN_FB_SRC')
    expect(graph.calls[0]!.options.body).toEqual({ recipient: { id: 'IGSID_1' }, messaging_type: 'RESPONSE', message: { text: 'hi' } })

    const h = await dm(fb, 'PSID_H', ago(HOUR))
    await setState(h, 'handoff', ago(HOUR))
    await queued(h, { text: 'ok' })
    expect(await conv(h)).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', waiting_since: null })
  })

  it('ở human: không chuyển trạng thái, xoá mốc chờ, rời "Cần xử lý"', async () => {
    const p = await page('facebook', 'FB_2')
    const c = await dm(p, 'PSID_2', ago(HOUR))
    await setState(c, 'human', ago(HOUR))
    expect(await countNeeds()).toBe(1)
    const before = await conv(c)
    await queued(c, { text: 'trả lời' })
    expect(await conv(c)).toMatchObject({ state: 'human', state_version: before.state_version, waiting_since: null })
    expect(emittedOf('conversation.state_changed')).toEqual([])
    expect(await countNeeds()).toBe(0)
  })

  it('ở done → human HUMAN_REPLIED, tắt AI (AD-9); ở human mà AI còn bật → tắt AI', async () => {
    const p = await page('facebook', 'FB_DN')
    const c = await dm(p, 'PSID_DN', ago(HOUR))
    await setState(c, 'done')
    await handle.sql`update conversations set ai_enabled = true where id = ${c}`
    await queued(c, { text: 'shop hỏi thêm' })
    expect(await conv(c)).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', ai_enabled: false })

    const h = await dm(p, 'PSID_DN2', ago(HOUR))
    await setState(h, 'human')
    await handle.sql`update conversations set ai_enabled = true where id = ${h}`
    await queued(h, { text: 'ok' })
    expect(await conv(h)).toMatchObject({ state: 'human', ai_enabled: false })
  })
})

describe('quá 24 giờ và đầu vào sai', () => {
  it('tin khách 25 giờ trước → 409 OUTSIDE_24H; tin vẫn lưu failed + message.failed; trạng thái không đổi; vẫn cần xử lý', async () => {
    const p = await page('facebook', 'FB_3')
    const c = await dm(p, 'PSID_3', ago(25 * HOUR))
    await setState(c, 'human', ago(25 * HOUR))
    const before = await conv(c)
    const res = await send(c, { text: 'muộn rồi' })
    expect(res.statusCode).toBe(409)
    const body = res.json<{ error: { code: string; details: { messageId: string } } }>()
    expect(body.error.code).toBe('OUTSIDE_24H')
    const id = body.error.details.messageId
    expect(await msgRow(id)).toMatchObject({ status: 'failed', error_code: 'OUTSIDE_24H', origin: 'app_human', delivery: 'dm' })
    expect(emittedOf('message.failed')).toEqual([{ id, pageId: p, conversationId: c, errorCode: 'OUTSIDE_24H' }])
    expect(await conv(c)).toMatchObject({ state: 'human', state_version: before.state_version })
    expect(await sendJobs()).toEqual([])
    // Tin lỗi không tính là đã trả lời.
    expect(await countNeeds()).toBe(1)
    const list = (await app.inject({ method: 'GET', url: '/api/v1/conversations?tab=needs_human', headers: { cookie } })).json<{ items: { preview: { origin: string } }[] }>()
    expect(list.items[0]!.preview.origin).toBe('customer')
  })

  it('chưa có tin khách (last_customer_message_at null) → OUTSIDE_24H', async () => {
    const p = await page('facebook', 'FB_4')
    const c = await dm(p, 'PSID_4', ago(HOUR))
    await handle.sql`update conversations set last_customer_message_at = null where id = ${c}`
    expect(await canSend(handle.db, c, 'dm')).toEqual({ ok: false, code: 'OUTSIDE_24H' })
  })

  it('chữ rỗng, quá giới hạn, mode lệch kênh, Threads nhắn riêng → 400, không lưu gì', async () => {
    const fb = await page('facebook', 'FB_5')
    const th = await page('threads', 'TH_5')
    const d = await dm(fb, 'PSID_5', ago(HOUR))
    const cm = await comment(fb, 'C_5', 'U_5', ago(HOUR))
    const tc = await comment(th, 'TC_5', 'TU_5', ago(HOUR))
    for (const [c, body] of [
      [d, { text: '   ' }],
      [d, { text: 'a'.repeat(2001) }],
      [d, { text: 'x', mode: 'private_reply' }],
      [cm, { text: 'x', mode: 'dm' }],
      [tc, { text: 'x', mode: 'private_reply' }],
      [tc, { text: 'a'.repeat(501) }],
    ] as const) {
      const res = await send(c, body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED')
    }
    const outbound = await handle.sql`select id from messages where direction = 'outbound'`
    expect(outbound).toHaveLength(0)
  })

  it('phiên / Origin / hội thoại không có / trang đã gỡ', async () => {
    const p = await page('facebook', 'FB_6')
    const c = await dm(p, 'PSID_6', ago(HOUR))
    expect((await post(`/api/v1/conversations/${c}/messages`, { text: 'x' }, { origin: ORIGIN })).statusCode).toBe(401)
    expect((await post(`/api/v1/conversations/${c}/messages`, { text: 'x' }, { cookie, origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await send('019a0000-0000-7000-8000-000000000000', { text: 'x' })).statusCode).toBe(404)
    await handle.sql`update pages set removed_at = now() where id = ${p}`
    expect((await send(c, { text: 'x' })).statusCode).toBe(404)
  })

  it('trang mất kết nối → 409 PAGE_DISCONNECTED, tin failed', async () => {
    const p = await page('facebook', 'FB_7')
    const c = await dm(p, 'PSID_7', ago(HOUR))
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${p}`
    const res = await send(c, { text: 'x' })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('PAGE_DISCONNECTED')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Bình luận
// ---------------------------------------------------------------------------------------------------------

describe('trả lời công khai', () => {
  it('FB → POST /{gốc}/comments; IG → /{gốc}/replies; Threads → container reply_to_id rồi publish', async () => {
    const fb = await page('facebook', 'FB_8')
    const ig = await page('instagram', 'IG_8')
    const th = await page('threads', 'TH_8')
    const cFb = await comment(fb, 'POST_1_C8', 'U8', ago(10 * 24 * HOUR))
    const cIg = await comment(ig, 'IGC_8', 'IGU8', ago(HOUR))
    const cTh = await comment(th, 'THC_8', 'THU8', ago(HOUR))

    // Bình luận 10 ngày trước vẫn trả lời công khai được; mặc định của bình luận = công khai.
    const idFb = await queued(cFb, { text: 'Cảm ơn chị' })
    expect(await msgRow(idFb)).toMatchObject({ delivery: 'public_reply', reply_to_platform_id: 'POST_1_C8' })
    graph.on('POST', '/POST_1_C8/comments', { ok: true, data: { id: 'POST_1_R1' } })
    expect(await deliver(idFb)).toBe('sent')
    expect(graph.calls.at(-1)!.options.form).toEqual({ message: 'Cảm ơn chị' })
    expect(await msgRow(idFb)).toMatchObject({ status: 'sent', platform_message_id: 'POST_1_R1' })

    const idIg = await queued(cIg, { text: 'Dạ', mode: 'public_reply' })
    graph.on('POST', '/IGC_8/replies', { ok: true, data: { id: 'IGR_1' } })
    expect(await deliver(idIg)).toBe('sent')
    expect(await msgRow(idIg)).toMatchObject({ status: 'sent', platform_message_id: 'IGR_1' })

    const idTh = await queued(cTh, { text: 'Cảm ơn bạn' })
    threads.on('POST', '/me/threads', { ok: true, data: { id: 'CONTAINER_1' } })
    threads.on('POST', '/me/threads_publish', { ok: true, data: { id: 'THR_1' } })
    expect(await deliver(idTh)).toBe('sent')
    expect(threads.calls.map((x) => [x.path, x.options.form, x.options.scope])).toEqual([
      ['/me/threads', { media_type: 'TEXT', text: 'Cảm ơn bạn', reply_to_id: 'THC_8' }, `threads:${th}`],
      ['/me/threads_publish', { creation_id: 'CONTAINER_1' }, `threads:${th}`],
    ])
    expect(await msgRow(idTh)).toMatchObject({ status: 'sent', platform_message_id: 'THR_1' })
  })

  it('bình luận gốc đã bị khách xoá → 409 SEND_REJECTED, tin failed', async () => {
    const fb = await page('facebook', 'FB_9')
    const c = await comment(fb, 'C9', 'U9', ago(HOUR))
    await handle.sql`update messages set removal = 'deleted', removed_at = now() where platform_message_id = 'C9'`
    const res = await send(c, { text: 'x', mode: 'public_reply' })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SEND_REJECTED')
  })
})

describe('nhắn riêng người bình luận', () => {
  it('lần đầu: Send API comment_id = bình luận mới nhất của khách; recipient_id gắn vào cùng khách; lần hai → PRIVATE_REPLY_USED', async () => {
    const fb = await page('facebook', 'FB_10')
    const c = await comment(fb, 'C10', 'U10', ago(2 * HOUR))
    // Người khác trả lời trong luồng (không phải khách của hội thoại) + khách bình luận thêm.
    await comment(fb, 'C10_OTHER', 'U_OTHER', ago(90 * 60_000), 'C10')
    await comment(fb, 'C10_B', 'U10', ago(HOUR), 'C10')
    await comment(fb, 'C10_OTHER2', 'U_OTHER', ago(30 * 60_000), 'C10')

    const id = await queued(c, { text: 'Shop nhắn riêng ạ', mode: 'private_reply' })
    expect(await msgRow(id)).toMatchObject({ delivery: 'private_reply', reply_to_platform_id: 'C10_B' })
    graph.on('POST', '/me/messages', { ok: true, data: { recipient_id: 'PSID_FROM_COMMENT', message_id: 'm_PR_1' } })
    expect(await deliver(id)).toBe('sent')
    expect(graph.calls[0]!.options.body).toEqual({ recipient: { comment_id: 'C10_B' }, message: { text: 'Shop nhắn riêng ạ', metadata: id } })

    const [owner] = await handle.sql<{ contact_id: string }[]>`
      select ci.contact_id from conversations c join contact_identities ci on ci.id = c.contact_identity_id where c.id = ${c}`
    const [linked] = await handle.sql<{ contact_id: string }[]>`select contact_id from contact_identities where page_id = ${fb} and platform_user_id = 'PSID_FROM_COMMENT'`
    expect(linked!.contact_id).toBe(owner!.contact_id)

    const again = await send(c, { text: 'lần hai', mode: 'private_reply' })
    expect(again.statusCode).toBe(409)
    expect(again.json<{ error: { code: string } }>().error.code).toBe('PRIVATE_REPLY_USED')
    // Khách nhắn riêng trả lời qua Messenger → vào cùng khách.
    const d = await dm(fb, 'PSID_FROM_COMMENT', ago(1000))
    const [dmOwner] = await handle.sql<{ contact_id: string }[]>`
      select ci.contact_id from conversations c join contact_identities ci on ci.id = c.contact_identity_id where c.id = ${d}`
    expect(dmOwner!.contact_id).toBe(owner!.contact_id)
  })

  it('recipient_id đã thuộc khách khác → giữ nguyên định danh, ghi gợi ý gộp (Story 4.9), không lỗi', async () => {
    const fb = await page('facebook', 'FB_11')
    const d = await dm(fb, 'PSID_TAKEN', ago(HOUR))
    const c = await comment(fb, 'C11', 'U11', ago(HOUR))
    const id = await queued(c, { text: 'x', mode: 'private_reply' })
    graph.on('POST', '/me/messages', { ok: true, data: { recipient_id: 'PSID_TAKEN', message_id: 'm_PR_2' } })
    expect(await deliver(id)).toBe('sent')
    const owners = await handle.sql<{ contact_id: string }[]>`select contact_id from contact_identities where page_id = ${fb} and platform_user_id = 'PSID_TAKEN'`
    expect(owners).toHaveLength(1)
    const ownerOf = async (convId: string) =>
      (await handle.sql<{ contact_id: string }[]>`select ci.contact_id from conversations c join contact_identities ci on ci.id = c.contact_identity_id where c.id = ${convId}`)[0]!
        .contact_id
    const [commenter, dmContact] = [await ownerOf(c), await ownerOf(d)]
    expect(owners[0]!.contact_id).toBe(dmContact)
    const suggestions = await handle.sql`select contact_id, other_contact_id, reason from contact_merge_suggestions`
    expect(suggestions).toEqual([{ contact_id: commenter, other_contact_id: dmContact, reason: 'private_reply' }])
    expect(emittedOf('contact.updated').map((e) => e.id).sort()).toEqual([commenter, dmContact].sort())
  })

  it('bình luận cũ hơn 7 ngày / chỉ còn bình luận đã xoá → PRIVATE_REPLY_INVALID; tin nhắn riêng lỗi không tính là đã dùng', async () => {
    const fb = await page('facebook', 'FB_12')
    const old = await comment(fb, 'C12', 'U12', ago(8 * 24 * HOUR))
    expect(await canSend(handle.db, old, 'private_reply')).toEqual({ ok: false, code: 'PRIVATE_REPLY_INVALID' })
    const del = await comment(fb, 'C12D', 'U12D', ago(HOUR))
    await handle.sql`update messages set removal = 'deleted', removed_at = now() where platform_message_id = 'C12D'`
    expect(await canSend(handle.db, del, 'private_reply')).toEqual({ ok: false, code: 'PRIVATE_REPLY_INVALID' })

    const ok = await comment(fb, 'C12OK', 'U12OK', ago(HOUR))
    const id = await queued(ok, { text: 'x', mode: 'private_reply' })
    await handle.sql`update messages set status = 'failed', error_code = 'SEND_FAILED' where id = ${id}`
    expect(await canSend(handle.db, ok, 'private_reply')).toEqual({ ok: true, replyTo: 'C12OK' })
  })

  it('Threads: canSend nhắn riêng → PRIVATE_REPLY_INVALID', async () => {
    const th = await page('threads', 'TH_13')
    const c = await comment(th, 'TC13', 'TU13', ago(HOUR))
    expect(await canSend(handle.db, c, 'private_reply')).toEqual({ ok: false, code: 'PRIVATE_REPLY_INVALID' })
    expect(await canSend(handle.db, c, 'public_reply')).toEqual({ ok: true, replyTo: 'TC13' })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Job `inbox.send`: lỗi Meta, retry, hoãn, huỷ, chạy trùng
// ---------------------------------------------------------------------------------------------------------

describe('job inbox.send', () => {
  async function dmQueued(account: string): Promise<{ pageId: string; conversationId: string; messageId: string }> {
    const pageId = await page('facebook', account)
    const conversationId = await dm(pageId, `PSID_${account}`, ago(HOUR))
    const messageId = await queued(conversationId, { text: 'x' })
    return { pageId, conversationId, messageId }
  }

  it.each([
    ['OUTSIDE_WINDOW', 'OUTSIDE_24H'],
    ['RECIPIENT_UNAVAILABLE', 'RECIPIENT_UNAVAILABLE'],
    ['REJECTED', 'SEND_REJECTED'],
    ['PERMISSION_DENIED', 'SEND_REJECTED'],
    ['PRIVATE_REPLY_INVALID', 'PRIVATE_REPLY_INVALID'],
  ])('lỗi %s → failed %s, kết thúc êm, message.failed', async (kind, code) => {
    const { messageId, pageId, conversationId } = await dmQueued(`FB_E_${kind}`)
    graph.on('POST', '/me/messages', fail(kind))
    expect(await deliver(messageId)).toBe('failed')
    expect(await msgRow(messageId)).toMatchObject({ status: 'failed', error_code: code })
    expect(emittedOf('message.failed')).toEqual([{ id: messageId, pageId, conversationId, errorCode: code }])
  })

  it('sendErrorOf: OUTSIDE_WINDOW khi nhắn riêng → PRIVATE_REPLY_INVALID; TRANSIENT/ABORTED → SEND_FAILED', () => {
    expect(sendErrorOf('OUTSIDE_WINDOW', 'private_reply')).toBe('PRIVATE_REPLY_INVALID')
    expect(sendErrorOf('OUTSIDE_WINDOW', 'dm')).toBe('OUTSIDE_24H')
    expect(sendErrorOf('TOKEN_INVALID', 'public_reply')).toBe('PAGE_DISCONNECTED')
    expect(sendErrorOf('TRANSIENT', 'dm')).toBe('SEND_FAILED')
    expect(sendErrorOf('ABORTED', 'dm')).toBe('SEND_FAILED')
  })

  it('TOKEN_INVALID ở IG → Fanpage nguồn + IG mất kết nối, tin failed PAGE_DISCONNECTED', async () => {
    const fb = await page('facebook', 'FB_TOK')
    const ig = await page('instagram', 'IG_TOK', { tokenSourcePageId: fb })
    const c = await dm(ig, 'IGSID_TOK', ago(HOUR))
    const id = await queued(c, { text: 'x' })
    graph.on('POST', '/me/messages', fail('TOKEN_INVALID', { code: 190 }))
    expect(await deliver(id)).toBe('failed')
    expect(await msgRow(id)).toMatchObject({ status: 'failed', error_code: 'PAGE_DISCONNECTED' })
    expect(await pageStatus(fb)).toBe('disconnected')
    expect(await pageStatus(ig)).toBe('disconnected')
    expect(emittedOf('page.disconnected').map((e) => e.id).sort()).toEqual([fb, ig].sort())
  })

  it('TRANSIENT: lần thường trả pending rồi ném (retry chiếm lại được); lần cuối → failed SEND_FAILED', async () => {
    const { messageId } = await dmQueued('FB_TR')
    graph.onSequence('POST', '/me/messages', [fail('TRANSIENT', { status: 503 }), fail('TRANSIENT', { status: 503 })])
    await expect(deliver(messageId)).rejects.toBeInstanceOf(SendRetryableError)
    expect(await msgRow(messageId)).toMatchObject({ status: 'pending', error_code: null })
    expect(await deliver(messageId, true)).toBe('failed')
    expect(await msgRow(messageId)).toMatchObject({ status: 'failed', error_code: 'SEND_FAILED' })
    expect(graph.calls).toHaveLength(2)
  })

  it('lỗi bất ngờ trước lời gọi Meta: lần thường trả pending rồi ném; lần cuối → failed SEND_FAILED rồi ném (không kẹt pending)', async () => {
    const { messageId } = await dmQueued('FB_NOCIPHER')
    const noCipher = { ...deliverDeps(), cipher: null }
    await expect(deliverMessage(noCipher, messageId, { finalAttempt: false })).rejects.toThrow()
    expect(await msgRow(messageId)).toMatchObject({ status: 'pending', error_code: null })
    await expect(deliverMessage(noCipher, messageId, { finalAttempt: true })).rejects.toThrow()
    expect(await msgRow(messageId)).toMatchObject({ status: 'failed', error_code: 'SEND_FAILED' })
    expect(graph.calls).toHaveLength(0)
  })

  it('handleSendJob: lần thử cuối theo retryCount/retryLimit', async () => {
    const { messageId } = await dmQueued('FB_HJ')
    graph.on('POST', '/me/messages', fail('TRANSIENT'))
    expect(await handleSendJob(deliverDeps(), { data: { messageId }, retryCount: 5, retryLimit: 5 })).toBe('failed')
    await expect(handleSendJob(deliverDeps(), { data: {}, retryCount: 0, retryLimit: 5 })).rejects.toThrow('messageId')
  })

  it('RATE_LIMITED: trả pending + job mới startAfter (không ném); quá 30 phút từ queued_at → failed RATE_LIMITED', async () => {
    const { messageId } = await dmQueued('FB_RL')
    graph.on('POST', '/me/messages', fail('RATE_LIMITED', { retryAfterMs: 60_000 }))
    const t0 = Date.now()
    expect(await deliver(messageId)).toBe('deferred')
    expect(await msgRow(messageId)).toMatchObject({ status: 'pending', error_code: null })
    const queuedJobs = (await sendJobs()).filter((j) => j.messageId === messageId)
    expect(queuedJobs).toHaveLength(2)
    expect(queuedJobs[1]!.startAfter.getTime()).toBeGreaterThanOrEqual(t0 + 59_000)

    await handle.sql`update messages set queued_at = ${new Date(Date.now() - RATE_LIMIT_DEFER_MAX_MS + 30_000).toISOString()}::timestamptz where id = ${messageId}`
    expect(await deliver(messageId)).toBe('failed')
    expect(await msgRow(messageId)).toMatchObject({ status: 'failed', error_code: 'RATE_LIMITED' })
  })

  it('trang gỡ / mất kết nối lúc gửi → PAGE_REMOVED / PAGE_DISCONNECTED, không gọi Meta', async () => {
    const a = await dmQueued('FB_RM')
    await handle.sql`update pages set removed_at = now() where id = ${a.pageId}`
    expect(await deliver(a.messageId)).toBe('failed')
    expect(await msgRow(a.messageId)).toMatchObject({ error_code: 'PAGE_REMOVED' })
    const b = await dmQueued('FB_DC')
    await handle.sql`update pages set connection_status = 'disconnected' where id = ${b.pageId}`
    expect(await deliver(b.messageId)).toBe('failed')
    expect(await msgRow(b.messageId)).toMatchObject({ error_code: 'PAGE_DISCONNECTED' })
    expect(graph.calls).toHaveLength(0)
  })

  it('tin AI pending bị Tiếp quản xoá trước khi job chạy → cancelled, không gọi Meta, không lỗi', async () => {
    const p = await page('facebook', 'FB_CX')
    const c = await dm(p, 'PSID_CX', ago(HOUR))
    await setState(c, 'ai')
    const [ai] = await handle.sql<{ id: string }[]>`insert into messages (conversation_id, page_id, direction, origin, status, delivery, text, platform_timestamp)
      values (${c}, ${p}, 'outbound', 'app_ai', 'pending', 'dm', 'AI nháp', now()) returning id`
    await applyUserAction({ db: handle.db, events }, c, 'takeover')
    expect(await deliver(ai!.id)).toBe('cancelled')
    expect(graph.calls).toHaveLength(0)
    expect(emittedOf('message.failed')).toEqual([])
  })

  it('job chạy hai lần → lần sau bỏ qua, một lời gọi Meta', async () => {
    const { messageId } = await dmQueued('FB_DUP')
    graph.on('POST', '/me/messages', { ok: true, data: { message_id: 'm_DUP' } })
    expect(await deliver(messageId)).toBe('sent')
    expect(await deliver(messageId)).toBe('skipped')
    expect(graph.calls).toHaveLength(1)
  })

  it('cron: kẹt sending 16 phút → failed SEND_UNKNOWN + message.failed; 10 phút giữ nguyên', async () => {
    const a = await dmQueued('FB_SW1')
    const b = await dmQueued('FB_SW2')
    await handle.sql`update messages set status = 'sending', sending_at = ${ago(16 * 60_000).toISOString()}::timestamptz where id = ${a.messageId}`
    await handle.sql`update messages set status = 'sending', sending_at = ${ago(10 * 60_000).toISOString()}::timestamptz where id = ${b.messageId}`
    expect(await sweepStuckSending({ db: handle.db, events })).toBe(1)
    expect(await msgRow(a.messageId)).toMatchObject({ status: 'failed', error_code: 'SEND_UNKNOWN' })
    expect(await msgRow(b.messageId)).toMatchObject({ status: 'sending', error_code: null })
    expect(emittedOf('message.failed')).toEqual([{ id: a.messageId, pageId: a.pageId, conversationId: a.conversationId, errorCode: 'SEND_UNKNOWN' }])
    // Job tới muộn không gửi lại tin SEND_UNKNOWN.
    expect(await deliver(a.messageId)).toBe('skipped')
  })

  it('registry: inbox.send standard, retry 5, concurrency 5, critical; sweep cron 5 phút', () => {
    expect(QUEUES['inbox.send']).toMatchObject({ policy: 'standard', retryLimit: 5, concurrency: 5, critical: true })
    expect(QUEUES['inbox.send_sweep'].cron.expression).toBe('*/5 * * * *')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Gửi lại
// ---------------------------------------------------------------------------------------------------------

describe('Gửi lại', () => {
  it('tin failed RATE_LIMITED → 200 pending, xoá mã, job mới, dời về cuối hội thoại', async () => {
    const p = await page('facebook', 'FB_RS')
    const c = await dm(p, 'PSID_RS', ago(2 * HOUR))
    const id = await queued(c, { text: 'gửi lại tôi' })
    await handle.sql`update messages set status = 'failed', error_code = 'RATE_LIMITED', platform_timestamp = ${ago(2 * HOUR + 1000).toISOString()}::timestamptz where id = ${id}`
    await dm(p, 'PSID_RS', ago(HOUR))
    await handle.sql`delete from pgboss.job where name = 'inbox.send'`

    const res = await post(`/api/v1/messages/${id}/resend`)
    expect(res.statusCode).toBe(200)
    expect(MessageDto.parse(res.json())).toMatchObject({ id, status: 'pending', errorCode: null })
    expect(await sendJobs()).toEqual([expect.objectContaining({ messageId: id })])
    const rows = await messagesOf(c)
    expect(rows.filter((r) => r.origin !== 'system').at(-1)!.id).toBe(id)
  })

  it('bị từ chối lại → 409 với mã mới, tin giữ failed; tin không failed / ngoài app → 409 VERSION_CONFLICT; không có → 404', async () => {
    const p = await page('facebook', 'FB_RS2')
    const c = await dm(p, 'PSID_RS2', ago(HOUR))
    const id = await queued(c, { text: 'x' })
    const conflict = await post(`/api/v1/messages/${id}/resend`)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('VERSION_CONFLICT')

    await handle.sql`update messages set status = 'failed', error_code = 'SEND_FAILED' where id = ${id}`
    await handle.sql`update conversations set last_customer_message_at = ${ago(25 * HOUR).toISOString()}::timestamptz where id = ${c}`
    const refused = await post(`/api/v1/messages/${id}/resend`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('OUTSIDE_24H')
    expect(await msgRow(id)).toMatchObject({ status: 'failed', error_code: 'OUTSIDE_24H' })

    // Story 5.4: tin AI lỗi gửi lại được (xem autoreply-run.test.ts); tin không phải của app (ngoài app) thì không.
    const [other] = await handle.sql<{ id: string }[]>`insert into messages (conversation_id, page_id, direction, origin, status, error_code, delivery, text, platform_timestamp)
      values (${c}, ${p}, 'outbound', 'external_human', 'failed', 'SEND_FAILED', 'dm', 'ngoài app', now()) returning id`
    const otherRes = await post(`/api/v1/messages/${other!.id}/resend`)
    expect(otherRes.statusCode).toBe(409)
    expect(otherRes.json<{ error: { code: string } }>().error.code).toBe('VERSION_CONFLICT')
    expect((await post('/api/v1/messages/019a0000-0000-7000-8000-000000000000/resend')).statusCode).toBe(404)
  })

  it('nhắn riêng gửi lại không tự chặn chính nó (PRIVATE_REPLY_USED chỉ tính tin khác)', async () => {
    const fb = await page('facebook', 'FB_RS3')
    const c = await comment(fb, 'C_RS3', 'U_RS3', ago(HOUR))
    const id = await queued(c, { text: 'x', mode: 'private_reply' })
    await handle.sql`update messages set status = 'failed', error_code = 'SEND_FAILED' where id = ${id}`
    expect((await post(`/api/v1/messages/${id}/resend`)).statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------------------
// TOKEN_INVALID ở job tên khách / caption (việc hoãn 4.3)
// ---------------------------------------------------------------------------------------------------------

describe('TOKEN_INVALID ở job nền của inbox', () => {
  it('fetch_profile và fetch_post_text → trang mất kết nối, job bỏ qua', async () => {
    const p = await page('facebook', 'FB_PROF')
    const c = await dm(p, 'PSID_PROF', ago(HOUR))
    const [identity] = await handle.sql<{ id: string }[]>`select contact_identity_id as id from conversations where id = ${c}`
    graph.on('GET', '/PSID_PROF', fail('TOKEN_INVALID', { code: 190 }))
    expect(await fetchProfile({ db: handle.db, events, cipher, graph }, identity!.id, { finalAttempt: false })).toBe('skipped')
    expect(await pageStatus(p)).toBe('disconnected')

    const q = await page('facebook', 'FB_POST')
    const cc = await comment(q, 'C_POST', 'U_POST', ago(HOUR))
    graph.on('GET', '/POST_1', fail('TOKEN_INVALID', { code: 190 }))
    expect(await fetchPostText({ db: handle.db, events, cipher, graph }, cc, { finalAttempt: false })).toBe('skipped')
    expect(await pageStatus(q)).toBe('disconnected')
  })
})

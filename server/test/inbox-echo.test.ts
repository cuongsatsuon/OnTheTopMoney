// Story 4.5 — nhận diện tin của chính trang (AD-20, AD-9, AD-4, AD-24): echo Messenger/IG và bình luận/trả lời của trang
// đi qua `webhook.route` → `inbox.ingestEcho`. Khớp tin app đã gửi (id, `metadata`, nội dung ≤120 giây) → gắn id, `sent`,
// không tin mới, không `message.received`; chưa khớp → job `inbox.echo_match` (5 giây × 3) rồi `app_unmatched`; app khác /
// không rõ app → `external_human` + `human` `HUMAN_REPLIED`; luồng chưa có hội thoại → `ignored`. "Đã nhận / đã xem" →
// `delivered|read` không hạ trạng thái.
import { randomBytes } from 'node:crypto'
import type { EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient, type FakeMetaClient } from '../src/adapters/meta/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import {
  ECHO_MATCH_DELAY_MS,
  EchoUnmatchedError,
  deliverMessage,
  echoAuthor,
  echoJobData,
  handleEchoMatchJob,
  ingestComment,
  ingestDm,
  parseEchoMatchJobData,
  sendMessage,
  type EchoMessage,
} from '../src/modules/inbox/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { routeWebhookEvent, webhookEventsTable } from '../src/modules/webhooks/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { QUEUES, createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const HOUR = 3_600_000
const OWN_APP = '111111111111111'
const BUSINESS_SUITE = '263902037430900'
const ago = (ms: number) => new Date(Date.now() - ms)
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance
let cookie: string
let graph: FakeMetaClient

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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-inbox-echo', { background: false })
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
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('inbox.send', 'inbox.echo_match', 'inbox.fetch_attachment', 'inbox.fetch_profile', 'inbox.fetch_post_text')`
  emitted.length = 0
  graph = createFakeMetaClient()
  const { token } = await createSession(handle.db)
  cookie = `${SESSION_COOKIE}=${token}`
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function page(platform: 'facebook' | 'instagram' | 'threads', accountId: string, opts: { tokenSourcePageId?: string; handle?: string } = {}): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, handle, connection_status)
    values (${platform}, ${accountId}, ${'Trang ' + accountId}, ${opts.handle ?? null}, 'active') returning id`
  const accessToken = opts.tokenSourcePageId ? null : cipher.encrypt(`TOKEN_${accountId}`)
  await handle.sql`insert into page_credentials (page_id, access_token, token_source_page_id)
    values (${p!.id}, ${accessToken}, ${opts.tokenSourcePageId ?? null})`
  return p!.id
}

let seq = 0
/** Tin DM của khách; trả id hội thoại. */
async function dm(pageId: string, sender: string, ts: Date = ago(HOUR)): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events, jobs },
    { pageId, message: { kind: 'dm', senderId: sender, recipientId: 'PAGE', mid: `mid_${seq}`, timestamp: ts, text: `tin ${seq}`, attachments: [] } },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

/** Bình luận gốc của khách; trả id hội thoại. */
async function comment(pageId: string, commentId: string, author = 'U_HA', ts: Date = ago(HOUR)): Promise<string> {
  const res = await ingestComment(
    { db: handle.db, events, jobs },
    {
      pageId,
      comment: {
        kind: 'comment',
        commentId,
        parentId: null,
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

/** Chủ shop gửi tin (đã vào hàng); `claimed` → giả job đã chiếm (`sending`). */
async function outbound(conversationId: string, text: string, opts: { mode?: 'dm' | 'public_reply' | 'private_reply'; claimed?: boolean } = {}): Promise<string> {
  const res = await sendMessage({ db: handle.db, events, jobs }, conversationId, { text, mode: opts.mode })
  if (res.status !== 'queued') throw new Error(`gửi không vào hàng: ${res.status}`)
  if (opts.claimed !== false) await handle.sql`update messages set status = 'sending', sending_at = now() where id = ${res.messageId}`
  emitted.length = 0
  return res.messageId
}

/** Ghi một mục webhook rồi chạy `webhook.route` như worker (app của máy chủ = `OWN_APP`). */
async function deliverWebhook(pageAccount: string, field: string, payload: unknown, product: 'meta' | 'threads' = 'meta'): Promise<string> {
  const [row] = await handle.db
    .insert(webhookEventsTable)
    .values({ product, platformPageId: pageAccount, field, dedupeKey: `k_${Math.random().toString(36).slice(2)}`, payload })
    .returning({ id: webhookEventsTable.id })
  await routeWebhookEvent({ db: handle.db, events, jobs, appIds: [OWN_APP] }, { eventId: row!.id })
  const [ev] = await handle.sql<{ status: string }[]>`select status from webhook_events where id = ${row!.id}`
  return ev!.status
}

/** Echo Messenger/IG (`message_echoes`): trang → khách. */
const echoItem = (pageAccount: string, customer: string, m: { mid: string; text?: string; appId?: string; metadata?: string; ts?: number }) => ({
  sender: { id: pageAccount },
  recipient: { id: customer },
  timestamp: m.ts ?? Date.now(),
  message: {
    mid: m.mid,
    is_echo: true,
    ...(m.appId ? { app_id: m.appId } : {}),
    ...(m.metadata ? { metadata: m.metadata } : {}),
    ...(m.text !== undefined ? { text: m.text } : {}),
  },
})
const echo = (pageAccount: string, customer: string, m: Parameters<typeof echoItem>[2]) => deliverWebhook(pageAccount, 'message_echoes', echoItem(pageAccount, customer, m))

/** Bình luận FB của chính trang trả lời `parentId`. */
const pageFeedReply = (pageAccount: string, commentId: string, parentId: string, text: string) =>
  deliverWebhook(pageAccount, 'feed', {
    field: 'feed',
    value: {
      item: 'comment',
      verb: 'add',
      comment_id: commentId,
      post_id: `${pageAccount}_POST1`,
      parent_id: parentId,
      from: { id: pageAccount, name: 'Shop' },
      message: text,
      created_time: Math.floor(Date.now() / 1000),
    },
  })

const msgRow = async (id: string) =>
  (
    await handle.sql<{ status: string | null; error_code: string | null; platform_message_id: string | null; origin: string }[]>`
      select status, error_code, platform_message_id, origin from messages where id = ${id}`
  )[0]!
const messagesOf = (conversationId: string) =>
  handle.sql<{ id: string; origin: string; direction: string | null; status: string | null; platform_message_id: string | null; delivery: string | null; reason_code: string | null }[]>`
    select id, origin, direction, status, platform_message_id, delivery, reason_code from messages where conversation_id = ${conversationId} order by platform_timestamp, id`
const conv = async (id: string) =>
  (
    await handle.sql<{ state: string; state_version: number; state_reason: string | null; ai_enabled: boolean; waiting_since: Date | null }[]>`
      select state, state_version, state_reason, ai_enabled, waiting_since from conversations where id = ${id}`
  )[0]!
const setState = (id: string, state: string, waitingSince: Date | null = null) =>
  handle.sql`update conversations set state = ${state}, waiting_since = ${waitingSince?.toISOString() ?? null}::timestamptz where id = ${id}`
const count = async (table: 'messages' | 'conversations') => Number((await handle.sql<{ n: string }[]>`select count(*)::text as n from ${handle.sql(table)}`)[0]!.n)
const echoJobs = async () =>
  (await handle.sql<{ data: unknown; start_after: Date; created_on: Date }[]>`select data, start_after, created_on from pgboss.job where name = 'inbox.echo_match' order by created_on`).map(
    (r) => ({ data: r.data, startAfter: new Date(r.start_after), createdOn: new Date(r.created_on) }),
  )
const countNeeds = async () => (await app.inject({ method: 'GET', url: '/api/v1/conversations/count?tab=needs_human', headers: { cookie } })).json<{ count: number }>().count
const echoDeps = () => ({ db: handle.db, events, jobs, appIds: [OWN_APP] })

/** Chạy job `inbox.echo_match` đang chờ ở lần thứ `retryCount`. */
async function runEchoJob(retryCount: number) {
  const [job] = await echoJobs()
  if (!job) throw new Error('không có job echo_match')
  return handleEchoMatchJob(echoDeps(), { data: job.data, retryCount })
}

// ---------------------------------------------------------------------------------------------------------
// Khớp tin app đã gửi
// ---------------------------------------------------------------------------------------------------------

describe('echo khớp tin của app', () => {
  it('Messenger: metadata = messages.id → gắn mid, sent, message.sent một lần; không tin mới, không message.received, trạng thái giữ', async () => {
    const p = await page('facebook', 'FB_1')
    const c = await dm(p, 'PSID_1')
    const id = await outbound(c, 'Dạ shop chào chị')
    const before = await conv(c)
    const total = await count('messages')

    expect(await echo('FB_1', 'PSID_1', { mid: 'm_E1', text: 'Dạ shop chào chị', appId: OWN_APP, metadata: id })).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'm_E1', origin: 'app_human' })
    expect(await count('messages')).toBe(total)
    expect(emittedOf('message.sent')).toEqual([{ id, pageId: p, conversationId: c }])
    expect(emittedOf('message.received')).toEqual([])
    expect(emittedOf('conversation.state_changed')).toEqual([])
    expect(await conv(c)).toEqual(before)
    expect(await echoJobs()).toEqual([])
  })

  it('echo tới GIỮA lời gọi Meta của job gửi → job không ghi đè, message.sent chỉ một lần', async () => {
    const p = await page('facebook', 'FB_2')
    const c = await dm(p, 'PSID_2')
    const id = await outbound(c, 'Còn hàng ạ', { claimed: false })
    graph.on('POST', '/me/messages', async () => {
      expect(await echo('FB_2', 'PSID_2', { mid: 'm_RACE', text: 'Còn hàng ạ', appId: OWN_APP, metadata: id })).toBe('routed')
      return { ok: true, data: { recipient_id: 'PSID_2', message_id: 'm_RACE' } }
    })
    expect(await deliverMessage({ db: handle.db, events, jobs, cipher, graph }, id, { finalAttempt: false })).toBe('sent')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'm_RACE' })
    expect(emittedOf('message.sent')).toHaveLength(1)
  })

  it('echo tới sau khi job đã lưu id → duplicate, không đổi gì; cùng echo hai lần → lần sau duplicate', async () => {
    const p = await page('facebook', 'FB_3')
    const c = await dm(p, 'PSID_3')
    const id = await outbound(c, 'ok')
    await handle.sql`update messages set status = 'sent', platform_message_id = 'm_SAVED' where id = ${id}`
    expect(await echo('FB_3', 'PSID_3', { mid: 'm_SAVED', text: 'ok', appId: OWN_APP, metadata: id })).toBe('routed')
    expect(emitted).toEqual([])
    expect(await count('messages')).toBe((await messagesOf(c)).length)
    expect((await messagesOf(c)).filter((m) => m.platform_message_id === 'm_SAVED')).toHaveLength(1)
  })

  it('khớp nội dung (IG không metadata): cùng chữ trong 120 giây → sent; 150 giây hoặc khác chữ → không khớp', async () => {
    const fb = await page('facebook', 'FB_SRC')
    const ig = await page('instagram', 'IG_1', { tokenSourcePageId: fb })
    const c = await dm(ig, 'IGSID_1')
    const id = await outbound(c, 'Size M còn ạ')
    expect(await echo('IG_1', 'IGSID_1', { mid: 'ig_far', text: 'Size M còn ạ', ts: Date.now() + 150_000 })).toBe('routed')
    expect(await echo('IG_1', 'IGSID_1', { mid: 'ig_other', text: 'Size L còn ạ' })).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sending', platform_message_id: null })
    expect(await echoJobs()).toHaveLength(2)

    expect(await echo('IG_1', 'IGSID_1', { mid: 'ig_ok', text: '  Size M còn ạ ', ts: Date.now() + 30_000 })).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'ig_ok' })
  })

  it('tin pending chưa từng gọi Meta không khớp theo nội dung; pending sau lỗi tạm (đã gọi) thì khớp', async () => {
    const p = await page('facebook', 'FB_4')
    const c = await dm(p, 'PSID_4')
    const fresh = await outbound(c, 'Dạ vâng', { claimed: false })
    expect(await echo('FB_4', 'PSID_4', { mid: 'm_bs', text: 'Dạ vâng' })).toBe('routed')
    expect(await msgRow(fresh)).toMatchObject({ status: 'pending', platform_message_id: null })

    await handle.sql`update messages set sending_at = now() where id = ${fresh}`
    expect(await echo('FB_4', 'PSID_4', { mid: 'm_retry', text: 'Dạ vâng' })).toBe('routed')
    expect(await msgRow(fresh)).toMatchObject({ status: 'sent', platform_message_id: 'm_retry' })
  })

  it('tin failed SEND_UNKNOWN + metadata khớp → sent, xoá mã lỗi', async () => {
    const p = await page('facebook', 'FB_5')
    const c = await dm(p, 'PSID_5')
    const id = await outbound(c, 'ok')
    await handle.sql`update messages set status = 'failed', error_code = 'SEND_UNKNOWN' where id = ${id}`
    expect(await echo('FB_5', 'PSID_5', { mid: 'm_late', text: 'ok', appId: OWN_APP, metadata: id })).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', error_code: null, platform_message_id: 'm_late' })
    expect(emittedOf('message.sent')).toEqual([{ id, pageId: p, conversationId: c }])
  })

  it('nhắn riêng: echo DM có metadata của tin private_reply ở hội thoại bình luận → khớp, không cần hội thoại DM', async () => {
    const p = await page('facebook', 'FB_6')
    const c = await comment(p, 'C6')
    const id = await outbound(c, 'Shop inbox chị nhé', { mode: 'private_reply' })
    expect(await echo('FB_6', 'PSID_NEW', { mid: 'm_pr', text: 'Shop inbox chị nhé', appId: OWN_APP, metadata: id })).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'm_pr' })
    expect(await count('conversations')).toBe(1)
  })

  it('nhắn riêng: echo tới GIỮA lời gọi Meta → recipient_id vẫn gắn vào cùng khách', async () => {
    const p = await page('facebook', 'FB_6R')
    const c = await comment(p, 'C6R', 'U_6R')
    const id = await outbound(c, 'Shop inbox ạ', { mode: 'private_reply', claimed: false })
    graph.on('POST', '/me/messages', async () => {
      expect(await echo('FB_6R', 'PSID_6R', { mid: 'm_pr_race', text: 'Shop inbox ạ', appId: OWN_APP, metadata: id })).toBe('routed')
      return { ok: true, data: { recipient_id: 'PSID_6R', message_id: 'm_pr_race' } }
    })
    expect(await deliverMessage({ db: handle.db, events, jobs, cipher, graph }, id, { finalAttempt: false })).toBe('sent')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'm_pr_race' })
    const owners = await handle.sql<{ contact_id: string }[]>`
      select ci.contact_id from contact_identities ci where ci.page_id = ${p} and ci.platform_user_id in ('U_6R', 'PSID_6R')`
    expect(owners).toHaveLength(2)
    expect(owners[0]!.contact_id).toBe(owners[1]!.contact_id)
    expect(emittedOf('message.sent')).toHaveLength(1)
  })

  it('bình luận FB của trang trả lời bình luận gốc, cùng chữ với trả lời công khai đang gửi → khớp', async () => {
    const p = await page('facebook', 'FB_7')
    const c = await comment(p, 'C7')
    const id = await outbound(c, 'Dạ còn ạ', { mode: 'public_reply' })
    expect(await pageFeedReply('FB_7', 'C7_r1', 'C7', 'Dạ còn ạ')).toBe('routed')
    expect(await msgRow(id)).toMatchObject({ status: 'sent', platform_message_id: 'C7_r1' })
    expect((await messagesOf(c)).filter((m) => m.direction === 'outbound')).toHaveLength(1)
    expect(emittedOf('message.received')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Chưa khớp: thử lại → app_unmatched
// ---------------------------------------------------------------------------------------------------------

describe('echo chưa khớp', () => {
  it('app mình: lần đầu enqueue echo_match sau 5 giây (routed); retry chưa khớp → ném; lần thứ 3 → app_unmatched, trạng thái giữ', async () => {
    const p = await page('facebook', 'FB_U')
    const c = await dm(p, 'PSID_U')
    await setState(c, 'human', ago(HOUR))
    const before = await conv(c)
    emitted.length = 0

    expect(await echo('FB_U', 'PSID_U', { mid: 'm_u', text: 'Tin AI cũ', appId: OWN_APP })).toBe('routed')
    const [job] = await echoJobs()
    expect(job!.startAfter.getTime() - job!.createdOn.getTime()).toBeGreaterThanOrEqual(ECHO_MATCH_DELAY_MS - 1000)
    expect(parseEchoMatchJobData(job!.data)).toMatchObject({ pageId: p, echo: { channel: 'dm', threadRef: 'PSID_U', platformMessageId: 'm_u', appId: OWN_APP } })

    await expect(runEchoJob(0)).rejects.toBeInstanceOf(EchoUnmatchedError)
    await expect(runEchoJob(1)).rejects.toBeInstanceOf(EchoUnmatchedError)
    expect(await runEchoJob(2)).toMatchObject({ status: 'inserted', origin: 'app_unmatched' })

    const out = (await messagesOf(c)).filter((m) => m.direction === 'outbound')
    expect(out).toEqual([expect.objectContaining({ origin: 'app_unmatched', status: 'sent', platform_message_id: 'm_u', delivery: 'dm' })])
    const after = await conv(c)
    expect(after).toMatchObject({ state: 'human', state_version: before.state_version, ai_enabled: before.ai_enabled, waiting_since: null })
    expect(emittedOf('conversation.state_changed')).toEqual([])
    expect(emittedOf('message.received')).toEqual([])
    expect(emittedOf('message.sent')).toHaveLength(1)
    // Lượt dự phòng chạy lại → duplicate, không chèn thêm.
    expect(await runEchoJob(3)).toMatchObject({ status: 'duplicate' })
  })

  it('giữa các lần thử job gửi lưu được id → lần sau duplicate, không chèn tin', async () => {
    const p = await page('facebook', 'FB_V')
    const c = await dm(p, 'PSID_V')
    const id = await outbound(c, 'Chữ đã lưu')
    expect(await echo('FB_V', 'PSID_V', { mid: 'm_v', text: 'Chữ Meta đổi', appId: OWN_APP })).toBe('routed')
    await handle.sql`update messages set status = 'sent', platform_message_id = 'm_v' where id = ${id}`
    expect(await runEchoJob(0)).toEqual({ status: 'duplicate', messageId: id })
    expect((await messagesOf(c)).filter((m) => m.direction === 'outbound')).toHaveLength(1)
  })

  it('metadata của app nhưng không còn tin (đã xoá) → hết lượt thì app_unmatched', async () => {
    const p = await page('facebook', 'FB_W')
    const c = await dm(p, 'PSID_W')
    expect(await echo('FB_W', 'PSID_W', { mid: 'm_w', text: 'x', metadata: '0190aaaa-0000-7000-8000-000000000009' })).toBe('routed')
    expect(await runEchoJob(2)).toMatchObject({ status: 'inserted', origin: 'app_unmatched' })
    expect((await messagesOf(c)).at(-1)).toMatchObject({ origin: 'app_unmatched' })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Chủ shop trả lời ngoài app
// ---------------------------------------------------------------------------------------------------------

describe('trả lời ngoài app (external_human)', () => {
  it('Business Suite (app_id khác) ở handoff: chèn ngay, human HUMAN_REPLIED, tắt AI, xoá tin AI pending, rời "Cần xử lý"', async () => {
    const p = await page('facebook', 'FB_X')
    const c = await dm(p, 'PSID_X')
    await setState(c, 'handoff', ago(HOUR))
    await handle.sql`insert into messages (conversation_id, page_id, direction, origin, status, text, platform_timestamp)
      values (${c}, ${p}, 'outbound', 'app_ai', 'pending', 'AI nháp', now())`
    expect(await countNeeds()).toBe(1)
    const before = await conv(c)
    emitted.length = 0

    expect(await echo('FB_X', 'PSID_X', { mid: 'm_bs', text: 'Chị chờ em xíu', appId: BUSINESS_SUITE })).toBe('routed')
    expect(await echoJobs()).toEqual([])
    const rows = await messagesOf(c)
    expect(rows.map((r) => r.origin)).toEqual(['customer', 'external_human', 'system'])
    expect(rows[1]).toMatchObject({ direction: 'outbound', status: 'sent', platform_message_id: 'm_bs', delivery: 'dm' })
    expect(rows[2]!.reason_code).toBe('HUMAN_REPLIED')
    expect(await conv(c)).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', ai_enabled: false, waiting_since: null, state_version: before.state_version + 1 })
    expect(emittedOf('conversation.state_changed')).toEqual([expect.objectContaining({ id: c, from: 'handoff', to: 'human', reasonCode: 'HUMAN_REPLIED' })])
    expect(emittedOf('message.received')).toEqual([])
    expect(emittedOf('message.sent')).toEqual([{ id: rows[1]!.id, pageId: p, conversationId: c }])
    expect(await countNeeds()).toBe(0)
  })

  it('ở ai: chuyển human, ai_enabled=false; echo lặp lại → duplicate', async () => {
    const p = await page('facebook', 'FB_Y')
    const c = await dm(p, 'PSID_Y')
    await setState(c, 'ai')
    expect(await echo('FB_Y', 'PSID_Y', { mid: 'm_y', text: 'em đây', appId: BUSINESS_SUITE })).toBe('routed')
    expect(await conv(c)).toMatchObject({ state: 'human', ai_enabled: false })
    const total = await count('messages')
    emitted.length = 0
    expect(await echo('FB_Y', 'PSID_Y', { mid: 'm_y', text: 'em đây', appId: BUSINESS_SUITE })).toBe('routed')
    expect(await count('messages')).toBe(total)
    expect(emitted).toEqual([])
  })

  it('không rõ app (bình luận FB / Threads của trang không khớp) → thử lại rồi external_human', async () => {
    const p = await page('facebook', 'FB_Z')
    const c = await comment(p, 'CZ')
    await setState(c, 'ai')
    expect(await pageFeedReply('FB_Z', 'CZ_r', 'CZ', 'Shop trả lời trên điện thoại')).toBe('routed')
    expect((await conv(c)).state).toBe('ai')
    await expect(runEchoJob(0)).rejects.toBeInstanceOf(EchoUnmatchedError)
    expect(await runEchoJob(2)).toMatchObject({ status: 'inserted', origin: 'external_human' })
    expect((await messagesOf(c)).find((m) => m.origin === 'external_human')).toMatchObject({ delivery: 'public_reply', platform_message_id: 'CZ_r' })
    expect(await conv(c)).toMatchObject({ state: 'human', state_reason: 'HUMAN_REPLIED', ai_enabled: false })

    await handle.sql`delete from pgboss.job where name = 'inbox.echo_match'`
    const th = await page('threads', 'TH_1', { handle: 'shop.threads' })
    const ingested = await ingestComment(
      { db: handle.db, events, jobs },
      {
        pageId: th,
        comment: { kind: 'comment', commentId: 'r_root', parentId: null, platformPostId: 'tp_1', author: { id: '@thuha', name: null, username: 'thuha' }, text: 'Ship HN?', timestamp: ago(HOUR), attachments: [] },
      },
    )
    if (ingested.status !== 'created') throw new Error('ingest trùng')
    const reply = { field: 'replies', value: { id: 'r_page', username: 'Shop.Threads', text: 'Có ạ', timestamp: new Date().toISOString(), replied_to: { id: 'r_root' }, root_post: { id: 'tp_1', owner_id: 'TH_1' } } }
    expect(await deliverWebhook('TH_1', 'replies', reply, 'threads')).toBe('routed')
    expect(await runEchoJob(2)).toMatchObject({ status: 'inserted', origin: 'external_human' })
    expect((await conv(ingested.conversationId)).state).toBe('human')
  })

  it('echo ngoài app kèm ảnh → đính kèm pending + job tải', async () => {
    const p = await page('facebook', 'FB_IMG')
    const c = await dm(p, 'PSID_IMG')
    const item = echoItem('FB_IMG', 'PSID_IMG', { mid: 'm_img', appId: BUSINESS_SUITE })
    ;(item.message as Record<string, unknown>).attachments = [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/a.jpg' } }]
    expect(await deliverWebhook('FB_IMG', 'message_echoes', item)).toBe('routed')
    const out = (await messagesOf(c)).find((m) => m.origin === 'external_human')!
    const atts = await handle.sql<{ status: string }[]>`select status from message_attachments where message_id = ${out.id}`
    expect(atts).toEqual([{ status: 'pending' }])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Không có hội thoại
// ---------------------------------------------------------------------------------------------------------

describe('luồng chưa có hội thoại', () => {
  it('echo cho khách chưa có trong Hộp thư / trang bình luận thẳng trên bài → ignored, không tạo gì, không job', async () => {
    await page('facebook', 'FB_N')
    expect(await echo('FB_N', 'PSID_NONE', { mid: 'm_n', text: 'x', appId: BUSINESS_SUITE })).toBe('ignored')
    expect(await echo('FB_N', 'PSID_NONE', { mid: 'm_n2', text: 'x', appId: OWN_APP })).toBe('ignored')
    expect(await pageFeedReply('FB_N', 'POST1_c_page', 'FB_N_POST1', 'Link ở đây')).toBe('ignored')
    expect(await count('conversations')).toBe(0)
    expect(await count('messages')).toBe(0)
    expect(await echoJobs()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Đã nhận / đã xem
// ---------------------------------------------------------------------------------------------------------

describe('đã nhận / đã xem (message_deliveries, message_reads)', () => {
  async function sentAt(conversationId: string, pageId: string, mid: string, at: Date): Promise<string> {
    const [row] = await handle.sql<{ id: string }[]>`
      insert into messages (conversation_id, page_id, direction, origin, status, delivery, text, platform_message_id, platform_timestamp)
      values (${conversationId}, ${pageId}, 'outbound', 'app_human', 'sent', 'dm', 'x', ${mid}, ${at.toISOString()}::timestamptz) returning id`
    return row!.id
  }
  const receipt = (pageAccount: string, customer: string, body: Record<string, unknown>, field: 'message_deliveries' | 'message_reads') =>
    deliverWebhook(pageAccount, field, { sender: { id: customer }, recipient: { id: pageAccount }, timestamp: Date.now(), ...body })

  it('delivery mids + watermark → delivered; read watermark → read; delivery sau read không hạ', async () => {
    const p = await page('facebook', 'FB_R')
    const c = await dm(p, 'PSID_R')
    const t1 = ago(60_000)
    const t2 = ago(30_000)
    const a = await sentAt(c, p, 'm_a', t1)
    const b = await sentAt(c, p, 'm_b', t2)

    expect(await receipt('FB_R', 'PSID_R', { delivery: { mids: ['m_a'], watermark: t1.getTime() } }, 'message_deliveries')).toBe('routed')
    expect((await msgRow(a)).status).toBe('delivered')
    expect((await msgRow(b)).status).toBe('sent')
    expect(emittedOf('message.updated')).toEqual([{ id: a, pageId: p, conversationId: c }])

    expect(await receipt('FB_R', 'PSID_R', { read: { watermark: t2.getTime() } }, 'message_reads')).toBe('routed')
    expect([(await msgRow(a)).status, (await msgRow(b)).status]).toEqual(['read', 'read'])

    emitted.length = 0
    expect(await receipt('FB_R', 'PSID_R', { delivery: { watermark: t2.getTime() } }, 'message_deliveries')).toBe('routed')
    expect([(await msgRow(a)).status, (await msgRow(b)).status]).toEqual(['read', 'read'])
    expect(emittedOf('message.updated')).toEqual([])
  })

  it('IG read theo mid → read cho tin đó và tin trước; tin sau giữ sent', async () => {
    const fb = await page('facebook', 'FB_IGS')
    const ig = await page('instagram', 'IG_R', { tokenSourcePageId: fb })
    const c = await dm(ig, 'IGSID_R')
    const a = await sentAt(c, ig, 'ig_a', ago(60_000))
    const b = await sentAt(c, ig, 'ig_b', ago(30_000))
    const later = await sentAt(c, ig, 'ig_c', ago(10_000))
    expect(await receipt('IG_R', 'IGSID_R', { read: { mid: 'ig_b' } }, 'message_reads')).toBe('routed')
    expect([(await msgRow(a)).status, (await msgRow(b)).status, (await msgRow(later)).status]).toEqual(['read', 'read', 'sent'])
  })

  it('không có hội thoại và không tin nào → ignored', async () => {
    await page('facebook', 'FB_RN')
    expect(await receipt('FB_RN', 'PSID_NONE', { read: { watermark: Date.now() } }, 'message_reads')).toBe('ignored')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Hàm thuần
// ---------------------------------------------------------------------------------------------------------

describe('echoAuthor + payload job + queue', () => {
  it('queue inbox.echo_match: standard, retry 3 cách 5 giây không backoff (AD-24)', () => {
    expect(QUEUES['inbox.echo_match']).toMatchObject({ policy: 'standard', retryLimit: 3, retryDelay: 5, concurrency: 5 })
    expect('retryBackoff' in QUEUES['inbox.echo_match']).toBe(false)
  })

  it('app khác chắc chắn ngoài app; app mình / metadata → app; không biết app (hoặc chưa cấu hình app) → unknown', () => {
    expect(echoAuthor({ appId: BUSINESS_SUITE, metadata: null }, [OWN_APP])).toBe('other_app')
    expect(echoAuthor({ appId: BUSINESS_SUITE, metadata: 'x' }, [OWN_APP])).toBe('other_app')
    expect(echoAuthor({ appId: OWN_APP, metadata: null }, [OWN_APP])).toBe('own_app')
    expect(echoAuthor({ appId: null, metadata: 'x' }, [OWN_APP])).toBe('own_app')
    expect(echoAuthor({ appId: null, metadata: null }, [OWN_APP])).toBe('unknown')
    expect(echoAuthor({ appId: BUSINESS_SUITE, metadata: null }, [])).toBe('unknown')
  })

  it('payload job đi/về giữ nguyên echo; payload hỏng → ném', () => {
    const e: EchoMessage = {
      channel: 'comment',
      threadRef: 'C1',
      platformMessageId: 'C1_r',
      text: null,
      timestamp: new Date('2026-10-23T03:00:00.000Z'),
      attachments: [{ kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' }],
      appId: null,
      metadata: null,
    }
    expect(parseEchoMatchJobData(JSON.parse(JSON.stringify(echoJobData('P', e))))).toEqual({ pageId: 'P', echo: e })
    expect(() => parseEchoMatchJobData({ pageId: 'P', echo: { ...e, timestamp: 'hôm qua' } })).toThrow()
    expect(() => parseEchoMatchJobData(null)).toThrow()
  })
})

// Story 4.3 — tin Messenger / IG Direct vào Hộp thư: `webhook.route` → `inbox.ingest` (định danh → khách → hội thoại
// → tin, chống trùng, chỉ tăng, thứ tự theo platform_timestamp), triage (`autoreply.triage` → `human` `AI_OFF`, khoá
// lạc quan), đính kèm (job → kho riêng tư, lỗi tạm/cố định), tên khách (job hồ sơ), trang không có/đã gỡ, mục bị bỏ
// qua, API Hộp thư (phạm vi, phân trang, đính kèm) và hint realtime.
import { randomBytes } from 'node:crypto'
import { ListConversationsResponse, ListMessagesResponse, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { FAKE_PNG, createFakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { createFakeMetaClient } from '../src/adapters/meta/fake.ts'
import type { AttachmentDownloadResult } from '../src/adapters/meta/index.ts'
import { handleTriageEvent } from '../src/modules/autoreply/index.ts'
import {
  AttachmentRetryableError,
  ProfileRetryableError,
  applyTriageDecision,
  fetchAttachment,
  fetchProfile,
  getTriageState,
  handleFetchAttachmentJob,
} from '../src/modules/inbox/index.ts'
import { setRemoved, upsertFromPlatform } from '../src/modules/pages/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { routeWebhookEvent, webhookEventsTable } from '../src/modules/webhooks/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, waitFor } from './helpers/realtime.ts'

const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-INBOX' }
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const at = (sec: number) => T0 + sec * 1000

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let realtime: Awaited<ReturnType<typeof listenRealtime>>
let media: MediaStores
let app: FastifyInstance

/** Sự kiện đã phát (qua publisher thật, trong transaction). */
const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name)

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-inbox', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  realtime = await listenRealtime(handle.sql)
  const fake = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: fake.fetch })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), media })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('inbox.fetch_attachment', 'inbox.fetch_profile', 'webhook.route')`
  emitted.length = 0
  realtime.messages.length = 0
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function page(platform: 'facebook' | 'instagram' | 'threads', accountId: string): Promise<string> {
  const { page: p } = await upsertFromPlatform(handle.db, { platform, platformAccountId: accountId, name: `Trang ${accountId}`, handle: null, avatarUrl: null })
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p.id}, ${cipher.encrypt(`TOKEN_${accountId}`)})`
  return p.id
}

let seq = 0
interface Msg {
  sender?: string
  mid?: string
  text?: string
  ts?: number
  attachments?: { type: string; payload: { url: string } }[]
  echo?: boolean
}
const messagingItem = (pageAccount: string, m: Msg) => {
  seq += 1
  return {
    sender: { id: m.sender ?? 'PSID_A' },
    recipient: { id: pageAccount },
    timestamp: m.ts ?? at(seq),
    message: {
      mid: m.mid ?? `m_${seq}`,
      ...(m.text !== undefined ? { text: m.text } : { text: `tin ${seq}` }),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      ...(m.echo ? { is_echo: true } : {}),
    },
  }
}

/** Ghi một mục webhook rồi chạy `webhook.route` như worker. */
async function deliver(pageAccount: string, payload: unknown, field = 'messages', product: 'meta' | 'threads' = 'meta') {
  const [row] = await handle.db
    .insert(webhookEventsTable)
    .values({ product, platformPageId: pageAccount, field, dedupeKey: `k_${Math.random().toString(36).slice(2)}`, payload })
    .returning({ id: webhookEventsTable.id })
  const result = await routeWebhookEvent({ db: handle.db, events, jobs }, { eventId: row!.id })
  const [ev] = await handle.sql<{ status: string }[]>`select status from webhook_events where id = ${row!.id}`
  return { result, status: ev!.status }
}
const dm = (pageAccount: string, m: Msg = {}) => deliver(pageAccount, messagingItem(pageAccount, m))

/** Chạy consumer `autoreply.triage` cho mọi `message.received` chưa xử lý. */
let triaged = 0
async function runTriage() {
  const received = emittedOf('message.received').slice(triaged)
  triaged = emittedOf('message.received').length
  const out = []
  for (const e of received) {
    const envelope: EventEnvelope = { event: 'message.received', payload: e.payload as never }
    out.push(await handleTriageEvent({ db: handle.db, events }, envelope))
  }
  return out
}
beforeEach(() => {
  triaged = 0
})

/** Mốc thời gian đọc ra dạng mili giây epoch (client SQL thô của Drizzle trả timestamptz dạng chuỗi). */
const conversationsRows = () =>
  handle.sql<{ id: string; page_id: string; state: string; state_version: number; state_reason: string | null; waiting_since: number | null; last_customer_message_at: number | null; last_message_at: number; thread_key: string }[]>`
    select id, page_id, state, state_version, state_reason, thread_key,
      (extract(epoch from waiting_since) * 1000)::float8 as waiting_since,
      (extract(epoch from last_customer_message_at) * 1000)::float8 as last_customer_message_at,
      (extract(epoch from last_message_at) * 1000)::float8 as last_message_at
    from conversations order by created_at`
const messagesOf = (conversationId: string) =>
  handle.sql<{ id: string; origin: string; direction: string | null; text: string | null; reason_code: string | null; platform_message_id: string | null }[]>`
    select id, origin, direction, text, reason_code, platform_message_id from messages where conversation_id = ${conversationId}
    order by platform_timestamp, id`
const jobsOf = (name: string) => handle.sql<{ data: Record<string, string> }[]>`select data from pgboss.job where name = ${name} order by created_on`
const count = async (table: string) => (await handle.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]!.n

// ---------------------------------------------------------------------------------------------------------
// Ingest + triage
// ---------------------------------------------------------------------------------------------------------

describe('ingest DM + triage', () => {
  it('tin Messenger đầu tiên → khách + định danh + hội thoại triage + tin; triage → human AI_OFF + tin system', async () => {
    const pageId = await page('facebook', 'FB_1')
    const ts = at(10)
    expect(await dm('FB_1', { sender: 'PSID_1', mid: 'm_first', text: 'Chào shop', ts })).toEqual({ result: 'routed', status: 'routed' })

    const [conv] = await conversationsRows()
    expect(conv).toMatchObject({ page_id: pageId, state: 'triage', state_version: 0, thread_key: 'PSID_1' })
    expect(conv!.last_customer_message_at!).toBe(ts)
    expect(await messagesOf(conv!.id)).toMatchObject([{ origin: 'customer', direction: 'inbound', text: 'Chào shop', platform_message_id: 'm_first' }])
    expect(await count('contacts')).toBe(1)
    expect(await count('contact_identities')).toBe(1)
    const received = emittedOf('message.received')
    expect(received).toHaveLength(1)
    expect(received[0]!.payload).toMatchObject({ pageId, conversationId: conv!.id })
    expect(await jobsOf('inbox.fetch_profile')).toHaveLength(1)

    expect(await runTriage()).toEqual(['applied'])
    const [after] = await conversationsRows()
    expect(after).toMatchObject({ state: 'human', state_version: 1, state_reason: 'AI_OFF' })
    expect(after!.waiting_since!).toBe(ts)
    const msgs = await messagesOf(conv!.id)
    expect(msgs.map((m) => m.origin)).toEqual(['customer', 'system'])
    expect(msgs[1]).toMatchObject({ direction: null, reason_code: 'AI_OFF' })
    expect(emittedOf('conversation.state_changed').map((e) => e.payload)).toEqual([
      { id: conv!.id, pageId, from: 'triage', to: 'human', reasonCode: 'AI_OFF', version: 1 },
    ])
    // Triage chạy lại (retry) → hội thoại không còn `triage` → bỏ qua, không ghi thêm.
    const envelope: EventEnvelope = { event: 'message.received', payload: received[0]!.payload as never }
    expect(await handleTriageEvent({ db: handle.db, events }, envelope)).toBe('skipped')
    expect(emittedOf('conversation.state_changed')).toHaveLength(1)
  })

  it('tin IG Direct → hội thoại thuộc trang IG, triage → human', async () => {
    const igId = await page('instagram', 'IG_1')
    expect((await dm('IG_1', { sender: 'IGSID_1' })).status).toBe('routed')
    expect(await runTriage()).toEqual(['applied'])
    const [conv] = await conversationsRows()
    expect(conv).toMatchObject({ page_id: igId, thread_key: 'IGSID_1', state: 'human' })
  })

  it('trùng mid (route chạy lại / Meta gửi lại gom khác) → một tin, không sự kiện mới', async () => {
    await page('facebook', 'FB_D')
    const payload = messagingItem('FB_D', { mid: 'm_dup' })
    await deliver('FB_D', payload)
    await deliver('FB_D', payload)
    expect(await count('messages')).toBe(1)
    expect(emittedOf('message.received')).toHaveLength(1)
    expect(await jobsOf('inbox.fetch_profile')).toHaveLength(1)
  })

  it('tin tới lệch thứ tự → hiển thị theo platform_timestamp; last_customer_message_at không giảm', async () => {
    await page('facebook', 'FB_O')
    await dm('FB_O', { mid: 'm_later', text: 'sau', ts: at(200) })
    await dm('FB_O', { mid: 'm_earlier', text: 'trước', ts: at(100) })
    const [conv] = await conversationsRows()
    expect((await messagesOf(conv!.id)).map((m) => m.text)).toEqual(['trước', 'sau'])
    expect(conv!.last_customer_message_at!).toBe(at(200))
    expect(conv!.last_message_at).toBe(at(200))
  })

  it('hội thoại human: tin mới giữ human, giữ mốc chờ; chưa chờ thì đặt mốc chờ; triage bỏ qua', async () => {
    await page('facebook', 'FB_H')
    await dm('FB_H', { ts: at(10) })
    await runTriage()
    await dm('FB_H', { ts: at(20) })
    expect(await runTriage()).toEqual(['skipped'])
    let [conv] = await conversationsRows()
    expect(conv).toMatchObject({ state: 'human', state_version: 1 })
    expect(conv!.waiting_since!).toBe(at(10))

    // Đã trả lời (Story 4.7 sẽ xoá mốc) → tin khách kế tiếp đặt lại mốc chờ.
    await handle.sql`update conversations set waiting_since = null`
    await dm('FB_H', { ts: at(30) })
    ;[conv] = await conversationsRows()
    expect(conv!.waiting_since!).toBe(at(30))
    expect(emittedOf('conversation.state_changed')).toHaveLength(1)
  })

  it('hội thoại done → tin khách mới đưa về triage (tăng version) → human AI_OFF', async () => {
    await page('facebook', 'FB_X')
    await dm('FB_X')
    await runTriage()
    await handle.sql`update conversations set state = 'done', waiting_since = null`
    await dm('FB_X')
    let [conv] = await conversationsRows()
    expect(conv).toMatchObject({ state: 'triage', state_version: 2 })
    expect(await runTriage()).toEqual(['applied'])
    ;[conv] = await conversationsRows()
    expect(conv).toMatchObject({ state: 'human', state_version: 3, state_reason: 'AI_OFF' })
    expect(emittedOf('conversation.state_changed').map((e) => (e.payload as { version: number }).version)).toEqual([1, 3])
  })

  it.each(['ai', 'handoff'] as const)('hội thoại %s → giữ trạng thái (Epic 5 xử lý), triage bỏ qua', async (state) => {
    await page('facebook', 'FB_S')
    await dm('FB_S')
    await runTriage()
    await handle.sql`update conversations set state = ${state}`
    await dm('FB_S')
    expect(await runTriage()).toEqual(['skipped'])
    const [conv] = await conversationsRows()
    expect(conv!.state).toBe(state)
  })

  it('cùng người, trang khác (PSID khác) → định danh + khách riêng, không gộp', async () => {
    await page('facebook', 'FB_A')
    await page('facebook', 'FB_B')
    await dm('FB_A', { sender: 'PSID_ON_A' })
    await dm('FB_B', { sender: 'PSID_ON_B' })
    expect(await count('contacts')).toBe(2)
    expect(await count('conversations')).toBe(2)
  })

  it('cùng khách nhắn lại → cùng hội thoại, cùng khách', async () => {
    await page('facebook', 'FB_R')
    await dm('FB_R', { sender: 'P' })
    await dm('FB_R', { sender: 'P' })
    expect(await count('contacts')).toBe(1)
    expect(await count('conversations')).toBe(1)
    expect(await count('messages')).toBe(2)
  })

  it('triage lệch phiên bản → bỏ quyết định, không ghi tin system', async () => {
    await page('facebook', 'FB_V')
    await dm('FB_V')
    const [conv] = await conversationsRows()
    const state = await getTriageState(handle.db, conv!.id)
    expect(state).toMatchObject({ state: 'triage', stateVersion: 0 })
    expect(await applyTriageDecision({ db: handle.db, events }, conv!.id, 5, { to: 'human', reasonCode: 'AI_OFF' })).toEqual({ applied: false, reason: 'stale' })
    expect(await applyTriageDecision({ db: handle.db, events }, '019a0000-0000-7000-8000-000000000000', 0, { to: 'human', reasonCode: 'AI_OFF' })).toEqual({
      applied: false,
      reason: 'missing',
    })
    expect((await messagesOf(conv!.id)).map((m) => m.origin)).toEqual(['customer'])
    expect(emittedOf('conversation.state_changed')).toHaveLength(0)
  })

  it('hai tin đầu tiên song song của cùng khách → một khách, một hội thoại (khoá luồng)', async () => {
    await page('facebook', 'FB_P')
    await Promise.all([dm('FB_P', { sender: 'SAME' }), dm('FB_P', { sender: 'SAME' }), dm('FB_P', { sender: 'SAME' })])
    expect(await count('contacts')).toBe(1)
    expect(await count('conversations')).toBe(1)
    expect(await count('messages')).toBe(3)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Route: trang không có / đã gỡ, mục bỏ qua
// ---------------------------------------------------------------------------------------------------------

describe('webhook.route — không tạo gì trong inbox', () => {
  it('trang không có trong DB → ignored, không hội thoại', async () => {
    expect(await dm('KHONG_CO')).toEqual({ result: 'ignored_no_page', status: 'ignored' })
    expect(await count('conversations')).toBe(0)
  })

  it('trang đã gỡ → ignored, không hội thoại', async () => {
    const pageId = await page('facebook', 'FB_GONE')
    await handle.db.transaction((tx) => setRemoved(tx, events, pageId))
    expect((await dm('FB_GONE')).status).toBe('ignored')
    expect(await count('conversations')).toBe(0)
  })

  it.each([
    ['echo', (acc: string) => messagingItem(acc, { echo: true })],
    ['postback', (acc: string) => ({ sender: { id: 'U' }, recipient: { id: acc }, postback: { payload: 'P' } })],
    ['reaction', (acc: string) => ({ sender: { id: 'U' }, recipient: { id: acc }, reaction: { mid: 'm', reaction: 'love' } })],
    ['thu hồi', (acc: string) => ({ sender: { id: 'U' }, recipient: { id: acc }, message: { mid: 'm_del', is_deleted: true } })],
    ['payload rỗng', () => ({})],
  ])('%s → ignored, không tạo gì', async (_name, build) => {
    await page('facebook', 'FB_I')
    expect((await deliver('FB_I', build('FB_I'))).status).toBe('ignored')
    expect(await count('conversations')).toBe(0)
    expect(emitted).toHaveLength(0)
  })

  it('mục messages của trang Threads → ignored (Threads không có DM)', async () => {
    await page('threads', 'TH_1')
    expect((await deliver('TH_1', messagingItem('TH_1', {}), 'messages', 'threads')).status).toBe('ignored')
    expect(await count('conversations')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Đính kèm
// ---------------------------------------------------------------------------------------------------------

describe('đính kèm', () => {
  const IMG = 'https://scontent.xx.fbcdn.net/v/a.png?oh=sig'
  const okDownload = (mime = 'image/png', data: Buffer = FAKE_PNG) => async (): Promise<AttachmentDownloadResult> => ({ ok: true, data, mime })
  const attachmentRows = () =>
    handle.sql<{ id: string; kind: string; status: string; error_code: string | null; source_url: string | null; mime: string | null; file_public_id: string | null }[]>`
      select id, kind, status, error_code, source_url, mime, file_public_id from message_attachments order by position`

  async function ingestWithAttachment(attachments = [{ type: 'image', payload: { url: IMG } }]) {
    await page('facebook', 'FB_M')
    await dm('FB_M', { text: '', attachments })
    return attachmentRows()
  }

  it('ingest → dòng pending + job fetch_attachment (cùng transaction); tin không có chữ', async () => {
    const rows = await ingestWithAttachment([
      { type: 'image', payload: { url: IMG } },
      { type: 'audio', payload: { url: 'https://cdn.fbsbx.com/v.mp4' } },
    ])
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['image', 'pending'],
      ['audio', 'pending'],
    ])
    expect((await jobsOf('inbox.fetch_attachment')).map((j) => j.data.attachmentId)).toEqual(rows.map((r) => r.id))
    const [msg] = await handle.sql<{ text: string | null }[]>`select text from messages`
    expect(msg!.text).toBeNull()
  })

  it('tải về → stored trên kho riêng tư, xoá source_url, phát message.updated; API trả bytes', async () => {
    const [row] = await ingestWithAttachment()
    expect(await fetchAttachment({ db: handle.db, events, media, download: okDownload() }, row!.id, { finalAttempt: false })).toBe('stored')
    const [stored] = await attachmentRows()
    expect(stored).toMatchObject({ status: 'stored', source_url: null, mime: 'image/png' })
    expect(stored!.file_public_id).toMatch(/^ottm-test\/private\//)
    expect(emittedOf('message.updated')).toHaveLength(1)
    // Chạy lại (job trùng) → bỏ qua.
    expect(await fetchAttachment({ db: handle.db, events, media, download: okDownload() }, row!.id, { finalAttempt: false })).toBe('skipped')

    const res = await app.inject({ method: 'GET', url: `/api/v1/attachments/${row!.id}`, headers: { cookie: await cookie() } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.from(res.rawPayload).equals(FAKE_PNG)).toBe(true)
  })

  it('lỗi tạm → ném để retry (giữ pending); lần thử cuối → failed FETCH_FAILED, tin vẫn còn', async () => {
    const [row] = await ingestWithAttachment()
    const transient = async (): Promise<AttachmentDownloadResult> => ({ ok: false, kind: 'TRANSIENT', status: 503 })
    await expect(
      handleFetchAttachmentJob({ db: handle.db, events, media, download: transient }, { data: { attachmentId: row!.id }, retryCount: 0, retryLimit: 3 }),
    ).rejects.toBeInstanceOf(AttachmentRetryableError)
    expect((await attachmentRows())[0]!.status).toBe('pending')
    expect(
      await handleFetchAttachmentJob({ db: handle.db, events, media, download: transient }, { data: { attachmentId: row!.id }, retryCount: 3, retryLimit: 3 }),
    ).toBe('failed')
    expect((await attachmentRows())[0]).toMatchObject({ status: 'failed', error_code: 'FETCH_FAILED', source_url: null })
    expect(await count('messages')).toBe(1)
    expect(emittedOf('message.updated')).toHaveLength(1)
  })

  it.each([
    ['host lạ', async (): Promise<AttachmentDownloadResult> => ({ ok: false, kind: 'INVALID_URL' }), 'INVALID_URL'],
    ['quá lớn', async (): Promise<AttachmentDownloadResult> => ({ ok: false, kind: 'TOO_LARGE' }), 'TOO_LARGE'],
    ['link hết hạn', async (): Promise<AttachmentDownloadResult> => ({ ok: false, kind: 'NOT_FOUND', status: 404 }), 'FETCH_FAILED'],
    ['MIME lạ', okDownload('text/html', Buffer.from('<html>')), 'UNSUPPORTED_TYPE'],
  ])('%s → failed ngay, không retry', async (_name, download, errorCode) => {
    const [row] = await ingestWithAttachment()
    expect(await fetchAttachment({ db: handle.db, events, media, download }, row!.id, { finalAttempt: false })).toBe('failed')
    expect((await attachmentRows())[0]).toMatchObject({ status: 'failed', error_code: errorCode })
  })

  it('kho chưa cấu hình → failed MEDIA_NOT_CONFIGURED, không tải link', async () => {
    const [row] = await ingestWithAttachment()
    let called = false
    const download = async (): Promise<AttachmentDownloadResult> => {
      called = true
      return { ok: false, kind: 'TRANSIENT' }
    }
    const unconfigured = createMediaStores({ CLOUDINARY_FOLDER: 'ottm' })
    expect(await fetchAttachment({ db: handle.db, events, media: unconfigured, download }, row!.id, { finalAttempt: false })).toBe('failed')
    expect(called).toBe(false)
    expect((await attachmentRows())[0]).toMatchObject({ status: 'failed', error_code: 'MEDIA_NOT_CONFIGURED' })
  })

  it('API: đính kèm chưa lưu / không có → 404', async () => {
    const [row] = await ingestWithAttachment()
    const c = await cookie()
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/${row!.id}`, headers: { cookie: c } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/v1/attachments/019a0000-0000-7000-8000-000000000000', headers: { cookie: c } })).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Tên khách
// ---------------------------------------------------------------------------------------------------------

describe('tên khách (inbox.fetch_profile)', () => {
  async function newIdentity(platform: 'facebook' | 'instagram' = 'facebook') {
    await page(platform, platform === 'facebook' ? 'FB_N' : 'IG_N')
    await dm(platform === 'facebook' ? 'FB_N' : 'IG_N', { sender: 'USER_N' })
    const [job] = await jobsOf('inbox.fetch_profile')
    return job!.data.identityId!
  }
  const contactName = async () => (await handle.sql<{ name: string | null }[]>`select name from contacts`)[0]!.name

  it('Messenger: ghép họ tên → điền tên trống + contact.updated; chạy lại → bỏ qua', async () => {
    const identityId = await newIdentity()
    const graph = createFakeMetaClient()
    graph.on('GET', '/USER_N', { ok: true, data: { first_name: 'Thu', last_name: 'Hà' } })
    expect(await fetchProfile({ db: handle.db, events, cipher, graph }, identityId, { finalAttempt: false })).toBe('updated')
    expect(await contactName()).toBe('Thu Hà')
    expect(graph.calls[0]!.options).toMatchObject({ token: 'TOKEN_FB_N', params: { fields: 'first_name,last_name,name' } })
    expect(emittedOf('contact.updated')).toHaveLength(1)
    expect(await fetchProfile({ db: handle.db, events, cipher, graph }, identityId, { finalAttempt: false })).toBe('skipped')
  })

  it('IG: name/username; tên đã có → không ghi đè', async () => {
    const identityId = await newIdentity('instagram')
    await handle.sql`update contacts set name = 'Tên chủ shop đặt'`
    const graph = createFakeMetaClient()
    graph.on('GET', '/USER_N', { ok: true, data: { name: 'IG Name', username: 'ig_user' } })
    expect(await fetchProfile({ db: handle.db, events, cipher, graph }, identityId, { finalAttempt: false })).toBe('unchanged')
    expect(await contactName()).toBe('Tên chủ shop đặt')
    expect(graph.calls[0]!.options.params).toEqual({ fields: 'name,username' })
    expect(emittedOf('contact.updated')).toHaveLength(0)
  })

  it('lỗi tạm → ném để retry; lỗi khác → bỏ qua, tên trống', async () => {
    const identityId = await newIdentity()
    const graph = createFakeMetaClient()
    graph.on('GET', '/USER_N', { ok: false, kind: 'TRANSIENT' })
    await expect(fetchProfile({ db: handle.db, events, cipher, graph }, identityId, { finalAttempt: false })).rejects.toBeInstanceOf(ProfileRetryableError)
    graph.on('GET', '/USER_N', { ok: false, kind: 'PERMISSION_DENIED' })
    expect(await fetchProfile({ db: handle.db, events, cipher, graph }, identityId, { finalAttempt: false })).toBe('skipped')
    expect(await contactName()).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// API Hộp thư + realtime
// ---------------------------------------------------------------------------------------------------------

async function cookie() {
  const { token } = await createSession(handle.db)
  return `${SESSION_COOKIE}=${token}`
}

describe('API Hộp thư', () => {
  it('danh sách theo phạm vi: mới nhất trước, xem trước, cần xử lý; trang ngoài phạm vi / đã gỡ không có', async () => {
    const a = await page('facebook', 'FB_LA')
    const b = await page('instagram', 'IG_LB')
    const gone = await page('facebook', 'FB_LG')
    await dm('FB_LA', { sender: 'U1', text: 'cũ', ts: at(1) })
    await dm('IG_LB', { sender: 'U2', text: 'mới', ts: at(2) })
    await dm('FB_LG', { sender: 'U3', ts: at(3) })
    await runTriage()
    await handle.db.transaction((tx) => setRemoved(tx, events, gone))
    const c = await cookie()

    const all = ListConversationsResponse.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/conversations', headers: { cookie: c } })).json(),
    )
    expect(all.items.map((i) => i.pageId)).toEqual([b, a])
    expect(all.items[0]).toMatchObject({
      state: 'human',
      stateReason: 'AI_OFF',
      needsAttention: true,
      channel: 'dm',
      aiEnabled: true,
      preview: { text: 'mới', origin: 'customer', attachmentCount: 0 },
      contact: { name: null, stage: 'new', pageIds: [b] },
    })
    expect(all.nextCursor).toBeNull()

    const scoped = ListConversationsResponse.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/conversations?scope=page:${a}`, headers: { cookie: c } })).json(),
    )
    expect(scoped.items.map((i) => i.pageId)).toEqual([a])
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations?scope=sai', headers: { cookie: c } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations?cursor=hong', headers: { cookie: c } })).statusCode).toBe(400)

    // Hội thoại của trang đã gỡ → 404.
    const [goneConv] = await handle.sql<{ id: string }[]>`select id from conversations where page_id = ${gone}`
    expect((await app.inject({ method: 'GET', url: `/api/v1/conversations/${goneConv!.id}`, headers: { cookie: c } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/conversations/${goneConv!.id}/messages`, headers: { cookie: c } })).statusCode).toBe(404)
  })

  it('phân trang danh sách bằng cursor (không trùng, không sót)', async () => {
    await page('facebook', 'FB_PG')
    for (let i = 0; i < 5; i++) await dm('FB_PG', { sender: `U${i}`, ts: at(i) })
    const c = await cookie()
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const url: string = `/api/v1/conversations?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const res = ListConversationsResponse.parse((await app.inject({ method: 'GET', url, headers: { cookie: c } })).json())
      seen.push(...res.items.map((i) => i.id))
      cursor = res.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('tin: trang mới nhất theo thứ tự hiển thị, cursor lùi về tin cũ; một hội thoại', async () => {
    await page('facebook', 'FB_MS')
    for (let i = 1; i <= 5; i++) await dm('FB_MS', { sender: 'U', text: `t${i}`, ts: at(i) })
    const [conv] = await conversationsRows()
    const c = await cookie()
    const first = ListMessagesResponse.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/conversations/${conv!.id}/messages?limit=3`, headers: { cookie: c } })).json(),
    )
    expect(first.items.map((m) => m.text)).toEqual(['t3', 't4', 't5'])
    const older = ListMessagesResponse.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/conversations/${conv!.id}/messages?limit=3&cursor=${first.nextCursor}`, headers: { cookie: c } })).json(),
    )
    expect(older.items.map((m) => m.text)).toEqual(['t1', 't2'])
    expect(older.nextCursor).toBeNull()

    const one = await app.inject({ method: 'GET', url: `/api/v1/conversations/${conv!.id}`, headers: { cookie: c } })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toMatchObject({ id: conv!.id, preview: { text: 't5' } })
  })

  it('cần phiên', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations' })).statusCode).toBe(401)
  })
})

describe('realtime', () => {
  it('ingest + triage → NOTIFY gợi ý message.received và conversation.state_changed (không mang nội dung)', async () => {
    const pageId = await page('facebook', 'FB_RT')
    await dm('FB_RT', { text: 'bí mật' })
    await runTriage()
    const hints = await waitFor(() => {
      const types = realtime.messages.map((m) => m.type)
      return types.includes('message.received') && types.includes('conversation.state_changed') ? realtime.messages : null
    })
    const received = hints.find((h) => h.type === 'message.received')!
    expect(received).toMatchObject({ entity: 'message', pageId })
    expect(JSON.stringify(hints)).not.toContain('bí mật')
  })
})

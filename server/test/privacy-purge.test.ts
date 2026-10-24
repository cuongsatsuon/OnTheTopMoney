// Story 9.2 — xoá khách và dữ liệu theo yêu cầu (AD-22, AD-1, AD-3, AD-24), Postgres thật + pg-boss thật + Cloudinary giả:
// - `POST /api/v1/contacts/:id/deletion`: xác nhận bắt buộc, 401 / 404, ẩn khách ngay, gọi lại cùng mã;
// - pipeline hai giai đoạn chạy qua đúng queue đã subscribe (`<module>.purge` → `events.privacy` → `inbox.purge`): sau khi
//   xoá không còn PII của khách ở mọi bảng epic-9 liệt kê, file riêng tư đã xoá, khách khác nguyên vẹn; `inbox` chỉ chạy
//   sau đủ phần, giai đoạn cuối phát đúng một lần;
// - lô dừng giữa chừng (kho lỗi tạm) chạy lại không để mồ côi; cron resume phát lại yêu cầu kẹt, bỏ qua yêu cầu 9.1 thiếu
//   ảnh chụp; cron trang gỡ quá 30 ngày (`scope=page`);
// - Meta `scope=all`: chỉ trang FB + IG của tài khoản, xoá `meta_accounts`; chống phát lại `signed_request`;
// - trang trạng thái có phạm vi + tiến độ; log không mang PII.
import { Writable } from 'node:stream'
import { ContactDeletionResponse, MetaDataDeletionResponse, PURGE_MODULE_NAMES, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { FAKE_PNG, createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import type { AttachmentDownloadResult } from '../src/adapters/meta/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { handleAiPurge } from '../src/modules/ai/index.ts'
import { handleAutoreplyPurge } from '../src/modules/autoreply/index.ts'
import { handleConnectionsPurge } from '../src/modules/connections/index.ts'
import { handleContentPurge } from '../src/modules/content/index.ts'
import { InboxPurgeRetryableError, fetchAttachment, handleInboxPurge, ingestComment, ingestDm, suggestMerge } from '../src/modules/inbox/index.ts'
import { handlePrivacyEvent, resumeStalledRequests, signRequestForTest, sweepRemovedPages } from '../src/modules/privacy/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { handleWebhooksPurge } from '../src/modules/webhooks/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, QUEUES, createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger, type Logger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const BASE = 'https://api.example.com'
const SECRET = 'meta-app-secret-purge'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-PURGE' }
/** Chuỗi PII của khách bị xoá — không được còn ở bảng nào / log nào. */
const PII = { name: 'Khách Kim Bí Mật', phone: '0901234567', note: 'ghi chú riêng của Kim', text: 'Bí mật K', psid: '7770001', fbuid: '7770002', igsid: '7770003' }

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let fake: FakeCloudinary
let media: MediaStores
let app: FastifyInstance
let cookie: string
let logLines: string[] = []
let log: Logger

const published: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    published.push({ name, payload: payload as Record<string, unknown> })
  },
}
const publishedOf = (name: EventName) => published.filter((e) => e.name === name).map((e) => e.payload)

/** Handler của mọi queue trong luồng xoá — như worker/main.ts. */
function handlers(m: Pick<MediaStores, 'configured' | 'publicStore' | 'privateStore'> = media): Record<string, (data: unknown) => Promise<unknown>> {
  const db = handle.db
  return {
    'autoreply.purge': (d) => handleAutoreplyPurge({ db, events }, d),
    'webhooks.purge': (d) => handleWebhooksPurge({ db, events }, d),
    'ai.purge': (d) => handleAiPurge({ db, events }, d),
    'content.purge': (d) => handleContentPurge({ db, events, media: m, log }, d),
    'connections.purge': (d) => handleConnectionsPurge({ db, events }, d),
    'inbox.purge': (d) => handleInboxPurge({ db, events, media: m, log }, d),
    'events.privacy': (d) => handlePrivacyEvent({ db, events, log }, d),
  }
}

/** Lấy job từ đúng các queue đã subscribe rồi chạy handler — tới khi không còn job nào. Trả số job đã chạy theo queue. */
async function drain(only?: string[], h = handlers()): Promise<Record<string, number>> {
  const ran: Record<string, number> = {}
  for (let round = 0; round < 30; round++) {
    let any = false
    for (const [queue, run] of Object.entries(h)) {
      if (only && !only.includes(queue)) continue
      const batch = await boss.fetch(queue, { batchSize: 20 })
      for (const job of batch) {
        await run(job.data)
        await boss.complete(queue, job.id)
        ran[queue] = (ran[queue] ?? 0) + 1
        any = true
      }
    }
    if (!any) return ran
  }
  throw new Error('drain không dừng')
}

const queued = async (queue: string) =>
  Number((await handle.sql.unsafe<{ n: string }[]>(`select count(*) as n from ${BOSS_SCHEMA}.job where name = $1 and state = 'created'`, [queue]))[0]!.n)

async function cleanup() {
  await handle.sql`delete from deletion_requests`
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from autoreply_runs`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from post_targets`
  await handle.sql`delete from posts`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from contacts`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from meta_accounts`
  await handle.sql`delete from sessions`
  await handle.sql.unsafe(`delete from ${BOSS_SCHEMA}.job`)
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-purge', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk))
      cb()
    },
  })
  log = createLogger({ level: 'debug' }, sink)
})
afterAll(async () => {
  await cleanup()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  published.length = 0
  logLines = []
  fake = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: fake.fetch })
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: log,
    http: { allowedOrigins: [ORIGIN] },
    events,
    jobs,
    privacy: { metaAppSecret: SECRET, publicBaseUrl: BASE, operator: {} },
  })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

// ---------------------------------------------------------------------------------------------------------
// Dữ liệu mẫu
// ---------------------------------------------------------------------------------------------------------

async function page(platform: 'facebook' | 'instagram' | 'threads', platformId: string): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${platformId}, ${`Trang ${platformId}`}) returning id`
  return p!.id
}

let seq = 0
const okDownload = async (): Promise<AttachmentDownloadResult> => ({ ok: true, data: FAKE_PNG, mime: 'image/png' })

/** Tin DM của `sender` (kèm ảnh đã lưu lên kho riêng tư nếu `withFile`); trả id hội thoại. */
async function dm(pageId: string, sender: string, text: string, withFile = false): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events: realEvents, jobs },
    {
      pageId,
      message: {
        kind: 'dm',
        senderId: sender,
        recipientId: 'PAGE',
        mid: `m_${sender}_${seq}`,
        timestamp: new Date(Date.now() - 60_000 + seq),
        text,
        attachments: withFile ? [{ kind: 'image', url: `https://cdn.fbsbx.com/${seq}.png?oh=sig` }] : [],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  if (withFile) {
    const [att] = await handle.sql<{ id: string }[]>`select id from message_attachments where message_id = ${res.messageId}`
    expect(await fetchAttachment({ db: handle.db, events: realEvents, media, download: okDownload }, att!.id, { finalAttempt: false })).toBe('stored')
  }
  return res.conversationId
}

async function comment(pageId: string, commentId: string, author: string, text: string, parentId: string | null = null): Promise<string> {
  seq += 1
  const res = await ingestComment(
    { db: handle.db, events: realEvents, jobs },
    {
      pageId,
      comment: { kind: 'comment', commentId, parentId, platformPostId: 'POST_1', author: { id: author, name: null, username: null }, text, timestamp: new Date(Date.now() - 60_000 + seq), attachments: [] },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

const contactOf = async (conversationId: string): Promise<string> =>
  (await handle.sql<{ contact_id: string }[]>`
    select ci.contact_id from conversations c join contact_identities ci on ci.id = c.contact_identity_id where c.id = ${conversationId}`)[0]!.contact_id

/** Gộp định danh của hội thoại vào khách `into` (một người nhắn nhiều trang / kênh). */
async function attach(conversationId: string, into: string) {
  const old = await contactOf(conversationId)
  if (old === into) return
  await handle.sql`update contact_identities set contact_id = ${into} where contact_id = ${old}`
  await handle.sql`delete from contacts where id = ${old}`
}

async function webhook(payload: object, pageId: string | null, platformPageId: string | null, product: 'meta' | 'threads' = 'meta') {
  seq += 1
  await handle.sql`
    insert into webhook_events (product, platform_page_id, page_id, field, dedupe_key, payload, status)
    values (${product}, ${platformPageId}, ${pageId}, 'messages', ${`k${seq}`}, ${JSON.stringify(payload)}::jsonb, 'routed')`
}

async function run(conversationId: string, pageId: string) {
  await handle.sql`
    insert into autoreply_runs (conversation_id, page_id, last_inbound_id, state_version, inbound_at)
    values (${conversationId}, ${pageId}, ${conversationId}, 0, now())`
}

async function usage(pageId: string | null, ref: string | null) {
  await handle.sql`
    insert into ai_usage (month, feature, model, page_id, ref, usd_micros, cost_vnd) values ('2026-10', 'autoreply', 'gpt-test', ${pageId}, ${ref}, 10, 1)`
}

/**
 * Khách Kim (K): DM Messenger + ảnh, bình luận gốc, DM Instagram — một khách trên hai trang; trả lời trong luồng bình luận
 * của khách Oanh (O). O có DM + ảnh riêng. Gợi ý gộp K–O, run AI, chi phí AI, payload webhook thô của cả hai.
 */
async function seedKimAndOanh() {
  const fb = await page('facebook', 'FB_A')
  const ig = await page('instagram', 'IG_A')
  const kDm = await dm(fb, PII.psid, `${PII.text} 1 — SĐT ${PII.phone}`, true)
  const k = await contactOf(kDm)
  const kComment = await comment(fb, 'C_K', PII.fbuid, `${PII.text} 2 bình luận`)
  await attach(kComment, k)
  const kIg = await dm(ig, PII.igsid, `${PII.text} 3 instagram`)
  await attach(kIg, k)
  await handle.sql`update contacts set name = ${PII.name}, phone = ${PII.phone}, note = ${PII.note}, tags = ${['vip']}, ai_summary = ${`${PII.name} thích son`}, ai_summary_at = now() where id = ${k}`

  const oDm = await dm(fb, '8880001', 'Tin của Oanh', true)
  const o = await contactOf(oDm)
  const oComment = await comment(fb, 'C_O', '8880002', 'Oanh bình luận')
  await attach(oComment, o)
  // K trả lời trong luồng bình luận của O (tin của K nằm ở hội thoại của O).
  const inOThread = await comment(fb, 'C_O_K', PII.fbuid, `${PII.text} 4 trả lời Oanh`, 'C_O')
  expect(inOThread).toBe(oComment)
  await handle.db.transaction((tx) => suggestMerge(tx, k, o, 'private_reply'))

  for (const c of [kDm, kComment, kIg]) await run(c, fb)
  await run(oDm, fb)
  await usage(fb, k)
  await usage(fb, kDm)
  await usage(ig, kIg)
  await usage(fb, oDm)
  await usage(null, null)
  await webhook({ sender: { id: PII.psid }, recipient: { id: 'FB_A' }, message: { mid: 'm_x', text: `${PII.text} thô` } }, fb, 'FB_A')
  await webhook({ field: 'feed', value: { from: { id: PII.fbuid, name: PII.name }, comment_id: 'C_K', message: `${PII.text} thô` } }, null, 'FB_A')
  await webhook({ sender: { id: PII.igsid }, message: { mid: 'm_y', text: 'ig' } }, ig, 'IG_A')
  await webhook({ sender: { id: '8880001' }, message: { mid: 'm_o', text: 'Tin của Oanh' } }, fb, 'FB_A')
  return { fb, ig, k, o, kConvs: [kDm, kComment, kIg], oDm, oComment }
}

const del = (id: string, body: unknown = { confirm: true }, headers: Record<string, string> = { cookie, origin: ORIGIN }) =>
  app.inject({ method: 'POST', url: `/api/v1/contacts/${id}/deletion`, headers, payload: body as object })

const count = async (q: Promise<{ n: string }[]>) => Number((await q)[0]!.n)

/** Mọi bảng epic-9 liệt kê còn mang PII của khách K? (0 ở mọi dòng = sạch.) */
async function piiLeft(k: string, kConvs: string[]) {
  const like = `%${PII.text}%`
  const ids = [PII.psid, PII.fbuid, PII.igsid]
  return {
    contacts: await count(handle.sql`select count(*) as n from contacts where id = ${k} or name like ${'%Kim%'} or phone = ${PII.phone} or note like ${'%Kim%'}`),
    identities: await count(handle.sql`select count(*) as n from contact_identities where contact_id = ${k} or platform_user_id = any(${ids})`),
    conversations: await count(handle.sql`select count(*) as n from conversations where id = any(${kConvs}) or thread_key = any(${[...ids, 'C_K']})`),
    messages: await count(handle.sql`select count(*) as n from messages where text like ${like} or conversation_id = any(${kConvs})`),
    attachments: await count(handle.sql`select count(*) as n from message_attachments a join messages m on m.id = a.message_id where m.conversation_id = any(${kConvs})`),
    suggestions: await count(handle.sql`select count(*) as n from contact_merge_suggestions where contact_id = ${k} or other_contact_id = ${k}`),
    webhooks: await count(handle.sql`select count(*) as n from webhook_events where payload::text like ${like} or payload::text like any(${ids.map((i) => `%"${i}"%`)})`),
    runs: await count(handle.sql`select count(*) as n from autoreply_runs where conversation_id = any(${kConvs})`),
    aiRefs: await count(handle.sql`select count(*) as n from ai_usage where ref = any(${[k, ...kConvs]})`),
  }
}
const CLEAN = { contacts: 0, identities: 0, conversations: 0, messages: 0, attachments: 0, suggestions: 0, webhooks: 0, runs: 0, aiRefs: 0 }

const statusPage = (code: string) => app.inject({ method: 'GET', url: `/privacy/status/${code}` })

// ---------------------------------------------------------------------------------------------------------
// Xoá một khách
// ---------------------------------------------------------------------------------------------------------

describe('xoá khách (scope=contact)', () => {
  it('202 → pipeline xoá sạch PII của khách ở mọi bảng + file riêng tư; khách khác giữ nguyên; trạng thái completed', async () => {
    const s = await seedKimAndOanh()
    expect(fake.assets.size).toBe(2)
    const res = await del(s.k)
    expect(res.statusCode).toBe(202)
    const body = ContactDeletionResponse.parse(res.json())
    expect(body).toMatchObject({ scope: 'contact', status: 'pending', statusUrl: `${BASE}/privacy/status/${body.code}` })
    const [ev] = publishedOf('privacy.purge_requested')
    expect(ev).toMatchObject({ id: body.requestId, scope: 'contact', targetId: s.k })
    expect([...(ev!.conversationIds as string[])].sort()).toEqual([...s.kConvs].sort())

    const ran = await drain()
    expect(ran).toMatchObject({ 'autoreply.purge': 1, 'webhooks.purge': 1, 'ai.purge': 1, 'inbox.purge': 1, 'events.privacy': 4 })
    // Phạm vi `contact` không có `content` / `connections`: job tới (cùng sự kiện) nhưng handler bỏ qua, không báo phần.
    expect(publishedOf('privacy.purge_part_completed').map((p) => p.module).sort()).toEqual(['ai', 'autoreply', 'inbox', 'webhooks'])

    expect(await piiLeft(s.k, s.kConvs)).toEqual(CLEAN)
    // File của K đã xoá trên kho; file của O còn.
    expect(fake.assets.size).toBe(1)
    const [oAtt] = await handle.sql<{ file_public_id: string }[]>`select a.file_public_id from message_attachments a join messages m on m.id = a.message_id where m.conversation_id = ${s.oDm}`
    expect([...fake.assets.values()][0]!.publicId).toBe(oAtt!.file_public_id)
    // O nguyên vẹn: khách, hai hội thoại, tin của O (tin K trả lời trong luồng của O đã xoá), run, ref AI, payload thô.
    expect(await count(handle.sql`select count(*) as n from contacts where id = ${s.o}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from conversations where id = any(${[s.oDm, s.oComment]})`)).toBe(2)
    expect(await count(handle.sql`select count(*) as n from messages where conversation_id = any(${[s.oDm, s.oComment]})`)).toBe(2)
    expect(await count(handle.sql`select count(*) as n from autoreply_runs where conversation_id = ${s.oDm}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from ai_usage where ref = ${s.oDm}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from webhook_events`)).toBe(1)
    // Dòng chi phí AI giữ (hạn mức tháng), chỉ mất tham chiếu.
    expect(await count(handle.sql`select count(*) as n from ai_usage`)).toBe(5)

    const [req] = await handle.sql<{ status: string; completed_at: Date | null }[]>`select status, completed_at from deletion_requests`
    expect(req).toMatchObject({ status: 'completed' })
    expect(publishedOf('privacy.purge_completed')).toEqual([{ id: body.requestId }])
    expect(publishedOf('contact.deleted')).toEqual([{ id: s.k }])
    const page = await statusPage(body.code)
    expect(page.body).toContain('Đã xoá xong')
    expect(page.body).toContain('Một khách và toàn bộ hội thoại của khách')
    expect(page.body).not.toContain('Kim')
  })

  it('khách ẩn ngay khỏi danh sách / chi tiết / facets / ⌘K, trước khi worker chạy; trang trạng thái hiện 0/4 phần', async () => {
    const s = await seedKimAndOanh()
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
    expect((await get(`/api/v1/contacts/${s.k}`)).statusCode).toBe(200)
    const before = (await get('/api/v1/contacts/facets')).json().total as number
    const { code } = ContactDeletionResponse.parse((await del(s.k)).json())
    expect((await get(`/api/v1/contacts/${s.k}`)).statusCode).toBe(404)
    expect((await get('/api/v1/contacts')).json().items.map((c: { id: string }) => c.id)).toEqual([s.o])
    expect((await get('/api/v1/contacts/facets')).json().total).toBe(before - 1)
    expect((await get(`/api/v1/search?q=${encodeURIComponent('Kim')}`)).json().contacts).toEqual([])
    // Gộp với khách đang chờ xoá → 404.
    const merge = await app.inject({ method: 'POST', url: `/api/v1/contacts/${s.o}/merge`, headers: { cookie, origin: ORIGIN }, payload: { sourceId: s.k } })
    expect(merge.statusCode).toBe(404)
    const page = await statusPage(code)
    expect(page.body).toContain('Đã nhận — đang chờ xoá')
    expect(page.body).toContain('Đã xong 0/4 phần')
  })

  it('gọi lại khi đang mở / sau khi xong → 200 cùng mã, không thêm yêu cầu', async () => {
    const s = await seedKimAndOanh()
    const first = ContactDeletionResponse.parse((await del(s.k)).json())
    const again = await del(s.k)
    expect(again.statusCode).toBe(200)
    expect(ContactDeletionResponse.parse(again.json()).code).toBe(first.code)
    await drain()
    const done = await del(s.k)
    expect(done.statusCode).toBe(200)
    expect(ContactDeletionResponse.parse(done.json())).toMatchObject({ code: first.code, status: 'completed' })
    expect(await count(handle.sql`select count(*) as n from deletion_requests`)).toBe(1)
    expect(publishedOf('privacy.purge_requested')).toHaveLength(1)
  })

  it('thiếu xác nhận → 400; không phiên → 401; khách lạ → 404; không ghi gì', async () => {
    const s = await seedKimAndOanh()
    expect((await del(s.k, {})).statusCode).toBe(400)
    expect((await del(s.k, { confirm: 'yes' })).statusCode).toBe(400)
    expect((await del(s.k, { confirm: true }, { origin: ORIGIN })).statusCode).toBe(401)
    expect((await del('0190f5c4-7b1e-7000-8000-000000000000')).statusCode).toBe(404)
    expect(await count(handle.sql`select count(*) as n from deletion_requests`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from contacts where deletion_requested_at is not null`)).toBe(0)
  })

  it('thứ tự: inbox chỉ chạy sau đủ phần giai đoạn 1; phần báo trùng không phát giai đoạn cuối lần hai', async () => {
    const s = await seedKimAndOanh()
    const { code } = ContactDeletionResponse.parse((await del(s.k)).json())
    await drain(['autoreply.purge', 'webhooks.purge', 'events.privacy'])
    expect(await queued('inbox.purge')).toBe(0)
    const page = await statusPage(code)
    expect(page.body).toContain('Đang xoá dữ liệu')
    expect(page.body).toContain('Đã xong 2/4 phần')
    // Dữ liệu inbox còn nguyên khi chưa tới lượt (webhooks đã tìm payload theo id nền tảng của khách).
    expect(await count(handle.sql`select count(*) as n from contacts where id = ${s.k}`)).toBe(1)
    await drain(['ai.purge', 'events.privacy'])
    expect(await queued('inbox.purge')).toBe(1)
    // Phát lại giai đoạn 1 (như cron resume) → mọi phần báo lại → không thêm giai đoạn cuối.
    const [req] = await handle.sql<{ id: string }[]>`select id from deletion_requests`
    await handle.db.transaction((tx) => events.publishEvent(tx, 'privacy.purge_part_completed', { id: req!.id, module: 'ai' }))
    await drain(['events.privacy'])
    expect(await queued('inbox.purge')).toBe(1)
    expect(publishedOf('privacy.purge_final_requested')).toHaveLength(1)
    await drain()
    expect(await piiLeft(s.k, s.kConvs)).toEqual(CLEAN)
  })

  it('lô dừng giữa chừng (kho lỗi tạm ở file thứ 2) → ném; chạy lại xoá tiếp, không còn file / dòng mồ côi', async () => {
    const fb = await page('facebook', 'FB_A')
    const c1 = await dm(fb, PII.psid, `${PII.text} a`, true)
    await dm(fb, PII.psid, `${PII.text} b`, true)
    await dm(fb, PII.psid, `${PII.text} c`, true)
    const k = await contactOf(c1)
    expect(fake.assets.size).toBe(3)
    await del(k)
    await drain(['autoreply.purge', 'webhooks.purge', 'ai.purge', 'events.privacy'])
    const [job] = await boss.fetch('inbox.purge')
    let calls = 0
    const flaky: MediaStores = {
      ...media,
      privateStore: { ...media.privateStore, delete: async (ref) => (++calls === 2 ? { ok: false, kind: 'TRANSIENT' } : media.privateStore.delete(ref)) },
    }
    await expect(handleInboxPurge({ db: handle.db, events, media: flaky, log, batchSize: { messages: 1 } }, job!.data)).rejects.toBeInstanceOf(InboxPurgeRetryableError)
    // Lô 1 xong (tin + file), lô 2 rollback: dòng đính kèm còn ⇔ file còn.
    const rows = await handle.sql<{ file_public_id: string }[]>`select file_public_id from message_attachments`
    expect(rows).toHaveLength(2)
    expect([...fake.assets.values()].map((a) => a.publicId).sort()).toEqual(rows.map((r) => r.file_public_id).sort())
    expect(await count(handle.sql`select count(*) as n from contacts where id = ${k}`)).toBe(1)
    // Lần retry (worker / pg-boss chạy lại cùng job).
    await handleInboxPurge({ db: handle.db, events, media, log, batchSize: { messages: 1 } }, job!.data)
    await drain()
    expect(fake.assets.size).toBe(0)
    expect(await count(handle.sql`select count(*) as n from messages`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from contacts`)).toBe(0)
    expect((await handle.sql<{ status: string }[]>`select status from deletion_requests`)[0]!.status).toBe('completed')
  })

  it('log của route + pipeline không mang PII (tên, SĐT, nội dung, id nền tảng)', async () => {
    const s = await seedKimAndOanh()
    logLines = []
    await del(s.k)
    await drain()
    const all = logLines.join('\n')
    expect(all).toContain('privacy: chủ shop yêu cầu xoá khách')
    for (const v of [PII.name, PII.phone, PII.note, PII.text, PII.psid, PII.fbuid, PII.igsid]) expect(all).not.toContain(v)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Cron: resume + trang gỡ quá 30 ngày
// ---------------------------------------------------------------------------------------------------------

describe('cron privacy', () => {
  it('resume: yêu cầu kẹt quá 1 giờ được phát lại rồi xong; yêu cầu all của 9.1 thiếu ảnh chụp bị bỏ qua', async () => {
    const s = await seedKimAndOanh()
    await del(s.k)
    // Mất job (vd sự kiện phát lúc chưa có consumer) + kẹt 2 giờ.
    await handle.sql.unsafe(`delete from ${BOSS_SCHEMA}.job where name like '%.purge'`)
    await handle.sql`update deletion_requests set last_published_at = now() - interval '2 hours'`
    await handle.sql`
      insert into deletion_requests (code, scope, target_id, status, source, matched, requested_at)
      values (${'a'.repeat(32)}, 'all', null, 'pending', 'meta_deauthorize', true, now() - interval '3 hours')`
    logLines = []
    expect(await resumeStalledRequests({ db: handle.db, events, log })).toEqual({ republished: 1, skippedLegacy: 1, closedReconnected: 0 })
    expect(logLines.join('\n')).toContain('thiếu ảnh chụp phạm vi trang')
    // Không yêu cầu nào mới kẹt → lần sau không phát lại.
    expect((await resumeStalledRequests({ db: handle.db, events })).republished).toBe(0)
    await drain()
    expect(await piiLeft(s.k, s.kConvs)).toEqual(CLEAN)
    const rows = await handle.sql<{ scope: string; status: string }[]>`select scope, status from deletion_requests order by requested_at`
    expect(rows).toEqual([
      { scope: 'all', status: 'pending' },
      { scope: 'contact', status: 'completed' },
    ])
  })

  it('trang gỡ quá 30 ngày → một yêu cầu page; dữ liệu khách / hội thoại / bài của trang hết, trang khác giữ; chạy lại không tạo thêm', async () => {
    const a = await page('facebook', 'FB_GONE')
    const b = await page('facebook', 'FB_RECENT')
    const c = await page('instagram', 'IG_LIVE')
    const xA = await dm(a, '9990001', 'X ở trang A', true)
    const x = await contactOf(xA)
    const xC = await dm(c, '9990002', 'X ở trang C')
    await attach(xC, x)
    const yA = await dm(a, '9990003', 'Y chỉ ở trang A')
    const y = await contactOf(yA)
    const zB = await dm(b, '9990004', 'Z ở trang B')
    await run(xA, a)
    await run(xC, c)
    await usage(a, xA)
    await usage(c, xC)
    await webhook({ sender: { id: '9990001' } }, a, 'FB_GONE')
    await webhook({ sender: { id: '9990003' } }, null, 'FB_GONE')
    await webhook({ sender: { id: '9990002' } }, c, 'IG_LIVE', 'meta')
    // Bài: một bài chỉ trang A (có ảnh), một bài trang A + C.
    const put = await media.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    if (!put.ok) throw new Error('put')
    const [img] = await handle.sql<{ id: string }[]>`
      insert into media_assets (source, status, public_id, url, width, height, bytes, format, created_at)
      values ('upload', 'ready', ${put.publicId}, ${put.url}, 2, 2, 10, 'png', now() - interval '1 day') returning id`
    const [p1] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
    const [p2] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
    const [t1] = await handle.sql<{ id: string }[]>`insert into post_targets (post_id, page_id, position, status) values (${p1!.id}, ${a}, 0, 'published') returning id`
    await handle.sql`insert into post_target_media (post_target_id, media_asset_id, position) values (${t1!.id}, ${img!.id}, 0)`
    await handle.sql`insert into post_targets (post_id, page_id, position, status, cancel_reason) values (${p2!.id}, ${a}, 0, 'cancelled', 'PAGE_REMOVED')`
    await handle.sql`insert into post_targets (post_id, page_id, position, status) values (${p2!.id}, ${c}, 1, 'published')`
    await handle.sql`update pages set removed_at = now() - interval '31 days' where id = ${a}`
    await handle.sql`update pages set removed_at = now() - interval '10 days' where id = ${b}`

    expect(await sweepRemovedPages({ db: handle.db, events, log })).toBe(1)
    expect(await sweepRemovedPages({ db: handle.db, events })).toBe(0)
    const [req] = await handle.sql<{ scope: string; target_id: string; source: string; page_ids: string[] }[]>`select scope, target_id, source, page_ids from deletion_requests`
    expect(req).toEqual({ scope: 'page', target_id: a, source: 'page_removed', page_ids: [a] })
    await drain()

    // Trang A: hết khách Y, hội thoại, tin, định danh, run, ref AI, payload thô (cả mục chưa route), bài + ảnh.
    expect(await count(handle.sql`select count(*) as n from contacts where id = ${y}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from conversations where page_id = ${a}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from messages where page_id = ${a}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from contact_identities where page_id = ${a}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from autoreply_runs where page_id = ${a}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from ai_usage where page_id = ${a} and ref is not null`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from webhook_events where page_id = ${a} or platform_page_id = 'FB_GONE'`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from post_targets where page_id = ${a}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from posts where id = ${p1!.id}`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from media_assets`)).toBe(0)
    expect(fake.assets.size).toBe(0)
    // Khách X còn (nhắn ở C) với đúng định danh C; trang B / C nguyên vẹn; bài A + C còn với đích C.
    expect((await handle.sql<{ page_id: string }[]>`select page_id from contact_identities where contact_id = ${x}`).map((r) => r.page_id)).toEqual([c])
    expect(await count(handle.sql`select count(*) as n from conversations where id = any(${[xC, zB]})`)).toBe(2)
    expect(await count(handle.sql`select count(*) as n from autoreply_runs where page_id = ${c}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from ai_usage where ref = ${xC}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from webhook_events`)).toBe(1)
    expect((await handle.sql<{ page_id: string }[]>`select page_id from post_targets where post_id = ${p2!.id}`).map((r) => r.page_id)).toEqual([c])
    expect((await handle.sql<{ status: string }[]>`select status from deletion_requests`)[0]!.status).toBe('completed')
    expect(publishedOf('privacy.purge_part_completed')).toHaveLength(5)
    // Hàng `pages` không bị xoá cứng.
    expect(await count(handle.sql`select count(*) as n from pages`)).toBe(3)
  })

  it('review: trang gỡ được kết nối lại khi yêu cầu chưa xong → đóng yêu cầu, inbox không xoá; resume cũng không phát lại', async () => {
    const a = await page('facebook', 'FB_BACK')
    const conv = await dm(a, '9990011', 'Tin trước khi gỡ')
    await handle.sql`update pages set removed_at = now() - interval '31 days' where id = ${a}`
    expect(await sweepRemovedPages({ db: handle.db, events })).toBe(1)
    // Chủ shop kết nối lại trước khi giai đoạn cuối chạy.
    await handle.sql`update pages set removed_at = null where id = ${a}`
    await drain()
    expect(publishedOf('privacy.purge_final_requested')).toEqual([])
    expect(await count(handle.sql`select count(*) as n from conversations where id = ${conv}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from messages where conversation_id = ${conv}`)).toBe(1)
    expect((await handle.sql<{ status: string }[]>`select status from deletion_requests`)[0]!.status).toBe('completed')

    // Yêu cầu kẹt rồi trang kết nối lại → cron resume đóng yêu cầu, không phát lại giai đoạn nào.
    await handle.sql`delete from deletion_requests`
    await handle.sql`update pages set removed_at = now() - interval '31 days' where id = ${a}`
    expect(await sweepRemovedPages({ db: handle.db, events })).toBe(1)
    await handle.sql.unsafe(`delete from ${BOSS_SCHEMA}.job where name like '%.purge'`)
    await handle.sql`update deletion_requests set last_published_at = now() - interval '2 hours'`
    await handle.sql`update pages set removed_at = null where id = ${a}`
    published.length = 0
    expect(await resumeStalledRequests({ db: handle.db, events })).toEqual({ republished: 0, skippedLegacy: 0, closedReconnected: 1 })
    expect(published).toEqual([])
    expect((await handle.sql<{ status: string }[]>`select status from deletion_requests`)[0]!.status).toBe('completed')
    // Trang đang dùng → cron trang gỡ không tạo yêu cầu.
    expect(await sweepRemovedPages({ db: handle.db, events })).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Meta scope=all + chống phát lại
// ---------------------------------------------------------------------------------------------------------

describe('Meta scope=all', () => {
  const OWNER = '100200300'
  const OTHER = '900800700'
  const signed = (userId: string, issuedAt: number) => signRequestForTest({ algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: userId }, SECRET)
  const callback = (kind: 'deauthorize' | 'data-deletion', sr: string) =>
    app.inject({ method: 'POST', url: `/privacy/meta/${kind}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `signed_request=${encodeURIComponent(sr)}` })

  async function seedAccounts() {
    const [owner] = await handle.sql<{ id: string }[]>`insert into meta_accounts (fb_user_id, name, user_token) values (${OWNER}, 'Chủ shop', 'v1:k1:x') returning id`
    const [other] = await handle.sql<{ id: string }[]>`insert into meta_accounts (fb_user_id, name, user_token) values (${OTHER}, 'Người khác', 'v1:k1:y') returning id`
    const fb = await page('facebook', 'FB1')
    const ig = await page('instagram', 'IG1')
    const th = await page('threads', 'TH1')
    const fb2 = await page('facebook', 'FB2')
    await handle.sql`insert into page_credentials (page_id, meta_account_id, access_token) values (${fb}, ${owner!.id}, 'v1:k1:p')`
    await handle.sql`insert into page_credentials (page_id, meta_account_id, token_source_page_id) values (${ig}, ${owner!.id}, ${fb})`
    await handle.sql`insert into page_credentials (page_id, access_token) values (${th}, 'v1:k1:t')`
    await handle.sql`insert into page_credentials (page_id, meta_account_id, access_token) values (${fb2}, ${other!.id}, 'v1:k1:q')`
    const convs = { fb: await dm(fb, '5550001', 'khách FB'), ig: await dm(ig, '5550002', 'khách IG'), th: await dm(th, '5550003', 'khách Threads'), fb2: await dm(fb2, '5550004', 'khách FB2') }
    await handle.sql`insert into posts (source) values ('manual')`
    const [post] = await handle.sql<{ id: string }[]>`select id from posts`
    await handle.sql`insert into post_targets (post_id, page_id, position, status) values (${post!.id}, ${fb}, 0, 'published'), (${post!.id}, ${th}, 1, 'published')`
    return { owner: owner!.id, other: other!.id, fb, ig, th, fb2, convs }
  }

  it('deauthorize → chỉ dữ liệu FB + IG của tài khoản bị xoá, meta_accounts của chủ shop xoá; Threads + tài khoản khác giữ', async () => {
    const s = await seedAccounts()
    expect((await callback('deauthorize', signed(OWNER, 1_790_000_000))).statusCode).toBe(200)
    const [ev] = publishedOf('privacy.purge_requested')
    expect(ev).toMatchObject({ scope: 'all', targetId: null, metaAccountId: s.owner })
    expect([...(ev!.pageIds as string[])].sort()).toEqual([s.fb, s.ig].sort())
    const ran = await drain()
    expect(ran['connections.purge']).toBe(1)
    expect(await count(handle.sql`select count(*) as n from conversations where id = any(${[s.convs.fb, s.convs.ig]})`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from conversations where id = any(${[s.convs.th, s.convs.fb2]})`)).toBe(2)
    expect((await handle.sql<{ fb_user_id: string }[]>`select fb_user_id from meta_accounts`).map((r) => r.fb_user_id)).toEqual([OTHER])
    expect((await handle.sql<{ page_id: string }[]>`select page_id from post_targets`).map((r) => r.page_id)).toEqual([s.th])
    // Token trang + dòng trang giữ (hẹp); khoá ngoại tới tài khoản đã xoá thành null.
    expect(await count(handle.sql`select count(*) as n from page_credentials where meta_account_id is null and page_id = any(${[s.fb, s.ig]})`)).toBe(2)
    const [req] = await handle.sql<{ code: string; status: string }[]>`select code, status from deletion_requests`
    expect(req!.status).toBe('completed')
    const page = await statusPage(req!.code)
    expect(page.body).toContain('Đã xoá xong')
    expect(page.body).toContain('Dữ liệu gắn với tài khoản Facebook đã cấp quyền')
  })

  it('phát lại signed_request cũ sau khi xong + đã kết nối lại → cùng mã, không ngắt trang, không yêu cầu mới; issued_at mới hơn → yêu cầu mới', async () => {
    const s = await seedAccounts()
    const old = signed(OWNER, 1_790_000_000)
    const first = MetaDataDeletionResponse.parse((await callback('data-deletion', old)).json())
    await callback('deauthorize', old)
    await drain()
    // Chủ shop kết nối lại cùng tài khoản Facebook.
    const [again] = await handle.sql<{ id: string }[]>`insert into meta_accounts (fb_user_id, name, user_token) values (${OWNER}, 'Chủ shop', 'v1:k1:z') returning id`
    await handle.sql`update page_credentials set meta_account_id = ${again!.id} where page_id = ${s.fb}`
    await handle.sql`update pages set connection_status = 'active', connection_status_reason = null where id = any(${[s.fb, s.ig]})`
    published.length = 0

    expect((await callback('deauthorize', old)).statusCode).toBe(200)
    const replay = MetaDataDeletionResponse.parse((await callback('data-deletion', old)).json())
    expect(replay.confirmation_code).toBe(first.confirmation_code)
    expect(await count(handle.sql`select count(*) as n from deletion_requests`)).toBe(1)
    expect((await handle.sql<{ connection_status: string }[]>`select connection_status from pages where id = ${s.fb}`)[0]!.connection_status).toBe('active')
    expect(publishedOf('page.disconnected')).toHaveLength(0)
    expect(publishedOf('privacy.purge_requested')).toHaveLength(0)

    const fresh = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER, 1_790_000_600))).json())
    expect(fresh.confirmation_code).not.toBe(first.confirmation_code)
    expect(await count(handle.sql`select count(*) as n from deletion_requests`)).toBe(2)
    expect(publishedOf('privacy.purge_requested')).toHaveLength(1)
  })
})

describe('khai báo queue', () => {
  it('mỗi module tham gia có queue `<module>.purge` critical; inbox nghe giai đoạn cuối, còn lại giai đoạn 1', () => {
    for (const m of PURGE_MODULE_NAMES) {
      const def = QUEUES[`${m}.purge` as keyof typeof QUEUES] as { subscribes?: readonly string[]; critical?: boolean }
      expect(def.critical).toBe(true)
      expect(def.subscribes).toEqual([m === 'inbox' ? 'privacy.purge_final_requested' : 'privacy.purge_requested'])
    }
    expect(QUEUES['events.privacy'].subscribes).toEqual(['privacy.purge_part_completed'])
    expect(QUEUES['privacy.purge_resume'].cron.tz).toBe('Asia/Ho_Chi_Minh')
    expect(QUEUES['privacy.removed_pages'].cron.tz).toBe('Asia/Ho_Chi_Minh')
  })
})

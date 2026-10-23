// Story 4.9 — Khách hàng: danh sách, thẻ, giai đoạn, lịch sử (AD-1, AD-7, AD-11, AD-18). Postgres thật, fake OpenAI.
// Phủ: lọc theo phạm vi (định danh giao phạm vi, trang đã gỡ), `pageIds`/`handledBy` từ read-model, lọc thẻ / giai đoạn /
// chữ + cursor + facets; sửa hồ sơ (chuẩn hoá thẻ, `contact.updated`, giai đoạn hiện ở Hộp thư) và lỗi kiểm; lịch sử
// nhiều trang (ghi trang, bỏ `system`, cursor); gộp khách (định danh, hội thoại, thẻ, sự kiện, lỗi); gợi ý gộp; hàng
// loạt; tóm tắt AI (202 + job, không enqueue lại khi chờ, 422, job ghi `aiSummary` + `ai_usage`, lỗi khoá / lỗi tạm);
// 401 / 404.
import { randomBytes } from 'node:crypto'
import { ContactDetailDto, ContactFacetsResponse, ListContactHistoryResponse, ListContactsResponse, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey } from '../src/modules/ai/index.ts'
import {
  ContactSummaryRetryableError,
  aiSummaryStatusOf,
  applyUserAction,
  ingestComment,
  ingestDm,
  suggestMerge,
  summarizeContact,
} from '../src/modules/inbox/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-CONTACTS-key-aaaa1111'
const MIN = 60_000
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let fake: FakeOpenAiAdapter
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
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name = 'inbox.contact_summary'`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-contacts', { background: false })
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
  await setOpenAiKey({ db: handle.db, events: realEvents, cipher, openai: fake }, GOOD)
  app = buildApp({ sql: handle.sql, db: handle.db, logger: log, http: { allowedOrigins: [ORIGIN] }, events, jobs, ai: { cipher, openai: fake } })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function page(name: string, platform: 'facebook' | 'instagram' | 'threads' = 'facebook'): Promise<string> {
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${randomBytes(6).toString('hex')}, ${name}) returning id`
  return p!.id
}

let seq = 0
const ago = (ms: number) => new Date(Date.now() - ms)

/** Tin DM của khách `sender` trên trang; trả id hội thoại. */
async function dm(pageId: string, sender: string, text: string | null, ts: Date, attachments: { kind: 'image'; url: string }[] = []): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events: realEvents, jobs },
    { pageId, message: { kind: 'dm', senderId: sender, recipientId: 'PAGE', mid: `mid_${seq}`, timestamp: ts, text, attachments } },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

async function comment(pageId: string, commentId: string, author: string, text: string, ts: Date): Promise<string> {
  const res = await ingestComment(
    { db: handle.db, events: realEvents, jobs },
    {
      pageId,
      comment: { kind: 'comment', commentId, parentId: null, platformPostId: 'POST_1', author: { id: author, name: null, username: null }, text, timestamp: ts, attachments: [] },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

const contactOf = async (conversationId: string): Promise<string> =>
  (
    await handle.sql<{ contact_id: string }[]>`
      select ci.contact_id from conversations c join contact_identities ci on ci.id = c.contact_identity_id where c.id = ${conversationId}`
  )[0]!.contact_id

/** Đưa định danh của hội thoại sang khách `contactId` (giả lập một khách nhắn nhiều trang) và xoá khách cũ. */
async function attach(conversationId: string, contactId: string) {
  const old = await contactOf(conversationId)
  await handle.sql`update contact_identities set contact_id = ${contactId} where contact_id = ${old}`
  await handle.sql`delete from contacts where id = ${old}`
}

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN }
  if (opts.auth !== false) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) })
}

const list = async (qs: string) => {
  const res = await api('GET', `/contacts?${qs}`)
  expect(res.statusCode).toBe(200)
  return ListContactsResponse.parse(res.json())
}
const detail = async (id: string) => ContactDetailDto.parse((await api('GET', `/contacts/${id}`)).json())
const patch = (id: string, body: unknown) => api('PATCH', `/contacts/${id}`, body)
const summaryJobs = async () => (await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = 'inbox.contact_summary'`)[0]!.n

// ---------------------------------------------------------------------------------------------------------
// Danh sách theo phạm vi
// ---------------------------------------------------------------------------------------------------------

describe('GET /api/v1/contacts', () => {
  it('khách có định danh giao phạm vi; pageIds chỉ trang chưa gỡ; handledBy theo hội thoại mới nhất (read-model)', async () => {
    const a = await page('Trang A')
    const b = await page('Trang B')
    const r = await page('Trang gỡ')
    const xa = await dm(a, 'X_A', 'chào shop', ago(30 * MIN))
    const x = await contactOf(xa)
    const xb = await dm(b, 'X_B', 'shop ơi', ago(10 * MIN))
    await attach(xb, x)
    const xr = await dm(r, 'X_R', 'cũ', ago(60 * MIN))
    await attach(xr, x)
    const y = await contactOf(await dm(b, 'Y_B', 'hỏi giá', ago(20 * MIN)))
    const z = await contactOf(await dm(r, 'Z_R', 'trang gỡ', ago(5 * MIN)))
    await handle.sql`update pages set removed_at = now() where id = ${r}`
    await handle.sql`update conversations set state = 'human' where id = ${xa}`
    await handle.sql`update conversations set state = 'ai' where id = ${xb}`

    const inA = await list(`scope=page:${a}`)
    expect(inA.items.map((c) => c.id)).toEqual([x])
    expect(inA.items[0]).toMatchObject({ pageIds: [a, b], handledBy: 'human', latest: { id: xa, pageId: a, channel: 'dm', state: 'human' } })
    expect(inA.items[0]!.latest!.preview).toMatchObject({ text: 'chào shop', origin: 'customer' })

    const all = await list('scope=all')
    expect(all.items.map((c) => c.id)).toEqual([x, y]) // X hoạt động gần nhất (trang B 10 phút trước); Z ở trang đã gỡ
    expect(all.items[0]).toMatchObject({ handledBy: 'ai', latest: { id: xb } })
    expect(all.items[1]).toMatchObject({ pageIds: [b], stage: 'new', tags: [], aiSummary: null, aiSummaryStatus: 'idle' })

    expect((await api('GET', `/contacts/${z}`)).statusCode).toBe(404)
    const d = await detail(x)
    expect(d.pageIds).toEqual([a, b])
    expect(d.conversations.map((c) => c.id)).toEqual([xb, xa])
    expect((await api('GET', '/contacts?scope=page:01900000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await api('GET', '/contacts?scope=bad')).statusCode).toBe(400)
  })

  it('lọc thẻ (không phân biệt hoa thường) / giai đoạn / chữ; cursor đi hết không trùng; facets', async () => {
    const a = await page('Trang A')
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) ids.push(await contactOf(await dm(a, `U${i}`, `tin ${i}`, ago((10 - i) * MIN))))
    const [c0, c1, c2, c3] = ids as [string, string, string, string]
    expect((await patch(c0, { tags: ['Khiếu nại', 'VIP'], stage: 'complaint', name: 'Nguyễn Thu Hà', phone: '0912 345 678' })).statusCode).toBe(200)
    expect((await patch(c1, { tags: ['vip'], stage: 'loyal' })).statusCode).toBe(200)
    expect((await patch(c2, { stage: 'complaint', name: 'Trần Long' })).statusCode).toBe(200)

    expect((await list('tag=khi%E1%BA%BFu%20n%E1%BA%A1i')).items.map((c) => c.id)).toEqual([c0])
    expect((await list('tag=VIP')).items.map((c) => c.id).sort()).toEqual([c0, c1].sort())
    expect((await list('stage=complaint')).items.map((c) => c.id)).toEqual([c2, c0])
    expect((await list('stage=complaint&tag=vip')).items.map((c) => c.id)).toEqual([c0])
    expect((await list('q=thu%20h')).items.map((c) => c.id)).toEqual([c0])
    expect((await list('q=345678')).items.map((c) => c.id)).toEqual([c0])
    expect((await list('q=100%25')).items).toEqual([])
    expect((await api('GET', '/contacts?stage=vip')).statusCode).toBe(400)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const pageRes: ListContactsResponse = await list(`limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...pageRes.items.map((c) => c.id))
      cursor = pageRes.nextCursor
    } while (cursor)
    expect(seen).toEqual([c3, c2, c1, c0])

    const facets = ContactFacetsResponse.parse((await api('GET', `/contacts/facets?scope=page:${a}`)).json())
    expect(facets).toEqual({ total: 4, stages: { new: 1, consulting: 0, ordered: 0, loyal: 1, complaint: 2 }, tags: ['Khiếu nại', 'VIP'] })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Sửa hồ sơ
// ---------------------------------------------------------------------------------------------------------

describe('PATCH /api/v1/contacts/:id', () => {
  it('gắn thẻ "Đổi trả", giai đoạn "Khách quen", ghi chú, SĐT → lưu, chuẩn hoá thẻ, contact.updated; Hộp thư thấy giai đoạn', async () => {
    const a = await page('Trang A')
    const conv = await dm(a, 'K1', 'nồi lỗi', ago(MIN))
    const id = await contactOf(conv)
    const res = await patch(id, { tags: ['Đổi trả', ' đổi trả ', 'VIP'], stage: 'loyal', note: '  Mua nồi 5L  ', phone: ' 0912 345 678 ' })
    expect(res.statusCode).toBe(200)
    expect(ContactDetailDto.parse(res.json())).toMatchObject({ tags: ['Đổi trả', 'VIP'], stage: 'loyal', note: 'Mua nồi 5L', phone: '0912 345 678' })
    expect(emittedOf('contact.updated')).toEqual([{ id }])
    const convDto = (await api('GET', `/conversations/${conv}`)).json<{ contact: { stage: string } }>()
    expect(convDto.contact.stage).toBe('loyal')

    expect(ContactDetailDto.parse((await patch(id, { phone: '', note: null, name: '  Chị Hà ' })).json())).toMatchObject({ phone: null, note: null, name: 'Chị Hà', tags: ['Đổi trả', 'VIP'] })
  })

  it('stage lạ / SĐT có chữ / body rỗng / thẻ quá dài → 400; không có → 404; không phiên → 401', async () => {
    const a = await page('Trang A')
    const id = await contactOf(await dm(a, 'K2', 'x', ago(MIN)))
    for (const body of [{ stage: 'vip' }, { phone: '09abc' }, {}, { tags: ['x'.repeat(41)] }]) {
      const res = await patch(id, body)
      expect(res.statusCode).toBe(400)
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED')
    }
    expect((await patch('01900000-0000-7000-8000-000000000000', { stage: 'new' })).statusCode).toBe(404)
    expect((await api('PATCH', `/contacts/${id}`, { stage: 'new' }, { auth: false })).statusCode).toBe(401)
    expect((await api('GET', '/contacts', undefined, { auth: false })).statusCode).toBe(401)
    expect(emittedOf('contact.updated')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Lịch sử nhiều trang
// ---------------------------------------------------------------------------------------------------------

describe('GET /api/v1/contacts/:id/messages', () => {
  it('tin của mọi hội thoại kèm trang + kênh, không có tin system; cursor lùi đi hết', async () => {
    const a = await page('Trang A')
    const b = await page('Trang B', 'instagram')
    const da = await dm(a, 'H_A', 'tin 1 trang A', ago(50 * MIN))
    const id = await contactOf(da)
    await dm(a, 'H_A', 'tin 2 trang A', ago(40 * MIN))
    await applyUserAction({ db: handle.db, events: realEvents }, da, 'takeover') // ghi tin system
    const cb = await comment(b, 'CB1', 'H_B', 'bình luận trang B', ago(30 * MIN))
    await attach(cb, id)

    const res = await api('GET', `/contacts/${id}/messages`)
    expect(res.statusCode).toBe(200)
    const all = ListContactHistoryResponse.parse(res.json())
    expect(all.items.map((m) => [m.text, m.pageId, m.channel])).toEqual([
      ['tin 1 trang A', a, 'dm'],
      ['tin 2 trang A', a, 'dm'],
      ['bình luận trang B', b, 'comment'],
    ])
    expect(all.items.every((m) => m.origin !== 'system')).toBe(true)
    expect(all.items[2]!.sender?.contactId).toBe(id)

    const first = ListContactHistoryResponse.parse((await api('GET', `/contacts/${id}/messages?limit=2`)).json())
    expect(first.items.map((m) => m.text)).toEqual(['tin 2 trang A', 'bình luận trang B'])
    const rest = ListContactHistoryResponse.parse((await api('GET', `/contacts/${id}/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)).json())
    expect(rest).toMatchObject({ items: [{ text: 'tin 1 trang A' }], nextCursor: null })
    expect((await api('GET', '/contacts/01900000-0000-7000-8000-000000000000/messages')).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Gộp khách + gợi ý gộp
// ---------------------------------------------------------------------------------------------------------

describe('POST /api/v1/contacts/:id/merge', () => {
  it('chuyển định danh, hội thoại, thẻ sang khách giữ lại; nguồn biến mất; sự kiện', async () => {
    const a = await page('Trang A')
    const b = await page('Trang B')
    const tConv = await dm(a, 'T_A', 'đích', ago(20 * MIN))
    const sConv = await dm(b, 'S_B', 'nguồn', ago(10 * MIN))
    const t = await contactOf(tConv)
    const s = await contactOf(sConv)
    await patch(t, { tags: ['VIP'], note: 'ghi chú đích' })
    await patch(s, { tags: ['vip', 'Đổi trả'], stage: 'complaint', phone: '0987 222 111', note: 'ghi chú nguồn', name: 'Trần Bảo Long' })
    emitted.length = 0

    const res = await api('POST', `/contacts/${t}/merge`, { sourceId: s })
    expect(res.statusCode).toBe(200)
    const merged = ContactDetailDto.parse(res.json())
    expect(merged).toMatchObject({
      id: t,
      name: 'Trần Bảo Long',
      tags: ['VIP', 'Đổi trả'],
      stage: 'complaint',
      phone: '0987 222 111',
      note: 'ghi chú đích\n\nghi chú nguồn',
      pageIds: [a, b],
    })
    expect(merged.conversations.map((c) => c.id)).toEqual([sConv, tConv])
    expect(await contactOf(sConv)).toBe(t)
    expect((await api('GET', `/contacts/${s}`)).statusCode).toBe(404)
    expect((await api('GET', `/conversations/${sConv}`)).json<{ contact: { id: string; pageIds: string[] } }>().contact).toMatchObject({ id: t, pageIds: [a, b] })
    expect(emittedOf('contact.merged')).toEqual([{ id: s, intoId: t }])
    expect(emittedOf('contact.updated')).toEqual([{ id: t }])
  })

  it('gộp với chính nó → 400; nguồn / đích không có → 404', async () => {
    const a = await page('Trang A')
    const t = await contactOf(await dm(a, 'T1', 'x', ago(MIN)))
    expect((await api('POST', `/contacts/${t}/merge`, { sourceId: t })).statusCode).toBe(400)
    expect((await api('POST', `/contacts/${t}/merge`, { sourceId: '01900000-0000-7000-8000-000000000000' })).statusCode).toBe(404)
    expect((await api('POST', `/contacts/01900000-0000-7000-8000-000000000000/merge`, { sourceId: t })).statusCode).toBe(404)
    expect((await api('POST', `/contacts/${t}/merge`, {})).statusCode).toBe(400)
  })

  it('gợi ý gộp hiện ở cả hai khách; gộp xong mất; gợi ý với khách thứ ba chuyển sang khách giữ lại', async () => {
    const a = await page('Trang A')
    const p = await contactOf(await dm(a, 'P', 'x', ago(3 * MIN)))
    const q = await contactOf(await dm(a, 'Q', 'y', ago(2 * MIN)))
    const r = await contactOf(await dm(a, 'R', 'z', ago(MIN)))
    expect(await suggestMerge(handle.db, p, q, 'private_reply')).toBe(true)
    expect(await suggestMerge(handle.db, q, p, 'private_reply')).toBe(false) // chiều ngược đã có
    expect(await suggestMerge(handle.db, q, r, 'private_reply')).toBe(true)
    expect((await detail(p)).mergeSuggestions).toEqual([{ contactId: q, name: null, reason: 'private_reply' }])
    expect((await detail(q)).mergeSuggestions.map((s) => s.contactId)).toEqual([p, r])

    expect((await api('POST', `/contacts/${p}/merge`, { sourceId: q })).statusCode).toBe(200)
    expect((await detail(p)).mergeSuggestions.map((s) => s.contactId)).toEqual([r])
    expect((await detail(r)).mergeSuggestions.map((s) => s.contactId)).toEqual([p])
  })

  it('gợi ý chuyển sang đích đã có theo chiều ngược → không nhân đôi', async () => {
    const a = await page('Trang A')
    const p = await contactOf(await dm(a, 'P2', 'x', ago(3 * MIN)))
    const q = await contactOf(await dm(a, 'Q2', 'y', ago(2 * MIN)))
    const r = await contactOf(await dm(a, 'R2', 'z', ago(MIN)))
    expect(await suggestMerge(handle.db, q, r, 'private_reply')).toBe(true)
    expect(await suggestMerge(handle.db, r, p, 'private_reply')).toBe(true)
    expect((await api('POST', `/contacts/${p}/merge`, { sourceId: q })).statusCode).toBe(200)
    expect((await detail(p)).mergeSuggestions.map((s) => s.contactId)).toEqual([r])
    expect((await detail(r)).mergeSuggestions.map((s) => s.contactId)).toEqual([p])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Hàng loạt
// ---------------------------------------------------------------------------------------------------------

describe('POST /api/v1/contacts/bulk', () => {
  it('gắn một thẻ (bỏ khách đã có) / đổi giai đoạn; sai thao tác → 400', async () => {
    const a = await page('Trang A')
    const x = await contactOf(await dm(a, 'B1', 'x', ago(2 * MIN)))
    const y = await contactOf(await dm(a, 'B2', 'y', ago(MIN)))
    await patch(x, { tags: ['đổi trả'] })
    const tagged = await api('POST', '/contacts/bulk', { ids: [x, y], addTag: 'Đổi trả' })
    expect(tagged.json()).toEqual({ updated: 1 })
    expect((await detail(x)).tags).toEqual(['đổi trả'])
    expect((await detail(y)).tags).toEqual(['Đổi trả'])
    expect((await api('POST', '/contacts/bulk', { ids: [x, y], stage: 'ordered' })).json()).toEqual({ updated: 2 })
    expect((await detail(y)).stage).toBe('ordered')
    expect((await api('POST', '/contacts/bulk', { ids: [x], stage: 'ordered', addTag: 'x' })).statusCode).toBe(400)
    expect((await api('POST', '/contacts/bulk', { ids: [x] })).statusCode).toBe(400)
    expect((await api('POST', '/contacts/bulk', { ids: [], stage: 'new' })).statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Tóm tắt bằng AI
// ---------------------------------------------------------------------------------------------------------

describe('Tóm tắt bằng AI (job contact_summary)', () => {
  const run = (id: string, finalAttempt = false) => summarizeContact({ db: handle.db, events, cipher, openai: fake, log }, id, { finalAttempt })

  it('202 pending + job; bấm lại khi đang chờ không thêm job; job ghi aiSummary + ai_usage (contact_summary)', async () => {
    const a = await page('Mỹ phẩm Lan Anh')
    const b = await page('Đồ gia dụng Minh', 'instagram')
    const ca = await dm(a, 'S_A', 'Serum vitamin C\ngiá bao nhiêu?', ago(30 * MIN))
    const id = await contactOf(ca)
    await attach(await dm(b, 'S_B', 'Nồi chiên 5L còn không?', ago(10 * MIN)), id)
    await patch(id, { phone: '0912 345 678' })

    const res = await api('POST', `/contacts/${id}/summarize`)
    expect(res.statusCode).toBe(202)
    expect(ContactDetailDto.parse(res.json())).toMatchObject({ aiSummaryStatus: 'pending', aiSummary: null })
    expect(await summaryJobs()).toBe(1)
    expect((await api('POST', `/contacts/${id}/summarize`)).statusCode).toBe(202)
    expect(await summaryJobs()).toBe(1)

    fake.onResponse({ ok: true, id: 'r', text: '  Khách quan tâm serum và nồi chiên.  ', usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })
    expect(await run(id)).toBe('updated')
    const input = String(fake.responseRequests.at(-1)!.input)
    expect(input).toContain('[Mỹ phẩm Lan Anh · tin nhắn Facebook] Khách: Serum vitamin C giá bao nhiêu?')
    expect(input).toContain('[Đồ gia dụng Minh · tin nhắn Instagram] Khách: Nồi chiên 5L còn không?')
    expect(input).not.toContain('0912')
    const d = await detail(id)
    expect(d).toMatchObject({ aiSummary: { text: 'Khách quan tâm serum và nồi chiên.' }, aiSummaryStatus: 'idle', aiSummaryError: null })
    const [usage] = await handle.sql<{ feature: string; page_id: string; ref: string }[]>`select feature, page_id, ref from ai_usage`
    expect(usage).toEqual({ feature: 'contact_summary', page_id: b, ref: id })
    expect(await run(id)).toBe('skipped') // không còn yêu cầu chờ
  })

  it('khách chưa có tin có chữ → 422; khoá thiếu → failed OPENAI_KEY_MISSING; lỗi tạm → retry, lần cuối ghi mã', async () => {
    const a = await page('Trang A')
    const empty = await contactOf(await dm(a, 'E1', null, ago(MIN), [{ kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' }]))
    const res = await api('POST', `/contacts/${empty}/summarize`)
    expect(res.statusCode).toBe(422)
    expect(await summaryJobs()).toBe(0)

    const id = await contactOf(await dm(a, 'E2', 'cho hỏi giá', ago(MIN)))
    fake.onResponse({ ok: false, kind: 'TRANSIENT', status: 503 })
    expect((await api('POST', `/contacts/${id}/summarize`)).statusCode).toBe(202)
    await expect(run(id)).rejects.toBeInstanceOf(ContactSummaryRetryableError)
    expect(await run(id, true)).toBe('failed')
    expect(await detail(id)).toMatchObject({ aiSummaryStatus: 'failed', aiSummaryError: 'AI_PROVIDER_ERROR' })

    await handle.sql`delete from secrets where name = 'openai_api_key'`
    expect((await api('POST', `/contacts/${id}/summarize`)).statusCode).toBe(202) // lỗi trước → được yêu cầu lại
    expect(await summaryJobs()).toBe(2)
    expect(await run(id)).toBe('failed')
    expect(await detail(id)).toMatchObject({ aiSummaryStatus: 'failed', aiSummaryError: 'OPENAI_KEY_MISSING', aiSummary: null })
    // Mỗi lần yêu cầu và mỗi lần ghi lỗi đều phát `contact.updated` (lần ném để retry thì không).
    expect(emittedOf('contact.updated').filter((e) => e.id === id)).toHaveLength(4)
  })

  it('job quá hạn (signal huỷ) → ném lại, không ghi lỗi, không gọi OpenAI', async () => {
    const a = await page('Trang A')
    const id = await contactOf(await dm(a, 'AB1', 'cho hỏi giá', ago(MIN)))
    expect((await api('POST', `/contacts/${id}/summarize`)).statusCode).toBe(202)
    const before = fake.responseRequests.length
    const ac = new AbortController()
    ac.abort(new Error('job expired'))
    await expect(summarizeContact({ db: handle.db, events, cipher, openai: fake, log }, id, { finalAttempt: true, signal: ac.signal })).rejects.toThrow('job expired')
    expect(fake.responseRequests.length).toBe(before)
    expect(await detail(id)).toMatchObject({ aiSummaryStatus: 'pending', aiSummaryError: null })
  })

  it('aiSummaryStatusOf: chờ quá 10 phút (job mất) → failed không mã; xong → idle', () => {
    const now = new Date('2026-10-24T10:00:00Z')
    const at = (m: number) => new Date(now.getTime() - m * MIN)
    expect(aiSummaryStatusOf({ aiSummaryRequestedAt: at(5), aiSummaryAt: null, aiSummaryError: null }, now)).toEqual({ status: 'pending', error: null })
    expect(aiSummaryStatusOf({ aiSummaryRequestedAt: at(11), aiSummaryAt: null, aiSummaryError: null }, now)).toEqual({ status: 'failed', error: null })
    expect(aiSummaryStatusOf({ aiSummaryRequestedAt: at(5), aiSummaryAt: at(1), aiSummaryError: null }, now)).toEqual({ status: 'idle', error: null })
    expect(aiSummaryStatusOf({ aiSummaryRequestedAt: null, aiSummaryAt: null, aiSummaryError: null }, now)).toEqual({ status: 'idle', error: null })
  })
})

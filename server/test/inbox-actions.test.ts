// Story 4.6 — tab Hộp thư, Tiếp quản và Đánh dấu xong (AD-9, AD-18): lọc + đếm theo tab ở server (`needs_human` =
// `handoff` hoặc `human` mà tin không phải `system` mới nhất là của khách, chờ lâu nhất trước), phân trang theo mốc
// chờ, phạm vi của số đếm; lệnh Tiếp quản / bật lại AI / Đánh dấu xong (khoá luồng, `state_version`, tin `system`,
// `conversation.state_changed`, huỷ tin AI `pending`), xung đột / không đổi / 404 / phiên / Origin; đua với triage và
// cổng AI của hội thoại `ai` trước Epic 5.
import { ConversationCountResponse, ConversationDto, ListConversationsResponse, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { handleTriageEvent } from '../src/modules/autoreply/index.ts'
import { applyTriageDecision, applyUserAction, getTriageState, ingestDm } from '../src/modules/inbox/index.ts'
import { setRemoved, upsertFromPlatform } from '../src/modules/pages/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1000)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance
let cookie: string

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const stateChanges = () => emitted.filter((e) => e.name === 'conversation.state_changed').map((e) => e.payload)

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-inbox-actions', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, events })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  emitted.length = 0
  const { token } = await createSession(handle.db)
  cookie = `${SESSION_COOKIE}=${token}`
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function page(accountId: string): Promise<string> {
  const { page: p } = await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: accountId, name: `Trang ${accountId}`, handle: null, avatarUrl: null })
  return p.id
}

let seq = 0
/** Một tin khách qua `inbox.ingestDm`; trả id hội thoại. */
async function customer(pageId: string, sender: string, ts: Date): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events, jobs },
    { pageId, message: { kind: 'dm', senderId: sender, recipientId: 'PAGE', mid: `mid_${seq}`, timestamp: ts, text: `tin ${seq}`, attachments: [] } },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  return res.conversationId
}

/** Chạy consumer `autoreply.triage` cho hội thoại như worker. */
const triage = (conversationId: string, pageId: string) =>
  handleTriageEvent({ db: handle.db, events }, { event: 'message.received', payload: { id: conversationId, pageId, conversationId } } as EventEnvelope)

/** Hội thoại ở trạng thái `state` với tin khách lúc `ts` (đi qua triage `human` rồi đặt thẳng trạng thái cần thử). */
async function conversationIn(pageId: string, sender: string, state: 'triage' | 'ai' | 'handoff' | 'human' | 'done', ts: Date): Promise<string> {
  const id = await customer(pageId, sender, ts)
  if (state === 'triage') return id
  await triage(id, pageId)
  if (state !== 'human') {
    await handle.sql`update conversations set state = ${state}, waiting_since = ${state === 'handoff' ? ts.toISOString() : null}::timestamptz where id = ${id}`
  }
  return id
}

/** Tin outbound giả (Story 4.7 chưa có đường gửi). */
async function outbound(conversationId: string, pageId: string, origin: 'app_human' | 'app_ai', status: 'pending' | 'sent', ts: Date) {
  await handle.sql`insert into messages (conversation_id, page_id, direction, origin, status, text, platform_timestamp)
    values (${conversationId}, ${pageId}, 'outbound', ${origin}, ${status}, 'trả lời', ${ts.toISOString()}::timestamptz)`
}

const row = async (id: string) =>
  (
    await handle.sql<{ state: string; state_version: number; state_reason: string | null; ai_enabled: boolean; waiting_since: number | null }[]>`
      select state, state_version, state_reason, ai_enabled, (extract(epoch from waiting_since) * 1000)::float8 as waiting_since
      from conversations where id = ${id}`
  )[0]!
const originsOf = async (id: string) =>
  (await handle.sql<{ origin: string; status: string | null; reason_code: string | null }[]>`
    select origin, status, reason_code from messages where conversation_id = ${id} order by platform_timestamp, id`)

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
const post = (url: string, headers: Record<string, string> = { cookie, origin: ORIGIN }) => app.inject({ method: 'POST', url, headers })
const list = async (qs: string) => ListConversationsResponse.parse((await get(`/api/v1/conversations?${qs}`)).json())
const countOf = async (qs: string) => ConversationCountResponse.parse((await get(`/api/v1/conversations/count?${qs}`)).json()).count

// ---------------------------------------------------------------------------------------------------------
// Tab + đếm
// ---------------------------------------------------------------------------------------------------------

describe('tab và badge ở server', () => {
  it('needs_human: handoff + human có tin khách cuối, chờ lâu nhất trước; triage chỉ ở Tất cả; count khớp', async () => {
    const p = await page('FB_TAB')
    const handoff = await conversationIn(p, 'U_HANDOFF', 'handoff', at(30))
    const humanWaiting = await conversationIn(p, 'U_HUMAN', 'human', at(10))
    const humanReplied = await conversationIn(p, 'U_REPLIED', 'human', at(5))
    await outbound(humanReplied, p, 'app_human', 'sent', at(6))
    const triageConv = await conversationIn(p, 'U_TRIAGE', 'triage', at(40))
    const ai = await conversationIn(p, 'U_AI', 'ai', at(50))
    const done = await conversationIn(p, 'U_DONE', 'done', at(60))

    const needs = await list('tab=needs_human')
    // Chờ lâu nhất trước: human chờ từ 10s, handoff từ 30s.
    expect(needs.items.map((c) => c.id)).toEqual([humanWaiting, handoff])
    expect(needs.items.every((c) => c.needsAttention)).toBe(true)
    expect(await countOf('tab=needs_human')).toBe(2)

    const all = await list('tab=all')
    expect(new Set(all.items.map((c) => c.id))).toEqual(new Set([handoff, humanWaiting, humanReplied, triageConv, ai, done]))
    expect((await list('')).items).toHaveLength(6)
    expect(await countOf('tab=all')).toBe(6)
    expect((await list('tab=ai')).items.map((c) => c.id)).toEqual([ai])
    expect((await list('tab=done')).items.map((c) => c.id)).toEqual([done])
    expect(await countOf('tab=done')).toBe(1)
    expect((await get('/api/v1/conversations?tab=sai')).statusCode).toBe(400)
    expect((await get('/api/v1/conversations/count?tab=sai')).statusCode).toBe(400)
  })

  it('human mà tin không phải system mới nhất là của người → ra khỏi Cần xử lý; tin system không tính', async () => {
    const p = await page('FB_SYS')
    const id = await conversationIn(p, 'U', 'human', at(1))
    // Tin system (AI_OFF) đứng sau tin khách nhưng không tính → vẫn cần xử lý.
    expect((await originsOf(id)).map((m) => m.origin)).toEqual(['customer', 'system'])
    expect(await countOf('tab=needs_human')).toBe(1)
    await outbound(id, p, 'app_human', 'sent', at(2))
    expect(await countOf('tab=needs_human')).toBe(0)
    await customer(p, 'U', at(3))
    expect(await countOf('tab=needs_human')).toBe(1)
  })

  it('phân trang needs_human theo mốc chờ: không trùng, không sót, đúng thứ tự; cursor hỏng → 400', async () => {
    const p = await page('FB_PAGE')
    const ids: string[] = []
    // Thêm theo thứ tự ngược để thứ tự tạo khác thứ tự chờ.
    for (let i = 5; i >= 1; i--) ids.unshift(await conversationIn(p, `U${i}`, i % 2 ? 'human' : 'handoff', at(i * 10)))
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const res: ListConversationsResponse = await list(`tab=needs_human&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...res.items.map((c) => c.id))
      cursor = res.nextCursor
    } while (cursor)
    expect(seen).toEqual(ids)
    expect((await get('/api/v1/conversations?tab=needs_human&cursor=hong')).statusCode).toBe(400)
  })

  it('count theo phạm vi; trang đã gỡ không tính', async () => {
    const a = await page('FB_SA')
    const b = await page('FB_SB')
    await conversationIn(a, 'U1', 'human', at(1))
    await conversationIn(b, 'U2', 'human', at(2))
    expect(await countOf('tab=needs_human')).toBe(2)
    expect(await countOf(`tab=needs_human&scope=page:${a}`)).toBe(1)
    await handle.db.transaction((tx) => setRemoved(tx, events, b))
    expect(await countOf('tab=needs_human')).toBe(1)
    expect((await get('/api/v1/conversations/count?scope=sai')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/v1/conversations/count' })).statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Lệnh
// ---------------------------------------------------------------------------------------------------------

describe('Tiếp quản', () => {
  it.each(['ai', 'handoff'] as const)('%s → human, tắt AI, version+1, tin system TAKEOVER, state_changed; huỷ tin AI pending', async (from) => {
    const p = await page(`FB_TK_${from}`)
    const id = await conversationIn(p, 'U', from, at(10))
    await outbound(id, p, 'app_ai', 'sent', at(11))
    await outbound(id, p, 'app_ai', 'pending', at(12))
    await customer(p, 'U', at(13))
    const before = await row(id)
    emitted.length = 0

    const res = await post(`/api/v1/conversations/${id}/takeover`)
    expect(res.statusCode).toBe(200)
    const dto = ConversationDto.parse(res.json())
    expect(dto).toMatchObject({ id, state: 'human', aiEnabled: false, stateReason: 'TAKEOVER', needsAttention: true })

    const after = await row(id)
    expect(after).toMatchObject({ state: 'human', state_version: before.state_version + 1, state_reason: 'TAKEOVER', ai_enabled: false })
    // Tin khách cuối chưa ai trả lời → vẫn chờ (handoff giữ mốc cũ; ai lấy tin khách cuối).
    expect(after.waiting_since).toBe(from === 'handoff' ? at(10).getTime() : at(13).getTime())
    const msgs = await originsOf(id)
    expect(msgs.filter((m) => m.origin === 'app_ai')).toEqual([{ origin: 'app_ai', status: 'sent', reason_code: null }])
    expect(msgs.at(-1)).toMatchObject({ origin: 'system', reason_code: 'TAKEOVER' })
    expect(stateChanges()).toEqual([{ id, pageId: p, from, to: 'human', reasonCode: 'TAKEOVER', version: before.state_version + 1 }])
  })

  it('tin không phải system cuối là của AI/người → tiếp quản không đặt mốc chờ', async () => {
    const p = await page('FB_TK_NOWAIT')
    const id = await conversationIn(p, 'U', 'ai', at(10))
    await outbound(id, p, 'app_ai', 'sent', at(11))
    await post(`/api/v1/conversations/${id}/takeover`)
    expect(await row(id)).toMatchObject({ state: 'human', waiting_since: null })
    expect(await countOf('tab=needs_human')).toBe(0)
  })

  it('đã human → 200 không đổi; done → 409 VERSION_CONFLICT; không ghi gì', async () => {
    const p = await page('FB_TK_X')
    const human = await conversationIn(p, 'U1', 'human', at(1))
    const done = await conversationIn(p, 'U2', 'done', at(2))
    emitted.length = 0
    const v = (await row(human)).state_version
    const ok = await post(`/api/v1/conversations/${human}/takeover`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ state: 'human', aiEnabled: true })
    expect((await row(human)).state_version).toBe(v)
    const conflict = await post(`/api/v1/conversations/${done}/takeover`)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
    expect(stateChanges()).toEqual([])
  })

  it('đua triage: tiếp quản lúc triage → human TAKEOVER; quyết định triage tới sau → stale', async () => {
    const p = await page('FB_RACE')
    const id = await customer(p, 'U', at(1))
    const pending = await getTriageState(handle.db, id)
    expect(pending).toMatchObject({ state: 'triage' })
    expect(await applyUserAction({ db: handle.db, events }, id, 'takeover')).toEqual({ status: 'applied', version: pending!.stateVersion + 1 })
    expect(await applyTriageDecision({ db: handle.db, events }, id, pending!.stateVersion, { to: 'human', reasonCode: 'AI_OFF' })).toEqual({
      applied: false,
      reason: 'stale',
    })
    expect(await triage(id, p)).toBe('skipped')
    expect(await row(id)).toMatchObject({ state: 'human', state_reason: 'TAKEOVER', ai_enabled: false })
    expect((await originsOf(id)).map((m) => m.reason_code).filter(Boolean)).toEqual(['TAKEOVER'])
  })
})

describe('Bật lại AI', () => {
  it.each(['human', 'handoff'] as const)('%s → ai, ai_enabled, AI_REENABLED, xoá mốc chờ; ra khỏi Cần xử lý', async (from) => {
    const p = await page(`FB_AI_${from}`)
    const id = await conversationIn(p, 'U', from, at(1))
    await handle.sql`update conversations set ai_enabled = false where id = ${id}`
    emitted.length = 0
    const res = await post(`/api/v1/conversations/${id}/enable-ai`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'ai', aiEnabled: true, stateReason: 'AI_REENABLED', waitingSince: null, needsAttention: false })
    expect(await row(id)).toMatchObject({ state: 'ai', ai_enabled: true, waiting_since: null })
    expect(stateChanges()).toMatchObject([{ from, to: 'ai', reasonCode: 'AI_REENABLED' }])
    expect(await countOf('tab=needs_human')).toBe(0)
    expect((await list('tab=ai')).items.map((c) => c.id)).toEqual([id])
  })

  it('ai + tin khách mới trước Epic 5 → cổng đóng → human AI_OFF, quay lại Cần xử lý', async () => {
    const p = await page('FB_AI_GATE')
    const id = await conversationIn(p, 'U', 'human', at(1))
    await post(`/api/v1/conversations/${id}/enable-ai`)
    await customer(p, 'U', at(5))
    expect(await triage(id, p)).toBe('applied')
    expect(await row(id)).toMatchObject({ state: 'human', state_reason: 'AI_OFF', ai_enabled: true, waiting_since: at(5).getTime() })
    expect(await countOf('tab=needs_human')).toBe(1)
    // Cổng mở (Epic 5) với hội thoại đã `ai` → không ghi gì.
    await handle.sql`update conversations set state = 'ai' where id = ${id}`
    const s = await getTriageState(handle.db, id)
    expect(await applyTriageDecision({ db: handle.db, events }, id, s!.stateVersion, { to: 'ai', reasonCode: 'GATE_OPEN' })).toEqual({ applied: false, reason: 'noop' })
  })

  it.each(['triage', 'done'] as const)('%s → 409; đã ai → 200 không đổi', async (from) => {
    const p = await page(`FB_AIX_${from}`)
    const id = await conversationIn(p, 'U', from, at(1))
    expect((await post(`/api/v1/conversations/${id}/enable-ai`)).statusCode).toBe(409)
    const ai = await conversationIn(p, 'U2', 'ai', at(2))
    const v = (await row(ai)).state_version
    expect((await post(`/api/v1/conversations/${ai}/enable-ai`)).statusCode).toBe(200)
    expect((await row(ai)).state_version).toBe(v)
  })
})

describe('Đánh dấu xong', () => {
  it.each(['triage', 'ai', 'handoff', 'human'] as const)('%s → done, ai_enabled, xoá mốc chờ, MARKED_DONE', async (from) => {
    const p = await page(`FB_DONE_${from}`)
    const id = await conversationIn(p, 'U', from, at(1))
    await handle.sql`update conversations set ai_enabled = false where id = ${id}`
    emitted.length = 0
    const res = await post(`/api/v1/conversations/${id}/done`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'done', aiEnabled: true, waitingSince: null, stateReason: 'MARKED_DONE', needsAttention: false })
    expect(await row(id)).toMatchObject({ state: 'done', ai_enabled: true, waiting_since: null, state_reason: 'MARKED_DONE' })
    expect((await originsOf(id)).at(-1)).toMatchObject({ origin: 'system', reason_code: 'MARKED_DONE' })
    expect(stateChanges()).toMatchObject([{ from, to: 'done', reasonCode: 'MARKED_DONE' }])
    expect((await list('tab=done')).items.map((c) => c.id)).toEqual([id])
  })

  it('đã done → 200 không đổi; khách nhắn lại → triage → human AI_OFF (Cần xử lý)', async () => {
    const p = await page('FB_DONE_AGAIN')
    const id = await conversationIn(p, 'U', 'human', at(1))
    await post(`/api/v1/conversations/${id}/done`)
    const v = (await row(id)).state_version
    expect((await post(`/api/v1/conversations/${id}/done`)).statusCode).toBe(200)
    expect((await row(id)).state_version).toBe(v)
    await customer(p, 'U', at(9))
    expect(await row(id)).toMatchObject({ state: 'triage' })
    expect(await triage(id, p)).toBe('applied')
    expect(await row(id)).toMatchObject({ state: 'human', state_reason: 'AI_OFF', waiting_since: at(9).getTime() })
    expect(await countOf('tab=needs_human')).toBe(1)
  })
})

describe('lệnh: lỗi chung', () => {
  it('không có / trang đã gỡ → 404; id sai → 400; không phiên → 401; sai Origin → 403', async () => {
    const p = await page('FB_ERR')
    const id = await conversationIn(p, 'U', 'ai', at(1))
    expect((await post('/api/v1/conversations/019a0000-0000-7000-8000-000000000000/takeover')).statusCode).toBe(404)
    expect((await post('/api/v1/conversations/khong-phai-uuid/done')).statusCode).toBe(400)
    expect((await post(`/api/v1/conversations/${id}/takeover`, { origin: ORIGIN })).statusCode).toBe(401)
    expect((await post(`/api/v1/conversations/${id}/takeover`, { cookie, origin: 'https://evil.example' })).statusCode).toBe(403)
    await handle.db.transaction((tx) => setRemoved(tx, events, p))
    expect((await post(`/api/v1/conversations/${id}/takeover`)).statusCode).toBe(404)
    expect(await row(id)).toMatchObject({ state: 'ai' })
  })
})

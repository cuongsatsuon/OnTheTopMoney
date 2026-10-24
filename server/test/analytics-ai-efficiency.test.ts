// Ma trận Story 8.3 — "Hiệu quả AI" + KPI "Tin nhắn" của `GET /performance` (AD-17, AD-9, AD-1). Qua app thật (buildApp) +
// Postgres nhúng; hội thoại / tin / tin `system` chèn thẳng vào bảng của `inbox` (như luồng AI trả lời để lại), số liệu bài
// vào `post_metrics`. Phủ: AI trả lời (gộp tin, thời gian phản hồi), chủ shop trả lời, tin không tính, AI chuyển người và
// trường hợp không phải, mẫu thời gian bị loại, bài AI vs tự viết, KPI "Tin nhắn" + kỳ trước, phạm vi rỗng.
import { PerformanceResponse, type AiEfficiencyDto } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const DAY = 24 * 60 * 60_000
const SEC = 1000
/** "Bây giờ": 10:00 giờ VN 24/10/2026 → kỳ 30 ngày = 24/09 – 23/10 (00:00 VN 24/09 = 23/09 17:00Z). */
const NOW = new Date('2026-10-24T03:00:00.000Z')
/** Một lúc giữa kỳ. */
const T = Date.parse('2026-10-10T05:00:00.000Z')

let handle: DbHandle
let app: FastifyInstance
let cookie: string
let seq = 0

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, clock: () => NOW })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from post_metrics`
  await handle.sql`delete from posts`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from groups`
  await handle.sql`delete from sessions`
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

/* ---------- Helper ---------- */

async function page(opts: { connectedDaysAgo?: number; removed?: boolean; groupId?: string } = {}): Promise<string> {
  const accountId = String(9000 + ++seq)
  const connectedAt = new Date(NOW.getTime() - (opts.connectedDaysAgo ?? 120) * DAY).toISOString()
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, group_id, connected_at, removed_at)
    values ('facebook', ${accountId}, ${'Trang ' + accountId}, 'active', ${opts.groupId ?? null}, ${connectedAt}::timestamptz,
      ${opts.removed ? NOW.toISOString() : null}::timestamptz)
    returning id`
  return p!.id
}

async function conversation(pageId: string): Promise<string> {
  const key = `psid_${++seq}`
  const [c] = await handle.sql<{ id: string }[]>`insert into contacts (name) values ('Khách') returning id`
  const [ident] = await handle.sql<{ id: string }[]>`
    insert into contact_identities (contact_id, page_id, platform_user_id) values (${c!.id}, ${pageId}, ${key}) returning id`
  const [conv] = await handle.sql<{ id: string }[]>`
    insert into conversations (page_id, channel, thread_key, contact_identity_id, state, last_message_at)
    values (${pageId}, 'dm', ${key}, ${ident!.id}, 'ai', ${NOW.toISOString()}::timestamptz) returning id`
  return conv!.id
}

type Origin = 'customer' | 'app_ai' | 'app_human' | 'external_human' | 'system'

/** Một tin lúc `at` (ms). Outbound mặc định `sent`, `sent_at` = `at + sentAfter`; `created_at` = `at` (mốc vào hệ thống). */
async function msg(
  pageId: string,
  conversationId: string,
  at: number,
  origin: Origin,
  opts: { status?: string; reason?: string; sentAfter?: number; removed?: boolean } = {},
): Promise<void> {
  const direction = origin === 'customer' ? 'inbound' : origin === 'system' ? null : 'outbound'
  const status = direction === 'outbound' ? (opts.status ?? 'sent') : null
  const sentAt = status && ['sent', 'delivered', 'read'].includes(status) ? new Date(at + (opts.sentAfter ?? 0)).toISOString() : null
  const iso = new Date(at).toISOString()
  await handle.sql`
    insert into messages (conversation_id, page_id, direction, origin, status, delivery, error_code, text, reason_code, sent_at,
      removal, removed_at, platform_timestamp, created_at)
    values (${conversationId}, ${pageId}, ${direction}, ${origin}, ${status}, ${direction === 'outbound' ? 'dm' : null},
      ${status === 'failed' ? 'SEND_FAILED' : null}, ${origin === 'system' ? null : 'Nội dung'}, ${opts.reason ?? null}, ${sentAt}::timestamptz,
      ${opts.removed ? 'deleted' : null}, ${opts.removed ? iso : null}::timestamptz, ${iso}::timestamptz, ${iso}::timestamptz)`
}

async function target(pageId: string, opts: { ai?: boolean; publishedAt?: number } = {}): Promise<string> {
  const [post] = await handle.sql<{ id: string }[]>`insert into posts (source) values ('manual') returning id`
  const [t] = await handle.sql<{ id: string }[]>`
    insert into post_targets (post_id, page_id, position, status, caption, ai_caption, platform_post_id, published_at)
    values (${post!.id}, ${pageId}, 0, 'published', 'Bài viết', ${opts.ai ?? false}, ${'pp_' + ++seq},
      ${new Date(opts.publishedAt ?? NOW.getTime() - 3 * DAY).toISOString()}::timestamptz)
    returning id`
  return t!.id
}

async function snapshot(targetId: string, pageId: string, date: string, engagement: number | null): Promise<void> {
  await handle.sql`
    insert into post_metrics (post_target_id, page_id, metric_date, views, reach, engagement, fetched_at)
    values (${targetId}, ${pageId}, ${date}, null, null, ${engagement}, ${NOW.toISOString()}::timestamptz)`
}

async function perf(query: Record<string, string> = {}): Promise<PerformanceResponse> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/performance?${new URLSearchParams(query)}`, headers: { origin: ORIGIN, cookie } })
  expect(res.statusCode, res.body).toBe(200)
  return PerformanceResponse.parse(res.json())
}

const ai = async (query: Record<string, string> = {}): Promise<AiEfficiencyDto> => (await perf(query)).ai

/* ---------- Ma trận ---------- */

describe('GET /performance — Hiệu quả AI từ tin nhắn', () => {
  it('AI trả lời: 2 tin khách gộp, 1 tin AI gửi sau 5 giây', async () => {
    const p = await page()
    const c = await conversation(p)
    await msg(p, c, T, 'customer')
    await msg(p, c, T + 1 * SEC, 'customer')
    await msg(p, c, T + 1.5 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, c, T + 4 * SEC, 'app_ai', { sentAfter: 1 * SEC })

    const r = await perf()
    expect(r.ai).toMatchObject({
      customerMessages: 2,
      aiAnswered: 2,
      aiMessages: 1,
      aiConversations: 1,
      handoffConversations: 0,
      avgResponseSeconds: 5,
      responseSamples: 1,
    })
    expect(r.kpis.messages.current).toBe(2)
  })

  it('chủ shop trả lời / chưa ai trả lời: tính tin khách, không tính AI', async () => {
    const p = await page()
    const c = await conversation(p)
    await msg(p, c, T, 'customer')
    await msg(p, c, T + 60 * SEC, 'app_human')
    await msg(p, c, T + 3600 * SEC, 'customer')
    expect(await ai()).toMatchObject({ customerMessages: 2, aiAnswered: 0, aiMessages: 0, aiConversations: 0, avgResponseSeconds: null, responseSamples: 0 })
  })

  it('tin không tính: AI failed / pending, tin khách bị gỡ, ngoài kỳ, trang ngoài phạm vi / đã gỡ', async () => {
    const p = await page()
    const c = await conversation(p)
    await msg(p, c, T, 'customer')
    await msg(p, c, T + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, c, T + 3 * SEC, 'app_ai', { status: 'failed' })
    await msg(p, c, T + 10 * SEC, 'app_ai', { status: 'pending' })
    await msg(p, c, T + 20 * SEC, 'customer', { removed: true })
    // Hôm nay (VN) và 23:59 VN ngày trước `from`.
    await msg(p, c, Date.parse('2026-10-23T17:00:00.000Z'), 'customer')
    await msg(p, c, Date.parse('2026-09-23T16:59:00.000Z'), 'customer')
    const other = await page()
    const oc = await conversation(other)
    await msg(other, oc, T, 'customer')
    await msg(other, oc, T + 2 * SEC, 'app_ai')
    const removed = await page({ removed: true })
    const rc = await conversation(removed)
    await msg(removed, rc, T, 'customer')

    expect(await ai({ scope: `page:${p}` })).toMatchObject({ customerMessages: 1, aiAnswered: 0, aiMessages: 0, aiConversations: 0 })
    // `all`: thêm trang `other`, không có trang đã gỡ.
    expect(await ai()).toMatchObject({ customerMessages: 2, aiAnswered: 1, aiMessages: 1, aiConversations: 1 })
  })

  it('AI chuyển người: câu chuyển tiếp + KEYWORD; đang ai (mở cổng trước kỳ) → AI_SEND_FAILED', async () => {
    const p = await page()
    const a = await conversation(p)
    await msg(p, a, T, 'customer')
    await msg(p, a, T + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, a, T + 3 * SEC, 'app_ai')
    await msg(p, a, T + 3 * SEC + 1, 'system', { reason: 'KEYWORD' })
    const b = await conversation(p)
    await msg(p, b, Date.parse('2026-09-01T05:00:00.000Z'), 'system', { reason: 'GATE_OPEN' })
    await msg(p, b, T, 'customer')
    await msg(p, b, T + 5 * SEC, 'system', { reason: 'AI_SEND_FAILED' })

    expect(await ai()).toMatchObject({ aiMessages: 1, aiConversations: 2, handoffConversations: 2 })
  })

  it('không phải AI chuyển: cổng đóng ở triage, Tiếp quản, chủ shop trả lời, AI_OFF', async () => {
    const p = await page()
    const c1 = await conversation(p)
    await msg(p, c1, T, 'customer')
    await msg(p, c1, T + 1 * SEC, 'system', { reason: 'OUTSIDE_HOURS' })
    for (const reason of ['TAKEOVER', 'HUMAN_REPLIED']) {
      const c = await conversation(p)
      await msg(p, c, T, 'customer')
      await msg(p, c, T + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
      await msg(p, c, T + 3 * SEC, 'app_ai')
      await msg(p, c, T + 60 * SEC, 'system', { reason })
    }
    const c4 = await conversation(p)
    await msg(p, c4, T - DAY, 'system', { reason: 'GATE_OPEN' })
    await msg(p, c4, T, 'customer')
    await msg(p, c4, T + 1 * SEC, 'system', { reason: 'AI_OFF' })

    expect(await ai()).toMatchObject({ aiConversations: 2, handoffConversations: 0 })
  })

  it('mẫu thời gian bị loại: AI chạy lại sau handoff, bật lại AI, nhóm tin bắt đầu trước kỳ', async () => {
    const p = await page()
    // Ngoài giờ 23:00 → handoff tạm đóng; sáng hôm sau khách nhắn tiếp, AI chạy lại trả lời cả hai.
    const resume = await conversation(p)
    await msg(p, resume, T, 'customer')
    await msg(p, resume, T + 1 * SEC, 'system', { reason: 'OUTSIDE_HOURS' })
    await msg(p, resume, T + 9 * 3600 * SEC, 'customer')
    await msg(p, resume, T + 9 * 3600 * SEC + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, resume, T + 9 * 3600 * SEC + 5 * SEC, 'app_ai')
    // Khách chờ ở `human`, 2 giờ sau chủ shop bật lại AI.
    const reenable = await conversation(p)
    await msg(p, reenable, T - DAY, 'system', { reason: 'HUMAN_REPLIED' })
    await msg(p, reenable, T, 'customer')
    await msg(p, reenable, T + 7200 * SEC, 'system', { reason: 'AI_REENABLED' })
    await msg(p, reenable, T + 7203 * SEC, 'app_ai')
    // Nhóm tin bắt đầu trước kỳ (23:00 VN 23/09), tin thứ hai trong kỳ (01:00 VN 24/09).
    const span = await conversation(p)
    const before = Date.parse('2026-09-23T16:00:00.000Z')
    await msg(p, span, before, 'customer')
    await msg(p, span, before + 2 * 3600 * SEC, 'customer')
    await msg(p, span, before + 2 * 3600 * SEC + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, span, before + 2 * 3600 * SEC + 4 * SEC, 'app_ai')
    // Một mẫu hợp lệ 4 giây.
    const good = await conversation(p)
    await msg(p, good, T, 'customer')
    await msg(p, good, T + 1 * SEC, 'system', { reason: 'GATE_OPEN' })
    await msg(p, good, T + 4 * SEC, 'app_ai')

    expect(await ai()).toMatchObject({ customerMessages: 5, aiAnswered: 5, aiMessages: 4, avgResponseSeconds: 4, responseSamples: 1 })
  })

  it('bài AI tạo vs bài tự viết: snapshot mới nhất, bỏ bài không có số liệu và bài ngoài kỳ', async () => {
    const p = await page()
    const a1 = await target(p, { ai: true })
    await snapshot(a1, p, '2026-10-20', 10)
    await snapshot(a1, p, '2026-10-22', 30)
    const a2 = await target(p, { ai: true })
    await snapshot(a2, p, '2026-10-22', 50)
    const m1 = await target(p)
    await snapshot(m1, p, '2026-10-22', 20)
    await target(p)
    const nullEng = await target(p)
    await snapshot(nullEng, p, '2026-10-22', null)
    const old = await target(p, { publishedAt: NOW.getTime() - 40 * DAY })
    await snapshot(old, p, '2026-10-22', 999)

    expect((await ai()).posts).toEqual({ ai: { posts: 2, avgEngagement: 40 }, manual: { posts: 1, avgEngagement: 20 } })
  })

  it('KPI Tin nhắn: kỳ này / kỳ trước; trang kết nối sau đầu kỳ trước → previous null', async () => {
    // 7 ngày: kỳ 17/10 – 23/10, kỳ trước 10/10 – 16/10.
    const p = await page({ connectedDaysAgo: 40 })
    const c = await conversation(p)
    for (const d of ['2026-10-18', '2026-10-20', '2026-10-23']) await msg(p, c, Date.parse(`${d}T05:00:00.000Z`), 'customer')
    for (const d of ['2026-10-11', '2026-10-16']) await msg(p, c, Date.parse(`${d}T05:00:00.000Z`), 'customer')

    expect((await perf({ range: '7d' })).kpis.messages).toEqual({ current: 3, previous: 2 })
    await page({ connectedDaysAgo: 10 })
    expect((await perf({ range: '7d' })).kpis.messages).toEqual({ current: 3, previous: null })
  })

  it('rỗng: nhóm không có trang; trang không có tin', async () => {
    const empty = {
      customerMessages: 0,
      aiAnswered: 0,
      aiMessages: 0,
      aiConversations: 0,
      handoffConversations: 0,
      avgResponseSeconds: null,
      responseSamples: 0,
      posts: { ai: { posts: 0, avgEngagement: null }, manual: { posts: 0, avgEngagement: null } },
    }
    const [g] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values ('Trống', 'group-1') returning id`
    expect(await ai({ scope: `group:${g!.id}` })).toEqual(empty)
    await page()
    const r = await perf()
    expect(r.ai).toEqual(empty)
    expect(r.kpis.messages).toEqual({ current: 0, previous: 0 })
  })
})

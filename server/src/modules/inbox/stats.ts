// Số liệu "Hiệu quả AI" (Story 8.3, AD-9, AD-17): đếm trên `messages` + tin `system` chuyển trạng thái — chỉ đọc, không
// đọc nội dung tin. `analytics` gọi qua `index.ts` (không SQL chéo bảng của `inbox`).
// - Tin khách = `origin='customer'` chưa bị gỡ; tin đã gửi = outbound `sent|delivered|read`. Thứ tự trong hội thoại theo
//   `(platform_timestamp, id)` như khung chat; tin thuộc kỳ theo `platform_timestamp` ∈ `[from, to)`.
// - "AI trả lời" một tin khách = tin đã gửi ĐẦU TIÊN sau nó là `app_ai` (câu chuyển tiếp của AI cũng tính).
// - "AI chuyển người" = tin `system` lý do `transient|sticky` (đích `handoff`) ngay sau một tin `system` `GATE_OPEN` /
//   `AI_REENABLED` (hội thoại đang `ai`). Đóng cổng ngay ở triage, Tiếp quản, chủ shop trả lời, lý do `not_applicable`
//   không tính.
// - Thời gian phản hồi: tin khách đầu nhóm → `sent_at` của tin AI trả lời nhóm đó, mốc `created_at` (lúc vào hệ thống ≈
//   webhook, như NFR1). Chỉ tính khi hội thoại ở với AI suốt quãng đó — khách nhắn lúc `handoff` / `human` rồi AI chạy lại
//   (5.6) hay chủ shop bật lại AI sẽ cho mẫu vài giờ, không phản ánh tốc độ AI.
// Truy vấn theo trang + kỳ đi index `messages (page_id, platform_timestamp)`; lần theo hội thoại đi
// `(conversation_id, platform_timestamp, id)`.
import { HANDOFF_REASON_KIND, HANDOFF_REASONS, type HandoffReason } from '@ottm/shared'
import { and, count, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { messages } from './schema.ts'

export interface AiReplyStats {
  customerMessages: number
  aiAnswered: number
  aiMessages: number
  aiConversations: number
  handoffConversations: number
  /** Trung bình mẫu thời gian phản hồi (giây); `null` khi không có mẫu. */
  avgResponseSeconds: number | null
  responseSamples: number
}

interface StatsRange {
  pageIds: readonly string[]
  from: Date
  to: Date
}

/** Lý do đưa hội thoại sang `handoff` (AD-9: `transient` / `sticky`). */
const HANDOFF_TO_HUMAN: readonly HandoffReason[] = HANDOFF_REASONS.filter((r) => HANDOFF_REASON_KIND[r] !== 'not_applicable')
/** Lý do đưa hội thoại sang `ai`. */
const TO_AI = ['GATE_OPEN', 'AI_REENABLED'] as const

const list = (values: readonly string[]): SQL => sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`
const uuidList = (values: readonly string[]): SQL => sql`(${sql.join(values.map((v) => sql`${v}::uuid`), sql`, `)})`

const EMPTY: AiReplyStats = {
  customerMessages: 0,
  aiAnswered: 0,
  aiMessages: 0,
  aiConversations: 0,
  handoffConversations: 0,
  avgResponseSeconds: null,
  responseSamples: 0,
}

/** Tin khách trong kỳ của các trang (KPI "Tin nhắn", cả kỳ trước). */
export async function countCustomerMessages(db: DbExecutor, range: StatsRange): Promise<number> {
  if (!range.pageIds.length) return 0
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        inArray(messages.pageId, [...range.pageIds]),
        eq(messages.origin, 'customer'),
        isNull(messages.removal),
        gte(messages.platformTimestamp, range.from),
        lt(messages.platformTimestamp, range.to),
      ),
    )
  return Number(row?.n ?? 0)
}

/** Đếm "Hiệu quả AI" của các trang (bên gọi truyền trang chưa gỡ của phạm vi) trong kỳ `[from, to)`. */
export async function aiReplyStats(db: DbExecutor, range: StatsRange): Promise<AiReplyStats> {
  if (!range.pageIds.length) return { ...EMPTY }
  const pages = uuidList(range.pageIds)
  const from = range.from.toISOString()
  const to = range.to.toISOString()
  const sent = list(['sent', 'delivered', 'read'])
  const toAi = list(TO_AI)

  const [replies] = await db.execute<{ customer_messages: string; ai_answered: string; avg_seconds: string | null; samples: string }>(sql`
    with c as (
      select m.id, m.conversation_id, m.platform_timestamp as ts, m.created_at
      from ${messages} m
      where m.page_id in ${pages} and m.origin = 'customer' and m.removal is null
        and m.platform_timestamp >= ${from}::timestamptz and m.platform_timestamp < ${to}::timestamptz
    ),
    r as (
      select c.*, rep.id as rep_id, rep.origin as rep_origin, rep.sent_at as rep_sent_at, rep.platform_timestamp as rep_ts
      from c left join lateral (
        select o.id, o.origin, o.sent_at, o.platform_timestamp from ${messages} o
        where o.conversation_id = c.conversation_id and o.direction = 'outbound' and o.status in ${sent}
          and (o.platform_timestamp, o.id) > (c.ts, c.id)
        order by o.platform_timestamp, o.id
        limit 1
      ) rep on true
    ),
    -- Tin khách sớm nhất (trong kỳ) của mỗi nhóm được một tin AI trả lời.
    anchors as (
      select distinct on (rep_id) rep_id, rep_ts, rep_sent_at, conversation_id, id as a_id, ts as a_ts, created_at as a_created
      from r
      where rep_origin = 'app_ai' and rep_sent_at is not null
      order by rep_id, ts, id
    ),
    samples as (
      select greatest(0, extract(epoch from (a.rep_sent_at - a.a_created))) as s
      from anchors a
      -- Đầu nhóm thật: tin hiệu lực liền trước không phải tin khách (nhóm bắt đầu trước kỳ thì bỏ).
      where coalesce((
          select p.origin from ${messages} p
          where p.conversation_id = a.conversation_id and (p.platform_timestamp, p.id) < (a.a_ts, a.a_id)
            and ((p.origin = 'customer' and p.removal is null) or (p.direction = 'outbound' and p.status in ${sent}))
          order by p.platform_timestamp desc, p.id desc
          limit 1
        ), '') <> 'customer'
        -- Lúc khách nhắn hội thoại đang với AI (mới, mở lại sau "xong", hoặc đang ai) ...
        and coalesce((
          select s.reason_code from ${messages} s
          where s.conversation_id = a.conversation_id and s.origin = 'system' and (s.platform_timestamp, s.id) < (a.a_ts, a.a_id)
          order by s.platform_timestamp desc, s.id desc
          limit 1
        ), 'MARKED_DONE') in ('GATE_OPEN', 'AI_REENABLED', 'MARKED_DONE')
        -- ... và không rời AI trước khi AI trả lời.
        and not exists (
          select 1 from ${messages} s
          where s.conversation_id = a.conversation_id and s.origin = 'system' and s.reason_code <> 'GATE_OPEN'
            and (s.platform_timestamp, s.id) > (a.a_ts, a.a_id) and (s.platform_timestamp, s.id) < (a.rep_ts, a.rep_id)
        )
    )
    select (select count(*) from r) as customer_messages,
           (select count(*) from r where rep_origin = 'app_ai') as ai_answered,
           (select avg(s) from samples) as avg_seconds,
           (select count(*) from samples) as samples`)

  const [ai] = await db.execute<{ ai_messages: string; ai_conversations: string; handoff_conversations: string }>(sql`
    with ai as (
      select m.conversation_id from ${messages} m
      where m.page_id in ${pages} and m.origin = 'app_ai' and m.status in ${sent}
        and m.platform_timestamp >= ${from}::timestamptz and m.platform_timestamp < ${to}::timestamptz
    ),
    handoffs as (
      select distinct s.conversation_id from ${messages} s
      cross join lateral (
        select p.reason_code from ${messages} p
        where p.conversation_id = s.conversation_id and p.origin = 'system' and (p.platform_timestamp, p.id) < (s.platform_timestamp, s.id)
        order by p.platform_timestamp desc, p.id desc
        limit 1
      ) prev
      where s.page_id in ${pages} and s.origin = 'system' and s.reason_code in ${list(HANDOFF_TO_HUMAN)}
        and s.platform_timestamp >= ${from}::timestamptz and s.platform_timestamp < ${to}::timestamptz
        and prev.reason_code in ${toAi}
    )
    select (select count(*) from ai) as ai_messages,
           (select count(*) from (select conversation_id from ai union select conversation_id from handoffs) x) as ai_conversations,
           (select count(*) from handoffs) as handoff_conversations`)

  const samples = Number(replies?.samples ?? 0)
  return {
    customerMessages: Number(replies?.customer_messages ?? 0),
    aiAnswered: Number(replies?.ai_answered ?? 0),
    aiMessages: Number(ai?.ai_messages ?? 0),
    aiConversations: Number(ai?.ai_conversations ?? 0),
    handoffConversations: Number(ai?.handoff_conversations ?? 0),
    avgResponseSeconds: samples && replies?.avg_seconds != null ? Number(replies.avg_seconds) : null,
    responseSamples: samples,
  }
}
